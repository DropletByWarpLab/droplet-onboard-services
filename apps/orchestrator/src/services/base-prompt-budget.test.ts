/**
 * WARP-1118 — worst-case fixed-system-block budget canary (§10).
 *
 * `BASE_PROMPT_MAX_CHARS = 10000` bounds the worst-case sum of EVERY fixed
 * system-prompt block: identity (4000) + persona (1200) + business (1500)
 * + memory facts (2000) + interview conductor (900) = 9600, leaving 400
 * chars of slack. This canary fails in CI if a future budget edit pushes
 * the sum over the ceiling.
 *
 * It ALSO folds in a representative serialized tools[] payload (§10): the
 * number that actually matters is the whole request, and tools[] lives in
 * no block. On the shipping single-box window (OLLAMA_CONTEXT_LENGTH=16384)
 * the fixed blocks + the full owner tool schemas fit comfortably under the
 * window minus the output reserve — the assertion documents that headroom
 * and regresses if the tool registry grows pathologically.
 *
 * NOTE: this canary asserts the FIXED-block char sums; the RUNTIME overflow
 * gate is estimateRequestTokens/degradeToFit (context-budget.service.test.ts),
 * which additionally accounts for pins, attachments, and history.
 */
import { describe, it, expect } from "vitest";
import { TOOLS } from "@droplet/tools-core";
import {
  PERSONA_PROMPT_MAX_CHARS,
  BUSINESS_CONTEXT_MAX_CHARS,
  INTERVIEW_PROMPT_MAX_CHARS,
  BASE_PROMPT_MAX_CHARS,
  OUTPUT_RESERVE,
} from "./prompt-budget.consts.js";
import {
  estimateTokensFromChars,
  DEFAULT_CONTEXT_WINDOW,
} from "./context-budget.service.js";
import { IDENTITY_MAX_CHARS } from "./identity-prompt.js";
import { EXCLUDED_FROM_CHAT_TOOLS } from "./chat-tool-scope.js";

/** buildMemoryFactsBlock's MEMORY_FACTS_CHAR_BUDGET (routes/llm.ts). Kept as
 *  a literal here (the const is route-local, not exported) so the invariant
 *  is complete; a change to the route budget should update this in lockstep. */
const MEMORY_FACTS_CHAR_BUDGET = 2000;

/** Serialize the DEFAULT CHAT advertisement to the wire tools[] shape the
 *  model sees (llm-agent.service.ts): the registry minus the WARP-1424
 *  chat-scope exclusions (chat-tool-scope.ts). Since the WARP-1423 rollout
 *  the full registry no longer fits the shipping window, so the scoped set
 *  IS what goes on the wire for an owner chat turn — and therefore the
 *  worst case this canary must budget. */
function serializeChatToolSchemas(): string {
  const tools = Array.from(TOOLS.values())
    .filter((t) => !EXCLUDED_FROM_CHAT_TOOLS.has(t.name))
    .map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));
  return JSON.stringify(tools);
}

describe("worst-case fixed system-block budget", () => {
  it("keeps identity + persona + business + memory + interview under BASE_PROMPT_MAX_CHARS", () => {
    const fixedBlockChars =
      IDENTITY_MAX_CHARS +
      PERSONA_PROMPT_MAX_CHARS +
      BUSINESS_CONTEXT_MAX_CHARS +
      MEMORY_FACTS_CHAR_BUDGET +
      INTERVIEW_PROMPT_MAX_CHARS;
    // 4000 + 1200 + 1500 + 2000 + 900 = 9600.
    expect(fixedBlockChars).toBe(9600);
    expect(fixedBlockChars).toBeLessThanOrEqual(BASE_PROMPT_MAX_CHARS);
  });

  it("fits the fixed blocks + default chat tools[] under the shipping window minus reserve", () => {
    // GROUND TRUTH (WARP-1118 §10, corrected 2026-07-08): the bundled box runs
    // OLLAMA_CONTEXT_LENGTH=16384 (docker-compose.yml, the WARP-854 fix). The
    // orchestrator estimator budgets against that window minus OUTPUT_RESERVE.
    const toolSchemasJson = serializeChatToolSchemas();
    const worstCaseChars =
      IDENTITY_MAX_CHARS +
      PERSONA_PROMPT_MAX_CHARS +
      BUSINESS_CONTEXT_MAX_CHARS +
      MEMORY_FACTS_CHAR_BUDGET +
      INTERVIEW_PROMPT_MAX_CHARS +
      toolSchemasJson.length;
    const worstCaseTokens = estimateTokensFromChars(worstCaseChars);
    const effectiveWindow = DEFAULT_CONTEXT_WINDOW - OUTPUT_RESERVE;

    // The fixed blocks + the scoped chat advertisement fit under the
    // effective window with room for history. Growing the advertised set
    // (registering a tool without adding it to chat-tool-scope.ts) spends
    // this headroom — when this assertion trips, either scope the new tool
    // out of chat or make a deliberate, measured budget decision here.
    expect(worstCaseTokens).toBeLessThan(effectiveWindow);
    // Regression ceiling on the FULL registry serialization (growth
    // tripwire for the MCP-facing surface, which advertises everything).
    // Re-baselined 2026-07 for the WARP-1423 rollout (94 → ~127 tools,
    // ~85K chars serialized).
    const fullRegistryJson = JSON.stringify(
      Array.from(TOOLS.values()).map((t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      })),
    );
    expect(fullRegistryJson.length).toBeLessThan(100000);
  });
});
