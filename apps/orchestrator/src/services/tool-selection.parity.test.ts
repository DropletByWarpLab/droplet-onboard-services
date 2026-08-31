/**
 * WARP-2552 — the budget estimate and the wire payload must be the same set.
 *
 * They were not. `routes/llm.ts` sized the whole chat pool while
 * `llm-agent.service.ts` advertised a per-turn subset, so on a 16384 window
 * the estimator charged ~14,986 tokens of tool schemas for a turn that ships
 * ~3,426. `degradeToFit` then dropped the business block and the persona block
 * to make room for schemas that were never sent — on every turn, on any box
 * carrying durable memory facts.
 *
 * The fix is one shared derivation. These tests are what stop it drifting
 * apart again: the source-level assertions below fail if either site goes back
 * to deriving the advertised set for itself.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";
import { TOOLS, TOOL_CATALOG } from "@droplet/tools-core";

import { EXCLUDED_FROM_CHAT_TOOLS } from "./chat-tool-scope.js";
import {
  narrowToolNamesToScope,
  type ToolAccessScope,
} from "./tool-access.service.js";
import {
  conversationToolNamesFor,
  effectiveAdvertisedToolNames,
  lastUserMessageText,
} from "./tool-selection.service.js";

const POOL = [...TOOLS.values()]
  .map((t) => t.name)
  .filter((n) => !EXCLUDED_FROM_CHAT_TOOLS.has(n));

function sourceOf(rel: string): string {
  return readFileSync(join(process.cwd(), "src", rel), "utf8");
}

const ROUTE_SRC = sourceOf("routes/llm.ts");
const LOOP_SRC = sourceOf("services/llm-agent.service.ts");

describe("one derivation, two call sites", () => {
  it("neither the route nor the loop calls the raw selector directly", () => {
    // THE drift guard. `selectAdvertisedTools` takes already-derived inputs,
    // so a caller that reaches for it has to derive `userMessage` and
    // `conversationToolNames` itself — which is exactly how the two sites
    // stopped agreeing. Both must go through `effectiveAdvertisedToolNames`.
    //
    // Mutation: put `selectAdvertisedTools({…})` back into either file → red.
    expect(ROUTE_SRC).not.toContain("selectAdvertisedTools");
    expect(LOOP_SRC).not.toContain("selectAdvertisedTools");
    expect(ROUTE_SRC).toContain("effectiveAdvertisedToolNames");
    expect(LOOP_SRC).toContain("effectiveAdvertisedToolNames");
  });

  it("the route sizes the advertised subset, not the whole pool", () => {
    // Mutation: serialize `effectiveTools` instead of the filtered subset →
    // red, and the ~11.5K-token phantom comes straight back.
    expect(ROUTE_SRC).toMatch(
      /effectiveTools\s*\n?\s*\.filter\(\(t\) => advertisedNamesForEstimate\.has\(t\.name\)\)/,
    );
  });

  it("the route passes the configured mode, so `off` still sizes everything", () => {
    // Under TOOL_SELECTION_MODE=off the pool genuinely IS the wire payload.
    // Hardcoding "domains" here would under-charge the one mode that needs
    // the full estimate. Mutation: replace with a literal → red.
    expect(ROUTE_SRC).toContain("mode: config.TOOL_SELECTION_MODE");
  });
});

describe("the derivation itself", () => {
  it("reads the LAST user message, ignoring assistant turns after it", () => {
    expect(
      lastUserMessageText([
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "second" },
      ]),
    ).toBe("second");
  });

  it("yields '' for a multimodal turn rather than throwing or stringifying", () => {
    // An image attachment makes `content` an array. Rule matching only reads
    // text, so the turn falls back to core-only advertisement — an accepted
    // gap the WARP-642 self-heal branch covers.
    // Mutation: `String(content)` → this returns "[object Object]" and the
    // rules start matching on punctuation → red.
    expect(lastUserMessageText([{ role: "user", content: [{ type: "image" }] }])).toBe("");
    expect(lastUserMessageText([])).toBe("");
  });

  it("unions continuity across earlier TURNS and earlier ITERATIONS", () => {
    // Both sources are required (WARP-1921): zod strips `tool_calls` from
    // replayed messages, so earlier turns can only arrive via priorToolNames.
    // Mutation: drop either arm → red.
    expect(
      conversationToolNamesFor(
        ["search_content"],
        [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            tool_calls: [{ function: { name: "list_files" } }],
          },
        ],
      ),
    ).toEqual(["search_content", "list_files"]);
  });

  it("returns the pool untouched under `off`", () => {
    // Mutation: narrow under `off` too → the rollback lever silently stops
    // advertising the whole registry, which is the only thing it is for.
    const all = effectiveAdvertisedToolNames({
      mode: "off",
      messages: [{ role: "user", content: "anything" }],
      pool: POOL,
    });
    expect(all.size).toBe(POOL.length);
  });
});

describe("selection actually shrinks the advertisement", () => {
  const serialize = (names: Set<string>): number =>
    JSON.stringify(
      [...TOOLS.values()]
        .filter((t) => names.has(t.name))
        .map((t) => ({
          type: "function" as const,
          function: {
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
          },
        })),
    ).length;

  it("a real turn advertises a small fraction of the pool", () => {
    // The number that matters. Before the fix the estimate charged for all of
    // POOL on every turn; a selected turn is a fraction of it.
    // Mutation: make the estimator size the pool again → this ratio goes to 1.
    const selected = effectiveAdvertisedToolNames({
      mode: "domains",
      messages: [{ role: "user", content: "what deals are in the pipeline?" }],
      pool: POOL,
    });
    const poolChars = serialize(new Set(POOL));
    const turnChars = serialize(selected);
    expect(turnChars).toBeLessThan(poolChars / 2);
    expect(selected.size).toBeLessThan(POOL.length);
  });
});

describe("the crm domain is reachable (WARP-2546)", () => {
  // Registering seven tools that no rule can match spends context budget on
  // capability the model never sees. This is the third instance of the class:
  // WARP-2058 fixed it for `pm`, WARP-2454 for `team_chat`.
  const CRM_TURNS = [
    "what deals are in the pipeline?",
    "show me my customers",
    "which clients have gone quiet?",
    "any leads worth a follow-up?",
    "which deals did we win last quarter?",
  ];

  for (const message of CRM_TURNS) {
    it(`advertises crm tools for: ${message}`, () => {
      // Mutation: delete the crm DOMAIN_RULES entry → every one of these goes
      // red, reproducing the ship-it-dead state exactly.
      const selected = effectiveAdvertisedToolNames({
        mode: "domains",
        messages: [{ role: "user", content: message }],
        pool: POOL,
      });
      const crm = [...selected].filter((n) => n.startsWith("crm_"));
      expect(crm.length).toBeGreaterThan(0);
    });
  }

  it("does not advertise crm tools for an unrelated turn", () => {
    // The rules are keyword-based, so over-claiming is the other failure mode.
    // Mutation: widen the crm pattern to something like /\w+/ → red.
    const selected = effectiveAdvertisedToolNames({
      mode: "domains",
      messages: [{ role: "user", content: "turn the kitchen lights off" }],
      pool: POOL,
    });
    expect([...selected].filter((n) => n.startsWith("crm_"))).toEqual([]);
  });

  it("matches whole words only — 'won' must not fire inside 'wondering'", () => {
    // The rule was written once without \b word boundaries and matched
    // substrings. Mutation: drop the \b anchors → red.
    const selected = effectiveAdvertisedToolNames({
      mode: "domains",
      messages: [{ role: "user", content: "I was wondering about the weather" }],
      pool: POOL,
    });
    expect([...selected].filter((n) => n.startsWith("crm_"))).toEqual([]);
  });

  it.each([
    "did we win the game last night",
    "I lost my keys again",
    "we won the pub quiz",
  ])("does not fire on ordinary English: %s", (message) => {
    // WARP-2556 — `won` / `win` / `lost` used to be claimed BARE, so each of
    // these advertised six CRM schemas on a turn that wanted none. The words
    // bought little: a real CRM sentence reaches the domain through `deals?`
    // ("which deals did we win last quarter"), asserted above.
    //
    // Mutation: put `won|win|lost` back into the crm pattern → all three red.
    const selected = effectiveAdvertisedToolNames({
      mode: "domains",
      messages: [{ role: "user", content: message }],
      pool: POOL,
    });
    expect([...selected].filter((n) => n.startsWith("crm_"))).toEqual([]);
  });
});

describe("the pool is scope-narrowed before it is sized (WARP-2556)", () => {
  // WARP-2497 filtered the estimate's pool through `toolAllowedInScope`.
  // WARP-2552 replaced the same block with the shared-helper estimate, and the
  // conflict resolution kept the better estimate and lost the scope narrowing
  // with the version it replaced — for one role+scope combination the estimate
  // went back to being sized against tools the wire never carries.
  //
  // Nothing went red, because every fixture in this file was UNSCOPED. These
  // tests are the scoped one.

  const scopeOf = (domains: string[], writeDomains: string[] = []): ToolAccessScope => ({
    domains: new Set(domains),
    writeDomains: new Set(writeDomains),
    locks: false,
  });

  // Read the CRM domain off the catalog rather than hardcoding "crm" — the
  // catalog is the thing under test's own source of truth.
  const CRM_DOMAIN = TOOL_CATALOG.find((t) => t.name.startsWith("crm_"))?.domain;
  const CRM_IN_POOL = POOL.filter((n) => n.startsWith("crm_"));

  it("the CRM tools this fixture depends on are actually in the chat pool", () => {
    // Guards the two tests below against passing because CRM left the pool.
    expect(CRM_DOMAIN).toBeDefined();
    expect(CRM_IN_POOL.length).toBeGreaterThan(0);
  });

  it("a scope without the CRM domain advertises no CRM tool, even on a CRM question", () => {
    // The role is scoped away from CRM, so `crm_*` cannot be dispatched. Sizing
    // them into the estimate charges the window for schemas the model will
    // never see — the WARP-2552 phantom, reopened per-scope.
    //
    // Mutation: drop the `toolAllowedInScope` filter in routes/llm.ts (i.e.
    // pass `pooledTools` straight through) → the route's pool contains crm_*
    // again and the source assertion below goes red.
    const scope = scopeOf(["general"]);
    const narrowedPool = narrowToolNamesToScope(POOL, scope);
    const selected = effectiveAdvertisedToolNames({
      mode: "domains",
      messages: [{ role: "user", content: "what deals are in the pipeline?" }],
      pool: narrowedPool,
    });
    expect([...selected].filter((n) => n.startsWith("crm_"))).toEqual([]);
  });

  it("the SAME question does advertise CRM tools when the scope allows it", () => {
    // Without this, the test above passes for a board that advertises nothing
    // at all, and the scope filter could be deleted again unnoticed.
    const scope = scopeOf([CRM_DOMAIN!]);
    const narrowedPool = narrowToolNamesToScope(POOL, scope);
    const selected = effectiveAdvertisedToolNames({
      mode: "domains",
      messages: [{ role: "user", content: "what deals are in the pipeline?" }],
      pool: narrowedPool,
    });
    expect([...selected].filter((n) => n.startsWith("crm_")).length).toBeGreaterThan(0);
  });

  it("the route narrows the pool by scope before deriving the advertised set", () => {
    // The behavioural tests above prove the composition is right; this one
    // proves the ROUTE performs it. It is the assertion whose absence let the
    // filter be dropped in a merge.
    //
    // Mutation: delete the `effectiveTools` narrowing, or size
    // `pooledTools` instead → red.
    //
    // Pinned against the SHARED helper rather than an inline
    // `pooledTools.filter((t) => toolAllowedInScope(...))`: the route used to
    // re-express the rule locally, which is the duplication that let the
    // estimate and dispatch sides drift apart. `narrowToolsToScope` is now the
    // single expression of it, and `tool-access.service.test.ts` pins its
    // behaviour — including that an absent scope narrows nothing.
    expect(ROUTE_SRC).toMatch(/narrowToolsToScope\(pooledTools, toolAccessScope\)/);
    expect(ROUTE_SRC).toContain("pool: effectiveTools.map((t) => t.name)");
  });

  it("the estimate and the dispatch narrow through the SAME helper", () => {
    // The real anti-drift guard, and the one whose absence let WARP-2556
    // happen: it is not enough that each side narrows: they have to narrow by
    // one shared expression, or a new access axis can be added to one and
    // missed in the other with nothing going red.
    //
    // Mutation: re-inline `toolAllowedInScope` at either site → red.
    expect(ROUTE_SRC).toContain("narrowToolsToScope");
    expect(LOOP_SRC).toContain("narrowToolsToScope");
    for (const src of [ROUTE_SRC, LOOP_SRC]) {
      expect(src).not.toMatch(/\.filter\(\([a-z]+\) => toolAllowedInScope\(/);
    }
  });
});
