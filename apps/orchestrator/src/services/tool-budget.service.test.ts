/**
 * WARP-2440 — the measurement, as a repeatable test rather than a note.
 * WARP-2445 — the loud-overflow contract.
 *
 * NO COUNT IS HARD-CODED HERE, on purpose. The registry grew by three tools in
 * the 54 commits between WARP-2348 being researched (134) and being picked up
 * (137), and `chat-tool-scope.ts` carried a stale "~85K chars (~21K tokens)"
 * for longer than that. Every figure below is re-derived from the live
 * registry on each run and PRINTED, so the number in the PR is the number at
 * that SHA and the next reader re-derives rather than trusts.
 *
 * The assertions are therefore about RELATIONSHIPS that must hold at any
 * count — "the full registry does not fit the window", "adding a remote
 * catalog makes it strictly worse" — not about literals that rot.
 */
// add-llm-tool:gate — WARP-2496 / WARP-2612: this test asserts on a site an
// agent edits when ADDING a tool, so the `add-llm-tool` skill must name every
// repo file it reads. Drop the pragma and it stops being derived from.

import { describe, it, expect, vi } from "vitest";
import { TOOLS, TOOL_CATALOG } from "@droplet/tools-core";
import {
  measureToolSpecs,
  toAdvertisedSpec,
  toolAdvertisementCeilingTokens,
  assertToolAdvertisementFitsBudget,
  ToolBudgetExceededError,
  serializeToolSpecs,
  toolSpecSizes,
  FIXED_SYSTEM_BLOCK_CHARS,
  type AdvertisedToolSpec,
} from "./tool-budget.service.js";
import {
  DEFAULT_CONTEXT_WINDOW,
  estimateTokensFromChars,
} from "./context-budget.service.js";
import { OUTPUT_RESERVE } from "./prompt-budget.consts.js";
import {
  ATLASSIAN_REMOTE_TOOLS,
  SLACK_REMOTE_TOOLS,
  ALL_REMOTE_TOOLS,
} from "./__fixtures__/remote-tool-catalog.js";

const localSpecs = (): AdvertisedToolSpec[] =>
  Array.from(TOOLS.values()).map(toAdvertisedSpec);

const remoteSpecs = (
  tools: readonly { name: string; description: string; inputSchema: unknown }[],
): AdvertisedToolSpec[] => tools.map(toAdvertisedSpec);

describe("WARP-2440 — measured serialisation sizes", () => {
  it("records the real numbers for the local registry and for local + remote catalogs", () => {
    const local = measureToolSpecs(localSpecs());
    const atlassian = measureToolSpecs(remoteSpecs(ATLASSIAN_REMOTE_TOOLS));
    const slack = measureToolSpecs(remoteSpecs(SLACK_REMOTE_TOOLS));
    const localPlusAtlassian = measureToolSpecs([
      ...localSpecs(),
      ...remoteSpecs(ATLASSIAN_REMOTE_TOOLS),
    ]);
    const localPlusAll = measureToolSpecs([
      ...localSpecs(),
      ...remoteSpecs(ALL_REMOTE_TOOLS),
    ]);

    // The window is the READ value of OLLAMA_CONTEXT_LENGTH (config.ts
    // default 16384, docker-compose.yml:225). Never inferred from the
    // variable's NAME: boxes provisioned after 2026-08-11 run Docker Model
    // Runner on :12434 (ADR-036 / WARP-1870) and carry the window in that
    // same variable.
    const effectiveWindow = DEFAULT_CONTEXT_WINDOW - OUTPUT_RESERVE;
    const ceiling = toolAdvertisementCeilingTokens();

    const row = (label: string, m: { count: number; chars: number; tokens: number }) =>
      `  ${label.padEnd(34)} ${String(m.count).padStart(4)} tools  ` +
      `${String(m.chars).padStart(7)} chars  ${String(m.tokens).padStart(6)} tokens  ` +
      `${((m.tokens / ceiling) * 100).toFixed(0).padStart(4)}% of tools[] ceiling`;

    // eslint-disable-next-line no-console
    console.log(
      [
        "",
        "WARP-2440 measured serialisation (re-derived at this SHA):",
        `  context window (OLLAMA_CONTEXT_LENGTH) = ${DEFAULT_CONTEXT_WINDOW} tokens`,
        `  output reserve                         = ${OUTPUT_RESERVE} tokens`,
        `  effective window                       = ${effectiveWindow} tokens`,
        `  fixed system blocks                    = ${FIXED_SYSTEM_BLOCK_CHARS} chars ` +
          `(${estimateTokensFromChars(FIXED_SYSTEM_BLOCK_CHARS)} tokens)`,
        `  => tools[] ceiling                     = ${ceiling} tokens`,
        "",
        row("local registry (full)", local),
        row("atlassian remote catalog", atlassian),
        row("slack remote catalog", slack),
        row("local + atlassian", localPlusAtlassian),
        row("local + atlassian + slack", localPlusAll),
        "",
        `  mean local tool = ${Math.round(local.chars / local.count)} chars`,
        `  mean remote tool = ${Math.round(
          (atlassian.chars + slack.chars) / (atlassian.count + slack.count),
        )} chars`,
        "",
      ].join("\n"),
    );

    // The load-bearing claim from chat-tool-scope.ts, re-proven rather than
    // quoted: the full registry does not fit the window AT ALL — not "is
    // tight". Mutation: shrink the registry below the window and this goes
    // red, which is the correct signal that the premise changed.
    expect(local.tokens).toBeGreaterThan(effectiveWindow);

    // ...and it is not merely over the ceiling, it is over the WHOLE window
    // with nothing else in it.
    expect(local.tokens).toBeGreaterThan(ceiling);

    // Adding a remote catalog is strictly worse. This is the sentence the
    // whole story rests on ("more surface, less capability"), asserted.
    expect(localPlusAtlassian.tokens).toBeGreaterThan(local.tokens);
    expect(localPlusAll.tokens).toBeGreaterThan(localPlusAtlassian.tokens);

    // Non-vacuity: the fixtures are the sizes the story names (~50 / ~15), so
    // an accidentally-empty fixture cannot make the comparisons trivially
    // true. Asserted against the fixture's own length, never a literal count
    // of the LOCAL registry.
    expect(atlassian.count).toBe(ATLASSIAN_REMOTE_TOOLS.length);
    expect(atlassian.count).toBeGreaterThanOrEqual(50);
    expect(slack.count).toBeGreaterThanOrEqual(15);

    // The registry and the catalog agree on the universe — the completeness
    // invariant catalog.test.ts enforces, restated here because every number
    // above is only meaningful if the two are the same set.
    expect(local.count).toBe(TOOL_CATALOG.length);
  });

  it("derives the tools[] ceiling from the window and the fixed blocks, not a literal", () => {
    // Mutation: replace the derivation with a constant and this goes red for
    // any non-default window.
    expect(toolAdvertisementCeilingTokens({ contextWindow: 16384 })).toBe(
      16384 - OUTPUT_RESERVE - estimateTokensFromChars(FIXED_SYSTEM_BLOCK_CHARS),
    );
    // A bigger window buys exactly the extra tokens, one for one.
    expect(toolAdvertisementCeilingTokens({ contextWindow: 32768 })).toBe(
      toolAdvertisementCeilingTokens({ contextWindow: 16384 }) + 16384,
    );
    // Never negative — a tiny window yields a zero ceiling, so every
    // advertisement fails loudly rather than the ceiling going negative and
    // silently accepting everything.
    expect(toolAdvertisementCeilingTokens({ contextWindow: 100 })).toBe(0);
  });

  it("serializes to exactly what the agent loop puts on the wire", () => {
    const specs = localSpecs().slice(0, 3);
    expect(serializeToolSpecs(specs)).toBe(JSON.stringify(specs));
    expect(measureToolSpecs(specs).chars).toBe(JSON.stringify(specs).length);
  });
});

describe("WARP-2445 — over-budget fails loudly, never truncates", () => {
  it("returns the measured size when the advertisement fits", () => {
    const specs = localSpecs().slice(0, 5);
    const size = assertToolAdvertisementFitsBudget({ specs });
    expect(size.count).toBe(5);
    expect(size.chars).toBeGreaterThan(0);
  });

  it("throws a typed failure — and does NOT return a shortened advertisement", () => {
    // The whole local registry cannot fit; that is the story's premise.
    const specs = localSpecs();
    let thrown: unknown;
    try {
      assertToolAdvertisementFitsBudget({ specs });
    } catch (e) {
      thrown = e;
    }

    // MUTATION: replace the `throw` in assertToolAdvertisementFitsBudget with
    // a truncating `return specs.slice(0, n)` and this goes red — nothing is
    // thrown, so `thrown` stays undefined. Silent truncation is the single
    // outcome this subtask exists to prevent.
    expect(thrown).toBeInstanceOf(ToolBudgetExceededError);
    const err = thrown as ToolBudgetExceededError;

    expect(err.code).toBe("TOOL_BUDGET_EXCEEDED");
    // The failure names how far over budget it was (WARP-2445 AC).
    expect(err.overageTokens).toBeGreaterThan(0);
    expect(err.overageTokens).toBe(err.tokens - err.ceilingTokens);
    expect(err.toolCount).toBe(specs.length);
    expect(err.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
    // ...and names the tools worth trimming, largest first.
    expect(err.largestTools.length).toBeGreaterThan(0);
    expect(err.largestTools[0].chars).toBeGreaterThanOrEqual(
      err.largestTools[err.largestTools.length - 1].chars,
    );
    // One log line carries the diagnosis: the message itself is complete.
    expect(err.message).toContain("tokens over budget");
    expect(err.message).toContain(String(err.overageTokens));
  });

  it("logs the overage at error level with the offending selection size", () => {
    // Assert on the CALL made (house pattern) — a failure nobody can see in
    // logs is only half a loud failure, and "visible in logs" is an explicit
    // WARP-2445 acceptance criterion.
    const specs = localSpecs();
    const errorLog = vi.fn();

    expect(() =>
      assertToolAdvertisementFitsBudget({
        specs,
        errorLog,
        logContext: { conversationId: "conv-1", mode: "domains" },
      }),
    ).toThrow(ToolBudgetExceededError);

    // MUTATION: delete the `emit(...)` call and this goes red — the throw
    // still happens, but the operator never learns it did.
    expect(errorLog).toHaveBeenCalledTimes(1);
    const [fields, msg] = errorLog.mock.calls[0];
    expect(msg).toBe("tool_budget_exceeded");
    expect(fields.overageTokens).toBeGreaterThan(0);
    expect(fields.toolCount).toBe(specs.length);
    expect(fields.ceilingTokens).toBe(toolAdvertisementCeilingTokens());
    expect(fields.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
    // Caller context is carried through, so the line is attributable.
    expect(fields.conversationId).toBe("conv-1");
    expect(fields.mode).toBe("domains");
    // Names names, so the cause is actionable from the one line.
    expect(Array.isArray(fields.largestTools)).toBe(true);
  });

  it("does not log when the advertisement fits", () => {
    const errorLog = vi.fn();
    assertToolAdvertisementFitsBudget({
      specs: localSpecs().slice(0, 5),
      errorLog,
    });
    // The budget guard is a promise about a log line that must NOT happen on
    // the happy path as much as one that must happen on the sad path.
    expect(errorLog).not.toHaveBeenCalled();
  });

  it("a well-behaved selected turn fits, so the gate is not trivially always-red", () => {
    // Non-vacuity for the whole suite: if the ceiling were mis-derived so that
    // NOTHING ever fits, the assertions above would pass while the feature was
    // broken. A realistic per-turn selection must pass cleanly.
    const smallTurn = localSpecs().slice(0, 12);
    expect(() =>
      assertToolAdvertisementFitsBudget({ specs: smallTurn }),
    ).not.toThrow();
  });

  it("respects a caller-supplied window — a larger box accepts a larger advertisement", () => {
    const specs = localSpecs();
    // Fails at the shipping window...
    expect(() => assertToolAdvertisementFitsBudget({ specs })).toThrow(
      ToolBudgetExceededError,
    );
    // ...and passes at a window big enough to hold it, proving the gate reads
    // the window rather than a baked-in 16384.
    const need = measureToolSpecs(specs).tokens;
    expect(() =>
      assertToolAdvertisementFitsBudget({
        specs,
        contextWindow:
          need + OUTPUT_RESERVE + estimateTokensFromChars(FIXED_SYSTEM_BLOCK_CHARS),
      }),
    ).not.toThrow();
  });

  it("toolSpecSizes names tools largest-first", () => {
    const sizes = toolSpecSizes(localSpecs());
    expect(sizes.length).toBe(TOOLS.size);
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i - 1].chars).toBeGreaterThanOrEqual(sizes[i].chars);
    }
  });
});

describe("FIXED_SYSTEM_BLOCK_CHARS", () => {
  it("is composed from the shipping constants, so it cannot drift from them", () => {
    // Mutation: change any block cap in prompt-budget.consts.ts and this
    // number moves with it; base-prompt-budget.test.ts pins the total.
    expect(FIXED_SYSTEM_BLOCK_CHARS).toBe(11800);
  });
});
