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

import { completeOnce } from "./llm-complete.service.js";
import type { RunStepTrace, Summarizer } from "./tool-spec-runner.service.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("tool-spec-summarizer");

/**
 * Prose, not JSON — so the ceiling is generous enough for five short
 * paragraphs without inviting an essay. The brief caps the tile at 2–5.
 */
const MAX_TOKENS = 700;

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

function renderFact(t: RunStepTrace): string {
  if (!t.ok) {
    // Failures are facts too, and the ones most worth saying out loud. A
    // narrative that silently omits the step that failed is exactly the
    // dishonesty this surface is built against.
    return `- ${t.tool}: COULD NOT BE READ (${t.error ?? "unknown error"})`;
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
  "- If a result says it could not be read, say so plainly in one clause.",
  "  Do not omit it and do not guess what it would have said.",
  "- Write prose. No bullet points, no headings, no markdown.",
  "- Second person, plain language, no exclamation marks.",
  "- If there is nothing of note, say that briefly rather than padding.",
].join("\n");

export function createToolSpecSummarizer(): Summarizer {
  return {
    async summarize(prompt: string, facts: RunStepTrace[]): Promise<string> {
      const model =
        process.env.DEFAULT_MODEL ?? process.env.LLM_MODEL ?? "mistral:7b-instruct";

      const result = await completeOnce({
        system: SYSTEM,
        text: `${prompt}\n\nResults:\n${renderFacts(facts)}`,
        model,
        temperature: TEMPERATURE,
        maxTokens: MAX_TOKENS,
      });

      const content = result.content.trim();
      if (!content) {
        // `completeOnce` treats empty content as a non-error. Here it is one:
        // an empty narrative would render as a report with nothing to say,
        // which is indistinguishable from a quiet day. Fail so the tile shows
        // its failure state instead.
        logger.warn({ model, factCount: facts.length }, "summarizer returned empty content");
        throw new Error("the model returned an empty summary");
      }
      return content;
    },
  };
}
