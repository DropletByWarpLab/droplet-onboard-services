/**
 * WARP-2966 — the Files section reads as one idea.
 *
 * The section carried six children: an "All files" row whose href was the
 * parent's own, Recents, Favorites, Shared, Trash and Sync Devices — a
 * duplicate, four places and a device-pairing screen, under one caption. The
 * list could not be read as a single thought because it was not one.
 *
 * Option B (the shipped shape): THREE children, all of them places you can be
 * inside the file tree — Recent, Shared, Trash. The parent IS Browse, so the
 * duplicate row goes. Favorites becomes a filter you reach from the browser
 * itself, and Sync Devices leaves Files for Settings
 * (`docs/design/files-surface-addendum.md` §2.3 — a move, not a deletion).
 *
 * These pins hold the SHAPE. The rail's own behaviour is pinned in
 * `Sidebar.files-rail.test.tsx`; the Settings row in
 * `settings.advanced-links.test.tsx`.
 */
import { describe, it, expect } from "vitest";

import { NAV_GROUPS, moduleForPath, type NavItem } from "@/components/nav-config";

function findItem(href: string): NavItem {
  for (const group of NAV_GROUPS) {
    const hit = group.items.find((i) => i.href === href);
    if (hit) return hit;
  }
  throw new Error(`no nav item for ${href}`);
}

describe("Files section shape (WARP-2966)", () => {
  it("has exactly three children — Recent, Shared, Trash", () => {
    const files = findItem("/files");
    expect(files.children?.map((c) => c.label)).toEqual([
      "Recent",
      "Shared",
      "Trash",
    ]);
    expect(files.children?.map((c) => c.href)).toEqual([
      "/files/recents",
      "/files/shared",
      "/files/trash",
    ]);
  });

  it("has no child whose href is its own — the parent IS Browse", () => {
    for (const group of NAV_GROUPS) {
      for (const item of group.items) {
        for (const child of item.children ?? []) {
          expect(
            child.href,
            `${item.label} repeats its own href as a child row`,
          ).not.toBe(item.href);
        }
      }
    }
  });

  it("keeps Favorites' route working even though it left the nav", () => {
    // The row is gone from the sub-nav; the ROUTE is not. It still belongs to
    // the files module via the /files prefix, so the WARP-1528 gap-(c) route
    // gate cannot regress into "unclaimed, therefore never blockable".
    expect(moduleForPath("/files/favorites")?.moduleId).toBe("files");
    const files = findItem("/files");
    expect(files.children?.map((c) => c.href)).not.toContain("/files/favorites");
  });

  it("tucks Sync devices out of Files without orphaning its route", () => {
    // WARP-1807's pattern: a hidden top-level entry renders on no surface but
    // stays in the definition, so `moduleForPath` keeps claiming the route and
    // the label/icon stay canonical. Settings owns the way in.
    const devices = findItem("/files/devices");
    expect(devices.hidden).toBe(true);
    expect(devices.requiresModule).toBe("files");
    expect(moduleForPath("/files/devices")?.moduleId).toBe("files");

    const files = findItem("/files");
    expect(files.children?.map((c) => c.href)).not.toContain("/files/devices");
  });

  it("keeps /files top-level — it owns a mobile tab", () => {
    // `mobileTabs` resolves MOBILE_PRIMARY_HREFS against TOP-LEVEL items only,
    // so demoting /files would silently delete its bottom tab.
    expect(NAV_GROUPS.flatMap((g) => g.items).map((i) => i.href)).toContain(
      "/files",
    );
  });
});
