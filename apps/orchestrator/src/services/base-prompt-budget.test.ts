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
import { TOOL_CATALOG, type ToolDomain } from "@droplet/tools-core";
import {
  CORE_TOOL_NAMES,
  toolNamesForDomain,
} from "./tool-selection.service.js";
import type { RuntimeToolDescriptor } from "./runtime-tool-registry.service.js";
import { ALL_REMOTE_TOOLS } from "./__fixtures__/remote-tool-catalog.js";

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
 * WARP-2446 — extended to measure the DYNAMIC half too.
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
 *
 * `runtimeTools` folds runtime-registered remote tools into the same
 * calculation. That is the WARP-2446 point: with part of the universe
 * arriving at runtime, a canary that measures only the static half covers
 * half the risk while LOOKING like it covers all of it — registering a remote
 * catalog would not have turned it red. `remoteInWorst` is reported so the
 * assertions can prove the dynamic half was actually measured rather than
 * silently contributing nothing.
 */
function worstCaseSelectedTurn(
  runtimeTools: readonly RuntimeToolDescriptor[] = [],
): { chars: number; domain: string; toolCount: number; remoteInWorst: number } {
  const localEntries = chatToolEntries();
  const remoteEntries = runtimeTools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
  const remoteNames = new Set(remoteEntries.map((e) => e.function.name));
  const entries = [...localEntries, ...remoteEntries];
  const byName = new Map(entries.map((e) => [e.function.name, e]));
  const core = [...CORE_TOOL_NAMES].filter((n) => byName.has(n));

  // Domain → the names in it, across BOTH layers. `toolNamesForDomain` is the
  // shipped resolver, used here rather than a parallel reimplementation so
  // the canary cannot drift from what selection actually does.
  const domains = new Set<string>([
    ...TOOL_CATALOG.filter((e) => byName.has(e.name)).map((e) => e.domain),
    ...runtimeTools.map((t) => t.domain),
  ]);

  let worst = { chars: 0, domain: "(none)", toolCount: 0, remoteInWorst: 0 };
  for (const d of domains) {
    const names = new Set([
      ...core,
      ...toolNamesForDomain(d as ToolDomain, runtimeTools),
    ]);
    const selected = entries.filter((e) => names.has(e.function.name));
    const chars = JSON.stringify(selected).length;
    if (chars > worst.chars) {
      worst = {
        chars,
        domain: d,
        toolCount: selected.length,
        remoteInWorst: selected.filter((e) => remoteNames.has(e.function.name))
          .length,
      };
    }
  }
  return worst;
}

/** Back-compat alias for the local-only worst case. */
function worstCaseSelectedTurnChars(): { chars: number; domain: string } {
  return worstCaseSelectedTurn();
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
      `[STATIC HALF] worst-case SELECTED turn is ${selectedTokens} tokens ` +
        `against a ${effectiveWindow} ceiling — domain "${worst.domain}" + ` +
        `core = ${worst.chars} chars. This is the LOCAL registry only; the ` +
        `dynamic half is asserted separately below. Largest advertised ` +
        `tools overall: ` +
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
    //
    // Re-baselined again 2026-08-30 for WARP-2546 — the seven-tool `crm`
    // domain took this from ~99.4K to 100,561 and tripped the 100,000 line.
    // Raised deliberately rather than trimmed under, for two reasons:
    //
    //   1. This ceiling watches the MCP-facing surface, which has no context
    //      window to blow — an external client asks for the catalog once. The
    //      number that bounds a real chat turn is the per-domain assertion
    //      above, and it is comfortably green.
    //   2. Shaving prose to squeeze under a growth tripwire is how a canary
    //      stops meaning anything. The point of the line is that crossing it
    //      is a decision somebody writes down, which is what this is.
    //
    // 110K leaves room for roughly one more domain of this size before the
    // next author has to make the same call consciously.
    //
    // ⚠ The CHAT-pool assertion above is a different matter: it now sits at
    // 59,941 of 60,000 — 59 chars of headroom. The next tool added to the chat
    // scope WILL trip it, and that one has a real consequence (it is the wire
    // payload of the TOOL_SELECTION_MODE=off rollback path). WARP-2547 tracks
    // deciding between re-baselining it and excluding a vertical suite.
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
    expect(fullRegistryJson.length).toBeLessThan(110000);
  });

  /**
   * WARP-2446 — the canary's dynamic half.
   *
   * Everything above measures the STATIC base prompt and the static registry.
   * Once part of the tool universe arrives at runtime, that covers half the
   * risk while looking like it covers all of it: registering a remote catalog
   * would not have turned any assertion above red, because none of them can
   * see a tool that is not in `TOOLS`.
   *
   * These assertions fold the fixture remote catalogs into the same
   * worst-case-selected-turn calculation, and — critically — prove the
   * dynamic half was actually MEASURED rather than silently contributing
   * nothing. A canary that quietly ignores the thing it claims to watch is
   * worse than no canary.
   */
  it("[DYNAMIC HALF] fits the worst-case selected turn with remote catalogs registered", () => {
    const fixedChars =
      IDENTITY_MAX_CHARS +
      PERSONA_PROMPT_MAX_CHARS +
      BUSINESS_CONTEXT_MAX_CHARS +
      TOOL_GUIDANCE_MAX_CHARS +
      MEMORY_FACTS_CHAR_BUDGET +
      INTERVIEW_PROMPT_MAX_CHARS;
    const effectiveWindow = DEFAULT_CONTEXT_WINDOW - OUTPUT_RESERVE;

    const worst = worstCaseSelectedTurn(ALL_REMOTE_TOOLS);
    const tokens = estimateTokensFromChars(fixedChars + worst.chars);

    // NON-VACUITY FIRST. If the worst-case domain contained no remote tool,
    // this assertion would be measuring the static half twice and passing for
    // the wrong reason. MUTATION: pass `[]` instead of ALL_REMOTE_TOOLS and
    // this goes red — which is exactly the state the canary was in before
    // WARP-2446.
    expect(
      worst.remoteInWorst,
      `the worst-case domain "${worst.domain}" contains no remote tool, so ` +
        `this assertion is not measuring the dynamic half at all`,
    ).toBeGreaterThan(0);

    expect(
      tokens,
      `[DYNAMIC HALF] worst-case selected turn WITH remote catalogs is ` +
        `${tokens} tokens against a ${effectiveWindow} ceiling — domain ` +
        `"${worst.domain}", ${worst.toolCount} tools (${worst.remoteInWorst} ` +
        `remote), ${worst.chars} chars of schemas. A red here means a ` +
        `registered remote catalog no longer fits a single-domain turn: trim ` +
        `the server's advertised tool set (WARP-2321 allowlisting) or split ` +
        `its tools across domains. Do NOT raise the ceiling.`,
    ).toBeLessThan(effectiveWindow);
  });

  it("[DYNAMIC HALF] goes RED when a remote catalog is pathologically large", () => {
    // Proof the dynamic assertion has teeth. A single server registering ~500
    // tools into ONE domain is the shape of catastrophe this canary must
    // catch, and today's static-only canary would not notice it at all.
    //
    // This is the WARP-2446 mutation, run as a test rather than described:
    // the same calculation that passes for the real catalogs must FAIL here.
    const pathological: RuntimeToolDescriptor[] = Array.from(
      { length: 500 },
      (_, i) => ({
        name: `bloated_remote_tool_${i}`,
        serverId: "pathological",
        domain: "pm" as const,
        domainSource: "server" as const,
        description:
          "A remote tool with a description of entirely ordinary length, " +
          "of the sort a real MCP server ships for each of its endpoints.",
        inputSchema: {
          type: "object",
          properties: {
            first: { type: "string", description: "The first parameter." },
            second: { type: "string", description: "The second parameter." },
          },
        },
      }),
    );

    const fixedChars =
      IDENTITY_MAX_CHARS +
      PERSONA_PROMPT_MAX_CHARS +
      BUSINESS_CONTEXT_MAX_CHARS +
      TOOL_GUIDANCE_MAX_CHARS +
      MEMORY_FACTS_CHAR_BUDGET +
      INTERVIEW_PROMPT_MAX_CHARS;
    const effectiveWindow = DEFAULT_CONTEXT_WINDOW - OUTPUT_RESERVE;

    const worst = worstCaseSelectedTurn(pathological);
    const tokens = estimateTokensFromChars(fixedChars + worst.chars);

    expect(worst.remoteInWorst).toBeGreaterThan(0);
    expect(
      tokens,
      "a 500-tool single-domain remote catalog must blow the window; if it " +
        "does not, the dynamic assertion above is measuring nothing",
    ).toBeGreaterThan(effectiveWindow);
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
