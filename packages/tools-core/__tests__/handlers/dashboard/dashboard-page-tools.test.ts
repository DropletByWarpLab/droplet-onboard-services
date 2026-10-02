import { describe, it, expect } from "vitest";
import {
  FIND_DASHBOARD_PAGE_TOOL,
  OPEN_DASHBOARD_PAGE_TOOL,
  isDashboardNavigateAction,
  type DashboardPage,
} from "@droplet/shared-types";
import findDashboardPage from "../../../src/handlers/dashboard/find-dashboard-page.js";
import openDashboardPage from "../../../src/handlers/dashboard/open-dashboard-page.js";
import type { ToolContext } from "../../../src/types.js";

const PAGES: DashboardPage[] = [
  { href: "/", label: "Overview", section: "Work" },
  { href: "/network", label: "Network", section: "Systems", keywords: ["wifi"] },
  { href: "/voice", label: "Voice", section: "Systems › Network" },
  { href: "/settings", label: "Settings", section: "Admin" },
  { href: "/files/recents", label: "Recent", section: "Work › Files" },
  { href: "/files/shared", label: "Shared", section: "Work › Files" },
];

function ctx(dashboardPages?: unknown): ToolContext {
  return {
    http: {} as ToolContext["http"],
    prisma: {} as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    signal: new AbortController().signal,
    ...(dashboardPages === undefined ? {} : { dashboardPages }),
  };
}

describe("tool names", () => {
  it("match the shared constants the dashboard and orchestrator key on", () => {
    // The handlers spell their names as literals for the TOOL_ROUTES drift
    // gate; useChat and navigationToolsWithheld use the constants.
    expect(findDashboardPage.name).toBe(FIND_DASHBOARD_PAGE_TOOL);
    expect(openDashboardPage.name).toBe(OPEN_DASHBOARD_PAGE_TOOL);
  });
});

describe("open_dashboard_page", () => {
  it("returns a navigate action for the resolved page", async () => {
    const r = await openDashboardPage.handler({ page: "voice settings" }, ctx(PAGES));
    expect(r).toEqual({
      ok: true,
      data: { action: "navigate", href: "/voice", label: "Voice" },
    });
    if (r.ok) expect(isDashboardNavigateAction(r.data)).toBe(true);
  });

  it("refuses off the web dashboard, where there is no screen to move", async () => {
    for (const pages of [undefined, [], "not-a-list"]) {
      const r = await openDashboardPage.handler({ page: "voice" }, ctx(pages));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("NAVIGATION_UNAVAILABLE");
    }
  });

  it("never navigates to a page that fails the shared schema", async () => {
    // The orchestrator validated this list already; the handler checks again
    // because this is where it becomes a navigation target.
    const r = await openDashboardPage.handler(
      { page: "evil" },
      ctx([{ href: "//evil.example", label: "Evil" }]),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("NAVIGATION_UNAVAILABLE");
  });

  it("hands the candidates back on a near tie so the model can ask", async () => {
    const r = await openDashboardPage.handler({ page: "files" }, ctx(PAGES));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("AMBIGUOUS_PAGE");
      const { candidates } = r.error.details as { candidates: { href: string }[] };
      expect(candidates.map((c) => c.href).sort()).toEqual([
        "/files/recents",
        "/files/shared",
      ]);
    }
  });

  it("hands the whole list back when nothing matches", async () => {
    const r = await openDashboardPage.handler({ page: "spaceship" }, ctx(PAGES));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("UNKNOWN_PAGE");
      const { pages } = r.error.details as { pages: { href: string }[] };
      expect(pages).toHaveLength(PAGES.length);
    }
  });

  it("rejects a missing or oversized argument", async () => {
    for (const page of [undefined, "", "x".repeat(201)]) {
      const r = await openDashboardPage.handler({ page }, ctx(PAGES));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_ARGS");
    }
  });
});

describe("find_dashboard_page", () => {
  it("returns linkable matches, best first", async () => {
    const r = await findDashboardPage.handler({ query: "wifi" }, ctx(PAGES));
    expect(r).toEqual({
      ok: true,
      data: { matches: [{ href: "/network", label: "Network", section: "Systems" }] },
    });
  });

  it("returns every page when nothing matches, so the model picks instead of inventing", async () => {
    const r = await findDashboardPage.handler({ query: "spaceship" }, ctx(PAGES));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as { matches: unknown[]; pages: { href: string }[] };
      expect(data.matches).toEqual([]);
      expect(data.pages.map((p) => p.href)).toEqual(PAGES.map((p) => p.href));
    }
  });

  it("refuses off the web dashboard", async () => {
    const r = await findDashboardPage.handler({ query: "voice" }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("NAVIGATION_UNAVAILABLE");
  });
});
