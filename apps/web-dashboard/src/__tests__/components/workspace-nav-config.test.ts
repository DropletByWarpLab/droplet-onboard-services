/**
 * WARP-2971 — pins on the Workspace layout's IA (`workspace-nav-config.ts`).
 *
 * The map is hrefs only; everything else is looked up in `nav-config.ts`.
 * These tests hold the two rules that make that safe:
 *   · every nav destination has exactly one home in the spaces (no route
 *     becomes unreachable when a person switches layouts, none appears twice);
 *   · the sidebar's gates apply unchanged — only the WARP-1807 tuck differs.
 */
import { describe, expect, it } from "vitest";

import {
  NAV_GROUPS,
  type AuthRole,
  type NavCapabilities,
} from "@/components/nav-config";
import {
  SPACES,
  indexedNavHrefs,
  locate,
  resolveSpaces,
} from "@/components/workspace/workspace-nav-config";

const ALL_CAPS: NavCapabilities = {
  claudeActivity: true,
  ragEval: true,
  medicalConnector: true,
};
const NO_CAPS: NavCapabilities = {
  claudeActivity: false,
  ragEval: false,
  medicalConnector: false,
};
const allOn = () => true;

const spaceHrefs = SPACES.flatMap((s) => s.hrefs);

describe("workspace-nav-config — the map is complete and single-homed", () => {
  it("every space href resolves to a nav-config entry", () => {
    const known = new Set(indexedNavHrefs());
    for (const href of spaceHrefs) {
      expect(known.has(href), `${href} is not in NAV_GROUPS`).toBe(true);
    }
  });

  it("no href appears in two spaces", () => {
    const seen = new Map<string, number>();
    for (const href of spaceHrefs) seen.set(href, (seen.get(href) ?? 0) + 1);
    const dupes = [...seen].filter(([, n]) => n > 1).map(([h]) => h);
    expect(dupes).toEqual([]);
  });

  it("every top-level nav item is a destination somewhere", () => {
    const set = new Set(spaceHrefs);
    const missing = NAV_GROUPS.flatMap((g) => g.items)
      .map((i) => i.href)
      .filter((href) => !set.has(href));
    expect(missing).toEqual([]);
  });

  it("every nav child is either a destination or a view of its parent", () => {
    const spaces = resolveSpaces("owner", ALL_CAPS, allOn);
    const reachable = new Set<string>();
    for (const s of spaces)
      for (const d of s.destinations) {
        reachable.add(d.item.href);
        for (const v of d.views) reachable.add(v.href);
      }
    const orphans: string[] = [];
    for (const g of NAV_GROUPS)
      for (const item of g.items)
        for (const child of item.children ?? [])
          if (!reachable.has(child.href)) orphans.push(child.href);
    expect(orphans).toEqual([]);
  });

  it("has six spaces, Business between Work and Operations (ADR-044)", () => {
    expect(SPACES.map((s) => s.id)).toEqual([
      "home",
      "work",
      "business",
      "ops",
      "ai",
      "admin",
    ]);
  });
});

describe("workspace-nav-config — gates are the sidebar's", () => {
  it("an owner with every capability sees every space", () => {
    const spaces = resolveSpaces("owner", ALL_CAPS, allOn);
    expect(spaces.map((s) => s.def.id)).toEqual(SPACES.map((s) => s.id));
  });

  it("labels and icons come from nav-config, not from the map", () => {
    const spaces = resolveSpaces("owner", ALL_CAPS, allOn);
    const files = spaces
      .flatMap((s) => s.destinations)
      .find((d) => d.item.href === "/files");
    const navFiles = NAV_GROUPS.flatMap((g) => g.items).find(
      (i) => i.href === "/files",
    );
    expect(files?.item.label).toBe(navFiles?.label);
    expect(files?.item.icon).toBe(navFiles?.icon);
  });

  it("a switched-off module drops its chip (WARP-1397)", () => {
    const isOn = (id: string) => id !== "cameras";
    const ops = resolveSpaces("owner", ALL_CAPS, isOn).find(
      (s) => s.def.id === "ops",
    );
    const hrefs = ops?.destinations.map((d) => d.item.href) ?? [];
    expect(hrefs).not.toContain("/cameras");
    // Events is Cameras' child in nav-config: it inherits the parent's gate
    // even though it is its own chip here (mirrors visibleItems).
    expect(hrefs).not.toContain("/events");
    expect(hrefs).toContain("/network");
  });

  it("a role gate hides the chip, and an emptied space loses its tab", () => {
    // Business is entirely role/module gated; a guest with every module off
    // has nothing there, so the tab must not render.
    const guest = resolveSpaces("guest", NO_CAPS, () => false);
    expect(guest.map((s) => s.def.id)).not.toContain("business");
    // …and nothing role-gated leaks to the guest anywhere.
    for (const s of guest)
      for (const d of s.destinations)
        expect(d.item.roles ?? ["guest"]).toContain("guest");
  });

  it("a capability gate hides the chip (Activity, RAG eval, Practice)", () => {
    const spaces = resolveSpaces("owner", NO_CAPS, allOn);
    const hrefs = spaces.flatMap((s) => s.destinations.map((d) => d.item.href));
    expect(hrefs).not.toContain("/admin/claude-activity");
    expect(hrefs).not.toContain("/admin/rag-eval");
    expect(hrefs).not.toContain("/practice");
  });

  it("the WARP-1807 tuck does NOT apply: Knowledge and Context are Intelligence chips", () => {
    const ai = resolveSpaces("family", ALL_CAPS, allOn).find(
      (s) => s.def.id === "ai",
    );
    const hrefs = ai?.destinations.map((d) => d.item.href) ?? [];
    expect(hrefs).toContain("/knowledge");
    expect(hrefs).toContain("/context");
    // …but Knowledge still honours its module gate.
    const off = resolveSpaces("family", ALL_CAPS, (id) => id !== "knowledge")
      .find((s) => s.def.id === "ai")
      ?.destinations.map((d) => d.item.href);
    expect(off).not.toContain("/knowledge");
    expect(off).toContain("/context");
  });
});

describe("workspace-nav-config — Level 3 views", () => {
  const spaces = resolveSpaces("owner", ALL_CAPS, allOn);
  const dest = (href: string) =>
    spaces.flatMap((s) => s.destinations).find((d) => d.item.href === href);

  it("Files' routed children become its views, All files first", () => {
    const labels = dest("/files")?.views.map((v) => v.label);
    expect(labels?.[0]).toBe("All files");
    expect(labels).toContain("Recents");
    expect(labels).toContain("Sync Devices");
  });

  /**
   * WARP-2968 crossed WARP-2971 on stage: Credentials stopped being a child of
   * Integrations in `nav-config.ts` (#2241) while this map still expected one.
   * It is a chip of its own now, so Integrations has no view pills at all —
   * and the fact worth pinning is that the destination did not go missing in
   * the move.
   */
  it("Integrations has no views — Credentials is a chip of its own (WARP-2968)", () => {
    expect(dest("/integrations")?.views).toEqual([]);
    expect(dest("/integrations/credentials")?.item.label).toBe("Credentials");
  });

  it("Cameras has no views — its only child (Events) is a chip", () => {
    expect(dest("/cameras")?.views).toEqual([]);
  });

  it("a destination without children has no views", () => {
    expect(dest("/network")?.views).toEqual([]);
  });
});

describe("workspace-nav-config — locate() derives space + destination from the URL", () => {
  const spaces = resolveSpaces("owner", ALL_CAPS, allOn);

  it.each([
    ["/", "home", "/", null],
    ["/reports", "home", "/reports", null],
    ["/files", "work", "/files", "/files"],
    ["/files/recents", "work", "/files", "/files/recents"],
    ["/events", "ops", "/events", null],
    ["/cameras/front-door", "ops", "/cameras", null],
    // WARP-2968 — its own chip, so the longest-match destination IS
    // /integrations/credentials and there is no view pill under it.
    ["/integrations/credentials", "ops", "/integrations/credentials", null],
    ["/admin", "admin", "/admin", null],
    ["/admin/audit", "admin", "/admin/audit", null],
    ["/admin/prompt", "ai", "/admin/prompt", null],
    ["/knowledge", "ai", "/knowledge", null],
    ["/network", "ops", "/network", null],
  ])("%s → %s / %s (view %s)", (path, space, destHref, viewHref) => {
    const loc = locate(spaces, path);
    expect(loc?.space.def.id).toBe(space);
    expect(loc?.destination.item.href).toBe(destHref);
    expect(loc?.view?.href ?? null).toBe(viewHref);
  });

  it("is segment-aware: /networking is not Network", () => {
    expect(locate(spaces, "/networking")).toBeNull();
  });

  it("returns null for a route no chip leads to", () => {
    expect(locate(spaces, "/clips")).toBeNull();
    expect(locate(spaces, "/admin/nowhere")).toBeNull();
  });

  it("does not light Console (exact) on its siblings", () => {
    expect(locate(spaces, "/admin/files")?.destination.item.href).toBe(
      "/admin/files",
    );
  });
});
