/**
 * WARP-2979 (ADR-059 P4 §6.11.1, D22) — the check every "Summary by Droplet"
 * passes before it is stored. Pure. The text is trimmed and its runs of
 * whitespace collapsed first; the rules run in this order and the first that
 * fails is the one named (the narrator retries once, naming the rule, never
 * quoting the text):
 *
 *   SHAPE  empty; over 700 chars; over 5 sentences; `http`, a backtick, `#`,
 *          `|`, `*` at a line start; a control, line-separator or bidi
 *          character (`hasUnsafeDisplayChars`);
 *   NAMES  a whole word that is a token (3+ letters) of a name from the
 *          box's directory (every display name and username). Both sides are
 *          compared in one form (`compareForm`: NFKC, no combining marks, no
 *          invisible format characters, straight apostrophes, lower case), so
 *          "Jose", "José", "Lo<U+200B>pez" and fullwidth letters are the name.
 *          Each exact phrase the input itself carries (the area, the cameras,
 *          the parts of a view, the codes' string facts) is set aside first —
 *          only that phrase: "Maria's office" may be written, and "Maria"
 *          anywhere else is still the name. The few words the prompt tells the
 *          model to write ("someone", "a person", "Droplet") never count;
 *   TIMES  a clock (`2:14`, `2:14 AM`, `2:14 p.m.`) or an hour (`3 AM`,
 *          `3am`, `3 a.m.`) that is not one of the input's own times (case,
 *          dots and the space before AM/PM aside; a bare `2:14` is `2:14 AM`
 *          when that is an input time; an hour is its `:00`, so "around 2 AM"
 *          is not 2:14 AM). No times in, none out;
 *   WORDS  monitor(ed), alarm, armed, secure(d), protected, guard(ed),
 *          zone(s), intruder(s), burglar(s), burglary/burglaries, thief,
 *          thieves, theft(s), steal(s)/stealing, stole(n), robbery/robberies,
 *          break-in(s) and "break in(s)" — the page never promises protection
 *          or accuses anyone.
 *          Read with the input's own name phrases set aside (#2423 review 4):
 *          "Secure storage" or "Loading zone camera" is what someone typed.
 */
import { hasUnsafeDisplayChars } from "../services/security-audit.js";
import type { NarrativeInputV1 } from "./security-narrative-prompt.js";

export const NARRATIVE_MAX_CHARS = 700;
export const NARRATIVE_MAX_SENTENCES = 5;

export type NarrativeCheckRule = "SHAPE" | "NAMES" | "TIMES" | "WORDS";
export type NarrativeCheckResult = { ok: true; text: string } | { ok: false; rule: NarrativeCheckRule };

/** Words the prompt itself tells the model to write: never a name, whoever is called that. */
const PROMPT_WORDS: ReadonlySet<string> = new Set(["someone", "person", "people", "droplet"]);
const WORDS =
  /\b(?:monitor(?:ed)?|alarm|armed|secured?|protected|guard(?:ed)?|zones?|intruders?|burglar(?:s|y|ies)?|thief|thieves|thefts?|steal(?:s|ing)?|stolen?|stole|robber(?:y|ies)|break[- ]ins?)\b/i;
/** `2:14`, `2:14 AM`, `2:14am`, `2:14 p.m.`: the clock, then the meridiem's letter if any. */
const CLOCK = /(?<![\d:.])\b(\d{1,2}:\d{2})(?!\d)(?:\s?([ap])\.?\s?m\b\.?)?/gi;
/** `3 AM`, `3am`, `3 a.m.`: an hour with a meridiem and no minutes (#2423 review 6). */
const HOUR = /(?<![\d:.])\b(\d{1,2})\s?([ap])\.?\s?m\b/gi;
const SENTENCE_END = /[.!?]+(?=\s|$)/g;

/**
 * The one form both sides of a comparison are read in (#2423 review 1): NFKC
 * (fullwidth and other compatibility letters fold), then every combining mark
 * (`\p{M}`: é → e) and every invisible format character (`\p{Cf}`: U+200B–
 * U+200D, U+2060, the soft hyphen, bidi marks) removed, curly apostrophes
 * made straight, whitespace runs one space, lower case.
 */
export function compareForm(s: string): string {
  return s
    .normalize("NFKC")
    .normalize("NFD")
    .replace(/[\p{M}\p{Cf}]/gu, "")
    .replace(/[\u2018\u2019\u02BC\uFF07]/g, "'")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** Letter tokens (any script) of an already compare-form string. */
function tokens(s: string): string[] {
  return s.match(/\p{L}+/gu) ?? [];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** ("2:14", "a") → "2:14 AM"; ("2:14", undefined) stays "2:14". */
function normalClock(hm: string, meridiem: string | undefined): string {
  return meridiem ? `${hm} ${meridiem.toUpperCase()}M` : hm;
}

/** The names the input carries, and may therefore be written: the area, sources, parts, and every string fact. */
function inputNames(input: NarrativeInputV1): string[] {
  const out: string[] = [];
  const add = (s: string | null | undefined) => {
    if (s) out.push(s);
  };
  add(input.place?.name);
  for (const e of input.events) {
    add(e.source);
    add(e.part);
  }
  for (const c of input.codes) for (const v of Object.values(c.facts)) if (typeof v === "string") add(v);
  return out;
}

/**
 * `text` (compare form) with each exact input-name phrase replaced by a space:
 * longest first, and only where it stands as a whole phrase (no letter or
 * digit either side), so "Maria's office" goes and "Maria" beside it stays.
 */
function setAsideInputNames(text: string, input: NarrativeInputV1): string {
  const phrases = [...new Set(inputNames(input).map((n) => compareForm(n).trim()))]
    .filter((p) => /[\p{L}\p{N}]/u.test(p))
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const phrase of phrases) {
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(phrase)}(?![\\p{L}\\p{N}])`, "gu"), " ");
  }
  return out;
}

export function checkNarrative(raw: string, input: NarrativeInputV1, forbiddenNames: readonly string[]): NarrativeCheckResult {
  const text = raw.trim().replace(/\s+/g, " ");

  // SHAPE — `*` at a line start is read on the raw text, before the lines are joined.
  if (
    text.length === 0 ||
    text.length > NARRATIVE_MAX_CHARS ||
    (text.match(SENTENCE_END)?.length ?? 0) > NARRATIVE_MAX_SENTENCES ||
    /http/i.test(text) ||
    /[`#|]/.test(text) ||
    /^\s*\*/m.test(raw) ||
    hasUnsafeDisplayChars(text)
  ) {
    return { ok: false, rule: "SHAPE" };
  }

  // NAMES — the text less its input-name phrases, against the WHOLE directory: no name is exempt.
  const rest = setAsideInputNames(compareForm(text), input);
  const forbidden = new Set<string>();
  for (const name of forbiddenNames) {
    for (const t of tokens(compareForm(name))) if (t.length >= 3 && !PROMPT_WORDS.has(t)) forbidden.add(t);
  }
  if (tokens(rest).some((t) => forbidden.has(t))) return { ok: false, rule: "NAMES" };

  // TIMES
  const times = new Set(input.times.map((t) => t.toUpperCase().replace(/\s+/g, " ")));
  const bare = new Set([...times].map((t) => t.replace(/\s?[AP]M$/, "")));
  for (const m of rest.matchAll(CLOCK)) {
    const clock = normalClock(m[1]!, m[2]);
    if (m[2] ? !times.has(clock) : !bare.has(clock)) return { ok: false, rule: "TIMES" };
  }
  for (const m of rest.matchAll(HOUR)) {
    if (!times.has(normalClock(`${m[1]}:00`, m[2]))) return { ok: false, rule: "TIMES" };
  }

  // WORDS — on the same text less its input-name phrases: an area someone called "Secure storage" may be named.
  if (WORDS.test(rest)) return { ok: false, rule: "WORDS" };

  return { ok: true, text };
}
