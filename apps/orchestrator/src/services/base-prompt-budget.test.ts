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
import { TOOL_CATALOG } from "@droplet/tools-core";
import { CORE_TOOL_NAMES } from "./tool-selection.service.js";

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

/**
 * WARP-1921 — the WORST-CASE SHIPPED TURN under `TOOL_SELECTION_MODE=domains`.
 *
 * Since WARP-1921 the shipping default advertises the core set plus the
 * domains matched by the user's message, not the whole chat scope. So the
 * number that bounds a real turn is `core ∪ (the single largest domain)` —
 * a turn matching two domains is possible but not the budgeted worst case
 * for a canary whose job is to catch pathological GROWTH of one tool group.
 *
 * Multi-domain turns are covered by the runtime gate
 * (estimateRequestTokens/degradeToFit), which sees the actual assembled
 * request; this canary is the static tripwire.
 */
function worstCaseSelectedTurnChars(): { chars: number; domain: string } {
  const entries = chatToolEntries();
  const byName = new Map(entries.map((e) => [e.function.name, e]));
  const core = [...CORE_TOOL_NAMES].filter((n) => byName.has(n));
  const domains = new Set(
    TOOL_CATALOG.filter((e) => byName.has(e.name)).map((e) => e.domain),
  );
  let worst = { chars: 0, domain: "(none)" };
  for (const d of domains) {
    const names = new Set([
      ...core,
      ...TOOL_CATALOG.filter((e) => e.domain === d).map((e) => e.name),
    ]);
    const chars = JSON.stringify(
      entries.filter((e) => names.has(e.function.name)),
    ).length;
    if (chars > worst.chars) worst = { chars, domain: d };
  }
  return worst;
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

  it("fits the fixed blocks + the worst-case SELECTED turn under the shipping window minus reserve", () => {
    // GROUND TRUTH (WARP-1118 §10, corrected 2026-07-08): the bundled box runs
    // a 16384-token window (docker-compose.yml, the WARP-854 fix). The
    // orchestrator estimator budgets against that window minus OUTPUT_RESERVE.
    //
    // WARP-1921 — this assertion now measures the SHIPPED turn, not the whole
    // chat scope. `TOOL_SELECTION_MODE` defaults to "domains", so a real turn
    // carries core ∪ the matched domain(s), not all ~71 in-scope tools.
    // Measuring the full pool here made the canary reject every new tool while
    // actual turns ran ~10K tokens under the ceiling — it blocked WARP-1893 on
    // 28 tokens of phantom headroom.
    const fixedChars =
      IDENTITY_MAX_CHARS +
      PERSONA_PROMPT_MAX_CHARS +
      BUSINESS_CONTEXT_MAX_CHARS +
      TOOL_GUIDANCE_MAX_CHARS +
      MEMORY_FACTS_CHAR_BUDGET +
      INTERVIEW_PROMPT_MAX_CHARS;
    const effectiveWindow = DEFAULT_CONTEXT_WINDOW - OUTPUT_RESERVE;

    const worst = worstCaseSelectedTurnChars();
    const selectedTokens = estimateTokensFromChars(fixedChars + worst.chars);

    // NEVER raise effectiveWindow to make this pass: it derives from the
    // shipping window and the output reserve, so raising it relocates the
    // cliff instead of removing it and the next tool lands past the real
    // limit silently. Trim the schema, or scope the tool out of chat.
    expect(
      selectedTokens,
      `worst-case SELECTED turn is ${selectedTokens} tokens against a ` +
        `${effectiveWindow} ceiling — domain "${worst.domain}" + core = ` +
        `${worst.chars} chars. Largest advertised tools overall: ` +
        chatToolSizes()
          .slice(0, 5)
          .map((r) => `${r.name} (${r.chars})`)
          .join(", "),
    ).toBeLessThan(effectiveWindow);
  });

  it("tracks the full chat pool as a growth tripwire (the TOOL_SELECTION_MODE=off rollback path)", () => {
    // The full in-scope pool is what goes on the wire when an operator sets
    // TOOL_SELECTION_MODE=off to roll back selection.
    //
    // HONEST LIMIT, stated so nobody reads a green here as a guarantee: the
    // pool passed 15360 tokens during WARP-1893 and is NOT expected to come
    // back under it. `off` is therefore a diagnostic/rollback mode that no
    // longer fits the window alongside the full fixed blocks — on a large
    // turn it will lean on the runtime degradeToFit gate. The shipped default
    // is what the assertion above budgets.
    //
    // This number still earns its keep as a GROWTH tripwire: it catches a
    // pathological jump (a tool group doubling) that the per-domain assertion
    // above could miss, and it makes the cost of `off` visible rather than
    // implicit.
    const poolChars = serializeChatToolSchemas().length;
    expect(
      poolChars,
      `full chat pool is ${poolChars} chars over ${chatToolSizes().length} tools`,
    ).toBeLessThan(60000);

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
