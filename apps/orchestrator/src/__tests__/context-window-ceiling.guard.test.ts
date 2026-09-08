/**
 * WARP-2851 — the ceiling on a resolved context window is DERIVED from the
 * ai-gateway's own limit, and this guard is what keeps the derivation true.
 *
 * `MAX_RESOLVABLE_CONTEXT_WINDOW` exists because a model's advertised window
 * is not the binding constraint on this box: every chat request goes through
 * the ai-gateway, which refuses more than `_MAX_TOTAL_CONTENT_CHARS` of
 * message content (`_validate_total_content` → FastAPI 422). Budget a
 * 200,000-token model at 200,000 and the in-loop guard — which would otherwise
 * have said "answer now from what you have" — never fires, so the turn dies at
 * the gateway instead of degrading.
 *
 * That makes the Python constant load-bearing for a TypeScript budget. It is
 * restated in `context-budget.service.ts` because the two languages cannot
 * share a literal, so this guard READS the Python file rather than trusting
 * the restatement. A drift here is silent in every other suite.
 */
import { describe, it, expect } from "vitest";
import { readRepoFile } from "./helpers/test-paths.js";
import {
  GATEWAY_MAX_TOTAL_CONTENT_CHARS,
  MAX_RESOLVABLE_CONTEXT_WINDOW,
  estimateTokensFromChars,
} from "../services/context-budget.service.js";
import {
  OUTPUT_RESERVE,
  ITERATION_MIN_HEADROOM,
} from "../services/prompt-budget.consts.js";

const SCHEMAS_PY = "services/ai-gateway/schemas.py";

/** `_MAX_TOTAL_CONTENT_CHARS = 128_000` — underscores are legal in Python
 *  int literals, so the pattern has to tolerate them. */
function parseGatewayContentCap(source: string): number | null {
  const m = source.match(/^_MAX_TOTAL_CONTENT_CHARS\s*=\s*([0-9_]+)/m);
  if (!m) return null;
  return Number(m[1]!.replace(/_/g, ""));
}

describe("WARP-2851 — the gateway content cap this ceiling is derived from", () => {
  it("still parses out of schemas.py (vacuity check for the assertions below)", () => {
    // A guard that reads a file it cannot find passes vacuously. Prove the
    // read works and the pattern matches BEFORE asserting anything with it.
    const source = readRepoFile(SCHEMAS_PY);
    expect(source.length).toBeGreaterThan(0);
    expect(source).toContain("_validate_total_content");
    expect(parseGatewayContentCap(source)).not.toBeNull();
  });

  it("rejects a source that does not carry the constant (the parser can fail)", () => {
    // Keeps the vacuity check above honest: a parser that returns a number for
    // anything would make every assertion here meaningless.
    expect(parseGatewayContentCap("nothing to see")).toBeNull();
  });

  it("matches the literal restated in context-budget.service.ts", () => {
    const fromPython = parseGatewayContentCap(readRepoFile(SCHEMAS_PY));
    expect(fromPython).toBe(GATEWAY_MAX_TOTAL_CONTENT_CHARS);
  });

  it("derives the ceiling so the in-loop guard fires no later than the gateway refuses", () => {
    // The loop trips at `window − OUTPUT_RESERVE − ITERATION_MIN_HEADROOM`
    // tokens of transcript. At the ceiling that must land at or below the
    // token-equivalent of the gateway's char cap, or the graceful stop is
    // unreachable and a long turn 422s instead.
    const guardTripsAt =
      MAX_RESOLVABLE_CONTEXT_WINDOW - OUTPUT_RESERVE - ITERATION_MIN_HEADROOM;
    const gatewayRefusesAt = estimateTokensFromChars(
      GATEWAY_MAX_TOTAL_CONTENT_CHARS,
    );

    expect(guardTripsAt).toBeLessThanOrEqual(gatewayRefusesAt);
    // And not needlessly conservative — the whole point is to unlock headroom.
    expect(guardTripsAt).toBe(gatewayRefusesAt);
  });

  it("is well above the local default, so a cloud turn actually gains room", () => {
    // If the ceiling ever collapsed to the local window this change would be a
    // no-op that still looked implemented.
    expect(MAX_RESOLVABLE_CONTEXT_WINDOW).toBeGreaterThan(16384);
  });
});
