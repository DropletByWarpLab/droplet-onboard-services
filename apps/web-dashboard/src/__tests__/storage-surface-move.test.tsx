/**
 * WARP-2959 — the Drives surface moved off Files and into Settings → Storage.
 *
 * Drives is box administration, not a place files live: it renders storage
 * pools, RAID health, the system disk, and destructive erase/adopt/reclaim
 * actions, none of which answer "where is my document?". It sat in the Files
 * sub-nav between "All files" and "Recents" purely because it reads the same
 * `/api/storage/*` data.
 *
 * The surface is MOVED, not deleted — same `DrivesPanel`, new address — so
 * these pins are about reachability. Each half of the move is one that fails
 * silently if it regresses: a stale nav row points at a 404, a missing
 * redirect breaks a bookmark, and a surface that lost its only entry point
 * fails nothing at all.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const redirect = vi.fn();
vi.mock("next/navigation", () => ({
  redirect: (href: string) => redirect(href),
  usePathname: () => "/settings/storage",
}));

// The panel itself is unchanged and tested in DrivesPanel.test.tsx /
// drives-panel.pools.test.tsx; a sentinel keeps this file about the MOVE and
// off the storage hooks.
vi.mock("@/components/FileManager/DrivesPanel", () => ({
  DrivesPanel: () => <p>drives panel</p>,
}));

// ShellPage fires a health fetch and reads the box address at render.
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, fetchSystemHealth: vi.fn().mockResolvedValue({ status: "ok" }) };
});
vi.mock("@/lib/hooks/useBoxAddress", () => ({ useBoxAddress: () => "droplet.local" }));

import StoragePage from "@/app/settings/storage/page";
import DrivesRedirect from "@/app/files/drives/page";
import { NAV_GROUPS } from "@/components/nav-config";
import { FILES_ROUTE_HEADERS, routeOwnership } from "@/app/files/files-routes";

describe("Settings → Storage is the Drives surface's new home", () => {
  it("renders DrivesPanel under a Storage header", () => {
    render(<StoragePage />);
    expect(screen.getByRole("heading", { name: "Storage" })).toBeInTheDocument();
    expect(screen.getByText("drives panel")).toBeInTheDocument();
  });
});

describe("the old /files/drives address keeps working", () => {
  it("redirects to /settings/storage rather than 404ing a bookmark", () => {
    redirect.mockClear();
    DrivesRedirect();
    expect(redirect).toHaveBeenCalledWith("/settings/storage");
    expect(redirect).toHaveBeenCalledTimes(1);
  });

  it("carries no header of its own — the layout must pass it straight through", () => {
    // A redirect page renders nothing; wrapping it in a ShellPage would paint
    // a header for a route nobody ever sees.
    expect(FILES_ROUTE_HEADERS["/files/drives"]).toBeUndefined();
    expect(routeOwnership("/files/drives")).toBe("page");
  });
});

describe("Files no longer offers Drives", () => {
  function filesChildren() {
    for (const group of NAV_GROUPS) {
      const files = group.items.find((i) => i.href === "/files");
      if (files) return files.children ?? [];
    }
    throw new Error("the Files nav item is gone");
  }

  it("drops the Drives child from the Files sub-nav", () => {
    const hrefs = filesChildren().map((c) => c.href);
    expect(hrefs).not.toContain("/files/drives");
    // …and the rest of the sub-nav is untouched.
    // WARP-2966 re-cut the rest of the sub-nav to three places: the "All
    // files" row repeated the parent href, Favorites is a filter reached from
    // the browser's toolbar, and Sync devices left Files for Settings.
    expect(hrefs).toEqual([
      "/files/recents",
      "/files/shared",
      "/files/trash",
    ]);
  });

  it("points nowhere at Drives from any nav group", () => {
    const every = NAV_GROUPS.flatMap((g) => g.items.flatMap((i) => [i, ...(i.children ?? [])]));
    expect(every.map((i) => i.href)).not.toContain("/files/drives");
  });
});
