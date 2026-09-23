/**
 * WARP-2976 (ADR-059 §2.3, §2.5) — the department nav filter.
 *
 * The rule under test: department nav = profile.navHrefs ∩ the existing
 * gates. An intersection, never a union; the gates run AFTER the filter and
 * are never replaced by it; Whole business is today's nav, unchanged.
 */
import { describe, expect, it } from "vitest";

import {
  NAV_GROUPS,
  passesGates,
  visibleItems,
  type NavCapabilities,
  type NavItem,
} from "@/components/nav-config";

import {
  DEPARTMENT_ALWAYS_HREFS,
  departmentHomeHref,
  departmentNavGroups,
  departmentRestrictSet,
  mergeNavSelection,
  navChoices,
  slugFromPath,
} from "./department-nav";
import { templateFor } from "./templates";

const ALL_CAPS: NavCapabilities = {
  claudeActivity: true,
  ragEval: true,
  medicalConnector: true,
};
const allOn = () => true;

const SECURITY = { name: "Security", slug: "security" };
const securityProfile = {
  icon: "shield-check",
  navHrefs: [...templateFor("security")!.navHrefs],
};

const hrefsOf = (items: NavItem[]) => items.map((i) => i.href);
const topLevel = NAV_GROUPS.flatMap((g) => g.items);

describe("departmentNavGroups — Whole business is today's nav", () => {
  it("returns NAV_GROUPS itself when no department is active", () => {
    expect(departmentNavGroups(NAV_GROUPS, null, null)).toBe(NAV_GROUPS);
    expect(departmentNavGroups(NAV_GROUPS, null, securityProfile)).toBe(NAV_GROUPS);
  });

  it("returns NAV_GROUPS itself for a department that is not set up", () => {
    expect(departmentNavGroups(NAV_GROUPS, SECURITY, null)).toBe(NAV_GROUPS);
    expect(departmentNavGroups(NAV_GROUPS, SECURITY, undefined)).toBe(NAV_GROUPS);
  });
});

describe("departmentNavGroups — intersection, never union", () => {
  const groups = departmentNavGroups(NAV_GROUPS, SECURITY, securityProfile);

  it("one group captioned with the department, its home first", () => {
    expect(groups[0].label).toBe("Security");
    expect(groups[0].items[0]).toMatchObject({
      href: departmentHomeHref("security"),
      label: "Security home",
      exact: true,
    });
  });

  it("holds only the profile's destinations, in profile order", () => {
    // /events is a CHILD of /cameras, so it arrives with its parent.
    expect(hrefsOf(groups[0].items)).toEqual([
      "/d/security",
      "/cameras",
      "/network",
      "/devices",
      "/integrations",
    ]);
  });

  it("adds nothing outside the profile except Ask AI, Settings and Help", () => {
    const every = groups.flatMap((g) => hrefsOf(g.items));
    expect(every).not.toContain("/");
    expect(every).not.toContain("/files");
    expect(hrefsOf(groups[1].items)).toEqual(["/chat", "/settings", "/help"]);
    expect(groups[1].label).toBe("General");
    expect(hrefsOf(groups[1].items)).toEqual([...DEPARTMENT_ALWAYS_HREFS]);
    expect(groups).toHaveLength(2);
  });

  it("keeps the ORIGINAL NavItem objects, so their gates travel with them", () => {
    const cameras = groups[0].items.find((i) => i.href === "/cameras");
    expect(cameras).toBe(topLevel.find((i) => i.href === "/cameras"));
    expect(cameras?.requiresModule).toBe("cameras");
  });

  it("follows navHrefs order, not NAV_GROUPS order", () => {
    const g = departmentNavGroups(NAV_GROUPS, SECURITY, {
      icon: "shield-check",
      navHrefs: ["/network", "/cameras"],
    });
    expect(hrefsOf(g[0].items)).toEqual(["/d/security", "/network", "/cameras"]);
  });

  it("ignores hrefs NAV_GROUPS does not have — no dead links", () => {
    const g = departmentNavGroups(NAV_GROUPS, SECURITY, {
      icon: "shield-check",
      navHrefs: ["/nope", "/network", "/admin/gone", "/networking"],
    });
    expect(hrefsOf(g[0].items)).toEqual(["/d/security", "/network"]);
  });

  it("lists an item once even when the parent and a child are both named", () => {
    const g = departmentNavGroups(NAV_GROUPS, SECURITY, {
      icon: "shield-check",
      navHrefs: ["/events", "/cameras"],
    });
    expect(hrefsOf(g[0].items)).toEqual(["/d/security", "/cameras"]);
  });

  it("does not repeat an always-reachable destination the profile already lists", () => {
    const g = departmentNavGroups(NAV_GROUPS, SECURITY, {
      icon: "shield-check",
      navHrefs: ["/chat", "/settings", "/help"],
    });
    expect(hrefsOf(g[0].items)).toEqual(["/d/security", "/chat", "/settings", "/help"]);
    expect(g).toHaveLength(1);
  });

  it("an unknown icon falls back to a glyph rather than nothing", () => {
    const g = departmentNavGroups(NAV_GROUPS, SECURITY, { icon: "no-such-icon", navHrefs: [] });
    expect(g[0].items[0].icon).toBeTruthy();
  });
});

describe("departmentNavGroups — the gates still apply AFTER the filter", () => {
  const groups = departmentNavGroups(NAV_GROUPS, SECURITY, securityProfile);
  const gated = (role: Parameters<typeof visibleItems>[1], isOn: (id: string) => boolean) =>
    groups.map((g) => ({ ...g, items: visibleItems(g.items, role, ALL_CAPS, isOn) }));

  it("a /cameras href in a Security profile is hidden when the cameras module is off", () => {
    const out = gated("owner", (id) => id !== "cameras");
    const hrefs = out.flatMap((g) => hrefsOf(g.items));
    expect(hrefs).not.toContain("/cameras");
    expect(hrefs).toContain("/network");
  });

  it("a role gate still hides Integrations from a family member of Security", () => {
    const out = gated("family", allOn);
    const hrefs = out.flatMap((g) => hrefsOf(g.items));
    expect(hrefs).not.toContain("/integrations");
    expect(hrefs).toContain("/cameras");
  });

  it("never yields an item that passesGates would reject", () => {
    for (const role of ["owner", "admin", "family", "guest"] as const) {
      const isOn = (id: string) => id !== "network";
      for (const g of gated(role, isOn))
        for (const item of g.items) {
          expect(passesGates(item, role, ALL_CAPS, isOn)).toBe(true);
        }
    }
  });
});

describe("departmentRestrictSet — the Workspace layout's restriction", () => {
  it("is null (no restriction) without a profile", () => {
    expect(departmentRestrictSet(null)).toBeNull();
    expect(departmentRestrictSet(undefined)).toBeNull();
  });

  it("is the profile's hrefs plus Ask AI, Settings and Help", () => {
    const set = departmentRestrictSet({ navHrefs: ["/cameras"] });
    expect([...(set ?? [])].sort()).toEqual(["/cameras", "/chat", "/help", "/settings"]);
  });
});

describe("slugFromPath", () => {
  it.each([
    ["/d/security", "security"],
    ["/d/front-desk/", "front-desk"],
    ["/d/caf%C3%A9", "café"],
    ["/d", null],
    ["/d/", null],
    ["/d/security/cameras", null],
    ["/dashboard", null],
    ["/", null],
    [null, null],
  ])("%s → %s", (path, slug) => {
    expect(slugFromPath(path)).toBe(slug);
  });
});

describe("departmentNavGroups × the WARP-2967 tuck and nesting", () => {
  const render = (
    slug: string,
    role: Parameters<typeof visibleItems>[1] = "owner",
    isOn: (id: string) => boolean = allOn,
  ) =>
    departmentNavGroups(NAV_GROUPS, { name: slug, slug }, {
      icon: "briefcase",
      navHrefs: [...templateFor(slug as never)!.navHrefs],
    }).flatMap((g) => hrefsOf(visibleItems(g.items, role, ALL_CAPS, isOn)));

  it("IT keeps Integrations, Users and Health, though Settings owns them in the whole-business nav", () => {
    expect(render("it")).toEqual(
      expect.arrayContaining(["/integrations", "/users", "/health"]),
    );
  });

  it("Operations keeps Routines; every department keeps Help", () => {
    expect(render("operations")).toContain("/routines");
    for (const slug of ["security", "it", "finance", "operations", "sales"])
      expect(render(slug), slug).toContain("/help");
  });

  it("Finance shows Money and Reports, not the Projects and Insights they nest under", () => {
    const hrefs = render("finance");
    expect(hrefs).toEqual(expect.arrayContaining(["/money", "/reports"]));
    expect(hrefs).not.toContain("/projects");
    expect(hrefs).not.toContain("/business");
  });

  it("a listed child still carries its parent's gates where it names none", () => {
    const g = (navHrefs: string[]) =>
      departmentNavGroups(NAV_GROUPS, SECURITY, { icon: "shield-check", navHrefs });
    // Events has no module of its own — it is part of Cameras.
    const events = g(["/events"])[0].items.find((i) => i.href === "/events")!;
    expect(visibleItems([events], "owner", ALL_CAPS, (id) => id !== "cameras")).toEqual([]);
    // Reports keeps the Insights role gate: guests never see it.
    const reports = g(["/reports"])[0].items.find((i) => i.href === "/reports")!;
    expect(visibleItems([reports], "guest", ALL_CAPS, allOn)).toEqual([]);
    // Money names its own module, so it survives Projects being off.
    const money = g(["/money"])[0].items.find((i) => i.href === "/money")!;
    expect(hrefsOf(visibleItems([money], "owner", ALL_CAPS, (id) => id !== "projects"))).toEqual([
      "/money",
    ]);
  });
});

describe("navChoices — only what the editor can reach", () => {
  it("offers tucked entries, drops the always-reachable ones", () => {
    const hrefs = navChoices(NAV_GROUPS, "owner", ALL_CAPS, allOn).map((c) => c.href);
    // WARP-2967: templates seed tucked hrefs (IT's /users, /health); an
    // editor who cannot see them in the checklist cannot uncheck them.
    expect(hrefs).toContain("/knowledge");
    expect(hrefs).toContain("/users");
    expect(hrefs).not.toContain("/chat");
    expect(hrefs).not.toContain("/settings");
    expect(hrefs).not.toContain("/help");
    expect(hrefs).toContain("/events");
  });

  it("runs the editor's own gates", () => {
    const hrefs = navChoices(NAV_GROUPS, "family", ALL_CAPS, (id) => id !== "cameras").map(
      (c) => c.href,
    );
    expect(hrefs).not.toContain("/integrations");
    expect(hrefs).not.toContain("/cameras");
    // A child drops with its parent, exactly as `visibleItems` drops it.
    expect(hrefs).not.toContain("/events");
  });

  it("offers Money when only Projects is off — the parent failed only its module", () => {
    const hrefs = navChoices(NAV_GROUPS, "owner", ALL_CAPS, (id) => id !== "projects").map(
      (c) => c.href,
    );
    expect(hrefs).toContain("/money");
    expect(hrefs).not.toContain("/projects");
  });
});

describe("mergeNavSelection — never silently drops what the editor cannot see", () => {
  it("keeps hrefs outside the editor's view, in place", () => {
    const out = mergeNavSelection(
      ["/cameras", "/integrations", "/network"],
      ["/cameras", "/network", "/devices"],
      new Set(["/network", "/devices"]),
    );
    expect(out).toEqual(["/integrations", "/network", "/devices"]);
  });

  it("appends newly checked hrefs in checklist order", () => {
    expect(mergeNavSelection([], ["/a", "/b", "/c"], new Set(["/c", "/a"]))).toEqual(["/a", "/c"]);
  });
});
