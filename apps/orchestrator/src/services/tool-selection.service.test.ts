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
