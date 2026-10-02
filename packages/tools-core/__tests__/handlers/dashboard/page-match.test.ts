import { describe, it, expect } from "vitest";
import type { DashboardPage } from "@droplet/shared-types";
import {
  findDashboardPages,
  resolveDashboardPage,
} from "../../../src/handlers/dashboard/page-match.js";

// Shaped like what the dashboard derives from nav-config for an owner.
const PAGES: DashboardPage[] = [
  { href: "/", label: "Overview", section: "Work", keywords: ["home", "dashboard"] },
  { href: "/chat", label: "Ask AI", section: "Work" },
  { href: "/files", label: "Files", section: "Work" },
  { href: "/files/trash", label: "Trash", section: "Work › Files", keywords: ["deleted"] },
  { href: "/calendar", label: "Calendar", section: "Work" },
  { href: "/network", label: "Network", section: "Systems", keywords: ["wifi", "internet", "router"] },
  { href: "/network/settings", label: "Open ports", section: "Systems › Network" },
  { href: "/voice", label: "Voice", section: "Systems › Network", keywords: ["microphone", "wake word"] },
  { href: "/settings", label: "Settings", section: "Admin" },
  {
    href: "/users",
    label: "People",
    section: "Settings › Account",
    description: "Who can sign in and what they can reach",
  },
  { href: "/help", label: "Help", section: "Settings › Advanced" },
];

const PAGES_WITH_FILLER_COPY: DashboardPage[] = [
  ...PAGES,
  {
    href: "/admin/prompt",
    label: "Assistant",
    section: "Settings › Automation",
    description: "What the assistant is told, and which tools it can reach",
  },
];

const hrefs = (pages: DashboardPage[]) => pages.map((p) => p.href);

describe("resolveDashboardPage", () => {
  it("resolves the words a person uses to the page they mean", () => {
    const r = resolveDashboardPage(PAGES, "voice settings");
    expect(r).toEqual({ kind: "match", page: expect.objectContaining({ href: "/voice" }) });
  });

  it("lands a guessed path on the page it was reaching for", () => {
    // The WARP-3116 incident: the model offered /settings/voice, which has
    // never existed. Its words still say Voice.
    const r = resolveDashboardPage(PAGES, "/settings/voice");
    expect(r.kind).toBe("match");
    if (r.kind === "match") expect(r.page.href).toBe("/voice");
  });

  it("takes an exact path or an exact label outright", () => {
    expect(resolveDashboardPage(PAGES, "/network/settings")).toMatchObject({
      kind: "match",
      page: { href: "/network/settings" },
    });
    expect(resolveDashboardPage(PAGES, "/files/trash/")).toMatchObject({
      kind: "match",
      page: { href: "/files/trash" },
    });
    expect(resolveDashboardPage(PAGES, "settings")).toMatchObject({
      kind: "match",
      page: { href: "/settings" },
    });
    expect(resolveDashboardPage(PAGES, "Ask AI")).toMatchObject({
      kind: "match",
      page: { href: "/chat" },
    });
  });

  it("uses keywords and descriptions for the words the nav label does not carry", () => {
    expect(resolveDashboardPage(PAGES, "wifi")).toMatchObject({ page: { href: "/network" } });
    expect(resolveDashboardPage(PAGES, "deleted files")).toMatchObject({
      page: { href: "/files/trash" },
    });
    expect(resolveDashboardPage(PAGES, "who can sign in")).toMatchObject({
      page: { href: "/users" },
    });
    expect(resolveDashboardPage(PAGES, "the home dashboard")).toMatchObject({
      page: { href: "/" },
    });
  });

  it("reports a near tie as ambiguous instead of picking one", () => {
    const pages: DashboardPage[] = [
      { href: "/files/recents", label: "Recent", section: "Work › Files" },
      { href: "/files/shared", label: "Shared", section: "Work › Files" },
    ];
    const r = resolveDashboardPage(pages, "files");
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") {
      expect(hrefs(r.candidates).sort()).toEqual(["/files/recents", "/files/shared"]);
    }
  });

  it("reports nothing rather than guessing when no word matches", () => {
    expect(resolveDashboardPage(PAGES, "spaceship controls")).toEqual({ kind: "none" });
    expect(resolveDashboardPage(PAGES, "   ")).toEqual({ kind: "none" });
  });

  // "take me to it" names no page: the model has to resolve "it" from the
  // conversation. Real copy is full of filler — the Assistant blurb below is
  // nav-config's, and "open" is a word of the "Open ports" label — so matching
  // on it would move the person somewhere they never named.
  it.each(["it", "take me to it", "it please", "open it", "the page", "show me that"])(
    "reports nothing for %j, which is filler alone",
    (reference) => {
      expect(resolveDashboardPage(PAGES_WITH_FILLER_COPY, reference)).toEqual({ kind: "none" });
    },
  );
});

describe("findDashboardPages", () => {
  it("treats 'settings' as a qualifier when the query names a place", () => {
    expect(hrefs(findDashboardPages(PAGES, "voice settings", 3))).toEqual(["/voice"]);
    expect(findDashboardPages(PAGES, "settings", 3)[0].href).toBe("/settings");
  });

  it("ranks the rare word over the common one", () => {
    // "files" names two pages, "deleted" one.
    expect(findDashboardPages(PAGES, "deleted files", 3)[0].href).toBe("/files/trash");
  });

  it("respects the limit and returns nothing for filler alone", () => {
    expect(findDashboardPages(PAGES, "settings", 1)).toHaveLength(1);
    expect(findDashboardPages(PAGES, "zzz", 5)).toEqual([]);
    expect(findDashboardPages(PAGES_WITH_FILLER_COPY, "where is it", 5)).toEqual([]);
    expect(findDashboardPages(PAGES_WITH_FILLER_COPY, "open it", 5)).toEqual([]);
  });

  it("is deterministic", () => {
    const a = findDashboardPages(PAGES, "network settings", 5);
    const b = findDashboardPages(PAGES, "network settings", 5);
    expect(hrefs(a)).toEqual(hrefs(b));
  });
});
