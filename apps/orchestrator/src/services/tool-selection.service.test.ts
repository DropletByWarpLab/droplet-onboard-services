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
import type { RuntimeToolDescriptor } from "./runtime-tool-registry.service.js";

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

/** Pool with camera tools, for the WARP-1921 phrasing cases below. */
const CAMERA_POOL = [...POOL, "list_cameras", "list_camera_events", "list_clips"];

/** Pool with tracker tools, for the WARP-2058 cases below. */
const PM_POOL = [
  ...POOL,
  "pm_create_project",
  "pm_create_work_item",
  "pm_list_projects",
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

  /**
   * WARP-1921 — the rules must answer sentences a household member would
   * actually type, not the vocabulary already inside the pattern.
   *
   * The regression that motivated this block: "show me people at the front
   * door yesterday" matched NO rule, so the most likely camera sentence in
   * the product advertised zero camera tools. Asserting on the word "camera"
   * would never have caught it — which is precisely why these cases are
   * whole sentences, and why several deliberately avoid the domain's own
   * nouns.
   */
  /**
   * WARP-2058 — the `pm` domain had no rule at all, so under the shipping
   * `domains` default not one `pm_*` tool was ever advertised. RBAC and
   * registration were both correct; the tracker was simply invisible.
   *
   * A count-based assertion would not have caught that (the core set is
   * always non-empty), so these name the tracker tools explicitly.
   */
  describe("tracker phrasing reaches the pm domain (WARP-2058)", () => {
    const PM_SENTENCES = [
      "set up a project for the roof replacement",
      "turn this quote into a project with tasks",
      "what's still open on the kitchen refit project?",
      "add a ticket for the broken dishwasher",
    ];
    it.each(PM_SENTENCES)("%s", (sentence) => {
      const r = selectAdvertisedTools({
        mode: "domains",
        userMessage: sentence,
        pool: PM_POOL,
        conversationToolNames: [],
      });
      expect(
        r.matchedDomains,
        `"${sentence}" advertised only [${r.advertised.join(", ")}]`,
      ).toContain("pm");
      expect(r.advertised).toContain("pm_create_project");
    });
  });

  // WARP-2057 — read_file is core but REJECTS PDFs, so its PDF-capable
  // sibling has to be core too; otherwise a turn that never says a
  // files-domain word advertises only the reader that cannot open the file.
  it("always advertises read_document_text alongside read_file", () => {
    expect(CORE_TOOL_NAMES.has("read_document_text")).toBe(true);
    const r = selectAdvertisedTools({
      mode: "domains",
      userMessage: "turn the lights off in the den",
      pool: [...POOL, "read_document_text"],
      conversationToolNames: [],
    });
    expect(r.advertised).toContain("read_document_text");
  });

  describe("real household phrasing → the right domain", () => {
    const CAMERA_SENTENCES = [
      // The original miss. Contains no camera vocabulary at all.
      "show me people at the front door yesterday",
      "was anyone at the house while I was out?",
      "did the package get delivered?",
      "who came by this afternoon?",
      "is there someone in the driveway",
      "check the porch",
      "anything move in the back yard last night?",
      "rename the garage camera to Side Gate",
    ];

    it.each(CAMERA_SENTENCES)("routes to cameras: %s", (sentence) => {
      const r = selectAdvertisedTools({
        mode: "domains",
        userMessage: sentence,
        pool: CAMERA_POOL,
        conversationToolNames: [],
      });
      expect(
        r.matchedDomains,
        `"${sentence}" advertised only [${r.advertised.join(", ")}]`,
      ).toContain("cameras");
      expect(r.advertised).toContain("list_camera_events");
    });

    it("rename by DISPLAY NAME only — 'rename Blue Eye to Kitchen' advertises rename_camera", () => {
      // WARP-1893 review — a rename that names the camera by its label
      // contains no camera vocabulary at all, so before the rename verbs
      // were added the turn advertised zero camera tools and rename_camera
      // could never be called. False-positive domains are cheap (see the
      // rule comment), so the verb also claims files for rename_file.
      const r = selectAdvertisedTools({
        mode: "domains",
        userMessage: "rename Blue Eye to Kitchen",
        pool: [...CAMERA_POOL, "rename_camera"],
        conversationToolNames: [],
      });
      expect(
        r.matchedDomains,
        `advertised only [${r.advertised.join(", ")}]`,
      ).toContain("cameras");
      expect(r.advertised).toContain("rename_camera");
      // rename_file lives in the files domain; the same verb must reach it.
      expect(r.matchedDomains).toContain("files");
    });

    it("a plain greeting still matches no domain (generosity has a floor)", () => {
      // Guards the opposite failure: if the widened vocabulary matched
      // everything, selection would save nothing and this suite would still
      // be green on the cases above.
      const r = selectAdvertisedTools({
        mode: "domains",
        userMessage: "hey, how are you doing today?",
        pool: CAMERA_POOL,
        conversationToolNames: [],
      });
      expect(r.matchedDomains).not.toContain("cameras");
      expect(r.advertised).not.toContain("list_camera_events");
    });

    it("'what do you remember about me' does not drag in the system tools", () => {
      // `memory usage` is a system phrase; bare `memory` belongs to the
      // memory domain. Claiming the bare word would load system tools on
      // every recall question.
      const r = selectAdvertisedTools({
        mode: "domains",
        userMessage: "what do you remember about me?",
        pool: POOL,
        conversationToolNames: [],
      });
      expect(r.matchedDomains).toContain("memory");
      expect(r.matchedDomains).not.toContain("system");
    });
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

  it("matches the bare verb 'block' to the network domain (regression: blocked? typo)", () => {
    const r = selectAdvertisedTools({
      mode: "domains",
      userMessage: "please block that iPad",
      pool: POOL,
      conversationToolNames: [],
    });
    expect(r.advertised).toContain("list_network_devices");
    expect(r.advertised).toContain("get_network_status");
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

/**
 * WARP-2443 / WARP-2444 — selection over a DYNAMIC universe.
 *
 * Before this change these tests were impossible to write: a
 * runtime-registered tool has no TOOL_CATALOG entry, so `DOMAIN_BY_NAME`
 * missed it and it was filtered out of every turn without erroring.
 */
describe("dynamic tool universe (WARP-2443)", () => {
  const jiraSearch: RuntimeToolDescriptor = {
    name: "jira_search_issues",
    serverId: "atlassian",
    domain: "pm",
    domainSource: "server",
    description: "Search Jira issues with JQL.",
    inputSchema: { type: "object", properties: {} },
  };
  const slackSend: RuntimeToolDescriptor = {
    name: "slack_send_message",
    serverId: "slack",
    domain: "team_chat",
    domainSource: "server",
    description: "Post a Slack message.",
    inputSchema: { type: "object", properties: {} },
  };
  const REMOTE_POOL = [...POOL, "jira_search_issues", "slack_send_message"];

  it("SELECTS a runtime-registered remote tool for a turn that needs it", () => {
    // The headline acceptance criterion. The `pm` keyword rule matches
    // "tickets"; the tool is eligible only because it was registered with a
    // domain.
    const r = selectAdvertisedTools({
      mode: "domains",
      userMessage: "what tickets are still open on the tracker?",
      pool: REMOTE_POOL,
      conversationToolNames: [],
      runtimeTools: [jiraSearch, slackSend],
    });
    expect(r.advertised).toContain("jira_search_issues");
    expect(r.matchedDomains).toContain("pm");
  });

  it("MUTATION — strip the domain assignment and the remote tool becomes unselectable", () => {
    // Reproduces the pre-WARP-2444 defect on demand: same turn, same pool,
    // but no descriptor list, so the tool has no domain and is silently
    // dropped. NO ERROR is raised — which is what made the bug invisible.
    const r = selectAdvertisedTools({
      mode: "domains",
      userMessage: "what tickets are still open on the tracker?",
      pool: REMOTE_POOL,
      conversationToolNames: [],
      // runtimeTools deliberately omitted
    });
    expect(r.advertised).not.toContain("jira_search_issues");
    expect(r.advertised).not.toContain("slack_send_message");
  });

  it("does not advertise a remote tool whose domain the turn did not match", () => {
    const r = selectAdvertisedTools({
      mode: "domains",
      userMessage: "what tickets are still open on the tracker?",
      pool: REMOTE_POOL,
      conversationToolNames: [],
      runtimeTools: [jiraSearch, slackSend],
    });
    // Slack sits in team_chat, which this sentence does not match — so
    // selection is doing real work rather than admitting every remote tool.
    expect(r.advertised).not.toContain("slack_send_message");
  });

  it("continuity works across the dynamic half — a prior remote call re-opens its domain", () => {
    const r = selectAdvertisedTools({
      mode: "domains",
      userMessage: "and the one after that?",
      pool: REMOTE_POOL,
      conversationToolNames: ["jira_search_issues"],
      runtimeTools: [jiraSearch, slackSend],
    });
    // MUTATION: revert the continuity lookup to the static-only
    // DOMAIN_BY_NAME and this goes red — a follow-up question loses the
    // integration the previous turn just used.
    expect(r.advertised).toContain("jira_search_issues");
    expect(r.matchedDomains).toContain("pm");
  });

  it("the static catalog WINS a name collision — a remote server cannot repoint a local tool", () => {
    // Trust decision: otherwise a remote server could move `control_device`
    // into a domain some innocuous sentence matches. MUTATION: flip the
    // coalesce order in resolveDomain and this goes red.
    const hijack: RuntimeToolDescriptor = {
      ...jiraSearch,
      name: "control_device",
      domain: "files",
    };
    const r = selectAdvertisedTools({
      mode: "domains",
      userMessage: "show me my documents",
      pool: POOL,
      conversationToolNames: [],
      runtimeTools: [hijack],
    });
    expect(r.advertised).not.toContain("control_device");
    expect(domainOfTool("control_device", [hijack])).toBe("smart-home");
  });

  it("is a SUBSET of the pool even with remote tools present", () => {
    // The standing invariant: selection narrows, never widens.
    const r = selectAdvertisedTools({
      mode: "domains",
      userMessage: "what tickets are open?",
      pool: POOL, // no remote names in the pool
      conversationToolNames: [],
      runtimeTools: [jiraSearch, slackSend],
    });
    expect(r.advertised).not.toContain("jira_search_issues");
    for (const n of r.advertised) expect(POOL).toContain(n);
  });

  it("is deterministic — same input, same subset", () => {
    const call = () =>
      selectAdvertisedTools({
        mode: "domains",
        userMessage: "any open tickets and did anyone post about them?",
        pool: REMOTE_POOL,
        conversationToolNames: [],
        runtimeTools: [jiraSearch, slackSend],
      });
    expect(call().advertised).toEqual(call().advertised);
  });

  it("local-only selection is UNCHANGED when no runtime tools are supplied", () => {
    // WARP-2443: "the local-only path produces the same selections it does
    // today for a fixed corpus of turns."
    const corpus = [
      "show me my documents",
      "turn off the kitchen lights",
      "who was at the front door yesterday",
      "is the wifi slow again",
      "what do you remember about me",
      "how much disk space is left",
    ];
    for (const userMessage of corpus) {
      const withoutArg = selectAdvertisedTools({
        mode: "domains",
        userMessage,
        pool: CAMERA_POOL,
        conversationToolNames: [],
      });
      const withEmpty = selectAdvertisedTools({
        mode: "domains",
        userMessage,
        pool: CAMERA_POOL,
        conversationToolNames: [],
        runtimeTools: [],
      });
      expect(withEmpty.advertised).toEqual(withoutArg.advertised);
      expect(withEmpty.matchedDomains).toEqual(withoutArg.matchedDomains);
    }
  });

  it("toolNamesForDomain spans both layers, catalog first", () => {
    const names = toolNamesForDomain("pm", [jiraSearch]);
    expect(names).toContain("pm_create_work_item"); // local
    expect(names).toContain("jira_search_issues"); // remote
    expect(names.indexOf("pm_create_work_item")).toBeLessThan(
      names.indexOf("jira_search_issues"),
    );
    // Without the runtime list it is the catalog grouping, unchanged.
    expect(toolNamesForDomain("pm")).not.toContain("jira_search_issues");
  });

  it("domainOfTool resolves remote names only when the runtime list is supplied", () => {
    expect(domainOfTool("jira_search_issues")).toBeUndefined();
    expect(domainOfTool("jira_search_issues", [jiraSearch])).toBe("pm");
  });
});

/**
 * WARP-2454 — the four keyword rules that missed the phrasing people
 * actually use.
 *
 * Every case below is a whole sentence someone would type, never a word
 * lifted out of the pattern (the discipline this file has enforced since
 * WARP-1921). Each fix is paired with its NEGATIVE, and the negatives are
 * load-bearing rather than decorative: all four of these defects could be
 * "fixed" by a rule so wide it advertises the domain on turns that have
 * nothing to do with it, and a wider rule is not a better one — `files` is
 * the largest domain in the catalog and a Slack catalog registered into
 * `team_chat` is the largest remote one, so an over-match is paid in window
 * on every unrelated turn.
 */
describe("WARP-2454 — keyword rules vs. natural phrasing", () => {
  const EMAIL_POOL = [...POOL, "email_search", "email_read"];
  const CALENDAR_POOL = [...POOL, "list_events", "create_event"];
  const FILES_POOL = [...POOL, "search_files", "list_recent_files"];
  const CHAT_POOL = [
    ...POOL,
    "team_chat_send_message",
    "team_chat_send_meeting_invite",
  ];

  const advertisedFor = (
    userMessage: string,
    pool: string[],
    conversationToolNames: string[] = [],
  ) =>
    selectAdvertisedTools({
      mode: "domains",
      userMessage,
      pool,
      conversationToolNames,
    }).advertised;

  // ── 1. email: `replied?` never matched `reply` or `replies` ────────────
  //
  // The original alternative was "replie" plus an optional "d": it matched
  // `replied` and the non-word `replie`, and missed both forms a person
  // actually types. MUTATION for this whole group: restore `replied?` in
  // tool-selection.service.ts and every positive below goes red.
  describe("email — reply / replies / replied / replying all reach the inbox", () => {
    it.each([
      "did the accountant ever reply about the VAT return?",
      "any replies from the landlord about the deposit?",
      "she replied to me last Tuesday, can you find it",
      "is he still replying on that thread from last week?",
    ])("%s selects the email domain", (message) => {
      expect(advertisedFor(message, EMAIL_POOL)).toContain("email_search");
    });

    it("does not match the non-word `replie` the old alternation admitted", () => {
      // Not pedantry: it is the direct evidence the alternation was
      // rewritten rather than merely widened with another optional letter.
      // `repl(y|ies|ied|ying)` rejects it; `replied?` accepted it.
      expect(advertisedFor("replie", EMAIL_POOL)).not.toContain("email_search");
    });
  });

  // ── 2. team_chat had NO rule at all ───────────────────────────────────
  describe("team_chat — reachable from a fresh turn, not only by continuity", () => {
    it("selects team_chat for an explicit Slack post, with no prior turn", () => {
      // MUTATION: delete the team_chat rule and this goes red. The whole
      // point is the FRESH turn: `conversationToolNames` is empty, so
      // continuity cannot be what carries it.
      expect(
        advertisedFor("post that in the team slack channel", CHAT_POOL),
      ).toContain("team_chat_send_message");
    });

    it("selects team_chat for the standup thread question, with no prior turn", () => {
      expect(
        advertisedFor("what did Sam say in the standup thread?", CHAT_POOL),
      ).toContain("team_chat_send_message");
    });

    it("stays narrow — a TV channel and a sewing thread are not team chat", () => {
      // The trade-off the rule's comment records, asserted. Bare `channel`
      // and bare `thread` are the two words that would have made this rule
      // easy and wrong; a 15-tool Slack catalog riding on "what channel is
      // the game on" is the cost being avoided.
      for (const message of [
        "what channel is the game on tonight?",
        "I need a thread that matches the blue cushion",
        "can you open the garage door",
      ]) {
        expect(
          advertisedFor(message, CHAT_POOL),
          `"${message}" should not advertise team chat`,
        ).not.toContain("team_chat_send_message");
      }
    });

    it("continuity still reaches team_chat when the keyword rule does not", () => {
      // Paired with the mutation above: deleting the team_chat RULE must
      // leave this green. That is what proves the two tests above measure
      // the keyword path and not the continuity path.
      expect(
        advertisedFor("and post that where the team will see it", CHAT_POOL, [
          "team_chat_send_message",
        ]),
      ).toContain("team_chat_send_message");
    });
  });

  // ── 3. calendar: the `free time` literal missed "am I free Thursday" ───
  describe("calendar — availability is bounded to a temporal cue", () => {
    it.each([
      "am I free Thursday afternoon?",
      "am I free on Friday?",
      "have I got anything, or am I free tomorrow",
      "are we available next week for the handover",
      // The determiner is allowed between preposition and cue, which is what
      // makes this one match. ACCEPTED FALSE POSITIVE, recorded rather than
      // hidden: "is the parking free at the weekend" matches too. The
      // availability reading is the dominant one for this shape, and a
      // stray calendar domain costs five schemas — cheaper than missing the
      // question a person actually asks most weeks.
      "am I free at the weekend?",
    ])("%s selects the calendar domain", (message) => {
      expect(advertisedFor(message, CALENDAR_POOL)).toContain("list_events");
    });

    it("does NOT fire on 'free' with no temporal cue", () => {
      // MUTATION: replace the bounded rule with a bare \bfree\b and every
      // one of these goes red. This is the guard the ticket asks for — the
      // reason the fix is not simply "add free to the alternation".
      for (const message of [
        "is the free trial still on?",
        "how much free space is left on the drive",
        "feel free to move things around in there",
      ]) {
        expect(
          advertisedFor(message, CALENDAR_POOL),
          `"${message}" should not advertise the calendar`,
        ).not.toContain("list_events");
      }
    });
  });

  // ── 4. files: a document named by its SUBJECT, not by a container word ─
  describe("files — documents named by what they are", () => {
    it.each([
      "find the signed lease agreement",
      "where did I put the signed lease agreement?",
      "can you dig out the contract from the roofer",
      "I need the insurance certificate for the van",
    ])("%s selects the files domain", (message) => {
      expect(advertisedFor(message, FILES_POOL)).toContain("search_files");
    });

    it("does NOT fire on a retrieval verb with no document in the sentence", () => {
      // MUTATION: swap the document-noun vocabulary for a bare
      // find|locate|where-is verb fallback and these go red. `files` is the
      // largest domain in the catalog (20 tools), so a verb fallback is the
      // single most expensive over-match available.
      for (const message of [
        "find me a good plumber",
        "where is the nearest petrol station",
        "look for someone who can fix the boiler",
      ]) {
        expect(
          advertisedFor(message, FILES_POOL),
          `"${message}" should not advertise the files domain`,
        ).not.toContain("search_files");
      }
    });
  });
});

describe("WARP-2497 — the cloud SaaS datasets are reachable from a fresh turn", () => {
  // The shipped tool name. One generic reader, not one per vendor: the
  // full-registry canary had ~2.6K chars of headroom when this landed.
  const CLOUD_POOL = [...POOL, "cloud_query_dataset"];

  const advertisedFor = (userMessage: string, pool: string[] = CLOUD_POOL) =>
    selectAdvertisedTools({
      mode: "domains",
      userMessage,
      pool,
      conversationToolNames: [],
    }).advertised;

  // ── positives ────────────────────────────────────────────────────────────
  //
  // Whole sentences, never a word lifted out of the pattern — asserting with
  // the vocabulary already inside the regex is the tautology that let the
  // `people` gap ship green (see the WARP-2454 header above).
  //
  // MUTATION for this whole group: delete the `domains: ["cloud"]` rule from
  // tool-selection.service.ts and every positive below goes red. Note each
  // one runs with an EMPTY `conversationToolNames`, so continuity cannot be
  // what carries it — the fresh turn is the whole point of the ticket.
  describe("positives", () => {
    it.each([
      // The sentence the ticket exists to answer.
      "what did we bill last week",
      "how much revenue did we take in August?",
      "pull up the open invoices from Stripe",
      "did that customer's refund go through?",
      "what is in the sales pipeline this quarter?",
      "how did the July campaign perform?",
      "are we billing them monthly or annually?",
      "what is our MRR right now?",
      "show me the payouts that landed this month",
      "which deals did we win in Q2?",
      "how many subscribers do we have?",
    ])("%s advertises the cloud dataset reader", (message) => {
      expect(advertisedFor(message)).toContain("cloud_query_dataset");
    });
  });

  // ── negatives ────────────────────────────────────────────────────────────
  //
  // These are the DELIBERATELY unclaimed words, and they are the half of the
  // trade-off that is easy to let rot. Each one belongs to another domain
  // that answers it better; a future widening that takes the bare word will
  // turn these red, which is the intended alarm rather than an inconvenience.
  //
  // MUTATION: add bare `tickets?`, `company`, `customers?`, `newsletters?` or
  // `contacts?` to the cloud pattern and the matching case below goes red.
  describe("negatives — the words other domains own", () => {
    it.each([
      // `pm` owns `ticket` (WARP-2058).
      "is there an open support ticket for the printer?",
      // `business` owns `company` and `customers`.
      "what are our opening hours?",
      "which company do we buy the milk from?",
      // `email` owns `newsletter`.
      "did the newsletter go out this morning?",
      // `search_contacts` is the on-box answer to this one.
      "find Dana's contact details",
      // Nothing to do with a SaaS account at all.
      "turn the living room lights off",
    ])("%s does NOT advertise the cloud dataset reader", (message) => {
      expect(advertisedFor(message)).not.toContain("cloud_query_dataset");
    });
  });

  it("does not let `open` alone reach the payments reader", () => {
    // `(open|click|bounce) rates?` and `(sales|open|closed|won|lost) deals?`
    // both REQUIRE their noun. Without that, "open" — one of the commonest
    // words in a support sentence — would claim the domain outright.
    // Mutation: drop the ` rates?` / ` deals?` tails so the qualifiers stand
    // alone → red.
    expect(advertisedFor("can you open the front door")).not.toContain("cloud_query_dataset");
  });

  it("still reaches the domain by continuity once the tool has been used", () => {
    // The rule and continuity are independent paths; this pins that a
    // follow-up with no keyword at all ("and the one before that?") keeps the
    // tool in reach, which is what makes a multi-turn drill-down work.
    // Mutation: drop the `conversationToolNames` loop in selectAdvertisedTools
    // → red.
    const advertised = selectAdvertisedTools({
      mode: "domains",
      userMessage: "and the one before that?",
      pool: CLOUD_POOL,
      conversationToolNames: ["cloud_query_dataset"],
    }).advertised;
    expect(advertised).toContain("cloud_query_dataset");
  });
});
