/**
 * WARP-2652 — the guard's own guard.
 *
 * `guardComposerFailOpen()` is the only thing standing between a broken
 * persona/business fixture and a silently green chat-route suite, and it is
 * installed by nineteen files. #1955 found its evidence was erasable: the
 * `afterEach` read `spy.mock.calls`, and `vi.clearAllMocks()` empties exactly
 * that. `llm-chat.streaming-reasoning-leak.test.ts:297` calls it MID-TEST,
 * after a full chat turn has already run — so a composer regression firing on
 * that turn was wiped before the guard could see it, and the case ran
 * unguarded inside the sweep meant to make that impossible.
 *
 * These two cases pin the property helper-side, where it protects every
 * present and future caller rather than one file's hook ordering.
 * `degradations()` and the fail-open filter read the SAME record, so proving
 * one survives proves both.
 */
import { describe, expect, it, vi } from "vitest";
import { guardComposerFailOpen } from "./prompt-block-fixtures.js";

const composers = guardComposerFailOpen();

/** The degradation warn exactly as `routes/llm.ts:1838` emits it. */
function emitDegradation(block: string): void {
  // eslint-disable-next-line no-console
  console.warn("[llm/chat] context-budget degradation", {
    block,
    estimatedTokens: 15_954,
    thresholdTokens: 15_360,
    conversationId: null,
    role: "owner",
  });
}

describe("guardComposerFailOpen — evidence that outlives vi.clearAllMocks()", () => {
  it("keeps what a mid-test clearAllMocks erased from the spy's own history", () => {
    emitDegradation("business");
    expect(composers.degradations().map((d) => d.block)).toEqual(["business"]);

    vi.clearAllMocks();

    // The spy's history IS gone — that is what `clearAllMocks` does, and it is
    // precisely why the guard must not use it as its evidence.
    const spy = console.warn as unknown as { mock: { calls: unknown[][] } };
    expect(spy.mock.calls).toEqual([]);

    // The guard's record is not.
    expect(composers.degradations().map((d) => d.block)).toEqual(["business"]);

    // …and it keeps recording afterwards, so a turn driven after the clear is
    // observed too.
    emitDegradation("persona");
    expect(composers.degradations().map((d) => d.block)).toEqual([
      "business",
      "persona",
    ]);
  });

  it("starts every test from an empty record", () => {
    // Per-test isolation, the other half of the contract: the case above
    // emitted two degradations and none of them leak into this one.
    expect(composers.degradations()).toEqual([]);
  });
});
