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
import { completeOnce } from "./llm-complete.service.js";
import { OFF_LAN_WITHHELD_DOMAINS } from "./stored-content-egress.service.js";
import type { RunStepTrace, Summarizer } from "./tool-spec-runner.service.js";
import { createLogger } from "../lib/logger.js";

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

function renderFact(t: RunStepTrace): string {
  if (!t.ok) {
    // Failures are facts too, and the ones most worth saying out loud. A
    // narrative that silently omits the step that failed is exactly the
    // dishonesty this surface is built against. The two markers are the
    // prompt's vocabulary: NOT CONNECTED is left out, COULD NOT BE READ is
    // said plainly.
    const { code, message } = parseToolError(t.error);
    if (code && NOT_CONNECTED_CODES.has(code)) return `- ${t.tool}: NOT CONNECTED`;
    return `- ${t.tool}: COULD NOT BE READ (${message})`;
  }
  let body: string;
  try {
    body = JSON.stringify(t.result ?? null);
  } catch {
    // Circular or otherwise unserialisable — say so rather than dropping it.
    body = "(result could not be serialised)";
  }
  if (body.length > MAX_RESULT_CHARS) {
    body = `${body.slice(0, MAX_RESULT_CHARS)}… (truncated; the full result was longer)`;
  }
  return `- ${t.tool}: ${body}`;
}

/** The facts block handed to the model, one line per step, in run order. */
export function renderFacts(facts: RunStepTrace[]): string {
  if (facts.length === 0) {
    // An honest empty rather than a blank prompt: without this the model is
    // free to invent a day from nothing.
    return "(no results were gathered)";
  }
  return facts.map(renderFact).join("\n");
}

const SYSTEM = [
  "You are writing a short briefing for the owner of a Droplet appliance,",
  "from tool results gathered on their own hardware.",
  "",
  "Rules you must follow:",
  "- Use ONLY figures that appear in the results. Never estimate, infer, or",
  "  carry a number over from general knowledge.",
  "- If a source is marked COULD NOT BE READ, say so plainly in one clause.",
  "  Do not omit it and do not guess what it would have said.",
  "- If a source is marked NOT CONNECTED, leave it out entirely. Something",
  "  the owner never connected is not news.",
  "- Write prose. No bullet points, no headings, no markdown.",
  "- Second person, plain language, no exclamation marks.",
  "- If there is nothing of note, say that briefly rather than padding.",
].join("\n");

const DOMAIN_OF: ReadonlyMap<string, ToolDomain> = new Map(TOOL_CATALOG.map((e) => [e.name, e.domain]));

/**
 * WARP-2979 (#2420 review 2b; ADR-059 P4 §6.13) — whether the facts include a
 * step from a domain that never goes to a cloud model (files, memory,
 * business, security: OFF_LAN_WITHHELD_DOMAINS, the chat rule). A failed
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
    async summarize(prompt: string, facts: RunStepTrace[]): Promise<string> {
      const local = factsNeedLocalModel(facts);
      const model = local ? await resolveLocalModel() : await resolveModel();
      if (!model) {
        // A failed step, said plainly — never a hardcoded tag the box does
        // not host (the historic mistral fallback 404'd upstream), and never
        // a cloud model for a withheld domain's results.
        throw new Error(
          local
            ? "no AI model on this Droplet is available to write a summary of these results"
            : "no local model is available to write the summary",
        );
      }

      const text = `${prompt}\n\nResults:\n${renderFacts(facts)}`;
      const ask = (maxTokens: number, reasoningEffort?: "low") =>
        completeOnce({
          system: SYSTEM,
          text,
          model,
          temperature: TEMPERATURE,
          maxTokens,
          ...(reasoningEffort ? { reasoningEffort } : {}),
        });

      let result = await ask(MAX_TOKENS);
      let content = result.content.trim();
      if (!content) {
        // WARP-2964 — one retry, because the cause is nearly always the
        // budget: the model thought until it was cut off. Double the room and
        // ask for less thinking (the gateway scopes `reasoning_effort` to the
        // gpt-oss family and DMR may ignore it — harmless either way). A
        // non-blank first answer never gets here, so the daily cost is still
        // one call.
        logger.warn(
          {
            model,
            factCount: facts.length,
            finishReason: result.finishReason,
            reasoningChars: result.reasoning.length,
          },
          "summarizer returned empty content; retrying with a doubled budget",
        );
        result = await ask(MAX_TOKENS * 2, "low");
        content = result.content.trim();
      }
      if (!content) {
        // `completeOnce` treats empty content as a non-error. Here it is one:
        // an empty narrative would render as a report with nothing to say,
        // which is indistinguishable from a quiet day. Fail so the tile shows
        // its failure state instead — and say WHY, because this string is the
        // whole of what the owner and the next debugger get: the runner puts
        // it verbatim into `trace[n].error` and `ToolRun.error`.
        throw new Error(
          `the model returned an empty summary (model=${model} ` +
            `finish_reason=${result.finishReason ?? "unknown"} ` +
            `reasoning_chars=${result.reasoning.length})`,
        );
      }
      return content;
    },
  };
}
