/**
 * Spec §3 — relevance-based tool selection. Deterministic, pure, and only
 * ever a SUBSET of the caller's pool; the taxonomy is tools-core's
 * TOOL_CATALOG (CI-complete), never a parallel list.
 */
import { describe, it, expect } from "vitest";
import {
  CORE_TOOL_NAMES,
  effectiveAdvertisedToolNames,
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

/**
 * Pool with tracker tools, for the WARP-2058 cases below.
 *
 * ADR-045 slice D — `pm_create_project` / `pm_create_work_item` no longer
 * exist, and a pool name with no catalog domain is silently dropped by
 * `selectAdvertisedTools`, so listing them would fail confusingly rather
 * than informatively. The tracker's WRITE is `business_create` now, and it
 * is reachable from a pm sentence because the pm rule claims `business`.
 */
const PM_POOL = [
  ...POOL,
  "business_create",
  "business_update",
  "pm_list_projects",
];

describe("selectAdvertisedTools (spec §3)", () => {
  describe("connection setup through natural language", () => {
    const tools = ["list_connections", "start_connection", "disconnect_connection"];
    it.each([
      "show me our integrations", "what connections do I have?", "connect my Stripe account",
      "add Gmail", "set up QuickBooks", "hook up our mail server", "sign in to Outlook",
      "disconnect my calendar", "which services are available services?",
    ])("%s", (userMessage) => {
      const result = selectAdvertisedTools({ mode: "domains", userMessage, pool: [...POOL, ...tools], conversationToolNames: [] });
      for (const name of tools) expect(result.advertised).toContain(name);
    });
    it("cannot widen a caller's connection tool grant", () => {
      const result = selectAdvertisedTools({ mode: "domains", userMessage: "connect Stripe", pool: POOL, conversationToolNames: [] });
      for (const name of tools) expect(result.advertised).not.toContain(name);
    });
  });
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
      // (see the WARP-2719 block below for the department half of this
      // vocabulary, which no sentence here reaches)
      // ADR-045 slice D — the tracker WRITE is `business_create`, and the
      // pm rule reaches it because it claims the `business` domain too.
      // Asserting the DOMAIN alone would pass on an empty advertisement,
      // which is exactly the hole WARP-2058 fell into.
      expect(r.advertised).toContain("business_create");
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
    // ADR-045 emptied the `pm` domain of local tools, so it can no longer
    // demonstrate ORDERING — there is nothing to come first. The ordering
    // assertion moves to a domain that still has both halves; which domain it
    // is was never the point. `pm` keeps the empty-plus-remote case below,
    // which is the more interesting one after the collapse.
    const remoteFiles = { ...jiraSearch, name: "box_list_shared", domain: "files" as const };
    const names = toolNamesForDomain("files", [remoteFiles]);
    expect(names).toContain("list_files"); // local
    expect(names).toContain("box_list_shared"); // remote
    expect(names.indexOf("list_files")).toBeLessThan(names.indexOf("box_list_shared"));
    // Without the runtime list it is the catalog grouping, unchanged.
    expect(toolNamesForDomain("files")).not.toContain("box_list_shared");
  });

  it("an EMPTIED domain still carries its remote tools — the ADR-045 case", () => {
    // The reason `pm` and `crm` keep their DOMAIN_RULES entries after the
    // collapse: a remote Atlassian catalog registers into `pm` (WARP-2316),
    // and the exclusion list names LOCAL tools only, so the rule is the ONLY
    // route by which that tool becomes selectable. If this goes red, a
    // connected tracker has been silently un-reached.
    expect(toolNamesForDomain("pm")).toEqual([]);
    expect(toolNamesForDomain("pm", [jiraSearch])).toEqual(["jira_search_issues"]);
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

  // ── WARP-3340: "message someone" reaches team chat ────────────────────
  //
  // Team chat is the default channel for reaching a colleague (email only
  // when asked for), so asking to message a PERSON has to advertise it. The
  // bare noun must not: this is the most expensive domain (see the team_chat
  // rule's comment), and "the message in the file" asks nobody to send
  // anything. MUTATION: delete the WARP-3340 rule and every positive goes
  // red; admit the bare noun (e.g. `\bmessag(e|es|ing)\b`) and the
  // negatives do.
  describe("WARP-3340 — messaging a person advertises team chat", () => {
    it.each([
      // agent-loop eval seed-028, verbatim: the address alone used to pull
      // only the email domain.
      "Before messaging dave@example.com, look them up to confirm they exist, then send them: 'Server maintenance tonight at 10pm'.",
      "message Priya that the delivery is late",
      "can you message the team about the outage?",
      "can you send Bob a quick message about the 3pm call",
      "send the team a message about the fire drill",
      "Send a message to the manager saying hello.",
      "send a status message to the ops channel",
      "let the team know the office is closed tomorrow",
      "ping him about the invoice",
      "text Sam that I'm running late",
      "tell everyone the printer is fixed",
    ])("%s selects team chat", (message) => {
      expect(advertisedFor(message, CHAT_POOL)).toContain("team_chat_send_message");
    });

    it.each([
      "what does this error message mean?",
      "fix the commit message on my last change",
      "find the email message from the accountant",
      "the e-mail messages from the landlord",
      // Review of #2541: the bare noun, each a turn that sends nothing.
      "what does the message in the file say?",
      "play the voice message from the supplier",
      "the message queue is backed up again",
      "are the MQTT messages still arriving?",
      "Kafka messages are piling up on the broker",
      "what does this warning message mean?",
      "set up my out-of-office message for next week",
      "read Dana's message",
      "the message Dana sent about the invoice",
      // A determiner makes the verb a noun: the lookbehind.
      "what was the message everyone got about the outage?",
      "read the text her manager forwarded",
      // A read question; the domain has no tool that reads messages.
      "any new messages from the front desk?",
      // The verbs, outside a person frame.
      "let me know when the backup finishes",
      "can you tell what that error means?",
      "ping the router",
      "send the error message to the log",
    ])("%s does not", (message) => {
      expect(advertisedFor(message, CHAT_POOL)).not.toContain("team_chat_send_message");
    });

    // With the email tools in the pool as well, which is the real choice the
    // model faces: seed-028's wording offers BOTH channels (the address still
    // matches the email rule), and an email reply offers email alone.
    const BOTH_POOL = [...CHAT_POOL, "email_search", "email_draft_reply", "email_send"];
    it("offers team chat AND email for seed-028's wording", () => {
      const advertised = advertisedFor(
        "Before messaging dave@example.com, look them up to confirm they exist, then send them: 'Server maintenance tonight at 10pm'.",
        BOTH_POOL,
      );
      expect(advertised).toContain("team_chat_send_message");
      expect(advertised).toContain("email_send");
    });

    it.each([
      "reply to the accountant's email thread",
      "Reply to the message from the accountant",
    ])("%s offers email and not team chat", (message) => {
      const advertised = advertisedFor(message, BOTH_POOL);
      expect(advertised).toContain("email_draft_reply");
      expect(advertised).not.toContain("team_chat_send_message");
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
      // WARP-2916 — the GitHub profile serves `task`; the vendor's name and
      // "pull request" are the words a person uses for it.
      "what is still open on GitHub?",
      "any pull requests waiting on me?",
      // WARP-2917 — the vendor's name carries the turn even when the sentence
      // uses GitLab's own word (`issue`), which is deliberately unclaimed.
      "which issues are still open in GitLab?",
      // WARP-2919 — the vendor name, exactly as `shopify` and `square` are.
      // NOT `receipts?`: that word belongs to the `files` domain ("file this
      // receipt"), and Loyverse serves no receipts dataset — see the
      // negative below.
      "what did Loyverse record yesterday?",
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
      // WARP-2917 — bare `issue` stays unclaimed: this is not a tracker question.
      "is there an issue with the printer?",
      // `business` owns `company` and `customers`.
      "what are our opening hours?",
      "which company do we buy the milk from?",
      // `email` owns `newsletter`.
      "did the newsletter go out this morning?",
      // `search_contacts` is the on-box answer to this one.
      "find Dana's contact details",
      // Nothing to do with a SaaS account at all.
      "turn the living room lights off",
      // WARP-2916 — bare `issue` stays unclaimed: the household sense.
      "there's an issue with the printer again",
      // WARP-2919 — `files` owns `receipt`: this is a filing turn, and no
      // cloud dataset serves receipts (Loyverse's are not read — no per-row
      // currency). MUTATION: add `receipts?` to the cloud pattern -> red.
      "file this receipt under expenses",
    ])("%s does NOT advertise the cloud dataset reader", (message) => {
      expect(advertisedFor(message)).not.toContain("cloud_query_dataset");
    });
  });

  // ── WARP-2719 — `working on`, and what it must not swallow ──────────────
  //
  // The rule exists because "what is Front Desk working on?" matched NOTHING:
  // `working` is not `work items?`, and a department's name is a proper noun
  // no pattern can enumerate. Without it the department filter is reachable
  // only by a model that had already used the domain for some other reason.
  //
  // It is the most ordinary English in this file, so its false positives are
  // written down rather than discovered. The three positives below are all
  // sentences where advertising the project tools is the RIGHT answer even
  // though the asker never said "project". The negatives are the household
  // sense of the same word.
  describe("`working on` reaches the tracker (WARP-2719)", () => {
    // Its own pool: the enclosing `advertisedFor` defaults to CLOUD_POOL, and
    // a tool absent from the pool can never be advertised however well the
    // rule matches — a default-pool assertion here would fail for a reason
    // that has nothing to do with the rule under test.
    const GRAPH_POOL = ["business_find", "business_create", "search_content"];
    const graph = (message: string) => advertisedFor(message, GRAPH_POOL);

    it.each([
      "what is Front Desk working on?",
      "what am I working on this week",
      "who is working on the kitchen",
      "what is assigned to Sam",
      "how is the team's workload looking",
    ])("%s advertises the business graph", (message) => {
      expect(graph(message)).toContain("business_find");
    });

    it.each([
      // The household sense: something is broken. No `on` follows, and the
      // rule requires it.
      "the dishwasher is not working",
      "the wifi stopped working last night",
      "is the printer working yet",
      // `work` bare is not enough either — the rule takes `working`/`worked`.
      "what time do you finish work",
    ])("%s does NOT", (message) => {
      expect(graph(message)).not.toContain("business_find");
    });

    it("MUTATION: take `work` bare and the household sentences all claim the tracker", () => {
      // Written down because it is the obvious widening: `work` instead of
      // `work(ing|ed) on` looks like it catches more of the same question and
      // actually catches every appliance complaint on the box.
      expect(graph("the dishwasher is not working")).not.toContain("business_find");
      expect(graph("my back has been playing up at work")).not.toContain("business_find");
    });
  });

  // ── WARP-2719 — the DEPARTMENT vocabulary, and the `team` it must not take ──
  //
  // The first cut of this ticket put `departments?|teams?` straight into the
  // pm noun list. `departments?` is fine there; a bare `teams?` was not. It
  // matched this repo's own team_chat continuity fixture — "and post that
  // where the team will see it" — and opened `pm` and `business` on a turn
  // that must reach Slack and nothing else, plus every household sentence
  // with the word in it. Nothing went red, because that fixture only ever
  // asserted `slack_send_message` was PRESENT, and an over-matching rule
  // ADDS domains: no present-tool assertion anywhere in this repo can see
  // one. Both halves are therefore pinned here, explicitly.
  describe("department / team vocabulary is bounded (WARP-2719)", () => {
    const GRAPH_POOL = ["business_find", "business_create", "search_content"];
    const domainsFor = (message: string) =>
      selectAdvertisedTools({
        mode: "domains",
        userMessage: message,
        pool: GRAPH_POOL,
        conversationToolNames: [],
      }).matchedDomains;

    // ── positives: each of these is carried by THIS rule and nothing else ──
    //
    // MUTATION for this group: delete the `departments? … teams?` rule
    // from tool-selection.service.ts and every one goes red. Verified by
    // deleting it — none of them survives on another rule, which is what
    // makes them a pin rather than a restatement of the ruleset.
    it.each([
      // `departments?`, bare — the word the tool's own schema uses.
      "which department does Sam sit in",
      "move the new hire into the billing department",
      // `on|in the <name> team` — membership in a NAMED team. One name word
      // and two both have to work; "front desk" is the ticket's own example.
      "who is on the clinical team",
      "who is on the front desk team",
      // `which|whose team` — the question is about the team itself.
      "which team should this go to",
      // `team('s) <work noun>` — the team as an owner of work.
      "how does the clinical team's roster look",
      "show me the team's capacity",
    ])("%s reaches the business graph", (message) => {
      expect(
        domainsFor(message),
        `"${message}" matched only [${domainsFor(message).join(", ")}]`,
      ).toContain("business");
    });

    // ── the negative that the first cut of this rule failed ────────────────
    it("the team_chat continuity fixture stays a Slack-only turn", () => {
      // THE regression. `advertisedFor(..., [prior call])` elsewhere in this
      // file proves the continuity path still delivers Slack; what was never
      // asserted is that the fixture's own WORDS reach no domain rule — and
      // `tool-selection.regression.test.ts` depends on exactly that to keep
      // the keyword path and the continuity path separable. A bare `teams?`
      // in the pm rule breaks it, and this is the assertion that says so.
      expect(
        domainsFor("and post that where the team will see it"),
        "the continuity fixture's own wording must match NO domain rule",
      ).toEqual([]);
    });

    it.each([
      // The household senses of the same noun. Two whole domains of tool
      // schema on any of these is pure waste on the turn that pays for it.
      "the team is coming over for dinner",
      "my football team lost again",
      "the away team scored in the last minute",
      // `in the team meeting` has no team NAME between determiner and noun,
      // so the membership frame does not fire. (It reaches `calendar`, which
      // is the right domain for it — `business` is what must stay out.)
      "we are in the team meeting until four",
      // The one household use of `department`, and the reason that half of
      // the rule carries a lookahead rather than standing bare.
      "I need to go to the department store",
    ])("%s does NOT", (message) => {
      expect(domainsFor(message)).not.toContain("business");
      expect(domainsFor(message)).not.toContain("pm");
    });

    it("MUTATION: put `teams?` back in the pm noun list and four of these flip", () => {
      // Written down because it is exactly the widening that shipped, and
      // the one a later reader will be tempted to redo: `teams?` alongside
      // `projects?|tickets?|…` reads harmless and takes the Slack fixture,
      // the dinner, the football and the meeting with it.
      for (const message of [
        "and post that where the team will see it",
        "the team is coming over for dinner",
        "my football team lost again",
        "we are in the team meeting until four",
      ]) {
        expect(domainsFor(message), message).not.toContain("business");
      }
    });

    it("the ticket's own two sentences do not depend on this rule at all", () => {
      // The narrowing costs the ticket nothing, stated as a test rather than
      // as prose: both acceptance sentences are carried by the
      // `work(ing|ed) on` / `assigned to` rule, so someone tightening the
      // department rule further can see immediately what is and is not
      // resting on it.
      expect(domainsFor("what is Front Desk working on?")).toContain("business");
      expect(domainsFor("what is assigned to the Clinical team right now?")).toContain(
        "business",
      );
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

describe("WARP-2894 — routines are reachable from a fresh turn", () => {
  const ROUTINES_POOL = [...POOL, "routine_draft", "routine_list", "routine_run"];

  const advertisedFor = (userMessage: string, pool: string[] = ROUTINES_POOL) =>
    selectAdvertisedTools({
      mode: "domains",
      userMessage,
      pool,
      conversationToolNames: [],
    }).advertised;

  // Whole sentences, never a word lifted out of the pattern (the WARP-2454
  // tautology). Every one runs with an EMPTY `conversationToolNames`.
  //
  // MUTATION: delete the `domains: ["routines"]` rule from
  // tool-selection.service.ts and every positive below goes red. This is the
  // fifth DOMAIN_RULES entry to ship; the WARP-2058 / 2454 / 2546 / 2719
  // class shipped a dead rule four times before, so the door is measured
  // here rather than argued.
  describe("positives — how a person asks for something recurring", () => {
    it.each([
      "every morning, tell me which scans came in overnight",
      "can you do that each Friday afternoon?",
      "automate the end-of-day file tidy",
      "set this up to run at 6pm",
      "schedule this so I don't have to ask",
      "I want a daily summary of what changed in Documents",
      "give me a weekly digest of the camera events",
      "what routines do we have set up?",
      "turn that into a recurring job",
      "do this every 2 hours",
    ])("%s advertises the routine tools", (message) => {
      const advertised = advertisedFor(message);
      expect(advertised).toContain("routine_draft");
      expect(advertised).toContain("routine_list");
    });
  });

  // The DELIBERATELY unclaimed shapes. Each belongs to a domain that answers
  // it better; a widening that takes the bare word turns these red on purpose.
  //
  // MUTATION: drop the cadence-noun requirement after `every|each`, or let
  // bare `schedule` through, and the matching case below goes red.
  describe("negatives — the words other domains own", () => {
    it.each([
      // `every` without a cadence noun is enumeration, not recurrence.
      "show me every file in the scans folder",
      "is every camera still online?",
      // bare `schedule` is the calendar's word.
      "what is on my schedule tomorrow?",
      "when is the next free slot in the schedule?",
      // a one-off ask is a one-off ask.
      "tidy up the Documents folder",
    ])("%s does not advertise the routine tools", (message) => {
      expect(advertisedFor(message)).not.toContain("routine_draft");
    });
  });

  it("still reaches the domain by continuity once a routine tool has been used", () => {
    const advertised = selectAdvertisedTools({
      mode: "domains",
      userMessage: "and the other one?",
      pool: ROUTINES_POOL,
      conversationToolNames: ["routine_list"],
    }).advertised;
    expect(advertised).toContain("routine_list");
  });
});

describe("WARP-3074 — bulk labelling reaches classify_items from a fresh turn", () => {
  const advertisedFor = (userMessage: string) =>
    selectAdvertisedTools({
      mode: "domains",
      userMessage,
      pool: [...POOL, "classify_items"],
      conversationToolNames: [],
    }).advertised;

  // Whole sentences a person types when they hand over a pile. MUTATION:
  // delete the WARP-3074 rule and every positive goes red — none of them
  // carries a word the older `data` rule owns.
  it.each([
    "can you go through these 40 support emails and categorise them by department?",
    "sort these customer reviews into happy, neutral and angry",
    "label each of these tickets as urgent or not urgent",
    "please triage this batch of leads for me: hot, warm or cold",
    "group these expense lines by cost centre",
    "work out which team each request belongs to",
  ])("%s advertises classify_items", (message) => {
    expect(advertisedFor(message)).toContain("classify_items");
  });

  // The ambiguous verbs, used the way they are used when nobody wants a
  // classifier. A widening that takes the bare word turns these red.
  it.each([
    "print a shipping label for the parcel to Lyon",
    "sort the files by newest first",
    "who is in the group chat for the front desk",
    "what's the name tag on the garage camera?",
    "what is the security classification of this file?",
    "who is on triage duty at the front desk this week?",
  ])("%s does not advertise classify_items", (message) => {
    expect(advertisedFor(message)).not.toContain("classify_items");
  });
});

describe("WARP-3116 — dashboard navigation is reachable from a fresh turn", () => {
  const NAV_TOOLS = ["find_dashboard_page", "open_dashboard_page"];
  // Stand-ins for the OTHER `data` tools (seven in the owner's chat pool). The
  // domain is admitted WHOLE (~2.2K tokens with the two below), so a
  // navigation rule that fires wrongly buys all of them along with the two it
  // exists for. A test that looked only at the navigation tools could not tell
  // "the rule did not fire" from "the rule fired and the pool held nothing
  // else".
  const DATA_TOOLS = ["get_weather", "calculate"];
  // A dashboard turn: the page list arrived, so both navigation tools survived
  // the withholding in dashboard-navigation.ts and sit in the pool.
  const NAV_POOL = [...POOL, ...DATA_TOOLS, ...NAV_TOOLS];
  // Every other turn (voice, phones, background runs): both are withheld.
  const PAGELESS_POOL = [...POOL, ...DATA_TOOLS];

  const select = (pool: string[], userMessage: string) =>
    selectAdvertisedTools({
      mode: "domains",
      userMessage,
      pool,
      conversationToolNames: [],
    });
  const advertisedFor = (userMessage: string) =>
    select(NAV_POOL, userMessage).advertised;

  // Whole sentences, EMPTY continuity. "take me to it" is the incident: the
  // follow-up names no page, so only the phrasing can admit the tool.
  //
  // One sentence per surviving alternative, so an edit that breaks one of
  // them is named by the case that goes red.
  //
  // Not here on purpose: "give me a link to the voice settings" and "go to
  // settings". They rode on the bare `link to` / `go to`, which also matched
  // the ordinary sentences in the negatives below, so they now reach the tool
  // the other way: the guidance line names find_dashboard_page on a dashboard
  // turn, and a call to a filtered-but-allowed tool expands its domain on the
  // next iteration. One lost iteration, not a failed turn.
  //
  // MUTATION: delete NAVIGATION_RULES from tool-selection.service.ts and
  // every positive below goes red.
  describe("positives — how a person asks to be moved or pointed somewhere", () => {
    it.each([
      "take me to it",
      "can you bring me to the calendar",
      "navigate to people",
      "jump to the camera recordings",
      "link me to the voice settings",
      "where do I change the wifi password?",
      "where is the guest wifi setting",
      "where are my deleted files?",
      "how do I get to the camera recordings",
      "open the people page",
      "open voice settings",
      "show me the network settings",
    ])("%s advertises the navigation tools", (message) => {
      const advertised = advertisedFor(message);
      expect(advertised).toContain("open_dashboard_page");
      expect(advertised).toContain("find_dashboard_page");
    });
  });

  // The review of PR #2443 (head 39e6658): four ordinary sentences matched the
  // rule and admitted the WHOLE `data` domain on turns that wanted none of it.
  // Each rode on one bare alternative, named beside it. The last two are the
  // same class, not named in the review, and fail the same assertion.
  //
  // MUTATION: put any of those alternatives back into NAVIGATION_RULES and the
  // case that rode on it goes red.
  describe("negatives — ordinary sentences the bare alternatives used to match", () => {
    it.each([
      // was `go(ing)? (back )?to`
      "I am going to need a summary of my inbox",
      "before I go to sleep remind me",
      // was `links? (to|for)`
      "send the link to Bob",
      // was `the \w+ (page|screen|tab)`
      "what is on the front page of the report",
      // was `head (over )?to`
      "let's head over to Bob's",
      // was `(page|screen|tab|section) (for|with)`
      "the screen with the error message",
    ])("%s admits no data tool", (message) => {
      const r = select(NAV_POOL, message);
      expect(r.matchedDomains).not.toContain("data");
      for (const name of [...NAV_TOOLS, ...DATA_TOOLS]) {
        expect(r.advertised, name).not.toContain(name);
      }
    });
  });

  describe("negatives — questions that are not about getting somewhere", () => {
    it.each([
      "turn off the kitchen lights",
      "summarise the lease agreement",
      // (no time words: those admit `data` through the utilities rule)
      "who came to the front door",
      "is the internet down?",
      // A setting named in an ACTION is the network tools' job, not a trip:
      // `settings` is claimed only after "open" / "show me".
      "change the wifi settings to WPA3",
    ])("%s does not advertise the navigation tools", (message) => {
      expect(advertisedFor(message)).not.toContain("open_dashboard_page");
    });
  });

  // The gate. Both navigation tools are withheld from any turn with no page
  // list (dashboard-navigation.ts), and a phrasing rule whose tools are not in
  // the pool can only buy the rest of the `data` schemas. So it does not run:
  // the pool is the gate, and it is the same pool the route's estimate and the
  // agent loop's wire payload both hand in.
  //
  // MUTATION: evaluate NAVIGATION_RULES whatever the pool holds and every case
  // below goes red — the review's finding, on the turns it named.
  describe("a turn with no page list never pays for the rule", () => {
    it.each([
      "take me to voice settings",
      "where do I change the wifi password?",
      "open the people page",
    ])("%s admits no data tool when the pool holds no navigation tool", (message) => {
      const r = select(PAGELESS_POOL, message);
      expect(r.matchedDomains).not.toContain("data");
      for (const name of DATA_TOOLS) expect(r.advertised, name).not.toContain(name);
    });

    it("the same sentence on a dashboard turn admits the whole domain", () => {
      // The control: without it the cases above pass for a rule that never fires.
      const r = select(NAV_POOL, "take me to voice settings");
      expect(r.matchedDomains).toContain("data");
      expect(r.advertised).toEqual(expect.arrayContaining([...NAV_TOOLS, ...DATA_TOOLS]));
    });

    it("a real data sentence still admits the domain with no page list", () => {
      // Only the navigation rule is gated; the utilities rule is not.
      expect(select(PAGELESS_POOL, "what is the weather like").advertised).toContain(
        "get_weather",
      );
    });

    it("holds through effectiveAdvertisedToolNames, the derivation both call sites share", () => {
      const messages = [{ role: "user", content: "take me to voice settings" }];
      const dashboard = effectiveAdvertisedToolNames({ mode: "domains", messages, pool: NAV_POOL });
      const pageless = effectiveAdvertisedToolNames({
        mode: "domains",
        messages,
        pool: PAGELESS_POOL,
      });
      expect(dashboard.has("open_dashboard_page")).toBe(true);
      for (const name of DATA_TOOLS) expect(pageless.has(name), name).toBe(false);
    });
  });

  it("reaches the tools by continuity once one has been used", () => {
    const advertised = selectAdvertisedTools({
      mode: "domains",
      userMessage: "yes that one",
      pool: NAV_POOL,
      conversationToolNames: ["find_dashboard_page"],
    }).advertised;
    expect(advertised).toContain("open_dashboard_page");
  });
});

describe("WARP-2896 — a workshop run's binding admits the workspace domain; nothing else does", () => {
  const WORKSPACE = [
    "workspace_read",
    "workspace_search",
    "workspace_diff",
    "workspace_log",
    "workspace_write",
    "workspace_commit",
    "workspace_run",
    "workspace_propose",
  ];
  // The goal the bench-box live proof ran (2026-09-23): a workshop sentence
  // that never says "workspace" and matches no rule reaching the domain.
  const GOAL =
    "Extend the extension: in src/index.ts add a 'lines' field to Output that counts the lines of input.text. Add a test for it, then run the build and the tests and make sure they pass, commit, and propose version 0.2.0.";
  const user = (content: string) => [{ role: "user", content }];

  it("a bound domain advertises all eight, whatever the sentence says", () => {
    // MUTATION: drop `...(opts.boundDomains ?? [])` from
    // effectiveAdvertisedToolNames and this goes red — the live failure.
    for (const text of [GOAL, "hello there", ""]) {
      const advertised = effectiveAdvertisedToolNames({
        mode: "domains",
        messages: user(text),
        pool: [...POOL, ...WORKSPACE],
        boundDomains: ["workspace"],
      });
      for (const name of WORKSPACE) expect(advertised.has(name), `${name} for "${text}"`).toBe(true);
    }
  });

  it("the same pool WITHOUT a binding advertises none — chat's explicit allowed_tools case", () => {
    // routes/llm.ts narrows a client-supplied `allowed_tools` by role/scope
    // only, so a chat request CAN put workspace_* in the pool. Pool membership
    // must therefore never admit the domain: chat has no binding and passes none.
    for (const text of [GOAL, "open my workspace and propose a change to the extension"]) {
      const advertised = effectiveAdvertisedToolNames({
        mode: "domains",
        messages: user(text),
        pool: [...POOL, ...WORKSPACE],
      });
      for (const name of WORKSPACE) expect(advertised.has(name), `${name} for "${text}"`).toBe(false);
    }
  });

  it("no keyword rule reaches the domain", () => {
    const r = selectAdvertisedTools({
      mode: "domains",
      userMessage: GOAL,
      pool: [...POOL, ...WORKSPACE],
      conversationToolNames: [],
    });
    expect(r.matchedDomains).not.toContain("workspace");
  });

  it("a binding never widens the pool", () => {
    const one = effectiveAdvertisedToolNames({
      mode: "domains",
      messages: user("hello there"),
      pool: [...POOL, "workspace_read"],
      boundDomains: ["workspace"],
    });
    expect([...one].filter((n) => n.startsWith("workspace_"))).toEqual(["workspace_read"]);
    const none = effectiveAdvertisedToolNames({
      mode: "domains",
      messages: user(GOAL),
      pool: POOL,
      boundDomains: ["workspace"],
    });
    for (const name of none) expect(POOL).toContain(name);
  });

  it("a binding composes with the sentence: matched domains still arrive", () => {
    const advertised = effectiveAdvertisedToolNames({
      mode: "domains",
      messages: user("turn off the kitchen lights"),
      pool: [...POOL, ...WORKSPACE],
      boundDomains: ["workspace"],
    });
    expect(advertised.has("control_device")).toBe(true);
    expect(advertised.has("workspace_write")).toBe(true);
    expect(advertised.has("list_network_devices")).toBe(false);
  });
});

/**
 * WARP-3538 — OneDrive and SharePoint are asked after by PLACE, not by
 * container.
 *
 * `search_cloud_files` lives in `files`, and nobody who wants it types one of
 * that rule's nouns: "what did Dana change in the SharePoint this week" holds
 * no file, document, folder or pdf. It advertised the core four and not the one
 * tool that can answer it — a tool registered, budgeted and advertised on no
 * relevant turn, the WARP-2058 / 2454 / 2497 / 2546 class again. The rule claims
 * the two product names and nothing wider.
 *
 * Whole sentences, never a word lifted out of the pattern — and none of them
 * carries a word the older `files` rules already claim (`document`, `upload`,
 * `file`, …), or the new rule would be doing no work and deleting it would stay
 * green. MUTATION: delete the rule and every positive goes red; drop either
 * product name from it and that name's sentences go red.
 */
describe("WARP-3538 — OneDrive and SharePoint reach search_cloud_files from a fresh turn", () => {
  const CLOUD_FILES_POOL = [...POOL, "search_cloud_files", "list_recent_files"];

  const advertisedFor = (userMessage: string, conversationToolNames: string[] = []) =>
    selectAdvertisedTools({ mode: "domains", userMessage, pool: CLOUD_FILES_POOL, conversationToolNames }).advertised;

  describe("positives — how a person asks after a file by where it lives", () => {
    it.each([
      "what did Dana change in the SharePoint this week?",
      "has the Front Desk site on SharePoint got the new price list yet?",
      "ask SharePoint who touched the staff roster last",
      "is the new staff handbook on OneDrive or only on the Droplet?",
      "anything Sam edited in my OneDrive since Monday?",
      "check my One-Drive for the roofer's paperwork",
    ])("%s", (message) => {
      const advertised = advertisedFor(message);
      expect(advertised).toContain("search_cloud_files");
      // The domain is admitted whole: its siblings come with it.
      expect(advertised).toContain("list_recent_files");
    });
  });

  describe("negatives — sentences that name neither product", () => {
    // The files domain is the largest in the catalog, so each of these would
    // buy ~4K tokens of schema on a turn that wanted none of it.
    it.each([
      // `one drive` with a space is a disk in an array, not a product. The
      // storage question has its own domain; it must not pull `files` in too.
      "one drive in the raid array has failed, is the storage ok?",
      // Microsoft 365 alone is not claimed: it is mail and calendar as much as
      // files, and `microsoft 365` in a calendar question must not buy `files`.
      "is my Microsoft 365 calendar syncing properly?",
      "I would like to share a point about the budget at the meeting",
      // The tool is provider-agnostic, but the word "cloud" is not claimed: this
      // product's customers type it about backups, cameras and privacy as often
      // as about files, and each would buy the whole domain.
      "is any of my camera footage being sent to the cloud?",
      "should the Droplet back itself up to the cloud overnight?",
    ])("%s does not advertise the files domain", (message) => {
      expect(advertisedFor(message)).not.toContain("search_cloud_files");
    });
  });

  it("a conversation that already searched cloud files keeps the files domain on a bare follow-up", () => {
    // "and the one before that?" names nothing; continuity carries it.
    expect(advertisedFor("and the one before that?", ["search_cloud_files"])).toContain("list_recent_files");
    expect(advertisedFor("and the one before that?")).not.toContain("list_recent_files");
  });
});

describe("WARP-3280 — contacts and the calculator are reachable from a fresh turn", () => {
  const CONTACTS_POOL = [...POOL, "search_contacts", "email_search"];
  const DATA_POOL = [...POOL, "calculate", "get_weather"];

  const advertisedFor = (userMessage: string, pool: string[]) =>
    selectAdvertisedTools({
      mode: "domains",
      userMessage,
      pool,
      conversationToolNames: [],
    }).advertised;

  // The ticket's own four sentences matched NO domain (or, for the second,
  // not `email`), so the model answered "no contact found" without ever
  // having search_contacts. MUTATION: drop `contacts?`/`address book`/the
  // bare-address alternative from the email rule and these go red.
  describe("contacts — positives", () => {
    it.each([
      "Look up the contact alice@example.com.",
      "Look up charlie@example.com and open the work item from their contact note.",
      "what's the plumber's number in my contacts?",
      "is Dana Whitfield in the address book?",
      "who is bob.smith+work@acme-corp.co.uk?",
      "find Maria Lopez's contact info",
    ])("%s advertises search_contacts", (message) => {
      expect(advertisedFor(message, CONTACTS_POOL)).toContain("search_contacts");
    });
  });

  // `contact` as a VERB ("contact me later", "who should I contact about the
  // boiler") is knowingly admitted: reaching a person is what the email
  // domain's tools do, and the whole domain is six schemas. What is NOT
  // admitted is the eyewear and card-payment senses, which want nothing
  // from an inbox.
  describe("contacts — negatives", () => {
    it.each([
      "I need to reorder my contact lenses",
      "does the shop take contactless payments?",
      // An `@` that is not an address: a handle and a time.
      "follow us @dropletbox",
      "meet me @ 5",
      "reorder my contact-lens prescription",
    ])("%s does not advertise search_contacts", (message) => {
      expect(advertisedFor(message, CONTACTS_POOL)).not.toContain("search_contacts");
    });
  });

  // Knowingly admitted: any `user@host.tld` token is read as an address, so a
  // git remote or an ssh target advertises the email domain too. Six schemas
  // is the cheap direction; pinned so a future narrowing is a decision.
  describe("contacts — address-shaped tokens that are not mail (accepted)", () => {
    it.each([
      "clone git@github.com:org/repo for me",
      "ssh root@droplet.local is refusing my key",
    ])("%s advertises search_contacts", (message) => {
      expect(advertisedFor(message, CONTACTS_POOL)).toContain("search_contacts");
    });
  });

  // MUTATION: narrow `calculat\w*` back to `calculate`, or drop the
  // arithmetic-expression alternative, and the matching positive goes red.
  describe("calculator — positives", () => {
    it.each([
      "What is 187 * 43?",
      "Use the calculator to work out 2+2.",
      "can you do the math on 1250 × 12 for the annual rent?",
      "what's 84 / 7",
      "quick calculation: 15% of 240",
      "what's 3 x 4.5",
      "how much is 2^10",
      "check my arithmetic, 17 - 9 is 8 right?",
    ])("%s advertises calculate", (message) => {
      expect(advertisedFor(message, DATA_POOL)).toContain("calculate");
    });
  });

  // `-`, `/` and `x` are expressions only with spaces around them; tight,
  // they are dates, phone numbers, resolutions and part numbers. Bare `sum`
  // is not claimed ("sum up the thread" is a summary). These sentences carry
  // no other data word, so they must stay off the domain.
  describe("calculator — negatives", () => {
    it.each([
      "call the landlord on 555-0142",
      "the 9/11 memorial photo",
      "is the monitor 1920x1080?",
      "sum up the thread with Karen",
      "C++ developer resume",
    ])("%s does not advertise calculate", (message) => {
      expect(advertisedFor(message, DATA_POOL)).not.toContain("calculate");
    });
  });
});

// WARP-3280 review — the first bare-address alternative (`[\w.+-]+@…`,
// unanchored and unbounded) backtracked O(n²): 40k chars took ~3 s, blocking
// the event loop on every turn and timing out llm-chat.integration.test.ts.
// `selectAdvertisedTools` tests EVERY `DOMAIN_RULES` pattern (no short
// circuit), so timing it times every rule. Each input is a worst case for at
// least one rule shape: a long word run, a run of `.`/`@` separators, a
// dotted domain with no TLD, whitespace after a digit (the arithmetic `\s*`
// alternatives), and a repeated `contact` lookahead. The auth-policy userid
// test is the precedent. MUTATION: restore `[\w.+-]+@[\w-]+(\.[\w-]+)*` and
// the first case takes seconds.
//
// WARP-3116 — `NAVIGATION_RULES` run only for a pool that holds a navigation
// tool, so a pool without one never times them. Each input therefore runs
// against BOTH pools, and the last four are worst cases for the navigation
// shapes (`open|show me` + the bounded `(\w+ ){0,2}`, `where …`).
describe("WARP-3280 — every domain rule runs in linear time on hostile input", () => {
  const N = 100_000;
  const NAV_POOL = [...POOL, "find_dashboard_page", "open_dashboard_page"];
  it.each([
    ["word run", "x".repeat(N)],
    ["dotted run", "a.".repeat(N / 2)],
    ["at run", "a@".repeat(N / 2)],
    ["local part, no @", "a".repeat(N) + "@"],
    ["domain, no TLD", "a@" + "a.".repeat(N / 2) + "1"],
    ["plus/dash run", "+-".repeat(N / 2) + "@x"],
    ["digit then spaces", "1" + " ".repeat(N) + "a"],
    ["digit-space run", "1 ".repeat(N / 2)],
    ["percent run", "1 % ".repeat(N / 4)],
    ["contact run", "contact ".repeat(N / 8)],
    ["open run", "open ".repeat(N / 5)],
    ["show me run", "show me ".repeat(N / 8)],
    ["open then words", "open " + "a ".repeat(N / 2)],
    ["where run", "where ".repeat(N / 6)],
    // WARP-3340 — the team-chat person-frame rule and its lookbehinds.
    ["message run", "message ".repeat(N / 8)],
    ["error message run", "error message ".repeat(N / 14)],
    ["error then spaces then message", "error" + " ".repeat(N) + "message"],
    ["message then spaces", "message" + " ".repeat(N) + "x"],
    ["send a run", "send a ".repeat(N / 7)],
    ["send then spaces", "send" + " ".repeat(N) + "a message"],
    ["let run", "let ".repeat(N / 4)],
    ["tell a word run", "tell " + "a".repeat(N)],
    // WARP-3538 — the OneDrive / SharePoint product names and their optional hyphens.
    ["one-drive run", "one-".repeat(N / 4)],
    ["share-point run", "share-".repeat(N / 6)],
    ["onedrive then spaces", "onedrive" + " ".repeat(N) + "x"],
  ])("%s (%#) decides in under 50 ms", (_label, hostile) => {
    for (const pool of [POOL, NAV_POOL]) {
      const started = performance.now();
      selectAdvertisedTools({ mode: "domains", userMessage: hostile, pool, conversationToolNames: [] });
      expect(performance.now() - started).toBeLessThan(50);
    }
  });
});
