/**
 * WARP-3125 — a service caller's explicit tool set is advertised as sent.
 *
 * Voice-io sends a curated `allowed_tools` (17 tools) on every tool turn. The
 * route used to run keyword selection over it as well, so the advertised
 * `tools[]` changed with every sentence. llama-server only reuses the KV cache
 * for the prompt prefix that is byte-identical to the previous request, so a
 * per-sentence tool block meant re-prefilling the whole tool block every
 * turn. It also dropped tools the sentence needed ("is everything working?"
 * matched no rule, so `get_system_health` was not advertised), and each miss
 * cost one of voice's two iterations to the self-heal.
 *
 * `explicit` is the per-turn mode for that caller: no keyword re-selection,
 * the tool budget is still asserted. These tests pin the pure half. The route
 * and agent-loop halves are pinned in `llm-chat.voice-cache-stable.test.ts`
 * and `llm-agent.explicit-tool-set.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { TOOLS } from "@droplet/tools-core";
import {
  effectiveAdvertisedToolNames,
  resolveTurnToolSelectionMode,
  selectionAssertsToolBudget,
} from "./tool-selection.service.js";
import {
  measureToolSpecs,
  toAdvertisedSpec,
  toolAdvertisementCeilingTokens,
} from "./tool-budget.service.js";
import { DEFAULT_CONTEXT_WINDOW } from "./context-budget.service.js";
import { readPackageFile } from "../__tests__/helpers/test-paths.js";
import { voiceDefaultAllowedTools } from "../__tests__/helpers/voice-allowed-tools.js";

// The list voice actually sends, read from voice-io's source.
const VOICE_POOL = voiceDefaultAllowedTools();

const turn = (content: string) => [{ role: "user", content }];

describe("voice's default tool set under `explicit`", () => {
  it("is read from voice-io and names only real catalog tools", () => {
    // A name that is not in the registry would be filtered out of the pool
    // without a word, and the budget check below would measure less than
    // voice asks for.
    expect(VOICE_POOL.length).toBeGreaterThan(0);
    expect(VOICE_POOL.filter((name) => !TOOLS.has(name))).toEqual([]);
    expect(VOICE_POOL).toContain("get_system_health");
  });

  it("fits the tool budget at the shipping context window", () => {
    // `explicit` advertises the whole set on every voice tool turn and still
    // runs `assertToolAdvertisementFitsBudget`. A set that outgrew the ceiling
    // would fail every voice tool turn with TOOL_BUDGET_EXCEEDED, so the
    // headroom is pinned here rather than assumed. The figures are printed so
    // the PR can quote the number at this SHA.
    const specs = VOICE_POOL.map((name) => toAdvertisedSpec(TOOLS.get(name)!));
    const size = measureToolSpecs(specs);
    const ceiling = toolAdvertisementCeilingTokens({
      contextWindow: DEFAULT_CONTEXT_WINDOW,
    });
    // eslint-disable-next-line no-console
    console.log(
      `[WARP-3125] voice explicit set: ${size.count} tools, ${size.chars} chars, ` +
        `~${size.tokens} tokens; ceiling ${ceiling} tokens at a ${DEFAULT_CONTEXT_WINDOW} window`,
    );
    expect(size.count).toBe(VOICE_POOL.length);
    expect(size.tokens).toBeLessThanOrEqual(ceiling);
  });
});

describe("effectiveAdvertisedToolNames under `explicit`", () => {
  it("returns the whole pool whatever the sentence says", () => {
    // Mutation: route `explicit` through the keyword rules → the health
    // question loses get_system_health again and this goes red.
    const health = effectiveAdvertisedToolNames({
      mode: "explicit",
      messages: turn("is everything working?"),
      pool: VOICE_POOL,
    });
    expect([...health]).toEqual(VOICE_POOL);
    expect(health.has("get_system_health")).toBe(true);
  });

  it("two different sentences advertise the identical set, in pool order", () => {
    const a = effectiveAdvertisedToolNames({
      mode: "explicit",
      messages: turn("is everything working?"),
      pool: VOICE_POOL,
    });
    const b = effectiveAdvertisedToolNames({
      mode: "explicit",
      messages: turn("is the front camera online?"),
      pool: VOICE_POOL,
    });
    expect([...a]).toEqual([...b]);
  });

  it("is the defect `domains` still has for the same two sentences", () => {
    // The contrast that makes the tests above mean something: under keyword
    // selection the two sentences get different sets, and the health question
    // is not given the health tool.
    const a = effectiveAdvertisedToolNames({
      mode: "domains",
      messages: turn("is everything working?"),
      pool: VOICE_POOL,
    });
    const b = effectiveAdvertisedToolNames({
      mode: "domains",
      messages: turn("is the front camera online?"),
      pool: VOICE_POOL,
    });
    expect([...a]).not.toEqual([...b]);
    expect(a.has("get_system_health")).toBe(false);
  });

  it("never widens the pool", () => {
    // The invariant every mode keeps: RBAC decided the pool before this ran.
    const narrowed = VOICE_POOL.filter((n) => n !== "control_device");
    const out = effectiveAdvertisedToolNames({
      mode: "explicit",
      messages: turn("turn off the kitchen lights"),
      pool: narrowed,
    });
    expect(out.has("control_device")).toBe(false);
  });
});

describe("resolveTurnToolSelectionMode", () => {
  it("a service principal with an explicit list gets `explicit`", () => {
    expect(
      resolveTurnToolSelectionMode({
        configured: "domains",
        callerSuppliedAllowedTools: true,
        servicePrincipal: true,
      }),
    ).toBe("explicit");
  });

  it("a person with an explicit list keeps keyword selection", () => {
    // Scoped to service principals on purpose: a dashboard caller's list is a
    // request, and the route's answer for it is unchanged.
    expect(
      resolveTurnToolSelectionMode({
        configured: "domains",
        callerSuppliedAllowedTools: true,
        servicePrincipal: false,
      }),
    ).toBe("domains");
  });

  it("a service principal with NO list keeps keyword selection", () => {
    // Without a list the pool is the whole chat scope, which does not fit the
    // window unselected. Only a caller that named its set may skip selection.
    expect(
      resolveTurnToolSelectionMode({
        configured: "domains",
        callerSuppliedAllowedTools: false,
        servicePrincipal: true,
      }),
    ).toBe("domains");
  });

  it("the operator's `off` stays `off` for every caller", () => {
    // TOOL_SELECTION_MODE=off is the documented rollback lever. It must not be
    // turned into a mode that asserts the budget.
    for (const servicePrincipal of [true, false]) {
      for (const callerSuppliedAllowedTools of [true, false]) {
        expect(
          resolveTurnToolSelectionMode({
            configured: "off",
            callerSuppliedAllowedTools,
            servicePrincipal,
          }),
        ).toBe("off");
      }
    }
  });
});

describe("agent and durable runs keep the configured mode", () => {
  // The run worker calls runAgent directly with `runToolPool()`, which is
  // roughly the whole chat pool, and relies on keyword selection to fit the
  // budget. `explicit` there would advertise the whole pool and fail the
  // budget assert on every run. The worker's behaviour is pinned by its own
  // suites (agent-run-worker.workshop.test.ts runs under `domains`); this
  // pins the wiring those suites cannot see: the worker never resolves a
  // per-turn mode and never names `explicit`.
  const WORKER_SRC = readPackageFile("src", "services/agent-run-worker.service.ts");

  it("reads the configured mode and passes it straight to runAgent", () => {
    expect(WORKER_SRC).toContain(
      "const toolSelectionMode = deps.toolSelectionMode ?? config.TOOL_SELECTION_MODE;",
    );
    expect(WORKER_SRC).toContain("tool_selection_mode: toolSelectionMode,");
    expect(WORKER_SRC).toContain('toolSelectionMode?: "off" | "domains";');
  });

  it("never opts into the chat route's per-turn mode", () => {
    expect(WORKER_SRC).not.toContain("resolveTurnToolSelectionMode");
    expect(WORKER_SRC).not.toMatch(/["']explicit["']/);
  });
});

describe("selectionAssertsToolBudget", () => {
  it("`domains` and `explicit` assert the budget; `off` and unset do not", () => {
    // Mutation: gate the assert on `=== "domains"` again → an explicit set
    // that outgrew the window would reach the wire unmeasured.
    expect(selectionAssertsToolBudget("domains")).toBe(true);
    expect(selectionAssertsToolBudget("explicit")).toBe(true);
    expect(selectionAssertsToolBudget("off")).toBe(false);
    expect(selectionAssertsToolBudget(undefined)).toBe(false);
  });
});
