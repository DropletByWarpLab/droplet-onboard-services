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
    //
    // ADR-045 slice D added `pm`, deliberately and with the documentation
    // this assertion demands (see the KNOWN OVERLAP block in
    // chat-tool-scope.ts). Every local pm WRITE collapsed into `business_*`
    // and the reads were already excluded, so the domain is empty LOCALLY.
    // The rule is kept because it still does two jobs: remote Atlassian pm
    // tools (WARP-2316) reach chat through it, and it now also claims
    // `business`, so a tracker sentence advertises the collapsed writes.
    // ADR-045 added BOTH `crm` and `pm`, deliberately and with the
    // documentation this assertion demands (see chat-tool-scope.ts's KNOWN
    // OVERLAP block). Slice C moved every CRM and PM read into `business_find`
    // / `business_timeline`; slice D moved every write into
    // `business_create` / `business_update`. Neither domain holds a local tool
    // any more, and both rules are retained because they are the route a
    // REMOTE Atlassian or HubSpot catalog becomes selectable, and because they
    // now also claim the `business` domain — "add a ticket for the broken
    // dishwasher" is a pm sentence that has to reach `business_create`.
    expect(deadRules).toEqual(["crm", "notifications", "pm"]);
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

  it("the pm rule still reaches a write tool — it just is not a pm_* one any more", () => {
    // ADR-045 slice D. The pm domain is empty LOCALLY (asserted above), so
    // the danger is that someone reads that and deletes the rule. This is
    // the test that goes red if they do: a tracker sentence must still put
    // a write verb in front of the model, and after the collapse that verb
    // lives in the `business` domain.
    //
    // MUTATION: drop `"business"` from the pm rule's `domains` → red, and
    // the product regresses to an assistant that can talk about a tracker
    // it cannot write to.
    const inScope = inScopeByDomain();
    expect(inScope.get("pm") ?? []).toEqual([]);
    expect(inScope.get("business")).toContain("business_create");

    const r = selectAdvertisedTools({
      mode: "domains",
      userMessage: "start a new project for the kitchen remodel",
      pool: chatPool(),
      conversationToolNames: [],
    });
    expect(r.matchedDomains).toContain("pm");
    expect(r.advertised).toContain("business_create");
    expect(r.advertised).toContain("business_update");
    // ...and the same for the CRM half of the collapse, through the crm rule.
    const deal = selectAdvertisedTools({
      mode: "domains",
      userMessage: "move the Acme deal to negotiation",
      pool: chatPool(),
      conversationToolNames: [],
    });
    expect(deal.advertised).toContain("business_update");
    // business_link is policy-excluded, so no turn may advertise it.
    expect(deal.advertised).not.toContain("business_link");
  });

  it("fully-excluded domains have no rule promising what the pool cannot deliver", () => {
    const inScope = inScopeByDomain();
    const fullyExcluded = TOOL_CATALOG.map((e) => e.domain).filter(
      (d, i, a) => a.indexOf(d) === i && (inScope.get(d) ?? []).length === 0,
    );
    // ADR-045 — `crm` and `pm` are NOT in this set, and the distinction is
    // worth stating because it looks like an omission. `fullyExcluded` is
    // derived from TOOL_CATALOG, so it can only name a domain that HAS local
    // tools which are all excluded. `crm` and `pm` have no catalog entries at
    // all now — they are EMPTY, which is a different condition, and the
    // deadRules assertion above is the one that catches it.
    expect([...fullyExcluded].sort()).toEqual([
      "erp",
      // WARP-2581 — money joins them: its one tool is excluded while the
      // base-prompt budget tripwire stands (WARP-2547 owns the re-baseline),
      // so a rule here would promise the model a tool it can never be offered.
      "money",
      "notifications",
      "switch",
    ]);
    // switch, erp and money are ruleless, which is the coherent state.
    expect(RULED_DOMAINS.has("switch")).toBe(false);
    expect(RULED_DOMAINS.has("erp")).toBe(false);
    expect(RULED_DOMAINS.has("money")).toBe(false);
    // ADR-045 — `pm` is the deliberate exception: locally EMPTY and yet ruled,
    // because the rule reaches remote tools and the `business` domain where
    // the writes went. Asserting it here stops a future reader "tidying" the
    // rule away on the strength of the emptiness above.
    expect(RULED_DOMAINS.has("pm")).toBe(true);
    expect(RULED_DOMAINS.has("business")).toBe(true);
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
