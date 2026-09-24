/**
 * WARP-2558 (ADR-044 slice 1) — nav pins for the Business group.
 *
 * The CRM shipped with `navHrefs: []` and `requires: "projects"`, so its only
 * door was another module's page. Three consequences this file pins the fix
 * for, because none of them is visible from a render test of one surface:
 *
 *  1. Customers and Projects are SIBLINGS, each surviving the other being off.
 *     The old shape made CRM-without-PM unrepresentable, which is most dental
 *     boxes.
 *  2. `/customers` is claimed by the `crm` module, so the route gate blocks it
 *     honestly instead of the page rendering a surface every request 404s.
 *  3. The mobile tab cap is NOT reopened. Business routes through the More
 *     drawer; WARP-290 measured four tabs at 360px and that stands.
 */
import { describe, it, expect } from "vitest";
import {
  NAV_GROUPS,
  MOBILE_PRIMARY_HREFS,
  visibleItems,
  moduleForPath,
} from "@/components/nav-config";

const openCapabilities = { claudeActivity: true, ragEval: true, medicalConnector: true };
const only =
  (...ids: string[]) =>
  (id: string) =>
    ids.includes(id);

function businessItems() {
  const group = NAV_GROUPS.find((g) => g.label === "Business");
  if (!group) throw new Error("Business nav group is gone");
  return group.items;
}

/**
 * WARP-2967 nested two of the six: Brief and Reports under Insights, Money
 * under Projects. Every assertion in this file is about which DESTINATIONS a
 * viewer is offered, not about which indent they sit at, so it reads the
 * group flattened one level — which is also what the mobile drawer renders.
 *
 * Nesting DOES add the parent's gate on top of the child's (`visibleItems`
 * drops a parent before its children are considered), and that narrowing is
 * pinned explicitly below rather than smuggled through this helper.
 */
const flatHrefs = (
  role: Parameters<typeof visibleItems>[1],
  caps = openCapabilities,
  isOn: (id: string) => boolean = () => true,
) =>
  visibleItems(businessItems(), role, caps, isOn).flatMap((i) => [
    i.href,
    ...(i.children ?? []).map((c) => c.href),
  ]);

describe("the Business group (WARP-2558)", () => {
  it("sits between Work and Systems (WARP-2967 renamed its neighbours)", () => {
    const labels = NAV_GROUPS.map((g) => g.label);
    expect(labels.indexOf("Business")).toBe(labels.indexOf("Work") + 1);
    expect(labels.indexOf("Systems")).toBe(labels.indexOf("Business") + 1);
  });

  it("holds the same six destinations, now two levels deep", () => {
    // WARP-2752 — /brief sits beside what was "Planning": both answer a
    // question about the business as a whole rather than about one record.
    // WARP-2967 made that relationship structural rather than adjacent, and
    // renamed the parent Insights because "Planning" named only one of the
    // three tenses it now carries.
    expect(businessItems().map((i) => i.href)).toEqual([
      "/business",
      "/customers",
      "/projects",
      "/practice",
    ]);
    expect(flatHrefs("owner")).toEqual([
      "/business",
      "/brief",
      "/reports",
      "/customers",
      "/projects",
      "/money",
      "/practice",
    ]);
  });

  it("no longer keeps Projects in Work — the route moved groups, not addresses", () => {
    const work = NAV_GROUPS.find((g) => g.label === "Work");
    expect(work?.items.map((i) => i.href) ?? []).not.toContain("/projects");
  });
});

describe("each entry survives its neighbour being off (WARP-2558)", () => {
  it("shows Customers alone on a CRM-on, Projects-off box", () => {
    expect(flatHrefs("owner", openCapabilities, only("crm"))).toEqual([
      "/business",
      "/brief",
      "/reports",
      "/customers",
      "/practice",
    ]);
  });

  it("shows Projects alone on a Projects-on, CRM-off box", () => {
    expect(flatHrefs("owner", openCapabilities, only("projects"))).toEqual([
      "/business",
      "/brief",
      "/reports",
      "/projects",
      "/practice",
    ]);
  });

  it("keeps Money on a books-on, Projects-OFF box — promoted into Projects' slot", () => {
    // WARP-2967 nested Money under Projects. Nesting is filing, not a gate:
    // books without PM is a supported box (the likely dental shape), so a
    // parent that fails ONLY its module gate promotes a child with a module of
    // its own (`passesParentGate`). Review of #2284 caught the earlier
    // version dropping Money here from every shell.
    expect(flatHrefs("owner", openCapabilities, only("money"))).toEqual([
      "/business",
      "/brief",
      "/reports",
      "/money",
      "/practice",
    ]);
  });

  it("keeps Money on a books-on, Projects-ON box", () => {
    expect(flatHrefs("owner", openCapabilities, only("money", "projects"))).toContain(
      "/money",
    );
  });

  it("keeps Practice with every module off — it is role-gated, not module-gated", () => {
    // WARP-2560 — there is no `erp` module, and this is the assertion that
    // stops one being invented by accident. Tagging Practice with somebody
    // else's module id would delete the practice's whole day the moment that
    // module was toggled, which is the /reports lesson one surface over.
    //
    // Insights, Brief and Reports survive for the same reason: none of the
    // three is module-gated, and nesting Brief and Reports under a parent that
    // carries no module gate could not introduce one.
    expect(flatHrefs("owner", openCapabilities, only())).toEqual([
      "/business",
      "/brief",
      "/reports",
      "/practice",
    ]);
  });

  it("shows all three when the modules are on", () => {
    expect(flatHrefs("owner", openCapabilities, only("crm", "projects"))).toEqual([
      "/business",
      "/brief",
      "/reports",
      "/customers",
      "/projects",
      "/practice",
    ]);
  });

  it("shows the whole group when every module gate is on", () => {
    expect(
      flatHrefs("owner", openCapabilities, only("crm", "projects", "money")),
    ).toEqual([
      "/business",
      "/brief",
      "/reports",
      "/customers",
      "/projects",
      "/money",
      "/practice",
    ]);
  });

  it("never captions a lone row: a family box with no business module shows one item", () => {
    // WARP-2967's "no group renders a lone item" rule. Brief is owner/admin,
    // so a family viewer with every module off is left with Insights and
    // Reports — two rows, one of them nested, which is a group. The Sidebar
    // drops the CAPTION when a group has fewer than two top-level rows; this
    // pins the data side of that.
    const family = visibleItems(businessItems(), "family", openCapabilities, only());
    expect(family.map((i) => i.href)).toEqual(["/business"]);
    expect(family[0]?.children?.map((c) => c.href)).toEqual(["/reports"]);
  });
});

describe("Practice is gated by role, matching the server (WARP-2560)", () => {
  const everyModuleOn = () => true;

  it("is visible to owner and admin", () => {
    for (const role of ["owner", "admin"] as const) {
      const visible = visibleItems(businessItems(), role, openCapabilities, everyModuleOn);
      expect(visible.map((i) => i.href)).toContain("/practice");
    }
  });

  it("is hidden from family and guest — the gate did NOT widen when it moved groups", () => {
    // It carried roles: ["owner","admin"] as a child of Integrations, and it
    // carries the same array now. A relocation that quietly widens who can
    // read patient data is the failure this pins.
    for (const role of ["family", "guest"] as const) {
      const visible = visibleItems(businessItems(), role, openCapabilities, everyModuleOn);
      expect(visible.map((i) => i.href)).not.toContain("/practice");
    }
  });

  it("claims no module for its route, so the route gate cannot 404 it", () => {
    expect(moduleForPath("/practice")).toBeNull();
  });

  // WARP-2880 — and by a connected MEDICAL integration. The page is the
  // practice's day read from a practice-management system; a box without one
  // (accounting only, or nothing connected yet) has nothing to show there.
  it("is hidden until the box reports a connected medical integration", () => {
    const noMedical = { ...openCapabilities, medicalConnector: false };
    expect(flatHrefs("owner", noMedical, everyModuleOn)).toEqual([
      "/business",
      "/brief",
      "/reports",
      "/customers",
      "/projects",
      "/money",
    ]);
  });

  it("keeps the fixed label when it appears — added, never relabelled (ADR-044 rule 1)", () => {
    const visible = visibleItems(businessItems(), "owner", openCapabilities, everyModuleOn);
    expect(visible.find((i) => i.href === "/practice")?.label).toBe("Practice");
  });

  it("has left the Integrations subtree, which keeps only the plumbing", () => {
    // WARP-2967 renamed Operations to Systems and tucked both Integrations
    // entries behind Settings; ADR-044's pin is unchanged either way — no
    // practice DATA surface hangs off the connector plumbing.
    const ops = NAV_GROUPS.find((g) => g.label === "Systems");
    // WARP-2968 flattened the subtree — Credentials is a sibling now, not a
    // child — so this reads every Integrations destination wherever it sits.
    // ADR-044's pin is unchanged: no practice DATA surface hangs off it.
    const reached = (ops?.items ?? [])
      .flatMap((i) => [i, ...(i.children ?? [])])
      .map((i) => i.href)
      .filter((href) => href.startsWith("/integrations"));
    expect(reached).toEqual(["/integrations", "/integrations/credentials"]);
  });
});

describe("Planning is composed, so it outlives every module (WARP-2561)", () => {
  const everyModuleOn = () => true;

  it("survives every module being off — it is role-gated, not module-gated", () => {
    // The /reports lesson, restated on the page that copies it: tagging a
    // composed page with one tile's module id deletes the whole page the
    // moment that module is toggled. There is deliberately no `business`
    // module, and this is the assertion that stops one appearing.
    const visible = visibleItems(businessItems(), "owner", openCapabilities, only());
    expect(visible.map((i) => i.href)).toContain("/business");
  });

  it("claims no module for its route", () => {
    expect(moduleForPath("/business")).toBeNull();
  });

  it("is visible to owner, admin and family — the /reports role array", () => {
    for (const role of ["owner", "admin", "family"] as const) {
      const visible = visibleItems(businessItems(), role, openCapabilities, everyModuleOn);
      expect(visible.map((i) => i.href)).toContain("/business");
    }
  });

  it("is hidden from guest, who would see almost nothing on it", () => {
    const visible = visibleItems(businessItems(), "guest", openCapabilities, everyModuleOn);
    expect(visible.map((i) => i.href)).not.toContain("/business");
  });

  it("is labelled Insights — the nav label and the page header are one word", () => {
    // WARP-2967 renamed it from "Planning": the entry now heads Brief and
    // Reports, and "Planning" named only the first of the three tenses. The
    // page header moved in the same change — this pin is what forces that.
    expect(businessItems().find((i) => i.href === "/business")?.label).toBe("Insights");
  });
});

describe("route ownership (WARP-2558)", () => {
  it("gives /customers to the crm module, so the route gate can block it", () => {
    expect(moduleForPath("/customers")?.moduleId).toBe("crm");
  });

  it("labels the blocked state 'Customers', not 'CRM' — the nav label IS the page label", () => {
    expect(moduleForPath("/customers")?.label).toBe("Customers");
  });

  it("matches by segment, so it cannot claim a route that merely starts the same", () => {
    expect(moduleForPath("/customersomething")).toBeNull();
  });

  it("leaves /projects with the projects module", () => {
    expect(moduleForPath("/projects")?.moduleId).toBe("projects");
  });

  it("gives /money to the money module, so a box without books blocks it honestly", () => {
    expect(moduleForPath("/money")?.moduleId).toBe("money");
  });
});

describe("the mobile tab cap is not reopened (WARP-290)", () => {
  it("still names exactly four primaries", () => {
    expect(MOBILE_PRIMARY_HREFS).toHaveLength(4);
  });

  it("does not promote a Business route into the bar", () => {
    expect(MOBILE_PRIMARY_HREFS as readonly string[]).not.toContain("/customers");
    expect(MOBILE_PRIMARY_HREFS as readonly string[]).not.toContain("/projects");
    expect(MOBILE_PRIMARY_HREFS as readonly string[]).not.toContain("/money");
  });
});
