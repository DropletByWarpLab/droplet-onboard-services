/**
 * WARP-1996 — the on-box `Summarizer` behind a spec's `summarize` step.
 *
 * Built on `completeOnce`, which is non-agentic BY CONTRACT: it advertises no
 * tools and cannot call any. That matters here — the facts this sees are the
 * results of steps that already cleared the §3 scope check, and the model's
 * job is to write them up, not to go and fetch more.
 *
 * Everything stays on the box: the default model triad resolves to whatever
 * the box pulled, and no cloud provider is reachable from this path without
 * the operator having configured one as the default.
 */

import { TOOL_CATALOG, type ToolDomain } from "@droplet/tools-core";
import { completeOnce, type CompleteOnceResult } from "./llm-complete.service.js";
import { OFF_LAN_WITHHELD_DOMAINS } from "./stored-content-egress.service.js";
import type { RunStepTrace, Summarizer, SummaryOutput } from "./tool-spec-runner.service.js";
import { createLogger } from "../lib/logger.js";
import { GATEWAY_MAX_TOKENS } from "../types/index.js";

const logger = createLogger("tool-spec-summarizer");

/**
 * Prose, not JSON — generous enough for five short paragraphs without
 * inviting an essay. The brief caps the tile at 2–5.
 *
 * WARP-2964 — it was 700, which is what five paragraphs COST but not what
 * they take to produce. On a reasoning model the budget is spent on the
 * harmony analysis channel first, and `content` only starts once that is
 * done: replaying a real daily report on gpt-oss:20B burned all 700 tokens
 * in `reasoning_content`, returned `finish_reason: "length"` with zero
 * characters of prose, and failed the run. The same prompt finished in
 * ~1150 completion tokens when given room. 2100 leaves headroom for a
 * longer day; this is one call every 24 h, so the ceiling costs nothing
 * when it is not used.
 */
const MAX_TOKENS = 2_100;

/**
 * Low but not zero. Deterministic-sounding prose across seven days reads as
 * a template; this is the same profile `completeOnce` uses for its other
 * light text tasks.
 */
const TEMPERATURE = 0.3;

/**
 * How much of one step's result may reach the prompt.
 *
 * A tool result is arbitrary JSON and some of them are large (a file listing,
 * a camera event page). Without a bound, one fat step could crowd every other
 * fact out of the context window and the narrative would silently describe
 * only part of the day. Truncation is marked so the model can say the list
 * was long rather than pretending it was complete.
 */
const MAX_RESULT_CHARS = 2_000;

/**
 * Error codes that mean "this source was never set up", not "this source
 * broke": ERP with no connector, or a per-user source in a run that has no
 * person to read it for (a scheduled fire). Decided HERE, by code, so the
 * model is never the one reading an error message and choosing whether the
 * owner should hear about it.
 */
const NOT_CONNECTED_CODES = new Set(["ERP_NOT_CONNECTED", "AUTH_REQUIRED"]);

/** The dispatcher throws the MCP error envelope verbatim (app.ts); pull the
 *  code and message back out. Anything else is a plain message. */
function parseToolError(error: string | undefined): { code?: string; message: string } {
  if (!error) return { message: "unknown error" };
  try {
    const e = (JSON.parse(error) as { error?: { code?: unknown; message?: unknown } }).error;
    if (e && typeof e === "object") {
      return {
        ...(typeof e.code === "string" ? { code: e.code } : {}),
        message: typeof e.message === "string" ? e.message : error,
      };
    }
  } catch {
    // not the envelope — a thrown Error's message, used as is
  }
  return { message: error };
}

/**
 * WARP-3409 — figures a person reads in other units than the tool returns.
 * Given raw results, every model opened the report with "running for 16,831
 * seconds". Keyed by field NAME across all results, so a name belongs here
 * only when it means the same unit in every tools-core result that uses it
 * (`size` is a file size in bytes wherever it appears; `totalBytesPerHour` is
 * a rate, which is why this is a list and not a `*Bytes` suffix rule).
 */
function humanBytes(n: number): string {
  // Binary units, like the dashboard's bytes.ts: Nextcloud reports binary sizes.
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return i === 0 ? `${n} B` : `${n.toFixed(1)} ${units[i]}`;
}

function humanDuration(sec: number): string {
  const d = Math.floor(sec / 86_400);
  const h = Math.floor((sec % 86_400) / 3_600);
  const m = Math.floor((sec % 3_600) / 60);
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  return m > 0 ? `${m} min` : `${Math.floor(sec)} s`;
}

function humanBitRate(bps: number): string {
  if (bps < 1_000) return `${bps} bps`;
  if (bps < 1_000_000) return `${(bps / 1_000).toFixed(1)} kbps`;
  if (bps < 1_000_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`;
  return `${(bps / 1_000_000_000).toFixed(1)} Gbps`;
}

// A Map, not an object literal: a result key like "constructor" must not
// find Object.prototype's.
const HUMANIZE: ReadonlyMap<string, (n: number) => string> = new Map([
  ["uptime", humanDuration],
  ["uptimeSec", humanDuration],
  ["size", humanBytes],
  ["sizeBytes", humanBytes],
  ["freeBytes", humanBytes],
  ["usedBytes", humanBytes],
  ["totalBytes", humanBytes],
  ["offLanBytes", humanBytes],
  ["offLanBytesThisMonth", humanBytes],
  ["wanUpBps", humanBitRate],
  ["wanDownBps", humanBitRate],
]);

/** `JSON.stringify` replacer: a known field's non-negative number, in its unit. */
function humanizeFigure(key: string, value: unknown): unknown {
  const fmt = HUMANIZE.get(key);
  return fmt && typeof value === "number" && Number.isFinite(value) && value >= 0 ? fmt(value) : value;
}

/** A source the owner never set up — not news, so no fact at all. */
function isNotConnected(t: RunStepTrace): boolean {
  if (t.ok) return false;
  const { code } = parseToolError(t.error);
  return code !== undefined && NOT_CONNECTED_CODES.has(code);
}

function renderFact(t: RunStepTrace): string {
  if (!t.ok) {
    // Failures are facts too, and the ones most worth saying out loud. A
    // narrative that silently omits the step that failed is exactly the
    // dishonesty this surface is built against. COULD NOT BE READ is the
    // prompt's vocabulary for it.
    return `- ${t.tool}: COULD NOT BE READ (${parseToolError(t.error).message})`;
  }
  let body: string;
  try {
    body = JSON.stringify(t.result ?? null, humanizeFigure);
  } catch {
    // Circular or otherwise unserialisable — say so rather than dropping it.
    body = "(result could not be serialised)";
  }
  if (body.length > MAX_RESULT_CHARS) {
    body = `${body.slice(0, MAX_RESULT_CHARS)}… (truncated; the full result was longer)`;
  }
  return `- ${t.tool}: ${body}`;
}

/**
 * The facts block handed to the model, one line per step, in run order.
 * WARP-3409 — a NOT CONNECTED source is dropped here, in code: marked and
 * left to the prompt, a model with thinking off wrote it up as "could not be
 * read" anyway.
 */
export function renderFacts(facts: RunStepTrace[]): string {
  const shown = facts.filter((t) => !isNotConnected(t));
  if (shown.length === 0) {
    // An honest empty rather than a blank prompt: without this the model is
    // free to invent a day from nothing.
    return "(no results were gathered)";
  }
  return shown.map(renderFact).join("\n");
}

/**
 * WARP-3409 — a failure the summarizer can name for the owner, in plain words
 * (`plain`, which completes "...couldn't be produced because ___"). `message`
 * stays the technical reason the trace and the log keep.
 */
class SummaryUnavailableError extends Error {
  constructor(
    message: string,
    readonly plain: string,
  ) {
    super(message);
  }
}

/** Safe read of a nested field of an arbitrary tool result. */
function at(value: unknown, ...path: string[]): unknown {
  let cur = value;
  for (const key of path) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

const count = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** list_recent_files' page size (its `/recents?limit=30`). */
const RECENT_FILES_PAGE = 30;

/**
 * WARP-3409 — the fallback write-up's line for each of the daily report's
 * reads: a label, and a readout of its key figures. A readout answers null
 * on a shape it does not recognise, which prints as "checked", never as a
 * guessed figure. Any other tool is named as is.
 */
type Readout = { label: string; read: (r: unknown) => string | null };
const READOUTS: ReadonlyMap<string, Readout> = new Map(
  Object.entries<Readout>({
    get_system_health: {
      label: "System health",
      read: (r) => {
        const comps = at(r, "components");
        if (!Array.isArray(comps)) return null;
        const down = comps.filter((c) => at(c, "status") !== "ok").map((c) => String(at(c, "name")));
        const tally = `${comps.length - down.length} of ${comps.length} services ok`;
        return down.length === 0 ? tally : `${tally} (not ok: ${down.join(", ")})`;
      },
    },
    list_recent_files: {
      label: "Recent files",
      read: (r) => {
        const items = at(r, "items");
        if (!Array.isArray(items)) return null;
        // The tool asks for one page (`/recents?limit=30`, tools-core list-recent-files.ts), so a
        // full page is "the most recent 30", never a count of everything that changed.
        return items.length >= RECENT_FILES_PAGE
          ? `the ${RECENT_FILES_PAGE} most recently changed items`
          : plural(items.length, "recently changed item");
      },
    },
    network_summary: {
      label: "Network",
      read: (r) => {
        const clients = count(at(r, "kpis", "clientCount"));
        const blocked = count(at(r, "kpis", "dnsBlockedToday"));
        if (clients === null) return null;
        return `${plural(clients, "device")} connected` + (blocked === null ? "" : `, ${plural(blocked, "DNS lookup")} blocked today`);
      },
    },
    get_camera_health: {
      label: "Cameras",
      read: (r) => {
        const total = count(at(r, "system", "cameraCount"));
        const live = count(at(r, "system", "camerasLive"));
        if (total === null) return null;
        if (total === 0) return "none set up";
        return live === null ? plural(total, "camera") : `${live} of ${total} live`;
      },
    },
    list_events: {
      label: "Calendar",
      read: (r) => {
        const n = count(at(r, "count"));
        if (n === null) return null;
        return n === 0 ? "no upcoming events" : plural(n, "upcoming event");
      },
    },
  }),
);

/**
 * WARP-3409 — `text` up to its last complete sentence, or "" when it has none.
 * A terminator counts only when whitespace follows it: the text was cut off,
 * so a final "8." may be the start of "8.8" rather than the end of a sentence.
 */
export function toLastSentence(text: string): string {
  let end = -1;
  for (const m of text.matchAll(/[.!?]["'\u201d\u2019)\]]*(?=\s)/g)) end = m.index + m[0].length;
  return end < 0 ? "" : text.slice(0, end);
}

/** WARP-3409 — appended to a write-up ended early, so it never reads as finished. */
export const TRUNCATED_NOTE = "This summary was cut short; some details may be missing.";

/** Why the model's write-up is missing, completing "...because ___". */
function plainReason(err: unknown): string {
  if (err instanceof SummaryUnavailableError) return err.plain;
  const message = err instanceof Error ? err.message : String(err);
  return /timeout/i.test(message) ? "the AI model took too long to answer" : "the AI service returned an error";
}

/**
 * WARP-3409 — the write-up used when the model could not produce one, so a
 * report never fails because its prose did (Romain: "if something returns
 * empty but the rest isn't then it still shouldn't fail"). Deterministic and
 * built only from the facts: one line per source in the prompt's vocabulary
 * (NOT CONNECTED left out, a failed read said plainly), then one sentence on
 * why there is no written summary.
 */
export function fallbackSummary(facts: RunStepTrace[], err: unknown): string {
  const lines = facts.flatMap((t) => {
    // Pseudo-steps (`(transform)`, an earlier `(summarize)`) are not sources.
    if (t.tool.startsWith("(")) return [];
    const readout = READOUTS.get(t.tool);
    const label = readout?.label ?? t.tool;
    if (!t.ok) return isNotConnected(t) ? [] : [`${label}: couldn't be read.`];
    return [`${label}: ${readout?.read(t.result) ?? "checked"}.`];
  });
  if (lines.length === 0) lines.push("Nothing was gathered to report on.");
  lines.push(`The written summary couldn't be produced because ${plainReason(err)}.`);
  return lines.join("\n");
}

/** The summary model's system prompt. Exported for scripts/model-support/replay-summary.mjs (WARP-3409),
 *  so a replay renders exactly what production sends. */
export const SUMMARY_SYSTEM = [
  "You are writing a short briefing for the owner of a Droplet appliance,",
  "from tool results gathered on their own hardware.",
  "",
  "Rules you must follow:",
  "- Use ONLY figures that appear in the results. Never estimate, infer, or",
  "  carry a number over from general knowledge.",
  "- If a source is marked COULD NOT BE READ, say so plainly in one clause.",
  "  Do not omit it and do not guess what it would have said.",
  "- Write prose. No bullet points, no headings, no markdown.",
  "- Second person, plain language, no exclamation marks.",
  "- If there is nothing of note, say that briefly rather than padding.",
].join("\n");

/** The ai-gateway's name for the on-box runtime (`ChatRequest.provider`). */
const LOCAL_PROVIDER = "local";

const DOMAIN_OF: ReadonlyMap<string, ToolDomain> = new Map(TOOL_CATALOG.map((e) => [e.name, e.domain]));

/**
 * WARP-2979 (#2420 review 2b) — whether the facts include a
 * step from a domain that never goes to a cloud model
 * (OFF_LAN_WITHHELD_DOMAINS, the chat rule). A failed
 * step counts too: its error text reaches the prompt as well.
 */
export function factsNeedLocalModel(facts: readonly RunStepTrace[]): boolean {
  return facts.some((f) => {
    const domain = DOMAIN_OF.get(f.tool);
    return domain !== undefined && OFF_LAN_WITHHELD_DOMAINS.has(domain);
  });
}

/**
 * @param resolveModel WARP-3047 — the box's ACTIVE model, asked per summary
 *   (routes/tools.ts passes `resolveActiveModel`). A routine run started from
 *   a chat turn (`routine_run`) summarises on the model that turn already
 *   has resident, instead of loading env DEFAULT_MODEL/LLM_MODEL next to it.
 * @param resolveLocalModel WARP-2979 — the box's LOCAL model only (routes/tools.ts
 *   passes the filing worker's local-only resolver). Used instead of the
 *   active model — which may be a cloud one — whenever the facts include a
 *   withheld domain's step; with none, the step fails: the summary is written
 *   on this Droplet or not at all.
 */
export function createToolSpecSummarizer(
  resolveModel: () => Promise<string | null>,
  resolveLocalModel: () => Promise<string | null> = async () => null,
): Summarizer {
  return {
    async summarize(prompt: string, facts: RunStepTrace[]): Promise<SummaryOutput> {
      const local = factsNeedLocalModel(facts);
      const model = local ? await resolveLocalModel() : await resolveModel();
      if (!model) {
        // A failed step, said plainly — never a hardcoded tag the box does
        // not host (the historic mistral fallback 404'd upstream), and never
        // a cloud model for a withheld domain's results.
        throw new SummaryUnavailableError(
          local
            ? "no AI model on this Droplet is available to write a summary of these results"
            : "no local model is available to write the summary",
          "no AI model was available to write it",
        );
      }

      const text = `${prompt}\n\nResults:\n${renderFacts(facts)}`;
      // WARP-3409 — every call asks for low thinking: a write-up of facts
      // already gathered needs little, and a thinking model at its default can
      // spend the whole budget before a word of prose. The gateway's per-family
      // table decides what "low" means for the active model (gpt-oss: low
      // effort; GLM on DMR: thinking off; unknown: nothing sent). Replaying
      // the failed run on gpt-oss:20B: default effort 796–2,100 completion
      // tokens, 8–22 s, one of three cut off; low 319–341 tokens, 3–4 s, 3/3
      // finished, prose of the same length.
      const ask = (maxTokens: number) =>
        completeOnce({
          system: SUMMARY_SYSTEM,
          text,
          model,
          temperature: TEMPERATURE,
          maxTokens,
          reasoningEffort: "low",
          // A withheld domain's results are written on the box, and the request SAYS so: the gateway routes by a
          // named provider before it looks at the model's name, so a local fine-tune called gpt-* or claude-* still
          // stays local. Any other summary keeps routing by model, as before.
          ...(local ? { provider: LOCAL_PROVIDER } : {}),
        });

      let result = await ask(MAX_TOKENS);
      let content = result.content.trim();
      // WARP-3409 — the longest write-up that ran out of room mid-sentence. A
      // cut-off answer is not a finished one: it is retried like a blank.
      let cutOff = "";
      if (!content || result.finishReason === "length") {
        // WARP-2964 — one retry, because the cause is nearly always the
        // budget: the model thought until it was cut off. Double the room,
        // up to the gateway's ceiling (WARP-3409: 2 × 2,100 was a 422). A
        // finished first answer never gets here, so the daily cost is still
        // one call.
        logger.warn(
          {
            model,
            factCount: facts.length,
            finishReason: result.finishReason,
            contentChars: content.length,
            reasoningChars: result.reasoning.length,
          },
          "summarizer returned empty or cut-off content; retrying with a doubled budget",
        );
        cutOff = content;
        let retry: CompleteOnceResult | null = null;
        try {
          retry = await ask(Math.min(MAX_TOKENS * 2, GATEWAY_MAX_TOKENS));
        } catch (err) {
          // A failed retry must not throw away prose the first call wrote.
          if (!cutOff) throw err;
          logger.warn({ model, err: (err as Error).message }, "summary retry failed; keeping the cut-off first answer");
        }
        content = retry ? retry.content.trim() : "";
        if (retry) result = retry;
        if (content && result.finishReason === "length") {
          if (content.length > cutOff.length) cutOff = content;
          content = "";
        }
      }
      if (!content && cutOff) {
        // Cut off twice: keep what was written, ended at its last complete
        // sentence so no fragment reaches the owner, and say so — in the step
        // (`truncated`) and in the prose itself, because no client reads the
        // flag and a trimmed summary would otherwise look finished.
        const whole = toLastSentence(cutOff);
        if (whole) {
          logger.warn({ model, keptChars: whole.length, cutChars: cutOff.length }, "summary cut off; kept up to its last complete sentence");
          return { text: `${whole}\n\n${TRUNCATED_NOTE}`, truncated: true };
        }
      }
      if (!content) {
        // `completeOnce` treats empty content as a non-error. Here it is one:
        // an empty narrative would render as a report with nothing to say,
        // which is indistinguishable from a quiet day. Throw — the runner
        // then writes `fallbackSummary` instead and marks the step — and say
        // WHY, because this string is what the trace's `fallbackReason` and
        // the log keep for the next debugger.
        throw new SummaryUnavailableError(
          `the model returned ${cutOff ? "no complete sentence" : "an empty summary"} (model=${model} ` +
            `finish_reason=${result.finishReason ?? "unknown"} ` +
            `reasoning_chars=${result.reasoning.length})`,
          cutOff
            ? "the AI model ran out of room before it finished a sentence"
            : result.finishReason === "length"
              ? "the AI model ran out of room before it wrote anything"
              : "the AI model returned no text",
        );
      }
      return content;
    },
    fallback: fallbackSummary,
  };
}
