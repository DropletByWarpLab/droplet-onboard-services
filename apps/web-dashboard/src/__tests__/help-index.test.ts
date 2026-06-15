/**
 * Help search — local in-repo help index (PR #382).
 *
 * The spec wants `GET /help/search?q=` semantic search over shipped help
 * articles indexed in the Files/chat embedding store. That backend index does
 * not exist yet for help content (FLAGGED to the controller). This PR ships a
 * local, in-repo, offline help index + a pure ranked-search function so the
 * Help UI is searchable today without standing up a second vector store or
 * inventing a data source.
 *
 * Pure-function tests (no DOM) — the UI wiring is covered in
 * help.search.test.tsx.
 */
import { describe, it, expect } from "vitest";
import { HELP_INDEX, searchHelp } from "@/lib/help-index";

// Mirror of the /help page's SECTIONS anchors. The index MUST carry one entry
// per browse section so the HelpLauncher search + "Browse all topics" surface
// every topic the page documents — a section without an index entry is silently
// unsearchable. Keep this list in sync with SECTIONS in app/help/page.tsx.
const PAGE_SECTION_ANCHORS = [
  "claim",
  "workspace",
  "roles",
  "extenders",
  "internet",
  "storage",
  "cameras",
  "vpn",
  "ai",
  "devices",
  "files",
];

describe("help index", () => {
  it("ships a non-empty index with stable anchors, titles, and searchable text", () => {
    expect(HELP_INDEX.length).toBeGreaterThan(0);
    for (const entry of HELP_INDEX) {
      expect(entry.id).toMatch(/^[a-z][a-z-]*$/); // anchor-safe slug
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.summary.length).toBeGreaterThan(0);
      expect(Array.isArray(entry.keywords)).toBe(true);
    }
    // Anchors are unique (they're DOM ids + deep-link targets).
    const ids = HELP_INDEX.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("carries an entry for every /help browse section (search mirrors the page)", () => {
    const ids = HELP_INDEX.map((e) => e.id);
    for (const anchor of PAGE_SECTION_ANCHORS) {
      // A page section with no matching index entry is invisible to the
      // HelpLauncher search + "Browse all topics" list.
      expect(ids).toContain(anchor);
    }
  });
});

describe("searchHelp", () => {
  it("returns the whole index for an empty / whitespace query", () => {
    expect(searchHelp("")).toHaveLength(HELP_INDEX.length);
    expect(searchHelp("   ")).toHaveLength(HELP_INDEX.length);
  });

  it("matches on title text case-insensitively", () => {
    const results = searchHelp("CAMERAS");
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.id === "cameras")).toBe(true);
  });

  it("matches on body/summary text, not just the title", () => {
    // "WireGuard" appears in the VPN topic's body, not its title.
    const results = searchHelp("wireguard");
    expect(results.some((r) => r.id === "vpn")).toBe(true);
  });

  it("matches on keywords (synonyms the prose may not contain verbatim)", () => {
    // A customer is likely to type "vpn" — the remote-access topic must
    // surface even though its title is phrased differently.
    const results = searchHelp("vpn");
    expect(results.some((r) => r.id === "vpn")).toBe(true);
  });

  it("ranks a title hit above a body-only hit", () => {
    // "storage" is a title; it also appears in other topics' bodies. The
    // titled topic must rank first.
    const results = searchHelp("storage");
    expect(results[0]?.id).toBe("storage");
  });

  it("returns an empty array when nothing matches", () => {
    expect(searchHelp("zzzzz-no-such-topic")).toHaveLength(0);
  });
});
