/**
 * WARP-2967 — the nav tree is four groups and a Settings front door.
 *
 * The sidebar had grown to 35 top-level rows across four captions, and the
 * Admin caption alone carried thirteen: a console, an inspector, a user list,
 * a catalog, a model status page, three log viewers, two downloads, a trust
 * page and a help page. None of them is daily operation, and a reader
 * scanning for "where do I work" had to scan past all of it.
 *
 * The shape now:
 *
 *   WORK      Overview · Ask AI · Files · Messages · Email · Calendar
 *   BUSINESS  Insights [Brief, Reports] · Customers · Projects [Money] · Practice
 *   SYSTEMS   Security · Cameras [Events] · Network [Voice, Remote access] · Devices
 *
 * Security (WARP-2977, ADR-059) landed on stage after this tree was cut and is
 * its own module, so it is a fifteenth row rather than a child of Cameras.
 *   ADMIN     Settings
 *
 * Everything else keeps its route and moves behind Settings as the WARP-1807
 * tuck: `hidden: true` plus a `settingsSection`, which is what the contextual
 * Settings panel and the Settings page both render from. A tucked item with no
 * section would be a destination with no way back in, so that pairing is
 * pinned here rather than left to reviewers.
 */
import { describe, it, expect } from "vitest";

import {
  NAV_GROUPS,
  SETTINGS_SECTIONS,
  isSettingsContext,
  settingsGroups,
  visibleItems,
  type AuthRole,
  type NavCapabilities,
  type NavItem,
} from "@/components/nav-config";

const ALL_CAPS: NavCapabilities = {
  claudeActivity: true,
  ragEval: true,
  medicalConnector: true,
};
const allOn = (_id: string) => true;

const group = (label: string) => {
  const g = NAV_GROUPS.find((x) => x.label === label);
  if (!g) throw new Error(`no nav group "${label}"`);
  return g;
};
const visible = (label: string, role: AuthRole = "owner", isOn = allOn) =>
  visibleItems(group(label).items, role, ALL_CAPS, isOn);

const everyItem = (): NavItem[] =>
  NAV_GROUPS.flatMap((g) => g.items.flatMap((i) => [i, ...(i.children ?? [])]));

describe("the tree is four groups (WARP-2967)", () => {
  it("has exactly four, in reading order", () => {
    expect(NAV_GROUPS.map((g) => g.label)).toEqual([
      "Work",
      "Business",
      "Systems",
      "Admin",
    ]);
  });

  it("renders at most fifteen top-level rows with everything switched on", () => {
    // The ticket's ≤ 14 plus WARP-2977's Security row.
    const rows = NAV_GROUPS.flatMap((g) => visible(g.label)).length;
    expect(rows).toBeLessThanOrEqual(15);
  });

  it.each([
    ["Work", ["/", "/chat", "/files", "/messages", "/email", "/calendar"]],
    ["Business", ["/business", "/customers", "/projects", "/practice"]],
    ["Systems", ["/security", "/cameras", "/network", "/devices"]],
    ["Admin", ["/settings"]],
  ])("%s shows exactly %j", (label, hrefs) => {
    expect(visible(label).map((i) => i.href)).toEqual(hrefs);
  });

  it("nests Brief and Reports under Insights, Money under Projects", () => {
    const insights = visible("Business").find((i) => i.href === "/business")!;
    expect(insights.label).toBe("Insights");
    expect(insights.children?.map((c) => c.href)).toEqual(["/brief", "/reports"]);

    const projects = visible("Business").find((i) => i.href === "/projects")!;
    expect(projects.children?.map((c) => c.href)).toEqual(["/money"]);
  });

  it("nests Voice and Remote access under Network, Events under Cameras", () => {
    const network = visible("Systems").find((i) => i.href === "/network")!;
    expect(network.children?.map((c) => c.href)).toEqual([
      "/voice",
      "/remote-access",
    ]);
    const cameras = visible("Systems").find((i) => i.href === "/cameras")!;
    expect(cameras.children?.map((c) => c.href)).toEqual(["/events"]);
  });

  // Review of #2284: nesting is filing, not a gate. A parent that fails ONLY
  // its module gate promotes a child that names a module of its own.
  it.each([
    ["Business", "money", "projects", "/money"],
    ["Systems", "voice", "network", "/voice"],
  ])("%s: %s on, %s off → %s is promoted to a top-level row", (label, _on, off, href) => {
    const rows = visible(label, "owner", (id) => id !== off);
    expect(rows.map((i) => i.href)).toContain(href);
    expect(rows.map((i) => i.href)).not.toContain(`/${off}`);
  });

  it("promotes nothing without a module of its own, and never past a role gate", () => {
    // Events is part of Cameras (no module), Remote access shares Network's.
    const sys = visible("Systems", "owner", (id) => id !== "cameras" && id !== "network");
    expect(sys.map((i) => i.href)).toEqual(["/security", "/voice", "/devices"]);
    // Insights is role-gated: a guest gets neither it nor its children.
    const biz = visible("Business", "guest").map((i) => i.href);
    expect(biz).not.toContain("/reports");
    expect(biz).not.toContain("/brief");
  });

  it("never nests more than two levels under any item", () => {
    for (const item of NAV_GROUPS.flatMap((g) => g.items))
      for (const child of item.children ?? [])
        expect(
          (child as NavItem).children,
          `${item.label} → ${child.label} has grandchildren`,
        ).toBeUndefined();
  });

  it("keeps every mobile primary top-level", () => {
    const top = NAV_GROUPS.flatMap((g) => g.items).map((i) => i.href);
    for (const href of ["/", "/chat", "/files", "/devices"])
      expect(top, `${href} must stay a top-level item`).toContain(href);
  });
});

describe("every tucked destination has a way back in (WARP-2967)", () => {
  const tucked = everyItem().filter((i) => i.hidden);

  it("tucks the sixteen admin surfaces the tree no longer carries", () => {
    expect(tucked.map((i) => i.href).sort()).toEqual(
      [
        "/admin",
        "/admin/audit",
        "/admin/claude-activity",
        "/admin/files",
        "/admin/prompt",
        "/admin/rag-eval",
        "/context",
        "/downloads",
        "/files/devices",
        "/health",
        "/help",
        "/integrations",
        "/integrations/credentials",
        "/knowledge",
        "/models",
        "/routines",
        "/tools",
        "/trust",
        "/users",
        "/workshop",
      ].sort(),
    );
  });

  it("gives every tucked item a Settings section and a blurb", () => {
    for (const item of tucked) {
      expect(
        item.settingsSection,
        `${item.href} is tucked with no settingsSection — no way back in`,
      ).toBeTruthy();
      expect(
        item.settingsBlurb,
        `${item.href} has no settingsBlurb — its row would read as a bare noun`,
      ).toBeTruthy();
      // Period-free noun-phrase fragments, matching the hand-written rows.
      expect(item.settingsBlurb?.endsWith("."), item.href).toBe(false);
    }
  });

  it("gates no tucked item on the medical connector", () => {
    // The Settings page resolves capabilities from /api/admin/capabilities
    // alone; `medicalConnector` is the Sidebar's own /api/integrations probe
    // (WARP-2880) and only /practice — a VISIBLE Business row — uses it. A
    // tucked item gating on it would silently lose its Settings row, so this
    // is the pin rather than a comment nobody reads.
    for (const item of tucked)
      expect(item.requiresCapability, item.href).not.toBe("medicalConnector");
  });

  it("gives no VISIBLE item a Settings section — the panel is the tuck's other half", () => {
    for (const item of everyItem().filter((i) => !i.hidden))
      expect(item.settingsSection, `${item.href}`).toBeUndefined();
  });

  it("puts every tucked item in exactly one panel row, in section order", () => {
    const groups = settingsGroups("owner", ALL_CAPS, allOn);
    expect(groups.map((g) => g.label)).toEqual(
      SETTINGS_SECTIONS.filter((s) => groups.some((g) => g.label === s)),
    );
    const rows = groups.flatMap((g) => g.items.map((i) => i.href));
    expect(new Set(rows).size).toBe(rows.length);
    expect(rows.sort()).toEqual(tucked.map((i) => i.href).sort());
  });

  it("applies the viewer's gates to the panel, but never the tuck itself", () => {
    // A guest may not see the console; nobody sees RAG eval without the
    // capability. The `hidden` flag is the one predicate the panel ignores —
    // it is what put these rows here.
    const guest = settingsGroups("guest", ALL_CAPS, allOn).flatMap((g) =>
      g.items.map((i) => i.href),
    );
    expect(guest).not.toContain("/admin");
    expect(guest).toContain("/help");

    const noCaps = settingsGroups("owner", {
      claudeActivity: false,
      ragEval: false,
      medicalConnector: false,
    }, allOn).flatMap((g) => g.items.map((i) => i.href));
    expect(noCaps).not.toContain("/admin/rag-eval");
    expect(noCaps).not.toContain("/admin/claude-activity");
  });

  it("drops a section that has nothing left rather than captioning air", () => {
    const none = settingsGroups("guest", ALL_CAPS, () => false);
    for (const g of none) expect(g.items.length).toBeGreaterThan(0);
  });
});

describe("isSettingsContext — which routes swap the sidebar (WARP-2967)", () => {
  it.each(["/settings", "/settings/storage", "/admin", "/admin/audit", "/tools", "/help"])(
    "%s is a settings context",
    (pathname) => {
      expect(isSettingsContext(pathname)).toBe(true);
    },
  );

  it.each(["/", "/files", "/files/trash", "/cameras", "/network", "/settingsomething"])(
    "%s is not",
    (pathname) => {
      expect(isSettingsContext(pathname)).toBe(false);
    },
  );
});
