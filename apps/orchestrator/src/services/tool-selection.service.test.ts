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
