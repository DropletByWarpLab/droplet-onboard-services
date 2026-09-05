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
// add-llm-tool:gate — WARP-2496 / WARP-2612: this test asserts on a site an
// agent edits when ADDING a tool, so the `add-llm-tool` skill must name every
// repo file it reads. Drop the pragma and it stops being derived from.

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
 * The corpus. 19 turns, of which 4 require a remote tool — the last four
 * added by WARP-2454, which fixed the rules that used to miss them.
 * Phrased as real sentences; the required tool is named from the shipping
 * catalog, so a turn goes red the moment selection stops reaching it.
 *
 * The coverage floor is asserted below rather than stated here, so growing
 * the corpus does not require remembering to update a count in a comment.
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
    // ADR-045 slice D — the same sentence, the same rule, a different tool.
    // This turn is now the end-to-end proof that the collapse did not make
    // the tracker unreachable: the sentence matches the `pm` rule, the pm
    // domain is locally empty, and the write verb arrives only because that
    // rule also claims `business`. Run it against a DOMAIN_RULES that lost
    // that claim and it is red — which is the point of keeping it here
    // rather than only in the unit test.
    //
    // Label prefix left as `pm` on purpose: the harness derives its
    // domain-coverage floor from the prefix, and `business` is already
    // covered by the opening-hours turn above.
    label: "pm / local tracker, through the collapsed write verb",
    message: "set up a new project for the kitchen remodel",
    requires: "business_create",
  },
  // ── ADR-045 slice C — the business graph, reached from BOTH vocabularies ──
  //
  // The collapse joined two suites that used to be reached by two different
  // rules. Both entry points get a whole sentence, because a graph read that
  // only the CRM half of the vocabulary can reach is half a collapse.
  {
    label: "business graph / the CRM half",
    message: "which customers have we not chased in a month?",
    requires: "business_find",
  },
  {
    label: "business graph / the PM half",
    message: "what's still open on the kitchen remodel project?",
    requires: "business_find",
  },
  {
    label: "business graph / history, in the words a person uses",
    message: "what's been happening with that roofing customer lately?",
    requires: "business_timeline",
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
  // ── WARP-2454 — the four sentences this harness pinned as GAPS ─────────
  //
  // These four were carried below as assertions that selection MISSED them,
  // with a message saying a red would be good news. It was. They are now
  // ordinary turns, which is the whole point of having pinned them: a gap
  // recorded only in a report evaporates, a gap recorded as a test gets
  // promoted the day someone fixes it.
  {
    label: "files / a document named by what it IS, not by the word 'document'",
    message: "where did I put the signed lease agreement?",
    requires: "search_files",
  },
  {
    label: "calendar / availability phrased as 'am I free'",
    message: "am I free Thursday afternoon?",
    requires: "list_events",
  },
  {
    label: "email / 'reply', which the old `replied?` alternation never matched",
    message: "did the accountant ever reply about the VAT return?",
    requires: "email_search",
  },
  {
    // The counterpart to the continuity turn above, and the reason both are
    // kept: this one has NO priorCalls, so it can only be carried by the new
    // keyword rule. Delete that rule and this goes red while the continuity
    // turn stays green — which is what proves they test different paths.
    label: "REMOTE team-chat keyword / fresh turn, no continuity",
    message: "post that in the team slack channel",
    requires: "slack_send_message",
    remote: true,
  },
  {
    // WARP-2497. The literal acceptance sentence from the ticket, run through
    // the REAL shipping chat pool — which is what makes it worth more than the
    // unit test in tool-selection.service.test.ts: this one would also catch
    // the tool being registered and then excluded from chat, or dropped by
    // the budget gate, neither of which a hand-built pool can see.
    label: "cloud dataset / the billing question this story exists to answer",
    message: "what did we bill last week",
    requires: "cloud_query_dataset",
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
 * WARP-2454 — THE GAPS THIS HARNESS PINNED, NOW CLOSED.
 *
 * Building the corpus for WARP-2348 turned up sentences a household would
 * plainly type that the keyword rules did not match at all — the same class
 * of defect as the WARP-1921 "people" gap and the WARP-2058 missing-`pm`-rule
 * gap: the turn advertises the floor and nothing else, the model has no way
 * to answer, and there is no error anywhere.
 *
 * They were out of WARP-2348's scope, so rather than being left in a report
 * to evaporate they were pinned as assertions of CURRENT (broken) behaviour,
 * each carrying the note "a red here is GOOD NEWS". WARP-2454 turned them
 * red on purpose and they have been promoted into `TURNS` above.
 *
 * What remains here is the other half of each fix — the NEGATIVES. They are
 * the reason this block was inverted rather than deleted. Every one of these
 * four defects could have been "fixed" by a rule wide enough to match its
 * sentence and half the language besides, and a rule that over-matches is not
 * a fixed rule: it is the same silent cost moved from "the tool is missing"
 * to "the window is full of tools the turn never needed". These assertions
 * are what stop the next widening from going too far.
 */
describe("WARP-2454 — the closed gaps stayed closed, and stayed narrow", () => {
  const advertisedFor = (message: string, priorCalls: string[] = []) =>
    selectAdvertisedTools({
      mode: "domains",
      userMessage: message,
      pool: POOL_WITH_REMOTE,
      conversationToolNames: priorCalls,
      runtimeTools: REMOTE_TOOLS,
    }).advertised;

  it.each([
    // Each pair is [sentence that MUST NOT reach the domain, the tool that
    // proves it]. The sentences are chosen to sit just outside the rule that
    // was widened, which is where an over-widening shows up first.
    ["is the free trial still on?", "list_events", "calendar/free"],
    ["how much free space is left on the drive?", "list_events", "calendar/free"],
    ["find me a good plumber", "search_files", "files/subject"],
    ["what channel is the game on tonight?", "slack_send_message", "team_chat"],
    ["I need a thread that matches the blue cushion", "slack_send_message", "team_chat"],
  ])("%s does not drag in %s (%s)", (message, tool) => {
    expect(
      advertisedFor(message as string),
      `"${message}" pulled in ${tool} — the rule widened too far`,
    ).not.toContain(tool as string);
  });

  it("the email rule matches every form of reply a person writes", () => {
    // Was: an isolated assertion that `\b(...|replied?|...)\b` FAILED on
    // "reply" and "replies" — the specific regex defect, kept out of a
    // selection assertion so the diagnosis stayed legible.
    //
    // Now it exercises the SHIPPED rule instead of a copy of it. The old
    // form duplicated the pattern into the test, which is exactly how a test
    // and the rule it guards drift apart; going through
    // `selectAdvertisedTools` means this cannot pass while the real rule is
    // broken. MUTATION: restore `replied?` and the first two go red.
    for (const message of [
      "did she ever reply to that?",
      "any replies from the landlord?",
      "she replied last week",
      "is he still replying on that one?",
    ]) {
      expect(advertisedFor(message), `"${message}" missed the email domain`).toContain(
        "email_search",
      );
    }
  });

  it("team_chat's keyword path and continuity path are independent", () => {
    // The pairing the ticket asks for, asserted in one place: the fresh turn
    // is carried by the rule, the follow-up is carried by continuity, and
    // the follow-up's own words match no team_chat rule. Delete the rule and
    // only the first of these goes red.
    expect(advertisedFor("post that in the team slack channel")).toContain(
      "slack_send_message",
    );
    expect(
      advertisedFor("and post that where the team will see it"),
      "the continuity turn's own wording must NOT match the keyword rule, " +
        "or it stops isolating the continuity path",
    ).not.toContain("slack_send_message");
    expect(
      advertisedFor("and post that where the team will see it", [
        "slack_send_message",
      ]),
    ).toContain("slack_send_message");
  });
});
