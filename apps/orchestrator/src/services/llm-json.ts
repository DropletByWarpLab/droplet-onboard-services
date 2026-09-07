/**
 * Recover one JSON object from a model's prose reply.
 *
 * Moved here from `email-analysis.service.ts` (WARP-466) so ADR-048's filing
 * extractor and the email triage share ONE parser rather than growing a second
 * one that drifts. It had no test of its own there — it was module-private and
 * only reachable through `createEmailAnalysisFn`; it has one now
 * (`filing-phi-screen.test.ts`).
 *
 * The balanced walk is not decoration. "First `{` to last `}`" breaks the
 * moment the prose around the object contains a brace of its own ("the field
 * {foo} means..."), which small instruction-tuned models do constantly.
 *
 * WHY THIS EXISTS AT ALL: there is no structured-output mode on this box. The
 * orchestrator `ChatRequest` has no `response_format`, ai-gateway's pydantic
 * `ChatRequest` declares only model/messages/stream/temperature/max_tokens/
 * provider/tools/reasoning_effort, and `ollama_local.py` forwards only a subset
 * of those. So JSON is prompt-requested and recovered here, then validated by a
 * zod schema — the parse is not the contract, the schema is.
 *
 * 🔴 CALLERS MUST NOT COPY `email-analysis`'s POSTURE, only its parser. That
 * service swallows any failure into a DEFAULT_ANALYSIS object, which is right
 * for a dashboard panel that must render something and wrong for anything that
 * writes: a default object is a wrong filing. The filing worker marks the row
 * `failed/bad_json` instead.
 */

/**
 * Pull the first balanced `{...}` out of `text`, tolerating a ```json fence.
 *
 * Returns the parsed value, or `null` when there is no recoverable object —
 * never a partial one, and never a thrown error, so the caller decides what a
 * failure means.
 */
export function extractJson(text: string): unknown {
  // Strip ``` ... ``` fences if present (optional `json` tag).
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const haystack = fenced ? fenced[1] : text;

  const start = haystack.indexOf("{");
  if (start === -1) return null;

  // Walk forward with a brace depth counter, honoring string literals
  // so a `}` inside a string doesn't fool us.
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < haystack.length; i++) {
    const ch = haystack[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(haystack.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
