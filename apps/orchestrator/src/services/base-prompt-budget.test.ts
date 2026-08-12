/**
 * WARP-1118 — worst-case fixed-system-block budget canary (§10).
 *
 * `BASE_PROMPT_MAX_CHARS = 12200` bounds the worst-case sum of EVERY fixed
 * system-prompt block: identity (4000) + persona (1200) + business (1500)
 * + tool guidance (2200) + memory facts (2000) + interview conductor (900)
 * = 11800, leaving 400 chars of slack. (2026-07-23: tool guidance became a
 * counted, capped block — previously ~600 uncounted chars riding inside
 * the identity fold.) This canary fails in CI if a future budget edit
 * pushes the sum over the ceiling.
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
  TOOL_GUIDANCE_MAX_CHARS,
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
function chatToolEntries() {
  return Array.from(TOOLS.values())
    .filter((t) => !EXCLUDED_FROM_CHAT_TOOLS.has(t.name))
    .map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));
}

function serializeChatToolSchemas(): string {
  return JSON.stringify(chatToolEntries());
}

/** Per-tool serialized sizes, largest first — the naming half of the canary. */
function chatToolSizes(): { name: string; chars: number }[] {
  return chatToolEntries()
    .map((e) => ({ name: e.function.name, chars: JSON.stringify(e).length }))
    .sort((a, b) => b.chars - a.chars);
}

/**
 * WARP-1891 — per-tool ceiling on a single serialized `tools[]` entry.
 *
 * Derivation: the effective window is DEFAULT_CONTEXT_WINDOW - OUTPUT_RESERVE
 * = 15360 tokens = 61440 chars, of which the fixed blocks take 11800, leaving
 * ~49.6K chars for the whole ~70-tool chat advertisement. 2000 chars is ~4% of
 * that budget in ONE tool — past that a tool is pathological, not merely rich.
 *
 * This exists because the aggregate assertion below is FILE-scoped: when the
 * sum tips over, it blames whichever tool happened to be registered last
 * rather than the one that is actually oversized. WARP-1861's get_gpu_status
 * tipped it by 19 tokens with a 491-char description while four other tools
 * carried larger payloads. This assertion names names.
 *
 * NOTE (WARP-1839): trimming a schema to fit here must NEVER be done by adding
 * `maxLength` / `pattern` / `enum` constraints. Those are what blew llama.cpp's
 * GBNF grammar and took out tool calling on the appliance entirely. Cut prose,
 * cut properties — never add constraints.
 */
const PER_TOOL_MAX_CHARS = 2000;

describe("worst-case fixed system-block budget", () => {
  it("keeps identity + persona + business + guidance + memory + interview under BASE_PROMPT_MAX_CHARS", () => {
    const fixedBlockChars =
      IDENTITY_MAX_CHARS +
      PERSONA_PROMPT_MAX_CHARS +
      BUSINESS_CONTEXT_MAX_CHARS +
      TOOL_GUIDANCE_MAX_CHARS +
      MEMORY_FACTS_CHAR_BUDGET +
      INTERVIEW_PROMPT_MAX_CHARS;
    // 4000 + 1200 + 1500 + 2200 + 2000 + 900 = 11800. (2026-07-23: tool
    // guidance became a counted, capped block — it was previously ~600
    // uncounted chars riding inside the identity fold.)
    expect(fixedBlockChars).toBe(11800);
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
      TOOL_GUIDANCE_MAX_CHARS +
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
    //
    // NEVER raise effectiveWindow to make this pass: it derives from the
    // shipping window and the output reserve, so raising it relocates the
    // cliff instead of removing it and the next tool lands past the real
    // limit silently. Trim the schema, or scope the tool out of chat.
    expect(
      worstCaseTokens,
      `worst-case chat turn is ${worstCaseTokens} tokens against a ${effectiveWindow} ` +
        `ceiling (${toolSchemasJson.length} chars of tools[] over ` +
        `${chatToolSizes().length} tools). Largest advertised tools: ` +
        chatToolSizes()
          .slice(0, 5)
          .map((r) => `${r.name} (${r.chars})`)
          .join(", "),
    ).toBeLessThan(effectiveWindow);
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

  it("keeps every default-chat tool under the per-tool serialized ceiling", () => {
    const sizes = chatToolSizes();
    const oversized = sizes.filter((r) => r.chars > PER_TOOL_MAX_CHARS);
    expect(
      oversized.map((r) => `${r.name} (${r.chars} chars)`),
      `these default-chat tools serialize over the ${PER_TOOL_MAX_CHARS}-char ` +
        `per-tool ceiling. Trim the description or drop properties — do NOT add ` +
        `maxLength/pattern/enum (WARP-1839), and do NOT raise the ceiling.`,
    ).toEqual([]);
    // Sanity: the set is non-empty, so an accidentally-empty advertisement
    // cannot make this assertion vacuously true.
    expect(sizes.length).toBeGreaterThan(50);
  });
});
