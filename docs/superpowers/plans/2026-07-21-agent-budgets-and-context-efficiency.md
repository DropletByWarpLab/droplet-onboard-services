# Agent Step-Budget & Context-Efficiency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the chat agent loop env-tunable (step limit), self-limiting under context pressure (token guard, repetition stop), and context-efficient (relevance-based tool selection), per the approved spec `docs/superpowers/specs/2026-07-21-agent-budgets-and-context-efficiency-design.md`.

**Architecture:** All agent-loop changes land in `apps/orchestrator/src/services/llm-agent.service.ts` behind existing seams (`AgentRequest` fields, config). Tool selection is a new pure service reusing the tools-core `TOOL_CATALOG` domain taxonomy. No default behavior changes ship in this plan — new knobs default to today's values and `TOOL_SELECTION_MODE` ships `off`; defaults change only after the spec §6 measurement protocol.

**Tech Stack:** TypeScript (orchestrator, Fastify-style routes, zod config), vitest, pnpm workspaces, docker compose, `@droplet/tools-core`.

## Global Constraints

- Work in worktree `.worktrees/agent-budgets-spec`; create branch `feat/agent-budgets-and-context-efficiency` off `docs/agent-budgets-and-context-efficiency-spec` before Task 1.
- No global pnpm on this machine — always `npx -y pnpm@9.15.9 <cmd>`.
- Run orchestrator tests as `cd apps/orchestrator && npx vitest run <file>`.
- No model swap; the One-Model Rule is untouched (spec Non-goals).
- `OUTPUT_RESERVE` stays a constant `1024`, never env-configurable (spec Non-goals).
- Tool selection only ever SUBSETS the role-allowed pool; RBAC (`WRITE_TOOLS`, `narrowAllowedToolsForRole`, `replayedWriteToolAttempt`, interview strip) is untouched (spec §3).
- Selection is deterministic — no embedding calls, no extra LLM calls (spec Non-goals).
- Every new stop reason surfaces in SSE `done` + trace — no silent caps (spec Error handling).
- Shipped defaults unchanged in this plan: `AGENT_MAX_ITER_DEFAULT=5`, `AGENT_MAX_ITER_CAP=10`, `OLLAMA_CONTEXT_LENGTH=16384`, `TOOL_SELECTION_MODE=off`, compose KV levers empty.
- Existing CI canaries must stay green: `base-prompt-budget.test.ts`, tools-core `catalog.test.ts`, all WARP-854 empty-completion tests.
- Merge policy: PRs end "ready for Romain's review" — never self-merge, never `--admin`.
- Line numbers below are against `origin/main` at `35f53bc2`; re-locate by the quoted code if drifted.

---

### Task 0: Branch + install

**Files:** none (setup)

- [ ] **Step 1: Create the feature branch in the worktree**

```bash
cd /Users/rjouffret/Projects/Droplet/droplet-onboard-services/.worktrees/agent-budgets-spec
git switch -c feat/agent-budgets-and-context-efficiency
```

- [ ] **Step 2: Install workspace deps**

```bash
npx -y pnpm@9.15.9 install
```

Expected: install completes; `apps/orchestrator/node_modules` exists.

- [ ] **Step 3: Baseline sanity — run one existing agent test**

```bash
cd apps/orchestrator && npx vitest run src/__tests__/llm-agent.max-tokens.test.ts
```

Expected: PASS (2 tests).

---

### Task 1: Env-tunable step limit — config schema + pure resolver

**Files:**
- Modify: `apps/orchestrator/src/config.ts` (schema near line 114; export block near line 982; resolver near the other exported pure helpers, e.g. after `isWeakJwtSecret`)
- Test: `apps/orchestrator/src/__tests__/config.agent-iter-limits.test.ts` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: `config.agentMaxIter: { defaultIter: number; capIter: number }` and exported pure `resolveAgentIterLimits(defaultIter: number, capIter: number, warn?: (msg: string) => void): { defaultIter: number; capIter: number }`. Task 2 reads `config.agentMaxIter`.

- [ ] **Step 1: Write the failing test**

Create `apps/orchestrator/src/__tests__/config.agent-iter-limits.test.ts`:

```ts
/**
 * Agent step-budget knobs (2026-07-21 agent-budgets spec §1) — the pure
 * resolver behind `config.agentMaxIter`. A misconfigured env (DEFAULT > CAP)
 * must clamp with a warning, never crash boot or silently break chat.
 */
import { describe, it, expect, vi } from "vitest";
import { resolveAgentIterLimits } from "../config.js";

describe("resolveAgentIterLimits (spec §1)", () => {
  it("passes well-formed values through unchanged", () => {
    const warn = vi.fn();
    expect(resolveAgentIterLimits(5, 10, warn)).toEqual({
      defaultIter: 5,
      capIter: 10,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("allows DEFAULT === CAP without warning", () => {
    const warn = vi.fn();
    expect(resolveAgentIterLimits(10, 10, warn)).toEqual({
      defaultIter: 10,
      capIter: 10,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("clamps DEFAULT down to CAP and warns when DEFAULT > CAP", () => {
    const warn = vi.fn();
    expect(resolveAgentIterLimits(12, 8, warn)).toEqual({
      defaultIter: 8,
      capIter: 8,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("AGENT_MAX_ITER_DEFAULT");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/orchestrator && npx vitest run src/__tests__/config.agent-iter-limits.test.ts
```

Expected: FAIL — `resolveAgentIterLimits` is not exported.

- [ ] **Step 3: Implement**

In `apps/orchestrator/src/config.ts`, directly below the `OLLAMA_CONTEXT_LENGTH` schema entry (`OLLAMA_CONTEXT_LENGTH: z.coerce.number().int().positive().default(16384),`), add:

```ts
  // Agent step-budget knobs (2026-07-21 agent-budgets spec §1). DEFAULT is
  // the per-turn iteration count when the caller sends no `max_iter`; CAP is
  // the ceiling both the /api/llm/chat zod schema and the agent loop's clamp
  // enforce. Both enforcement points read the SAME resolved value
  // (config.agentMaxIter) so they can never drift. `.positive()`: zero
  // iterations is meaningless, so zod rejects it at boot.
  AGENT_MAX_ITER_DEFAULT: z.coerce.number().int().positive().default(5),
  AGENT_MAX_ITER_CAP: z.coerce.number().int().positive().default(10),
```

Near the other exported pure helpers (after `isWeakJwtSecret`), add:

```ts
/** PURE — resolve the agent iteration limits, clamping DEFAULT down to CAP
 *  when misconfigured: a bad env must not silently break chat (same
 *  philosophy as voiceReasoningEffortDefault). Exported for tests. */
export function resolveAgentIterLimits(
  defaultIter: number,
  capIter: number,
  warn: (msg: string) => void = console.warn,
): { defaultIter: number; capIter: number } {
  if (defaultIter > capIter) {
    warn(
      `config: AGENT_MAX_ITER_DEFAULT (${defaultIter}) exceeds ` +
        `AGENT_MAX_ITER_CAP (${capIter}); clamping default to ${capIter}`,
    );
    return { defaultIter: capIter, capIter };
  }
  return { defaultIter, capIter };
}
```

In the `export const config = { ...parsed, ... }` block (near line 982), add alongside the other resolved fields:

```ts
  agentMaxIter: resolveAgentIterLimits(
    parsed.AGENT_MAX_ITER_DEFAULT,
    parsed.AGENT_MAX_ITER_CAP,
  ),
```

- [ ] **Step 4: Run tests**

```bash
cd apps/orchestrator && npx vitest run src/__tests__/config.agent-iter-limits.test.ts && npx tsc --noEmit
```

Expected: PASS (3 tests); tsc clean.

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/src/config.ts apps/orchestrator/src/__tests__/config.agent-iter-limits.test.ts
git commit -m "feat(agent-budgets): env-tunable agent iteration limits in config (AGENT_MAX_ITER_DEFAULT/CAP)"
```

---

### Task 2: Loop + route consume the configured limits

**Files:**
- Modify: `apps/orchestrator/src/services/llm-agent.service.ts` (imports; delete `const DEFAULT_MAX_ITER = 5;` near line 297; clamp near line 685; header comment "Iteration cap: default 5, hard max 10")
- Modify: `apps/orchestrator/src/routes/llm.ts:171`
- Test: `apps/orchestrator/src/__tests__/llm-agent.iter-config.test.ts` (create)

**Interfaces:**
- Consumes: `config.agentMaxIter` from Task 1.
- Produces: `runAgent` honors `config.agentMaxIter.defaultIter` when `req.max_iter` unset and clamps to `config.agentMaxIter.capIter`. No signature changes.

- [ ] **Step 1: Write the failing test**

Create `apps/orchestrator/src/__tests__/llm-agent.iter-config.test.ts`:

```ts
/**
 * Spec §1 — the agent loop reads its iteration limits from config, not
 * hard-coded 5/10. Config is mocked to distinctive values so a regression to
 * the literals fails loudly.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../config.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../config.js")>();
  return {
    ...mod,
    config: { ...mod.config, agentMaxIter: { defaultIter: 2, capIter: 3 } },
  };
});

import { runAgent, type AgentDeps } from "../services/llm-agent.service.js";

/** Gateway that ALWAYS returns a tool call, so the loop runs to its cap. */
function loopingDeps() {
  const chat = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "c1",
                type: "function",
                function: { name: "list_files", arguments: "{}" },
              },
            ],
          },
        },
      ],
    }),
  });
  const deps: AgentDeps = {
    mcp: {
      listTools: vi
        .fn()
        .mockResolvedValue([
          { name: "list_files", description: "d", inputSchema: {} },
        ]),
      callTool: vi.fn().mockResolvedValue({
        isError: false,
        content: [{ type: "text", text: "{}" }],
      }),
    } as never,
    aiGateway: { chat } as never,
  };
  return { deps, chat };
}

describe("runAgent — config-driven iteration limits (spec §1)", () => {
  it("uses config.agentMaxIter.defaultIter when max_iter unset", async () => {
    const { deps, chat } = loopingDeps();
    const result = await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(chat).toHaveBeenCalledTimes(2); // mocked default = 2
    expect(result.stop_reason).toBe("iteration_limit");
    expect(result.iterations).toBe(2);
  });

  it("clamps an oversized caller max_iter to config.agentMaxIter.capIter", async () => {
    const { deps, chat } = loopingDeps();
    const result = await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      max_iter: 99,
    });
    expect(chat).toHaveBeenCalledTimes(3); // mocked cap = 3
    expect(result.iterations).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/orchestrator && npx vitest run src/__tests__/llm-agent.iter-config.test.ts
```

Expected: FAIL — chat called 5× (hard-coded default), not 2×.

- [ ] **Step 3: Implement**

In `llm-agent.service.ts`:

1. Add to the imports: `import { config } from "../config.js";`
2. Delete the line `const DEFAULT_MAX_ITER = 5;`
3. Replace the clamp

```ts
  const maxIter = Math.max(1, Math.min(req.max_iter ?? DEFAULT_MAX_ITER, 10));
```

with:

```ts
  // Spec §1 — both enforcement points (this clamp + the /api/llm/chat zod
  // bound) read config.agentMaxIter, so they cannot drift.
  const maxIter = Math.max(
    1,
    Math.min(
      req.max_iter ?? config.agentMaxIter.defaultIter,
      config.agentMaxIter.capIter,
    ),
  );
```

4. Update the file-header comment line `* Iteration cap: default 5, hard max 10 — a confused or prompt-injected` to:

```
 * Iteration cap: config.agentMaxIter (env AGENT_MAX_ITER_DEFAULT / CAP,
 * ships 5 / 10) — a confused or prompt-injected
```

In `routes/llm.ts:171`, replace:

```ts
  max_iter: z.number().int().min(1).max(10).optional(),
```

with:

```ts
  // Spec §1 — the cap comes from config so it matches the loop's clamp.
  max_iter: z.number().int().min(1).max(config.agentMaxIter.capIter).optional(),
```

- [ ] **Step 4: Run tests**

```bash
cd apps/orchestrator && npx vitest run src/__tests__/llm-agent.iter-config.test.ts src/__tests__/llm-agent.max-tokens.test.ts && npx tsc --noEmit
```

Expected: PASS; tsc clean. (Existing suites still see 5/10 — env defaults are unchanged.)

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/src/services/llm-agent.service.ts apps/orchestrator/src/routes/llm.ts apps/orchestrator/src/__tests__/llm-agent.iter-config.test.ts
git commit -m "feat(agent-budgets): agent loop + chat route read iteration limits from config"
```

---

### Task 3: Token-aware iteration guard (spec §2)

**Files:**
- Modify: `apps/orchestrator/src/services/prompt-budget.consts.ts` (append)
- Modify: `apps/orchestrator/src/services/llm-agent.service.ts` (AgentRequest, AgentResult union near line 293, loop)
- Modify: `apps/orchestrator/src/types/sse-events.ts` (done union)
- Modify: `apps/orchestrator/src/routes/llm.ts` (pass `context_window` at the two `runAgent` calls near lines 1670/1724; widen the WARP-854 blank-turn conversions near lines 1583/1762)
- Test: `apps/orchestrator/src/__tests__/llm-agent.context-budget-guard.test.ts` (create)

**Interfaces:**
- Consumes: `estimateTokensFromChars`, `DEFAULT_CONTEXT_WINDOW` from `context-budget.service.ts`; `OUTPUT_RESERVE` from `prompt-budget.consts.ts`.
- Produces: `ITERATION_MIN_HEADROOM = 1536` (const, `prompt-budget.consts.ts`); `AgentRequest.context_window?: number`; stop-reason literals `"context_budget"` and `"repetition"` added to `AgentResult.stop_reason` and the SSE `done` union (BOTH literals here — Task 7 reuses `"repetition"` without touching the types again); internal `finalizeReason` mechanism Task 7 sets.

- [ ] **Step 1: Write the failing test**

Create `apps/orchestrator/src/__tests__/llm-agent.context-budget-guard.test.ts`:

```ts
/**
 * Spec §2 — token-aware iteration guard. When the estimated transcript
 * leaves < ITERATION_MIN_HEADROOM under (context_window − OUTPUT_RESERVE),
 * the loop stops dispatching tools and runs ONE finalization pass (zero
 * tools, tool_choice "none", a system nudge) ending stop_reason
 * "context_budget" — never a silent history trim.
 */
import { describe, it, expect, vi } from "vitest";
import { runAgent, type AgentDeps } from "../services/llm-agent.service.js";
import type { SSEEvent } from "../types/sse-events.js";

/** First call: tool_calls; later calls: scripted content answers. */
function deps(opts: { toolResultChars: number; answers?: unknown[] }) {
  const toolCallMsg = {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "c1",
        type: "function",
        function: { name: "search_content", arguments: "{}" },
      },
    ],
  };
  const answerMsg = { role: "assistant", content: "final answer" };
  const queue = [toolCallMsg, ...(opts.answers ?? [answerMsg])];
  const chat = vi.fn().mockImplementation(async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: queue[Math.min(chat.mock.calls.length - 1, queue.length - 1)] }],
    }),
  }));
  const agentDeps: AgentDeps = {
    mcp: {
      listTools: vi
        .fn()
        .mockResolvedValue([
          { name: "search_content", description: "d", inputSchema: {} },
        ]),
      callTool: vi.fn().mockResolvedValue({
        isError: false,
        content: [{ type: "text", text: "x".repeat(opts.toolResultChars) }],
      }),
    } as never,
    aiGateway: { chat } as never,
  };
  return { agentDeps, chat };
}

describe("runAgent — context-budget iteration guard (spec §2)", () => {
  it("finalizes with zero tools once headroom is gone", async () => {
    // window 4096 − reserve 1024 − headroom 1536 = 1536 tokens = 6144 chars.
    // One 8000-char tool result blows through that before iteration 2.
    const { agentDeps, chat } = deps({ toolResultChars: 8000 });
    const events: SSEEvent[] = [];
    const result = await runAgent(
      { ...agentDeps, onEvent: (e) => events.push(e) },
      {
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        context_window: 4096,
      },
    );
    expect(chat).toHaveBeenCalledTimes(2);
    const finalReq = chat.mock.calls[1]![0] as {
      tools: unknown[];
      tool_choice: string;
      messages: { role: string; content: unknown }[];
    };
    expect(finalReq.tools).toEqual([]);
    expect(finalReq.tool_choice).toBe("none");
    expect(
      finalReq.messages.some(
        (m) =>
          m.role === "system" &&
          String(m.content).includes("Context budget reached"),
      ),
    ).toBe(true);
    expect(result.stop_reason).toBe("context_budget");
    expect(result.message.content).toBe("final answer");
    const done = events.find((e) => e.type === "done");
    expect(done).toMatchObject({ stop_reason: "context_budget" });
  });

  it("does not fire with a roomy window", async () => {
    const { agentDeps, chat } = deps({ toolResultChars: 100 });
    const result = await runAgent(agentDeps, {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      context_window: 16384,
    });
    expect(result.stop_reason).toBe("model_done");
    const secondReq = chat.mock.calls[1]![0] as { tools: unknown[] };
    expect(secondReq.tools.length).toBeGreaterThan(0);
  });

  it("a finalize pass that still emits tool_calls terminates (no third call)", async () => {
    const toolCallMsg = {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "c2",
          type: "function",
          function: { name: "search_content", arguments: "{}" },
        },
      ],
    };
    const { agentDeps, chat } = deps({
      toolResultChars: 8000,
      answers: [toolCallMsg],
    });
    const result = await runAgent(agentDeps, {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      context_window: 4096,
    });
    expect(chat).toHaveBeenCalledTimes(2);
    expect(result.stop_reason).toBe("context_budget");
    expect(result.message.content).toBe(""); // WARP-854 path owns blank turns
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/orchestrator && npx vitest run src/__tests__/llm-agent.context-budget-guard.test.ts
```

Expected: FAIL — `context_window` unknown, guard absent, `stop_reason` is `iteration_limit`/`model_done`.

- [ ] **Step 3: Implement**

`prompt-budget.consts.ts` — append:

```ts
/**
 * Agent-loop iteration guard (2026-07-21 agent-budgets spec §2): minimum
 * estimated-token headroom under `window − OUTPUT_RESERVE` required to start
 * another tool-calling iteration. Below it the loop stops dispatching tools
 * and runs one finalization pass (stop_reason "context_budget") instead of
 * pushing the request into history-trim territory. Sized so one more
 * 8000-char tool result (~2000 tokens at 4 chars/token) can't fit anyway;
 * 1536 keeps usable iterations while never over-filling. Revisit with the
 * spec §6 measurement data.
 */
export const ITERATION_MIN_HEADROOM = 1536;
```

`types/sse-events.ts` — widen the `done` member:

```ts
  | {
      type: "done";
      iterations: number;
      stop_reason:
        | "model_done"
        | "iteration_limit"
        | "error"
        | "context_budget"
        | "repetition";
      error?: string;
    };
```

`llm-agent.service.ts`:

1. Imports:

```ts
import {
  ITERATION_MIN_HEADROOM,
  OUTPUT_RESERVE,
} from "./prompt-budget.consts.js";
import {
  DEFAULT_CONTEXT_WINDOW,
  estimateTokensFromChars,
} from "./context-budget.service.js";
```

2. `AgentRequest` — add:

```ts
  /**
   * Spec §2 — effective model context window in tokens
   * (config.OLLAMA_CONTEXT_LENGTH in production; the route passes it
   * explicitly). Drives the per-iteration token guard. Unset →
   * DEFAULT_CONTEXT_WINDOW (conservative fallback for direct callers).
   */
  context_window?: number;
```

3. `AgentResult` — widen:

```ts
  stop_reason:
    | "model_done"
    | "iteration_limit"
    | "error"
    | "context_budget"
    | "repetition";
```

4. In `runAgent`, after `const availableToolList = ...`:

```ts
  // Spec §2/§4 — when set, the NEXT model call is a finalization pass: zero
  // tools, tool_choice "none", plus a one-time system nudge. A flag rather
  // than a break because the user still deserves an answer synthesized from
  // the gathered results, which needs one more inference call.
  const contextWindow = req.context_window ?? DEFAULT_CONTEXT_WINDOW;
  let toolSchemasJsonLen = JSON.stringify(tools).length;
  let finalizeReason: "context_budget" | "repetition" | null = null;
```

(`toolSchemasJsonLen` is `let` because Task 6's self-heal rebuilds `tools`.)

5. At the top of the `for` loop body, immediately after the `if (req.signal?.aborted) return abortedResult(iter);` line:

```ts
    // Spec §2 — token-aware iteration guard. chars/4 rounded up, matching
    // context-budget.service.ts; JSON.stringify over-counts (keys, escapes,
    // and any inlined image payloads), which only makes the guard fire
    // EARLIER than the true fill — conservative by construction.
    if (
      iter > 0 &&
      finalizeReason === null &&
      toolChoice !== "none" &&
      estimateTokensFromChars(
        JSON.stringify(messages).length + toolSchemasJsonLen,
      ) >
        contextWindow - OUTPUT_RESERVE - ITERATION_MIN_HEADROOM
    ) {
      finalizeReason = "context_budget";
    }
    if (finalizeReason !== null) {
      messages.push({
        role: "system",
        content:
          "Context budget reached — answer the user now from the information already gathered. Do not call any more tools.",
      });
    }
    const iterTools = finalizeReason !== null ? [] : tools;
    const iterToolChoice: "auto" | "none" =
      finalizeReason !== null ? "none" : toolChoice;
```

6. In the `chatReq` object literal a few lines below, replace `tools,` with `tools: iterTools,` and `tool_choice: toolChoice,` with `tool_choice: iterToolChoice,`.

7. Immediately BEFORE the terminal branch `if (!asst.tool_calls?.length) {`:

```ts
    // Spec §2 — the finalize pass advertised zero tools; a model that still
    // emits tool_calls gets no second chance. Strip them so this turn takes
    // the terminal path (empty content lands in WARP-854's FAILED-turn path).
    if (finalizeReason !== null && asst.tool_calls?.length) {
      delete asst.tool_calls;
    }
```

8. In the terminal branch, replace both `stop_reason: "model_done"` literals (the `emit({ type: "done", iterations: iter + 1, stop_reason: "model_done" });` and the `return { ..., stop_reason: "model_done" }`) with:

```ts
stop_reason: finalizeReason ?? "model_done",
```

`routes/llm.ts`:

9. In BOTH `runAgent` invocations (near lines 1670 and 1724), add alongside `max_iter: chatReq.max_iter,`:

```ts
            context_window: config.OLLAMA_CONTEXT_LENGTH,
```

10. Widen the two WARP-854 blank-turn conversions. Near line 1583, replace:

```ts
            e.stop_reason === "model_done" &&
```

with:

```ts
            (e.stop_reason === "model_done" ||
              e.stop_reason === "context_budget" ||
              e.stop_reason === "repetition") &&
```

Near line 1762, replace:

```ts
          result.stop_reason === "model_done" &&
```

with:

```ts
          (result.stop_reason === "model_done" ||
            result.stop_reason === "context_budget" ||
            result.stop_reason === "repetition") &&
```

- [ ] **Step 4: Run tests**

```bash
cd apps/orchestrator && npx vitest run src/__tests__/llm-agent.context-budget-guard.test.ts src/__tests__/llm-agent.iter-config.test.ts src/__tests__/llm-agent.max-tokens.test.ts src/services/base-prompt-budget.test.ts && npx tsc --noEmit
```

Expected: all PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/src/services/prompt-budget.consts.ts apps/orchestrator/src/services/llm-agent.service.ts apps/orchestrator/src/types/sse-events.ts apps/orchestrator/src/routes/llm.ts apps/orchestrator/src/__tests__/llm-agent.context-budget-guard.test.ts
git commit -m "feat(agent-budgets): token-aware iteration guard — finalize with stop_reason context_budget instead of trimming"
```

---

### Task 4: Dashboard handles the new stop reasons

**Files:**
- Modify: `apps/web-dashboard/src/lib/hooks/useChat.ts` (`DoneEvent` near line 215; WARP-854 live-path guard near line 1887)

**Interfaces:**
- Consumes: the widened SSE `done` union from Task 3.
- Produces: nothing downstream.

- [ ] **Step 1: Widen the `DoneEvent` union**

Replace:

```ts
  stop_reason: "model_done" | "iteration_limit" | "error";
```

with:

```ts
  stop_reason:
    | "model_done"
    | "iteration_limit"
    | "error"
    | "context_budget"
    | "repetition";
```

- [ ] **Step 2: Include the new reasons in the blank-turn guard**

In the WARP-854 live-path block, replace:

```ts
        if (
          (evt.stop_reason === "model_done" ||
            evt.stop_reason === "iteration_limit") &&
```

with:

```ts
        if (
          (evt.stop_reason === "model_done" ||
            evt.stop_reason === "iteration_limit" ||
            evt.stop_reason === "context_budget" ||
            evt.stop_reason === "repetition") &&
```

- [ ] **Step 3: Run the dashboard chat-hook suites**

```bash
cd apps/web-dashboard && npx vitest run src/__tests__/lib/useChat.test.tsx && npx tsc --noEmit
```

Expected: PASS; tsc clean.

- [ ] **Step 4: Commit**

```bash
git add apps/web-dashboard/src/lib/hooks/useChat.ts
git commit -m "feat(agent-budgets): dashboard accepts context_budget/repetition stop reasons"
```

---

### Task 5: Tool-selection service (spec §3, pure part)

**Files:**
- Create: `apps/orchestrator/src/services/tool-selection.service.ts`
- Test: `apps/orchestrator/src/services/tool-selection.service.test.ts` (co-located, matching the other `services/*.test.ts`)

**Interfaces:**
- Consumes: `TOOL_CATALOG`, `type ToolDomain` from `@droplet/tools-core`.
- Produces (Task 6 imports all of these):
  - `type ToolSelectionMode = "off" | "domains"`
  - `CORE_TOOL_NAMES: ReadonlySet<string>`
  - `selectAdvertisedTools(opts: { mode: ToolSelectionMode; userMessage: string; pool: string[]; conversationToolNames: string[] }): { advertised: string[]; matchedDomains: ToolDomain[] }`
  - `domainOfTool(name: string): ToolDomain | undefined`
  - `toolNamesForDomain(domain: ToolDomain): string[]`

- [ ] **Step 1: Write the failing test**

Create `apps/orchestrator/src/services/tool-selection.service.test.ts`:

```ts
/**
 * Spec §3 — relevance-based tool selection. Deterministic, pure, and only
 * ever a SUBSET of the caller's pool; the taxonomy is tools-core's
 * TOOL_CATALOG (CI-complete), never a parallel list.
 */
import { describe, it, expect } from "vitest";
import {
  CORE_TOOL_NAMES,
  selectAdvertisedTools,
  domainOfTool,
  toolNamesForDomain,
} from "./tool-selection.service.js";

const POOL = [
  "search_content",
  "read_file",
  "list_files",
  "memory_recall",
  "control_device",
  "run_scene",
  "list_network_devices",
  "get_network_status",
];

describe("selectAdvertisedTools (spec §3)", () => {
  it("mode off is a pass-through", () => {
    const r = selectAdvertisedTools({
      mode: "off",
      userMessage: "anything",
      pool: POOL,
      conversationToolNames: [],
    });
    expect(r.advertised).toEqual(POOL);
  });

  it("always includes the core set present in the pool", () => {
    const r = selectAdvertisedTools({
      mode: "domains",
      userMessage: "hello there",
      pool: POOL,
      conversationToolNames: [],
    });
    for (const name of ["search_content", "read_file", "list_files", "memory_recall"]) {
      expect(r.advertised).toContain(name);
    }
    // No rule matched "hello there": nothing beyond core.
    expect(r.advertised).not.toContain("control_device");
    expect(r.advertised).not.toContain("list_network_devices");
  });

  it("a smart-home message pulls in the smart-home domain, not network", () => {
    const r = selectAdvertisedTools({
      mode: "domains",
      userMessage: "turn off the kitchen lights",
      pool: POOL,
      conversationToolNames: [],
    });
    expect(r.advertised).toContain("control_device");
    expect(r.advertised).toContain("run_scene");
    expect(r.advertised).not.toContain("list_network_devices");
  });

  it("conversation continuity keeps a previously used domain advertised", () => {
    const r = selectAdvertisedTools({
      mode: "domains",
      userMessage: "thanks, and what did it say?",
      pool: POOL,
      conversationToolNames: ["get_network_status"],
    });
    expect(r.advertised).toContain("list_network_devices");
    expect(r.advertised).toContain("get_network_status");
  });

  it("never invents names outside the pool (subset invariant)", () => {
    const tiny = ["search_content", "control_device"];
    const r = selectAdvertisedTools({
      mode: "domains",
      userMessage: "dim the lights and check my files",
      pool: tiny,
      conversationToolNames: [],
    });
    for (const name of r.advertised) expect(tiny).toContain(name);
  });
});

describe("catalog helpers", () => {
  it("domainOfTool resolves registered names and rejects unknowns", () => {
    expect(domainOfTool("control_device")).toBe("smart-home");
    expect(domainOfTool("no_such_tool")).toBeUndefined();
  });

  it("toolNamesForDomain returns the catalog grouping", () => {
    expect(toolNamesForDomain("memory")).toContain("memory_recall");
  });

  it("CORE_TOOL_NAMES are all real registered tools", () => {
    for (const name of CORE_TOOL_NAMES) {
      expect(domainOfTool(name)).toBeDefined();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/orchestrator && npx vitest run src/services/tool-selection.service.test.ts
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `apps/orchestrator/src/services/tool-selection.service.ts`:

```ts
/**
 * 2026-07-21 agent-budgets spec §3 — relevance-based tool selection.
 *
 * The owner-role chat loop advertises every in-scope tool schema on every
 * turn (~11k tokens of the 16k window — see chat-tool-scope.ts / WARP-1424),
 * which both starves history/memory of context and measurably degrades tool
 * CHOICE on small local models (the WARP-1334 skips-retrieval class). This
 * service narrows the advertisement per-turn.
 *
 * Deterministic by design: keyword rules → ToolDomain groups. No embedding
 * call, no second LLM call — the single-box has no latency budget for
 * either. Wrong guesses self-heal in the agent loop (a filtered-but-allowed
 * call expands its domain next iteration; see llm-agent.service.ts).
 *
 * INVARIANT: the result is always a subset of `pool`. RBAC narrowing
 * (narrowAllowedToolsForRole / WRITE_TOOLS) has already been applied to the
 * pool before this runs; this layer must never widen it.
 *
 * The taxonomy is tools-core's TOOL_CATALOG (registry-derived, completeness
 * CI-enforced by catalog.test.ts) — never a parallel list that can drift.
 */
import { TOOL_CATALOG, type ToolDomain } from "@droplet/tools-core";

export type ToolSelectionMode = "off" | "domains";

/** Reverse index over the CI-complete catalog: tool name → its domain. */
const DOMAIN_BY_NAME: ReadonlyMap<string, ToolDomain> = new Map(
  TOOL_CATALOG.map((e) => [e.name, e.domain]),
);

/**
 * Always advertised (when present in the pool): retrieval + memory-read.
 * These are the tools nearly every knowledge turn needs, and the eval's
 * worst failure class is the model NOT reaching for them.
 */
export const CORE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "search_content",
  "read_file",
  "list_files",
  "memory_recall",
]);

/**
 * Keyword/intent rules → domains. Case-insensitive test against the latest
 * user message. Deliberately generous: a false-positive domain costs a few
 * hundred schema tokens; a false NEGATIVE costs an iteration (self-heal).
 * pm / erp / switch have no rules — they're excluded from default chat
 * scope (chat-tool-scope.ts) and reachable via explicit allowed_tools.
 */
const DOMAIN_RULES: ReadonlyArray<{ pattern: RegExp; domains: ToolDomain[] }> = [
  { pattern: /\b(files?|documents?|docs?|pdf|photos?|images?|pictures?|notes?|folders?|receipts?|invoices?|csv|spreadsheets?|uploads?)\b/i, domains: ["files"] },
  { pattern: /\b(lights?|lamps?|scenes?|thermostat|plugs?|heating|temperature|dim|brightness|routines?|turn (on|off))\b/i, domains: ["smart-home"] },
  { pattern: /\b(wi-?fi|network|internet|router|dhcp|firewall|ssid|blocked?|unblock|bandwidth|devices?)\b/i, domains: ["network"] },
  { pattern: /\b(cameras?|clips?|recordings?|footage|motion|doorbell)\b/i, domains: ["cameras"] },
  { pattern: /\b(calendar|meetings?|appointments?|events?|schedule)\b/i, domains: ["calendar"] },
  { pattern: /\b(remind(er)?s?|tasks?|to-?dos?)\b/i, domains: ["reminders"] },
  { pattern: /\b(notifications?|notify|alerts?)\b/i, domains: ["notifications"] },
  { pattern: /\b(e-?mails?|inbox|newsletters?)\b/i, domains: ["email"] },
  { pattern: /\b(remember|memory|forget|know about me)\b/i, domains: ["memory"] },
  { pattern: /\b(business|company|opening hours|customers?)\b/i, domains: ["business"] },
  { pattern: /\b(time|date|today|tomorrow|weather|calculate|convert|translate|timestamp)\b/i, domains: ["data"] },
  { pattern: /\b(storage|disks?|drives?|updates?|system|health|audit)\b/i, domains: ["system"] },
];

export function domainOfTool(name: string): ToolDomain | undefined {
  return DOMAIN_BY_NAME.get(name);
}

export function toolNamesForDomain(domain: ToolDomain): string[] {
  return TOOL_CATALOG.filter((e) => e.domain === domain).map((e) => e.name);
}

/**
 * Compute the per-turn advertised subset: core set ∪ rule-matched domains ∪
 * domains of tools already called in this conversation (continuity). Pure —
 * no I/O, no clock, safe to call per turn.
 */
export function selectAdvertisedTools(opts: {
  mode: ToolSelectionMode;
  userMessage: string;
  pool: string[];
  conversationToolNames: string[];
}): { advertised: string[]; matchedDomains: ToolDomain[] } {
  if (opts.mode === "off") {
    return { advertised: opts.pool, matchedDomains: [] };
  }
  const domains = new Set<ToolDomain>();
  for (const rule of DOMAIN_RULES) {
    if (rule.pattern.test(opts.userMessage)) {
      for (const d of rule.domains) domains.add(d);
    }
  }
  for (const name of opts.conversationToolNames) {
    const d = DOMAIN_BY_NAME.get(name);
    if (d) domains.add(d);
  }
  const advertised = opts.pool.filter((name) => {
    if (CORE_TOOL_NAMES.has(name)) return true;
    const d = DOMAIN_BY_NAME.get(name);
    return d !== undefined && domains.has(d);
  });
  return { advertised, matchedDomains: [...domains] };
}
```

- [ ] **Step 4: Run tests**

```bash
cd apps/orchestrator && npx vitest run src/services/tool-selection.service.test.ts && npx tsc --noEmit
```

Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/src/services/tool-selection.service.ts apps/orchestrator/src/services/tool-selection.service.test.ts
git commit -m "feat(agent-budgets): relevance-based tool selection service on the tools-core domain catalog"
```

---

### Task 6: Wire selection into the loop + self-healing guard branch

**Files:**
- Modify: `apps/orchestrator/src/config.ts` (schema: `TOOL_SELECTION_MODE`)
- Modify: `apps/orchestrator/src/services/llm-agent.service.ts` (AgentRequest field; tool assembly; guard branch)
- Modify: `apps/orchestrator/src/routes/llm.ts` (pass mode at both `runAgent` calls)
- Test: `apps/orchestrator/src/__tests__/llm-agent.tool-selection.test.ts` (create)

**Interfaces:**
- Consumes: Task 5 exports; `config.TOOL_SELECTION_MODE`.
- Produces: `AgentRequest.tool_selection_mode?: "off" | "domains"`. The loop derives `userMessage` (last user message) and `conversationToolNames` (assistant `tool_calls` in history) from `req.messages` itself — the route only forwards the mode.

- [ ] **Step 1: Write the failing test**

Create `apps/orchestrator/src/__tests__/llm-agent.tool-selection.test.ts`:

```ts
/**
 * Spec §3 — selection wired into the loop, plus the self-healing guard: a
 * model call to a REAL pool tool that selection filtered out is answered
 * with TOOL_NOW_AVAILABLE and the tool's domain joins the advertisement for
 * the next iteration — one lost iteration, never a failed turn.
 */
import { describe, it, expect, vi } from "vitest";
import { runAgent, type AgentDeps } from "../services/llm-agent.service.js";

const POOL_TOOLS = [
  { name: "search_content", description: "d", inputSchema: {} },
  { name: "read_file", description: "d", inputSchema: {} },
  { name: "list_files", description: "d", inputSchema: {} },
  { name: "memory_recall", description: "d", inputSchema: {} },
  { name: "control_device", description: "d", inputSchema: {} },
  { name: "list_network_devices", description: "d", inputSchema: {} },
];

function makeDeps(assistantTurns: unknown[]) {
  const chat = vi.fn().mockImplementation(async () => ({
    ok: true,
    json: async () => ({
      choices: [
        {
          message:
            assistantTurns[
              Math.min(chat.mock.calls.length - 1, assistantTurns.length - 1)
            ],
        },
      ],
    }),
  }));
  const callTool = vi.fn().mockResolvedValue({
    isError: false,
    content: [{ type: "text", text: "{}" }],
  });
  const deps: AgentDeps = {
    mcp: { listTools: vi.fn().mockResolvedValue(POOL_TOOLS), callTool } as never,
    aiGateway: { chat } as never,
  };
  return { deps, chat, callTool };
}

const toolNames = (call: unknown) =>
  (call as { tools: { function: { name: string } }[] }).tools.map(
    (t) => t.function.name,
  );

describe("runAgent — tool selection (spec §3)", () => {
  it("mode unset advertises the full pool (unchanged behavior)", async () => {
    const { deps, chat } = makeDeps([{ role: "assistant", content: "hi" }]);
    await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "turn off the lights" }],
    });
    expect(toolNames(chat.mock.calls[0]![0])).toHaveLength(POOL_TOOLS.length);
  });

  it("domains mode narrows to core + matched domain", async () => {
    const { deps, chat } = makeDeps([{ role: "assistant", content: "done" }]);
    await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "turn off the kitchen lights" }],
      tool_selection_mode: "domains",
    });
    const names = toolNames(chat.mock.calls[0]![0]);
    expect(names).toContain("control_device"); // smart-home rule matched
    expect(names).toContain("search_content"); // core
    expect(names).not.toContain("list_network_devices"); // unmatched domain
  });

  it("self-heals a filtered-but-allowed call and dispatches on retry", async () => {
    const callControl = {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: { name: "control_device", arguments: "{}" },
        },
      ],
    };
    const { deps, chat, callTool } = makeDeps([
      callControl, // iter 0: filtered → heal
      callControl, // iter 1: now advertised → dispatch
      { role: "assistant", content: "done" },
    ]);
    const result = await runAgent(deps, {
      model: "m",
      // "hello there" matches no rule → core-only advertisement.
      messages: [{ role: "user", content: "hello there" }],
      tool_selection_mode: "domains",
    });
    expect(toolNames(chat.mock.calls[0]![0])).not.toContain("control_device");
    expect(toolNames(chat.mock.calls[1]![0])).toContain("control_device");
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(result.stop_reason).toBe("model_done");
    expect(result.message.content).toBe("done");
  });

  it("selection never resurrects a tool outside allowed_tools", async () => {
    const { deps, chat } = makeDeps([{ role: "assistant", content: "hi" }]);
    await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "turn off the lights" }],
      tool_selection_mode: "domains",
      allowed_tools: ["search_content"], // RBAC-style narrowing wins
    });
    expect(toolNames(chat.mock.calls[0]![0])).toEqual(["search_content"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/orchestrator && npx vitest run src/__tests__/llm-agent.tool-selection.test.ts
```

Expected: FAIL — `tool_selection_mode` unknown; full pool always advertised.

- [ ] **Step 3: Implement**

`config.ts` — add to the schema, below the Task 1 entries:

```ts
  // Spec §3 — relevance-based tool selection kill switch. "off" (default)
  // advertises the full effective pool exactly as before; "domains" narrows
  // per-turn via tool-selection.service.ts. The shipped default flips only
  // after the spec §6 phase-3 eval says so.
  TOOL_SELECTION_MODE: z.enum(["off", "domains"]).default("off"),
```

`llm-agent.service.ts`:

1. Import:

```ts
import {
  selectAdvertisedTools,
  domainOfTool,
  toolNamesForDomain,
} from "./tool-selection.service.js";
```

2. `AgentRequest` — add:

```ts
  /**
   * Spec §3 — relevance-based tool selection. "domains" narrows the
   * advertised tools per-turn (core set + rule-matched + conversation-
   * continuity domains); a filtered-but-allowed call self-heals via the
   * WARP-642 guard. Unset/"off" → full-pool advertisement, byte-for-byte
   * today's behavior. Only ever SUBSETS the pool this loop already resolved
   * (allowed_tools / chat scope) — RBAC is decided before this field.
   */
  tool_selection_mode?: "off" | "domains";
```

3. Replace the tool-assembly block. Current code:

```ts
  const filtered = req.allowed_tools
    ? allTools.filter((t) => req.allowed_tools!.includes(t.name))
    : allTools.filter((t) => !EXCLUDED_FROM_CHAT_TOOLS.has(t.name));
  const tools = filtered.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema as Record<string, unknown>,
    },
  }));
```

New code (keep the existing comments above `filtered`):

```ts
  const filtered = req.allowed_tools
    ? allTools.filter((t) => req.allowed_tools!.includes(t.name))
    : allTools.filter((t) => !EXCLUDED_FROM_CHAT_TOOLS.has(t.name));
  const toSpec = (t: (typeof filtered)[number]) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema as Record<string, unknown>,
    },
  });
  // Spec §3 — per-turn relevance selection. `filtered` (the effective pool
  // after RBAC/chat-scope) stays the ceiling: the self-heal branch below may
  // re-admit pool tools that selection dropped, but NOTHING outside it.
  const fullPoolNames = new Set(filtered.map((t) => t.name));
  let activeTools = filtered;
  if (req.tool_selection_mode === "domains" && toolChoice !== "none") {
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    const conversationToolNames = req.messages.flatMap((m) =>
      m.role === "assistant" && m.tool_calls
        ? m.tool_calls.map((tc) => tc.function.name)
        : [],
    );
    const sel = selectAdvertisedTools({
      mode: "domains",
      userMessage:
        typeof lastUser?.content === "string" ? lastUser.content : "",
      pool: filtered.map((t) => t.name),
      conversationToolNames,
    });
    const selected = new Set(sel.advertised);
    activeTools = filtered.filter((t) => selected.has(t.name));
  }
  let tools = activeTools.map(toSpec);
```

4. Make the advertisement mutable — replace:

```ts
  const advertisedNames = new Set(tools.map((t) => t.function.name));
  const availableToolList = tools.map((t) => t.function.name).join(", ");
```

with:

```ts
  let advertisedNames = new Set(tools.map((t) => t.function.name));
  let availableToolList = tools.map((t) => t.function.name).join(", ");
```

(Task 3's `let toolSchemasJsonLen = JSON.stringify(tools).length;` sits just below and stays.)

5. In the dispatch loop, at the TOP of the existing `if (!advertisedNames.has(call.function.name)) {` branch (before the `safeName` line), insert the self-heal:

```ts
        if (fullPoolNames.has(call.function.name)) {
          // Spec §3 self-heal — a REAL pool tool that selection filtered
          // out. Expand its whole domain for the remaining iterations and
          // tell the model to retry: one lost iteration, not a failed turn.
          // Deliberately NOT counted as a guard hit (the model named a real
          // tool) and not a real dispatch either.
          const domain = domainOfTool(call.function.name);
          const domainNames = new Set(
            domain ? toolNamesForDomain(domain) : [call.function.name],
          );
          const keep = new Set([
            ...advertisedNames,
            call.function.name,
            ...domainNames,
          ]);
          tools = filtered.filter((t) => keep.has(t.name)).map(toSpec);
          advertisedNames = new Set(tools.map((t) => t.function.name));
          availableToolList = tools.map((t) => t.function.name).join(", ");
          toolSchemasJsonLen = JSON.stringify(tools).length;
          const heal = {
            status: "error" as const,
            error: {
              code: "TOOL_NOW_AVAILABLE",
              message:
                `The tool '${call.function.name}' is now available. ` +
                `Call it again with the same arguments.`,
            },
          };
          trace.push({
            tool_call_id: call.id,
            tool: call.function.name,
            args,
            result: heal,
          });
          emit({ type: "tool_result", id: call.id, ok: false, data: heal });
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify(heal).slice(0, 8000),
          });
          continue;
        }
```

`routes/llm.ts`:

6. In BOTH `runAgent` invocations, add alongside `context_window`:

```ts
            tool_selection_mode: config.TOOL_SELECTION_MODE,
```

- [ ] **Step 4: Run tests**

```bash
cd apps/orchestrator && npx vitest run src/__tests__/llm-agent.tool-selection.test.ts src/__tests__/llm-agent.context-budget-guard.test.ts src/__tests__/llm-agent.iter-config.test.ts src/__tests__/llm-agent.output-hygiene.test.ts && npx tsc --noEmit
```

Expected: all PASS (default mode `off` keeps every existing suite byte-identical); tsc clean.

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/src/config.ts apps/orchestrator/src/services/llm-agent.service.ts apps/orchestrator/src/routes/llm.ts apps/orchestrator/src/__tests__/llm-agent.tool-selection.test.ts
git commit -m "feat(agent-budgets): wire per-turn tool selection into the agent loop with self-healing guard"
```

---

### Task 7: Repetition early-stop (spec §4)

**Files:**
- Modify: `apps/orchestrator/src/services/llm-agent.service.ts` (dispatch loop)
- Test: `apps/orchestrator/src/__tests__/llm-agent.repetition-stop.test.ts` (create)

**Interfaces:**
- Consumes: the `finalizeReason` mechanism and `"repetition"` stop-reason literal from Task 3.
- Produces: nothing new downstream.

- [ ] **Step 1: Write the failing test**

Create `apps/orchestrator/src/__tests__/llm-agent.repetition-stop.test.ts`:

```ts
/**
 * Spec §4 — repetition early-stop. Occurrence 1 of (name, canonical args)
 * dispatches; occurrence 2 gets a REPEATED_CALL nudge and no dispatch;
 * occurrence 3 triggers the finalization pass (stop_reason "repetition").
 */
import { describe, it, expect, vi } from "vitest";
import { runAgent, type AgentDeps } from "../services/llm-agent.service.js";

const sameCall = {
  role: "assistant",
  content: null,
  tool_calls: [
    {
      id: "c1",
      type: "function",
      function: { name: "search_content", arguments: '{"query":"sophie"}' },
    },
  ],
};

function makeDeps(turns: unknown[]) {
  const chat = vi.fn().mockImplementation(async () => ({
    ok: true,
    json: async () => ({
      choices: [
        { message: turns[Math.min(chat.mock.calls.length - 1, turns.length - 1)] },
      ],
    }),
  }));
  const callTool = vi.fn().mockResolvedValue({
    isError: false,
    content: [{ type: "text", text: '{"hits":[]}' }],
  });
  const deps: AgentDeps = {
    mcp: {
      listTools: vi
        .fn()
        .mockResolvedValue([
          { name: "search_content", description: "d", inputSchema: {} },
        ]),
      callTool,
    } as never,
    aiGateway: { chat } as never,
  };
  return { deps, chat, callTool };
}

describe("runAgent — repetition early-stop (spec §4)", () => {
  it("nudges on the first repeat, finalizes on the second", async () => {
    const { deps, chat, callTool } = makeDeps([
      sameCall, // occ 1: dispatched
      sameCall, // occ 2: nudged
      sameCall, // occ 3: nudged + finalize
      { role: "assistant", content: "here is what I found" },
    ]);
    const result = await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "find sophie" }],
      max_iter: 10,
    });
    expect(callTool).toHaveBeenCalledTimes(1); // only occurrence 1 dispatched
    const finalReq = chat.mock.calls[3]![0] as {
      tools: unknown[];
      messages: { role: string; content: unknown }[];
    };
    expect(finalReq.tools).toEqual([]); // finalization pass
    expect(
      finalReq.messages.filter((m) =>
        String(m.content).includes("REPEATED_CALL"),
      ).length,
    ).toBe(2);
    expect(result.stop_reason).toBe("repetition");
    expect(result.message.content).toBe("here is what I found");
  });

  it("different args are not repetition", async () => {
    const otherCall = {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "c2",
          type: "function",
          function: { name: "search_content", arguments: '{"query":"marc"}' },
        },
      ],
    };
    const { deps, callTool } = makeDeps([
      sameCall,
      otherCall,
      { role: "assistant", content: "done" },
    ]);
    const result = await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "find people" }],
    });
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(result.stop_reason).toBe("model_done");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/orchestrator && npx vitest run src/__tests__/llm-agent.repetition-stop.test.ts
```

Expected: FAIL — callTool dispatched 3×, stop_reason "model_done".

- [ ] **Step 3: Implement**

In `runAgent`, next to the Task 3 `finalizeReason` declaration, add:

```ts
  // Spec §4 — repetition early-stop. Key = tool name + canonicalized args
  // (sorted keys, so {"a":1,"b":2} and {"b":2,"a":1} collide as intended).
  const executedCallCounts = new Map<string, number>();
  const canonicalCallKey = (
    name: string,
    args: Record<string, unknown>,
  ): string => `${name}:${JSON.stringify(args, Object.keys(args).sort())}`;
```

In the dispatch loop, AFTER the full `if (!advertisedNames.has(call.function.name)) { ... }` guard block and BEFORE the `iterRealDispatches++;` / `emit({ type: "tool_call", ... })` lines, insert:

```ts
      // Spec §4 — occurrence 1 dispatches; 2 nudges; 3 finalizes. A nudged
      // call is neither a guard hit nor a real dispatch, so the WARP-642
      // circuit breaker is unaffected.
      const callKey = canonicalCallKey(call.function.name, args);
      const priorCalls = executedCallCounts.get(callKey) ?? 0;
      executedCallCounts.set(callKey, priorCalls + 1);
      if (priorCalls >= 1) {
        const nudge = {
          status: "error" as const,
          error: {
            code: "REPEATED_CALL",
            message:
              `You already called '${call.function.name}' with these exact ` +
              `arguments; its result is in the conversation above. Use that ` +
              `result or answer the user — do not repeat the call.`,
          },
        };
        trace.push({
          tool_call_id: call.id,
          tool: call.function.name,
          args,
          result: nudge,
        });
        emit({ type: "tool_result", id: call.id, ok: false, data: nudge });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(nudge).slice(0, 8000),
        });
        if (priorCalls >= 2) {
          finalizeReason = finalizeReason ?? "repetition";
        }
        continue;
      }
```

- [ ] **Step 4: Run tests — full orchestrator suite this time**

```bash
cd apps/orchestrator && npx vitest run src/__tests__/llm-agent.repetition-stop.test.ts && npx vitest run && npx tsc --noEmit
```

Expected: new tests PASS; full suite green (compare failures, if any, against a pre-change `git stash` run — pre-existing reds are not yours to fix); tsc clean.

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/src/services/llm-agent.service.ts apps/orchestrator/src/__tests__/llm-agent.repetition-stop.test.ts
git commit -m "feat(agent-budgets): repetition early-stop — nudge once, finalize on the second identical repeat"
```

---

### Task 8: Compose + .env.example window levers (spec §5)

**Files:**
- Modify: `docker/docker-compose.yml` (ollama service `environment:` block, after `OLLAMA_CONTEXT_LENGTH`, near line 2170)
- Modify: `.env.example` (near the existing `# OLLAMA_CONTEXT_LENGTH=16384` line ~120)

- [ ] **Step 1: Add the env tokens to the ollama service**

Directly below `OLLAMA_CONTEXT_LENGTH: "${OLLAMA_CONTEXT_LENGTH:-16384}"` add:

```yaml
      # 2026-07-21 agent-budgets spec §5 — window-experiment levers. Empty
      # defaults = Ollama's own defaults (f16 KV cache, flash attention off),
      # so today's behavior is byte-identical. OLLAMA_KV_CACHE_TYPE=q8_0
      # roughly halves KV-cache VRAM (flash attention is its prerequisite);
      # set both in .env only per the spec §6 measurement protocol — never
      # as a silent default change.
      OLLAMA_FLASH_ATTENTION: "${OLLAMA_FLASH_ATTENTION:-}"
      OLLAMA_KV_CACHE_TYPE: "${OLLAMA_KV_CACHE_TYPE:-}"
```

- [ ] **Step 2: Document in .env.example**

Below the `# OLLAMA_CONTEXT_LENGTH=16384` line add:

```
# Window-experiment levers (agent-budgets spec §5) — leave unset until the
# spec §6 measurement protocol picks values. q8_0 KV cache roughly halves KV
# VRAM; flash attention is its prerequisite. Both apply to the bundled
# `ollama` service only.
# OLLAMA_FLASH_ATTENTION=1
# OLLAMA_KV_CACHE_TYPE=q8_0
```

- [ ] **Step 3: Validate compose syntax**

```bash
docker compose -f docker/docker-compose.yml config --quiet
```

Expected: exit 0, no output. (Config validation needs no daemon; if docker itself is unavailable, `npx -y yaml-lint docker/docker-compose.yml` is the fallback.)

- [ ] **Step 4: Commit**

```bash
git add docker/docker-compose.yml .env.example
git commit -m "feat(agent-budgets): compose env levers for KV-cache quantization experiments (default off)"
```

---

### Task 9: Measurement-protocol runbook (spec §6)

**Files:**
- Create: `/Users/rjouffret/Projects/Droplet/staging-seed/eval/agent-budgets-tuning-protocol.md` (staging-seed lives OUTSIDE this repo — write the file, no git commit here)

- [ ] **Step 1: Write the runbook**

```markdown
# Agent step-budget & window tuning — measurement protocol

Source spec: droplet-onboard-services
`docs/superpowers/specs/2026-07-21-agent-budgets-and-context-efficiency-design.md` §6.
Harness: the `/staging-suite` skill (36-row eval) on the lab box
(droplet@192.168.1.87; creds are per-session from Romain).
Noise band: single-run deltas < 4 rows are noise — a winner needs a ≥ 4-row
delta or two confirming runs.

## Phase 1 — window sweep (steps = 5, selection off)

Cells: OLLAMA_CONTEXT_LENGTH = 16384 (baseline) → 24576 → 32768 with
OLLAMA_FLASH_ATTENTION=1 + OLLAMA_KV_CACHE_TYPE=q8_0.

Per cell, on the box:
1. Edit `.env`, then `docker compose up -d ollama orchestrator` (both read
   the same token).
2. VRAM GATE before any eval time: send one long prompt through chat, then
   `ollama ps` — the model line must read 100% GPU. Any CPU split → reject
   the cell on latency grounds, stop here.
3. Run /staging-suite; record the table below.

## Phase 2 — step sweep (winning window; token guard is live in the build)

Cells: AGENT_MAX_ITER_DEFAULT = 5 (baseline) → 8 → 10 (orchestrator env).

## Phase 3 — tool selection on/off (winning window + steps)

Cells: TOOL_SELECTION_MODE=off (baseline) → domains (orchestrator env).
Watch specifically: WARP-1334-class rows (skips-retrieval / wrong tool) and
TOOL_NOW_AVAILABLE frequency in traces (self-heal cost).

## Record per cell

| metric | how |
|---|---|
| eval pass rate (n/36) | /staging-suite scoreboard |
| wall-clock per row | suite log timestamps |
| VRAM split | `ollama ps` after a long turn |
| degradation/trim warnings | orchestrator logs (degradeToFit warns) |
| stop_reason distribution | count done events: model_done / iteration_limit / context_budget / repetition / error |

## Outputs

- Shipped defaults: AGENT_MAX_ITER_DEFAULT, OLLAMA_CONTEXT_LENGTH (.env),
  TOOL_SELECTION_MODE — each changed only on phase evidence.
- Findings file `staging-seed/eval/findings-<date>.md` + WARP tickets per the
  standing staging protocol (re-check previous tickets first).
```

- [ ] **Step 2: Verify the file exists and the eval directory convention held**

```bash
ls /Users/rjouffret/Projects/Droplet/staging-seed/eval/agent-budgets-tuning-protocol.md
```

Expected: path prints.

---

### Task 10: Final verification + PR

- [ ] **Step 1: Full orchestrator + dashboard suites and typecheck**

```bash
cd apps/orchestrator && npx vitest run && npx tsc --noEmit
cd ../web-dashboard && npx vitest run && npx tsc --noEmit
```

Expected: green (modulo pre-existing baseline failures — verify any red also fails on the branch base before touching it).

- [ ] **Step 2: Push and open the PR (as rjouffret; the Nahast account lost repo access)**

```bash
git push -u origin feat/agent-budgets-and-context-efficiency
gh pr create --title "Agent step-budget tuning + context-efficiency (token guard, tool selection, repetition stop)" --body "$(cat <<'EOF'
Implements the approved spec docs/superpowers/specs/2026-07-21-agent-budgets-and-context-efficiency-design.md:

- env-tunable agent iteration limits (AGENT_MAX_ITER_DEFAULT/CAP), both enforcement points reading one config value
- token-aware iteration guard: finalize with stop_reason "context_budget" instead of history-trimming
- relevance-based tool selection (TOOL_SELECTION_MODE, ships off) on the tools-core domain catalog, with a self-healing guard branch
- repetition early-stop (nudge once, finalize on the second identical repeat)
- compose levers for KV-cache quantization experiments (default off)

NO shipped default changes — values move only after the spec §6 measurement protocol on the staging box.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL printed. Stop here — merge is Romain's click (repo policy).
