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
  moduleForPath,
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

  // WARP-2967 — the sidebar's re-cut must not reach this layout's reach. Two
  // ways it could: a destination tucked behind Settings losing its chip (rule
  // 2 says `hidden` is a surface decision), or a destination that merely
  // changed indent in the sidebar losing its home here.
  it("keeps every tucked destination as a first-class chip (WARP-2967)", () => {
    const spaces = resolveSpaces("owner", ALL_CAPS, allOn);
    const chips = new Set(
      spaces.flatMap((s) => s.destinations.map((d) => d.item.href)),
    );
    const tucked = NAV_GROUPS.flatMap((g) => g.items).filter((i) => i.hidden);
    expect(tucked.length).toBeGreaterThan(0);
    for (const item of tucked)
      expect(chips.has(item.href), `${item.href} lost its chip`).toBe(true);
  });

  it("keeps the newly nested routes homed (WARP-2967)", () => {
    const set = new Set(spaceHrefs);
    for (const href of ["/brief", "/reports", "/money", "/voice", "/remote-access"])
      expect(set.has(href), `${href} has no home`).toBe(true);
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

  it("keeps Money with Projects off and Voice with Network off (review of #2284)", () => {
    // A parent failing only its MODULE gate does not take a child that names
    // its own module — the sidebar's `passesParentGate`, mirrored here.
    const chips = (off: string) =>
      resolveSpaces("owner", ALL_CAPS, (id) => id !== off).flatMap((s) =>
        s.destinations.map((d) => d.item.href),
      );
    expect(chips("projects")).toContain("/money");
    expect(chips("projects")).not.toContain("/projects");
    expect(chips("network")).toContain("/voice");
    expect(chips("network")).not.toContain("/remote-access");
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

  it("Files' routed children become its views, the section itself first", () => {
    // WARP-2966 removed the "All files" child whose href was its parent's, so
    // `viewsFor` now prepends the section entry itself (marked `exact`) — the
    // documented branch for a section that does not list its own index.
    const views = dest("/files")?.views ?? [];
    expect(views[0]?.href).toBe("/files");
    expect(views[0]?.exact).toBe(true);
    expect(views.map((v) => v.label)).toEqual(["Files", "Recent", "Shared", "Trash"]);
    // Sync devices left Files entirely — it is its own Work chip now.
    expect(dest("/files/devices")?.item.label).toBe("Sync devices");
  });

  it("Integrations and Credentials are sibling chips, neither has views (WARP-2968)", () => {
    expect(dest("/integrations")?.views).toEqual([]);
    expect(dest("/integrations/credentials")?.views).toEqual([]);
  });

  it("a view row is never a single pill", () => {
    // A lone pill is a title, not a choice: `viewsFor` returns [] below two.
    for (const s of spaces)
      for (const d of s.destinations)
        expect(d.views.length === 0 || d.views.length >= 2).toBe(true);
  });

  it("Cameras has no views — its only child (Events) is a chip", () => {
    expect(dest("/cameras")?.views).toEqual([]);
  });

  it("Security's Areas, Patterns and Settings are its views, the section itself first (WARP-2977 P2b, WARP-2980, WARP-2978)", () => {
    const views = dest("/security")?.views ?? [];
    // WARP-2978 — /security/settings holds the opening hours AND who is told about alerts.
    expect(views.map((v) => v.label)).toEqual(["Security", "Areas", "Patterns", "Settings"]);
    // Out of context "Settings" would collide with the app's own Settings link:
    // its accessible name says whose settings they are (and contains the visible label).
    expect(views.find((v) => v.href === "/security/settings")?.ariaLabel).toBe("Security settings");
    expect(views.map((v) => v.href)).toEqual(["/security", "/security/zones", "/security/patterns", "/security/settings"]);
    // The section pill is exact, so it does not stay lit on its sub-pages.
    expect(views[0]?.exact).toBe(true);
    // Views, never chips of their own.
    expect(spaceHrefs).not.toContain("/security/zones");
    expect(spaceHrefs).not.toContain("/security/settings");
    expect(spaceHrefs).not.toContain("/security/patterns");
  });

  it("Security's views follow the security module, not a role (both pages read at view)", () => {
    const family = resolveSpaces("family", NO_CAPS, allOn);
    const sec = family.flatMap((s) => s.destinations).find((d) => d.item.href === "/security");
    expect(sec?.views.map((v) => v.label)).toEqual(["Security", "Areas", "Patterns", "Settings"]);
    const off = resolveSpaces("owner", ALL_CAPS, (m) => m !== "security");
    expect(off.flatMap((s) => s.destinations).find((d) => d.item.href === "/security")).toBeUndefined();
  });

  it("a destination without children has no views", () => {
    expect(dest("/network")?.views).toEqual([]);
  });

  // WARP-2981 (ADR-059 P6) — the wall is reached from /security's header, never
  // the nav, and is still gated by the security module (the prefix rule).
  it("the Security wall is no chip and no view, but the security module still gates it", () => {
    expect(spaceHrefs).not.toContain("/security/wall");
    expect((dest("/security")?.views ?? []).map((v) => v.href)).not.toContain("/security/wall");
    expect(NAV_GROUPS.flatMap((g) => g.items.flatMap((i) => [i.href, ...(i.children ?? []).map((c) => c.href)]))).not.toContain("/security/wall");
    expect(moduleForPath("/security/wall")?.moduleId).toBe("security");
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
    ["/integrations/credentials", "ops", "/integrations/credentials", null],
    ["/integrations", "ops", "/integrations", null],
    ["/admin", "admin", "/admin", null],
    ["/admin/audit", "admin", "/admin/audit", null],
    ["/admin/prompt", "ai", "/admin/prompt", null],
    ["/knowledge", "ai", "/knowledge", null],
    ["/network", "ops", "/network", null],
    // WARP-2977 P2b — Security's sub-pages are views of the Security chip.
    ["/security", "ops", "/security", "/security"],
    ["/security/zones", "ops", "/security", "/security/zones"],
    ["/security/settings", "ops", "/security", "/security/settings"],
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

describe("workspace-nav-config — restrictTo (WARP-2976, ADR-059 §2.3)", () => {
  const hrefsOf = (spaces: ReturnType<typeof resolveSpaces>) =>
    spaces.flatMap((s) => s.destinations.map((d) => d.item.href));

  it("omitted, the spaces are exactly today's", () => {
    expect(hrefsOf(resolveSpaces("owner", ALL_CAPS, allOn, undefined))).toEqual(
      hrefsOf(resolveSpaces("owner", ALL_CAPS, allOn)),
    );
  });

  it("keeps only destinations in the set, and drops the spaces it empties", () => {
    const restrict = new Set(["/cameras", "/events", "/network", "/settings", "/help"]);
    const spaces = resolveSpaces("owner", ALL_CAPS, allOn, restrict);
    expect(spaces.map((s) => s.def.id)).toEqual(["ops", "admin"]);
    expect(hrefsOf(spaces)).toEqual(["/cameras", "/events", "/network", "/settings", "/help"]);
  });

  it("is an intersection: the gates still apply inside the set", () => {
    const restrict = new Set(["/cameras", "/events", "/network", "/integrations"]);
    const hrefs = hrefsOf(resolveSpaces("family", ALL_CAPS, (id) => id !== "cameras", restrict));
    // cameras module off → Cameras and its Events child go; Integrations is
    // owner/admin only → gone for family. Only Network survives.
    expect(hrefs).toEqual(["/network"]);
  });

  it("an href outside NAV_GROUPS in the set adds nothing", () => {
    const hrefs = hrefsOf(resolveSpaces("owner", ALL_CAPS, allOn, new Set(["/nope", "/files"])));
    expect(hrefs).toEqual(["/files"]);
  });

  it("an empty set leaves no spaces at all", () => {
    expect(resolveSpaces("owner", ALL_CAPS, allOn, new Set())).toEqual([]);
  });

  it("keeps a destination's views when the destination survives", () => {
    const files = resolveSpaces("owner", ALL_CAPS, allOn, new Set(["/files"]))[0]
      ?.destinations[0];
    expect(files?.views.map((v) => v.href)).toContain("/files/recents");
  });
});
