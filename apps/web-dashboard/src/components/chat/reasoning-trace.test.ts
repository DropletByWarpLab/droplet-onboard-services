/**
 * WARP-1605 — the flattened-trace codec.
 *
 * `ChatMessage.reasoning` is one string carrying a LIST of agent steps. These
 * tests pin the two invariants the rendering depends on:
 *
 *   1. splitting is total and lossless for every shape we can receive —
 *      including the pre-WARP-1602 shapes, which must come back as a single
 *      step whose text is unchanged;
 *   2. the live append reproduces the orchestrator's own flattening
 *      (`\n\n` within an agent iteration, the sentinel between iterations),
 *      so a streamed turn and the same turn after reload are byte-identical.
 */
import { describe, it, expect } from "vitest";
import {
  REASONING_STEP_SEPARATOR,
  appendReasoningStep,
  splitReasoningSteps,
} from "./reasoning-trace";

describe("splitReasoningSteps", () => {
  it("returns [] for absent / blank traces", () => {
    expect(splitReasoningSteps(undefined)).toEqual([]);
    expect(splitReasoningSteps(null)).toEqual([]);
    expect(splitReasoningSteps("")).toEqual([]);
    expect(splitReasoningSteps("   \n  ")).toEqual([]);
  });

  it("returns a single unchanged step for a trace with no sentinel", () => {
    // Every pre-WARP-1602 row, and every single-iteration turn today.
    const legacy = "I check the docs.\n\nThen I compare options.";
    expect(splitReasoningSteps(legacy)).toEqual([legacy]);
  });

  it("recovers one entry per agent step", () => {
    const trace = [
      "We need the invoice folder.",
      "Now summarise what came back.",
    ].join(REASONING_STEP_SEPARATOR);
    expect(splitReasoningSteps(trace)).toEqual([
      "We need the invoice folder.",
      "Now summarise what came back.",
    ]);
  });

  it("keeps the \\n\\n paragraph structure WITHIN a step", () => {
    const trace = `a1\n\na2${REASONING_STEP_SEPARATOR}b1`;
    expect(splitReasoningSteps(trace)).toEqual(["a1\n\na2", "b1"]);
  });

  it("drops empty fragments so a trailing sentinel yields no blank block", () => {
    // A turn whose last iteration ended on a tool call with no more thinking.
    expect(splitReasoningSteps(`only${REASONING_STEP_SEPARATOR}`)).toEqual([
      "only",
    ]);
    expect(
      splitReasoningSteps(
        `a${REASONING_STEP_SEPARATOR}   ${REASONING_STEP_SEPARATOR}b`,
      ),
    ).toEqual(["a", "b"]);
  });
});

describe("appendReasoningStep", () => {
  it("seeds the trace with the first step", () => {
    expect(appendReasoningStep(undefined, "first", false)).toBe("first");
  });

  it("joins events belonging to the SAME iteration with \\n\\n", () => {
    // Matches the orchestrator's `stepParts.join("\n\n")`.
    const one = appendReasoningStep(undefined, "part a", false);
    expect(appendReasoningStep(one, "part b", true)).toBe("part a\n\npart b");
  });

  it("separates iterations with the step sentinel", () => {
    const one = appendReasoningStep(undefined, "step 1", false);
    // stepOpen=false — a tool_call closed the iteration.
    const two = appendReasoningStep(one, "step 2", false);
    expect(two).toBe(`step 1${REASONING_STEP_SEPARATOR}step 2`);
    expect(splitReasoningSteps(two)).toEqual(["step 1", "step 2"]);
  });

  it("round-trips a mixed multi-part, multi-step turn", () => {
    let t = appendReasoningStep(undefined, "a1", false);
    t = appendReasoningStep(t, "a2", true); // same iteration
    t = appendReasoningStep(t, "b1", false); // after a tool_call
    expect(splitReasoningSteps(t)).toEqual(["a1\n\na2", "b1"]);
  });
});
