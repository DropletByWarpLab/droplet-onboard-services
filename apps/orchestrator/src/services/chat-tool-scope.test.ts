/**
 * WARP-2448 — the two-mechanism interaction, asserted.
 *
 * `EXCLUDED_FROM_CHAT_TOOLS` (policy: what chat may do at all) and per-turn
 * selection (relevance: what this sentence needs) both shrink the prompt. The
 * ticket's worry is that leaving them overlapping and undocumented guarantees
 * the next engineer tunes one and is surprised by the other.
 *
 * The resolution taken is RETAIN + DOCUMENT (see chat-tool-scope.ts's header
 * for why policy cannot be folded into relevance). This file is the half of
 * that resolution a comment cannot provide: it recomputes the overlap on every
 * run, so the documented state either stays true or CI says so.
 */
import { describe, it, expect } from "vitest";
import { TOOLS, TOOL_CATALOG, type ToolDomain } from "@droplet/tools-core";
import { EXCLUDED_FROM_CHAT_TOOLS } from "./chat-tool-scope.js";
import {
  selectAdvertisedTools,
  RULED_DOMAINS,
  CORE_TOOL_NAMES,
} from "./tool-selection.service.js";
import type { RuntimeToolDescriptor } from "./runtime-tool-registry.service.js";

/** The default chat POOL: the registry minus the policy exclusions. */
const chatPool = (): string[] =>
  Array.from(TOOLS.values())
    .map((t) => t.name)
    .filter((n) => !EXCLUDED_FROM_CHAT_TOOLS.has(n));

/** In-scope tool names per domain, after the policy layer has run. */
function inScopeByDomain(): Map<ToolDomain, string[]> {
  const pool = new Set(chatPool());
  const m = new Map<ToolDomain, string[]>();
  for (const e of TOOL_CATALOG) {
    if (!pool.has(e.name)) continue;
    const list = m.get(e.domain) ?? [];
    list.push(e.name);
    m.set(e.domain, list);
  }
  return m;
}

describe("EXCLUDED_FROM_CHAT_TOOLS is the POLICY layer, selection is the RELEVANCE layer", () => {
  it("an excluded tool is never selected, on any turn, in any domain", () => {
    // The layering contract: the pool is selection's ceiling. Selection is
    // handed the already-narrowed pool, so it CANNOT re-admit a policy
    // exclusion — even on the turn most likely to want it.
    //
    // MUTATION: have the agent loop pass the full registry as `pool` instead
    // of the chat-scoped pool and this goes red.
    const pool = chatPool();
    const turns = [
      "delete the clip from the front door camera",
      "show me the switch VLANs and set port 4 to VLAN 20",
      "run a regex test and hash this text for me",
      "apply the update and list the storage pools",
      "send me a notification about it",
    ];
    for (const userMessage of turns) {
      const r = selectAdvertisedTools({
        mode: "domains",
        userMessage,
        pool,
        conversationToolNames: [],
      });
      for (const name of r.advertised) {
        expect(EXCLUDED_FROM_CHAT_TOOLS.has(name)).toBe(false);
      }
    }
    // Named specimens, so the assertion is not vacuous if `advertised` were
    // ever empty.
    expect(EXCLUDED_FROM_CHAT_TOOLS.has("delete_clip")).toBe(true);
    expect(pool).not.toContain("delete_clip");
  });

  it("even an explicit prior call cannot re-admit an excluded tool", () => {
    // Continuity re-opens a DOMAIN, which is the most plausible route by
    // which an excluded tool might sneak back in.
    const r = selectAdvertisedTools({
      mode: "domains",
      userMessage: "and now delete it",
      pool: chatPool(),
      conversationToolNames: ["list_clips", "delete_clip"],
      });
    expect(r.advertised).not.toContain("delete_clip");
    // ...while the domain IS re-opened, proving continuity ran at all.
    expect(r.matchedDomains).toContain("cameras");
    expect(r.advertised).toContain("list_clips");
  });

  it("records exactly which domains have a rule that advertises no local tool", () => {
    // WARP-2448 AC: "no tool is unreachable for two different reasons at once
    // without that being documented." This computes the set rather than
    // trusting the header comment, so the two cannot drift.
    const inScope = inScopeByDomain();
    const deadRules = [...RULED_DOMAINS]
      .filter((d) => (inScope.get(d) ?? []).length === 0)
      .sort();

    // `notifications`: both send_notification and list_notifications are
    // excluded, yet the notify/alerts rule matches. Documented in
    // chat-tool-scope.ts. If this set GROWS, someone has added a rule for a
    // domain the policy layer removes entirely — document it there or drop
    // the rule.
    expect(deadRules).toEqual(["notifications"]);
  });

  it("records exactly which domains have in-scope tools but NO rule to advertise them", () => {
    // WARP-2552 — the INVERSE of the assertion above, and the half that was
    // missing. The test before this one catches "a rule that reaches no tool";
    // nothing caught "a tool no rule can reach", which is the strictly worse
    // failure: the schemas are serialized into the pool, charged against the
    // context budget on every turn, and advertised to the model on NONE.
    //
    // This has now happened three times — WARP-2058 for `pm`, WARP-2454 for
    // `team_chat`, and WARP-2546 shipped seven `crm_*` tools with no `crm`
    // rule. Each was found by hand, after the fact. This finds the fourth at
    // commit time.
    //
    // Mutation: delete the `crm` entry from DOMAIN_RULES → `crm` appears in
    // this set → red.
    const inScope = inScopeByDomain();
    const unreachable = [...inScope.entries()]
      .filter(([domain, tools]) => tools.length > 0 && !RULED_DOMAINS.has(domain))
      .map(([domain]) => domain)
      .sort();

    // Empty is the only correct answer. A domain whose tools are in the chat
    // pool must have SOME rule that can advertise them — otherwise exclude the
    // tools from the pool instead, so they stop costing budget for nothing.
    expect(unreachable).toEqual([]);
  });

  it("the pm rule is NOT dead — WARP-2058's comment is stale", () => {
    // Recorded because the obvious reading of the exclusion list is that
    // every pm_* tool is gone. Nine of ten are; pm_create_project is not.
    const inScope = inScopeByDomain();
    expect(inScope.get("pm")).toEqual(["pm_create_project"]);

    const r = selectAdvertisedTools({
      mode: "domains",
      userMessage: "start a new project for the kitchen remodel",
      pool: chatPool(),
      conversationToolNames: [],
    });
    expect(r.advertised).toContain("pm_create_project");
  });

  it("fully-excluded domains have no rule promising what the pool cannot deliver", () => {
    const inScope = inScopeByDomain();
    const fullyExcluded = TOOL_CATALOG.map((e) => e.domain).filter(
      (d, i, a) => a.indexOf(d) === i && (inScope.get(d) ?? []).length === 0,
    );
    expect([...fullyExcluded].sort()).toEqual([
      "erp",
      "notifications",
      "switch",
    ]);
    // switch and erp are ruleless, which is the coherent state.
    expect(RULED_DOMAINS.has("switch")).toBe(false);
    expect(RULED_DOMAINS.has("erp")).toBe(false);
  });

  it("the exclusion list governs LOCAL tools only — a remote tool in a stripped domain is still selectable", () => {
    // This is why the notifications/pm rules are kept rather than deleted:
    // they are the route by which a REMOTE catalog becomes reachable. A
    // remote tool never passes through EXCLUDED_FROM_CHAT_TOOLS.
    const remoteNotifier: RuntimeToolDescriptor = {
      name: "pagerduty_list_alerts",
      serverId: "pagerduty",
      domain: "notifications",
      domainSource: "server",
      description: "List current alerts.",
      inputSchema: { type: "object", properties: {} },
    };
    const r = selectAdvertisedTools({
      mode: "domains",
      userMessage: "any alerts I should know about?",
      pool: [...chatPool(), "pagerduty_list_alerts"],
      conversationToolNames: [],
      runtimeTools: [remoteNotifier],
    });
    expect(r.advertised).toContain("pagerduty_list_alerts");
    // ...while the LOCAL notifications tools stay excluded on the same turn.
    expect(r.advertised).not.toContain("send_notification");
    expect(r.advertised).not.toContain("list_notifications");
  });

  it("every excluded name that is registered is genuinely out of the pool", () => {
    // Names in the list that are not registered are inert by design; the ones
    // that ARE registered must actually be removed.
    const registered = new Set(TOOLS.keys());
    const pool = new Set(chatPool());
    const live = [...EXCLUDED_FROM_CHAT_TOOLS].filter((n) => registered.has(n));
    expect(live.length).toBeGreaterThan(0);
    for (const n of live) expect(pool.has(n)).toBe(false);
  });

  it("the floor survives the policy layer — no core tool is excluded", () => {
    // A floor tool that the policy layer removes would be unreachable for two
    // reasons at once, which is precisely the state this ticket forbids.
    for (const name of CORE_TOOL_NAMES) {
      expect(
        EXCLUDED_FROM_CHAT_TOOLS.has(name),
        `${name} is in the always-advertised floor AND excluded from chat`,
      ).toBe(false);
    }
  });
});
