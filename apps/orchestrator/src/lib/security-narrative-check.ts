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
 *   NAMES  a whole word, any case, that is a token (3+ letters) of a name
 *          from the box's directory (every display name and username) — and
 *          not also a token of a name the input itself carries (the area,
 *          cameras, parts of a view, the codes' facts), so "Maria's office"
 *          can be named while Maria cannot. The few words the prompt tells
 *          the model to write ("someone", "a person", "Droplet") never count;
 *   TIMES  a clock (`2:14`, `2:14 AM`) that is not one of the input's own
 *          times (case and the space before AM/PM aside; a bare `2:14` is
 *          `2:14 AM` when that is an input time). No times in, none out;
 *   WORDS  monitor(ed), alarm, armed, secure(d), protected, guard(ed),
 *          zone(s), intruder(s), burglar(s), thief, thieves, break-in,
 *          stole(n) — the page never promises protection or accuses anyone.
 */
import { hasUnsafeDisplayChars } from "../services/security-audit.js";
import type { NarrativeInputV1 } from "./security-narrative-prompt.js";

export const NARRATIVE_MAX_CHARS = 700;
export const NARRATIVE_MAX_SENTENCES = 5;

export type NarrativeCheckRule = "SHAPE" | "NAMES" | "TIMES" | "WORDS";
export type NarrativeCheckResult = { ok: true; text: string } | { ok: false; rule: NarrativeCheckRule };

/** Words the prompt itself tells the model to write: never a name, whoever is called that. */
const PROMPT_WORDS: ReadonlySet<string> = new Set(["someone", "person", "people", "droplet"]);
const WORDS = /\b(?:monitor(?:ed)?|alarm|armed|secured?|protected|guard(?:ed)?|zones?|intruders?|burglars?|thief|thieves|break-in|stolen?|stole)\b/i;
const CLOCK = /\b(\d{1,2}:\d{2})(\s?[ap]m)?\b/gi;
const SENTENCE_END = /[.!?]+(?=\s|$)/g;

/** Letter tokens (any script), lower-cased. */
function tokens(s: string): string[] {
  return s.toLowerCase().match(/\p{L}+/gu) ?? [];
}

/** "2:14 AM" / "2:14am" / "2:14 am" → "2:14 AM"; "2:14" stays "2:14". */
function normalClock(hm: string, ampm: string | undefined): string {
  return ampm ? `${hm} ${ampm.trim().toUpperCase()}` : hm;
}

/** The names the input carries (and may therefore be written): the area, sources, parts, and every string fact. */
function inputNameTokens(input: NarrativeInputV1): Set<string> {
  const out = new Set<string>();
  const add = (s: string | null | undefined) => {
    if (s) for (const t of tokens(s)) out.add(t);
  };
  add(input.place?.name);
  for (const e of input.events) {
    add(e.source);
    add(e.part);
  }
  for (const c of input.codes) for (const v of Object.values(c.facts)) if (typeof v === "string") add(v);
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

  // NAMES
  const allowed = inputNameTokens(input);
  const forbidden = new Set<string>();
  for (const name of forbiddenNames) {
    for (const t of tokens(name)) if (t.length >= 3 && !allowed.has(t) && !PROMPT_WORDS.has(t)) forbidden.add(t);
  }
  if (tokens(text).some((t) => forbidden.has(t))) return { ok: false, rule: "NAMES" };

  // TIMES
  const times = new Set(input.times.map((t) => t.toUpperCase().replace(/\s+/g, " ")));
  const bare = new Set([...times].map((t) => t.replace(/\s?[AP]M$/, "")));
  for (const m of text.matchAll(CLOCK)) {
    const clock = normalClock(m[1]!, m[2]);
    if (m[2] ? !times.has(clock) : !bare.has(clock)) return { ok: false, rule: "TIMES" };
  }

  // WORDS
  if (WORDS.test(text)) return { ok: false, rule: "WORDS" };

  return { ok: true, text };
}
