/**
 * WARP-2851 — the ceiling on a resolved context window is DERIVED from the
 * ai-gateway's own limit, and this guard is what keeps the derivation true.
 *
 * `MAX_RESOLVABLE_CONTEXT_WINDOW` exists because a model's advertised window
 * is not the binding constraint on this box: every chat request goes through
 * the ai-gateway, which refuses more than `_MAX_TOTAL_CONTENT_CHARS` of
 * message content (`_validate_total_content` → FastAPI 422). Budget a
 * 200,000-token model at 200,000 and neither budget gate ever fires, so the
 * turn dies at the gateway instead of degrading.
 *
 * That makes the Python constant load-bearing for a TypeScript budget. It is
 * restated in `context-budget.service.ts` because the two languages cannot
 * share a literal, so this guard READS the Python file rather than trusting
 * the restatement. A drift here is silent in every other suite.
 *
 * THE DERIVATION IS AGAINST `degradeToFit`, NOT THE IN-LOOP GUARD. Two gates
 * budget a turn and they use different formulas; only `degradeToFit` runs
 * before the turn's FIRST completion call (the loop's guard is gated
 * `iter > 0`). Deriving the ceiling from the loop's laxer formula — as this
 * guard originally did — leaves a band of requests that pass degradation
 * UN-degraded and then 422 on that first call. So this file asserts BOTH
 * halves: the arithmetic, and `degradeToFit`'s actual behaviour at the
 * ceiling.
 */
import { describe, it, expect } from "vitest";
import { readRepoFile } from "./helpers/test-paths.js";
import {
  DEFAULT_CONTEXT_WINDOW,
  GATEWAY_MAX_TOTAL_CONTENT_CHARS,
  MAX_RESOLVABLE_CONTEXT_WINDOW,
  degradeToFit,
  estimateTokensFromChars,
  type RequestSizeParts,
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

  it("derives the ceiling so degradeToFit's OWN threshold lands where the gateway refuses", () => {
    // THE BINDING CHECK. `degradeToFit` is the only budget gate the turn's
    // FIRST completion call passes through — the in-loop guard below is gated
    // `iter > 0` (llm-agent.service.ts), so it cannot see iteration 0 at all.
    // The ceiling therefore has to be derived against THIS formula
    // (context-budget.service.ts: `contextWindow − OUTPUT_RESERVE`), not the
    // loop's. Derive it against the loop's laxer-by-ITERATION_MIN_HEADROOM
    // formula instead and a request can pass degradation UN-degraded at
    // ITERATION_MIN_HEADROOM tokens past the gateway's cap, then 422 on the
    // turn's very first call — with nothing downstream to catch it, because
    // `historyTrimNeeded` has no reader (see its docstring).
    const degradeTripsAt = MAX_RESOLVABLE_CONTEXT_WINDOW - OUTPUT_RESERVE;
    const gatewayRefusesAt = estimateTokensFromChars(
      GATEWAY_MAX_TOTAL_CONTENT_CHARS,
    );

    expect(degradeTripsAt).toBeLessThanOrEqual(gatewayRefusesAt);
    // And not needlessly conservative — the whole point is to unlock headroom.
    expect(degradeTripsAt).toBe(gatewayRefusesAt);
  });

  it("leaves the in-loop guard's headroom as ADDITIVE margin, not shared slack", () => {
    // The loop trips at `window − OUTPUT_RESERVE − ITERATION_MIN_HEADROOM`
    // tokens of transcript. Now that the ceiling is sized against
    // `degradeToFit`, that lands one whole ITERATION_MIN_HEADROOM BELOW the
    // gateway's cap rather than exactly on it — deliberately. The two gates
    // no longer share one safety margin, so neither can spend the other's.
    const guardTripsAt =
      MAX_RESOLVABLE_CONTEXT_WINDOW - OUTPUT_RESERVE - ITERATION_MIN_HEADROOM;
    const gatewayRefusesAt = estimateTokensFromChars(
      GATEWAY_MAX_TOTAL_CONTENT_CHARS,
    );

    expect(guardTripsAt).toBeLessThan(gatewayRefusesAt);
    expect(gatewayRefusesAt - guardTripsAt).toBe(ITERATION_MIN_HEADROOM);
  });

  it("is well above the local default, so a cloud turn actually gains room", () => {
    // If the ceiling ever collapsed to the local window this change would be a
    // no-op that still looked implemented.
    expect(MAX_RESOLVABLE_CONTEXT_WINDOW).toBeGreaterThan(16384);
  });

  it("is scheduled to RUN on a PR that touches only the Python file it reads", () => {
    // A cross-language guard is only as good as the CI leg that runs it. This
    // suite lives under `apps/orchestrator/**`, and `ci.yml`'s `detect` job is
    // path-filtered — so a PR that edits nothing but
    // `services/ai-gateway/schemas.py` would run the ai-gateway leg and NOT
    // this one, which is the single PR most able to break the constant this
    // guard protects. Drift would then surface only on some later, unrelated
    // orchestrator PR — i.e. after it had already merged.
    //
    // Same precedent as the `scripts/host/…`, `scripts/image/autoinstall/
    // user-data` and `data/app-downloads/**` entries already in that filter:
    // a file the orchestrator leg ASSERTS ON belongs in the orchestrator
    // leg's filter, wherever in the tree it lives.
    // Line endings normalised first: `.gitattributes` pins `*.yml text eol=lf`
    // today, but a guard that reads source should not be one `.gitattributes`
    // edit away from silently failing to find the block it asserts on.
    const ci = readRepoFile(".github/workflows/ci.yml").split("\r\n").join("\n");
    const start = ci.indexOf("\n            orchestrator:\n");
    const end = ci.indexOf("\n            web-dashboard:\n");
    // Vacuity guard: if `detect`'s filter block is ever re-indented or the
    // group renamed, this must fail loudly rather than pass on an empty slice.
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const orchestratorFilter = ci.slice(start, end);
    expect(orchestratorFilter).toContain('"apps/orchestrator/**"');
    expect(orchestratorFilter).toContain(`"${SCHEMAS_PY}"`);
  });
});

/**
 * The constants above are only half the guard. This half drives the real
 * `degradeToFit` at the real ceiling and asserts the OUTCOME, because a
 * derivation can be right and the function that consumes it still wrong.
 */
describe("WARP-2851 — degradeToFit at the ceiling never passes a request the gateway would refuse", () => {
  const GATEWAY_TOKEN_CAP = estimateTokensFromChars(
    GATEWAY_MAX_TOTAL_CONTENT_CHARS,
  );

  /** Blocks sized at their real WARP-1118 caps, padded with history so the
   *  whole request estimates to exactly `totalTokens`. */
  function partsOfExactly(totalTokens: number): RequestSizeParts {
    const identityBlock = "i".repeat(4000);
    const personaBlock = "p".repeat(1200);
    const businessBlock = "b".repeat(1500);
    const brainBlock = "n".repeat(4000);
    const fixedChars =
      identityBlock.length +
      personaBlock.length +
      businessBlock.length +
      brainBlock.length;
    const historyChars = totalTokens * 4 - fixedChars;
    expect(historyChars).toBeGreaterThan(0);
    return {
      identityBlock,
      personaBlock,
      businessBlock,
      toolGuidance: "",
      memoryFactsBlock: "",
      brainBlock,
      toolSchemasJson: "",
      pinsText: "",
      attachmentsText: "",
      historyText: "h".repeat(historyChars),
    };
  }

  it("builds a fixture whose estimate is exactly the requested size (fixture sanity)", () => {
    // A fixture that silently mis-sizes would make every case below vacuous.
    const parts = partsOfExactly(33_000);
    const untouched = degradeToFit(parts, {
      contextWindow: Number.MAX_SAFE_INTEGER,
    });
    expect(untouched.estimatedTokens).toBe(33_000);
    expect(untouched.dropped).toEqual([]);
  });

  // The band this PR's ceiling made reachable. Before it every turn was
  // budgeted at the local 16,384, where `degradeToFit`'s threshold is 15,360 —
  // so a request this large ALWAYS degraded. 33,536 is the exact top of the
  // band under the original, in-loop-derived ceiling of 34,560.
  for (const totalTokens of [32_001, 33_000, 33_536]) {
    it(`degrades a ${totalTokens}-token request at the ceiling rather than passing it through`, () => {
      const result = degradeToFit(partsOfExactly(totalTokens), {
        contextWindow: MAX_RESOLVABLE_CONTEXT_WINDOW,
      });

      // The invariant that matters: whatever survives degradation is
      // something the ai-gateway will actually accept. `estimateRequestTokens`
      // also counts `toolSchemasJson`, which the gateway does NOT count as
      // message content, so this is conservative in the safe direction.
      expect(result.estimatedTokens).toBeLessThanOrEqual(GATEWAY_TOKEN_CAP);
      // And it got there by DROPPING, not by being flagged — nothing reads
      // `historyTrimNeeded`, so a flag on its own is still a 422.
      expect(result.dropped.length).toBeGreaterThan(0);
      expect(result.historyTrimNeeded).toBe(false);
    });
  }

  it("still leaves a request that already fits completely alone", () => {
    // The ceiling must not turn into blanket degradation: the whole point of
    // WARP-2851 is that a cloud turn gets MORE room, not less.
    const parts = partsOfExactly(20_000);
    const result = degradeToFit(parts, {
      contextWindow: MAX_RESOLVABLE_CONTEXT_WINDOW,
    });
    expect(result.dropped).toEqual([]);
    expect(result.personaBlock).toBe(parts.personaBlock);
    expect(result.businessBlock).toBe(parts.businessBlock);
    expect(result.brainBlock).toBe(parts.brainBlock);
    expect(result.historyTrimNeeded).toBe(false);
  });

  it("does not change what the LOCAL default window degrades (no collateral regression)", () => {
    // The fix moves the ceiling, not `degradeToFit`'s formula — so a
    // local-window turn budgets byte-for-byte as it did before WARP-2851.
    const parts = partsOfExactly(20_000);
    const local = degradeToFit(parts, { contextWindow: DEFAULT_CONTEXT_WINDOW });
    expect(local.dropped).toEqual(["business", "persona", "brain"]);
    expect(local.historyTrimNeeded).toBe(true);
  });
});
