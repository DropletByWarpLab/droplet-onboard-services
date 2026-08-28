/**
 * WARP-2447 — the selection-quality regression harness.
 *
 * Selection's failure mode is invisible from the outside: a subset that omits
 * the needed tool looks EXACTLY like a model that chose not to use it. There
 * is no error, no log, no user-visible signal — just an agent that seems
 * dimmer than it was. The only defence is a corpus of turns where the
 * required tool is known in advance.
 *
 * TESTING DISCIPLINE (inherited from tool-selection.service.test.ts): every
 * turn below is phrased as a sentence a household member would plausibly
 * TYPE, never assembled from the vocabulary already inside the matching
 * regex. Asserting with the pattern's own words is a tautology — it is
 * exactly what let the WARP-1921 `people` gap ship green.
 *
 * TEETH: the harness must fail when selection is deliberately made too
 * narrow, or it is decorative. `narrowToSingleTool` below is that mutation,
 * run as a test rather than described in a comment.
 */
import { describe, it, expect } from "vitest";
import { TOOLS } from "@droplet/tools-core";
import { EXCLUDED_FROM_CHAT_TOOLS } from "./chat-tool-scope.js";
import { selectAdvertisedTools } from "./tool-selection.service.js";
import type { RuntimeToolDescriptor } from "./runtime-tool-registry.service.js";
import {
  assertToolAdvertisementFitsBudget,
  toAdvertisedSpec,
} from "./tool-budget.service.js";

/** The shipping default chat pool: registry minus the policy exclusions. */
const CHAT_POOL: string[] = Array.from(TOOLS.values())
  .map((t) => t.name)
  .filter((n) => !EXCLUDED_FROM_CHAT_TOOLS.has(n));

/**
 * Remote tools for the dynamic half of the corpus.
 *
 * `jira_search_issues` is SERVER-derived into `pm`. `confluence_search` is
 * OPERATOR-mapped into `files` — a deliberate second case, because an
 * operator remapping a server's domain is one of the three assignment routes
 * WARP-2444 names, and a harness that only covers the server-derived route
 * would leave it untested.
 */
const REMOTE_TOOLS: RuntimeToolDescriptor[] = [
  {
    name: "jira_search_issues",
    serverId: "atlassian",
    domain: "pm",
    domainSource: "server",
    description: "Search Jira issues with a JQL query.",
    inputSchema: {
      type: "object",
      properties: { jql: { type: "string", description: "JQL query." } },
    },
  },
  {
    name: "confluence_search",
    serverId: "atlassian",
    domain: "files",
    domainSource: "operator",
    description: "Search Confluence pages with a CQL query.",
    inputSchema: {
      type: "object",
      properties: { cql: { type: "string", description: "CQL query." } },
    },
  },
  {
    name: "slack_send_message",
    serverId: "slack",
    domain: "team_chat",
    domainSource: "server",
    description: "Post a message to a Slack channel.",
    inputSchema: {
      type: "object",
      properties: { channel: { type: "string", description: "Channel id." } },
    },
  },
];

const POOL_WITH_REMOTE = [...CHAT_POOL, ...REMOTE_TOOLS.map((t) => t.name)];

interface Turn {
  label: string;
  message: string;
  /** The tool this turn genuinely needs. Selection must not drop it. */
  requires: string;
  /** Prior calls in the conversation, for continuity turns. */
  priorCalls?: string[];
  /** True when `requires` is a runtime-registered remote tool. */
  remote?: boolean;
}

/**
 * The corpus. 14 turns spanning 12 domains, of which 3 require a remote tool.
 * Phrased as real sentences; the required tool is named from the shipping
 * catalog, so a turn goes red the moment selection stops reaching it.
 */
const TURNS: Turn[] = [
  {
    label: "files / find a document by what it is",
    message: "I need the invoice from the plumber, can you dig it out?",
    requires: "search_files",
  },
  {
    label: "cameras / the sentence a household actually types",
    message: "did anyone come to the house while we were out on Saturday?",
    requires: "list_camera_events",
  },
  {
    label: "smart-home / plain control",
    message: "it's freezing in here, can you turn the heating up",
    requires: "control_device",
  },
  {
    label: "network / who is connected",
    message: "the internet is crawling, what's hogging it?",
    requires: "list_network_devices",
  },
  {
    label: "calendar / what is coming up",
    message: "what's on my schedule for tomorrow?",
    requires: "list_events",
  },
  {
    label: "reminders / a spoken to-do",
    message: "don't forget I need to call the plumber back",
    requires: "create_reminder",
  },
  {
    label: "email / find correspondence",
    message: "check my inbox for anything from the accountant",
    requires: "email_search",
  },
  {
    label: "memory / retract something previously said",
    message: "forget what I told you about the car, it's sold",
    requires: "memory_forget",
  },
  {
    label: "system / capacity question",
    message: "are we running out of disk space on the box?",
    requires: "list_drives",
  },
  {
    label: "data / everyday utility",
    message: "what's the weather doing today?",
    requires: "get_weather",
  },
  {
    label: "business / the shop's own details",
    message: "remind me what our opening hours are on a Sunday",
    requires: "business_profile_get",
  },
  {
    label: "pm / local tracker",
    message: "set up a new project for the kitchen remodel",
    requires: "pm_create_project",
  },
  {
    label: "REMOTE pm / server-derived domain",
    message: "which tickets are still open on the tracker?",
    requires: "jira_search_issues",
    remote: true,
  },
  {
    label: "REMOTE files / operator-mapped domain",
    message: "find the onboarding document for new starters",
    requires: "confluence_search",
    remote: true,
  },
  {
    label: "REMOTE team_chat / reached by continuity",
    message: "and post that where the team will see it",
    requires: "slack_send_message",
    priorCalls: ["slack_send_message"],
    remote: true,
  },
];

const select = (t: Turn) =>
  selectAdvertisedTools({
    mode: "domains",
    userMessage: t.message,
    pool: POOL_WITH_REMOTE,
    conversationToolNames: t.priorCalls ?? [],
    runtimeTools: REMOTE_TOOLS,
  }).advertised;

describe("WARP-2447 — selection never drops the tool the turn needed", () => {
  it("covers at least 10 turns, of which at least 2 require a remote tool", () => {
    // Guards the harness's own coverage contract. MUTATION: delete turns
    // until the corpus is thin and this goes red before the suite quietly
    // stops testing anything.
    expect(TURNS.length).toBeGreaterThanOrEqual(10);
    expect(TURNS.filter((t) => t.remote).length).toBeGreaterThanOrEqual(2);
    const domainsCovered = new Set(TURNS.map((t) => t.label.split(" /")[0]));
    expect(domainsCovered.size).toBeGreaterThanOrEqual(10);
  });

  it("every required tool is actually reachable in the pool", () => {
    // Non-vacuity: a turn requiring a tool that is not in the pool at all
    // would be asserting nothing about SELECTION. This catches a typo or a
    // tool that got excluded upstream.
    for (const t of TURNS) {
      expect(POOL_WITH_REMOTE, `${t.label}: "${t.requires}" not in pool`).toContain(
        t.requires,
      );
    }
  });

  for (const t of TURNS) {
    it(`selects ${t.requires} for: ${t.label}`, () => {
      const advertised = select(t);
      expect(
        advertised,
        `turn "${t.message}" requires ${t.requires}, but selection ` +
          `advertised ${advertised.length} tools without it. A turn whose ` +
          `tool is missing looks identical to a model that declined to use ` +
          `it — that is the failure this harness exists to make visible.`,
      ).toContain(t.requires);
    });
  }

  it("MUTATION — narrowing selection to a single tool turns the harness red", () => {
    // The ticket's teeth check, executed. If an over-narrow selection did NOT
    // break at least one turn, the harness would be measuring nothing.
    const narrowToSingleTool = (t: Turn) => select(t).slice(0, 1);

    const broken = TURNS.filter(
      (t) => !narrowToSingleTool(t).includes(t.requires),
    );
    expect(
      broken.length,
      "an over-narrow selection broke no turn — the harness has no teeth",
    ).toBeGreaterThan(0);
    // In practice it breaks nearly all of them; assert generously so the
    // check is about discrimination, not about an exact count that would
    // rot as the corpus grows.
    expect(broken.length).toBeGreaterThanOrEqual(TURNS.length - 2);
  });

  it("MUTATION — dropping the runtime universe breaks exactly the remote turns", () => {
    // Proves the remote turns are carried by the WARP-2443 change and not by
    // some accident of the pool. Without `runtimeTools`, remote tools have no
    // domain and vanish — today's silent defect, reproduced on demand.
    const withoutRuntime = (t: Turn) =>
      selectAdvertisedTools({
        mode: "domains",
        userMessage: t.message,
        pool: POOL_WITH_REMOTE,
        conversationToolNames: t.priorCalls ?? [],
      }).advertised;

    for (const t of TURNS) {
      const advertised = withoutRuntime(t);
      if (t.remote) {
        expect(advertised, `${t.label} should lose its remote tool`).not.toContain(
          t.requires,
        );
      } else {
        expect(advertised, `${t.label} must be unaffected`).toContain(t.requires);
      }
    }
  });

  it("every turn's selection fits the serialised budget", () => {
    // Selection quality is only half the promise; a turn that reaches the
    // right tool but overflows the window still fails the user. Ties the
    // harness to the WARP-2445 gate on real turns rather than synthetic ones.
    const specByName = new Map(
      [
        ...Array.from(TOOLS.values()).map((t) => [t.name, toAdvertisedSpec(t)] as const),
        ...REMOTE_TOOLS.map((t) => [t.name, toAdvertisedSpec(t)] as const),
      ],
    );
    for (const t of TURNS) {
      const specs = select(t)
        .map((n) => specByName.get(n))
        .filter((s): s is NonNullable<typeof s> => Boolean(s));
      expect(
        () => assertToolAdvertisementFitsBudget({ specs }),
        `${t.label} produced an over-budget advertisement`,
      ).not.toThrow();
    }
  });

  it("selection is stable across repeated runs of the whole corpus", () => {
    const first = TURNS.map((t) => select(t));
    const second = TURNS.map((t) => select(t));
    expect(second).toEqual(first);
  });
});

/**
 * KNOWN GAPS this harness surfaced — recorded, not fixed.
 *
 * Building the corpus above turned up three sentences that a household would
 * plainly type and that today's keyword rules do not match at all. They are
 * the same class of defect as the WARP-1921 "people" gap and the WARP-2058
 * missing-`pm`-rule gap: the turn advertises the floor and nothing else, the
 * model has no way to answer, and there is no error anywhere.
 *
 * They are PRE-EXISTING and out of WARP-2348's scope — this story is about
 * per-turn selection over an over-subscribed window and a dynamic universe,
 * not about widening the local vocabulary. Fixing them here would also mean
 * shipping a behaviour change nobody asked for inside a budget story.
 *
 * But leaving them only in a report means they evaporate. So they are pinned
 * as assertions of CURRENT behaviour. When someone widens the rules, these go
 * red — which is the prompt to delete the entry and move the sentence up into
 * `TURNS` where it belongs. A red here is GOOD NEWS.
 */
describe("known selection gaps (pre-existing, recorded not fixed)", () => {
  const gaps = [
    {
      label: "files — a document named by what it IS, not by the word 'document'",
      message: "where did I put the signed lease agreement?",
      wants: "search_files",
      why: "the files rule lists container words (files/docs/pdf/invoices) but no rule matches a document named only by its subject.",
    },
    {
      label: "calendar — availability phrased as 'am I free'",
      message: "am I free Thursday afternoon?",
      wants: "list_events",
      why: "the calendar rule has the literal 'free time' but not bare 'free', so the most natural availability question misses.",
    },
    {
      label: "email — 'reply' (the regex only matches 'replied')",
      message: "did the accountant ever reply about the VAT return?",
      wants: "email_search",
      why: "the email rule's `replied?` alternation matches 'replied' and 'replie' but NOT 'reply' or 'replies'. Almost certainly meant to be repl(y|ies|ied).",
    },
  ];

  for (const g of gaps) {
    it(`STILL MISSES: ${g.label}`, () => {
      const advertised = selectAdvertisedTools({
        mode: "domains",
        userMessage: g.message,
        pool: POOL_WITH_REMOTE,
        conversationToolNames: [],
        runtimeTools: REMOTE_TOOLS,
      }).advertised;
      expect(
        advertised,
        `GOOD NEWS IF RED: "${g.message}" now reaches ${g.wants}. ` +
          `Reason it did not: ${g.why} Move this case into TURNS and delete ` +
          `it from the gap list.`,
      ).not.toContain(g.wants);
    });
  }

  it("the email rule's `replied?` alternation is the specific bug named above", () => {
    // Isolated so the diagnosis is not folded into a selection assertion:
    // this is a regex defect, independent of any pool or turn.
    const emailRule = /\b(e-?mails?|inbox|newsletters?|unread|spam|replied?|sent)\b/i;
    expect(emailRule.test("did she reply")).toBe(false);
    expect(emailRule.test("any replies")).toBe(false);
    expect(emailRule.test("she replied")).toBe(true);
  });
});
