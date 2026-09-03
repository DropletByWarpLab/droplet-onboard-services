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

const openCapabilities = { claudeActivity: true, ragEval: true };
const only =
  (...ids: string[]) =>
  (id: string) =>
    ids.includes(id);

function businessItems() {
  const group = NAV_GROUPS.find((g) => g.label === "Business");
  if (!group) throw new Error("Business nav group is gone");
  return group.items;
}

describe("the Business group (WARP-2558)", () => {
  it("sits between Workspace and Operations", () => {
    const labels = NAV_GROUPS.map((g) => g.label);
    expect(labels.indexOf("Business")).toBe(labels.indexOf("Workspace") + 1);
    expect(labels.indexOf("Operations")).toBe(labels.indexOf("Business") + 1);
  });

  it("holds Planning, Customers, Projects, Money and Practice, in that order", () => {
    expect(businessItems().map((i) => i.href)).toEqual([
      "/business",
      "/customers",
      "/projects",
      "/money",
      "/practice",
    ]);
  });

  it("no longer keeps Projects in Workspace — the route moved groups, not addresses", () => {
    const workspace = NAV_GROUPS.find((g) => g.label === "Workspace");
    expect(workspace?.items.map((i) => i.href) ?? []).not.toContain("/projects");
  });
});

describe("each entry survives its neighbour being off (WARP-2558)", () => {
  it("shows Customers alone on a CRM-on, Projects-off box", () => {
    const visible = visibleItems(businessItems(), "owner", openCapabilities, only("crm"));
    expect(visible.map((i) => i.href)).toEqual(["/business", "/customers", "/practice"]);
  });

  it("shows Projects alone on a Projects-on, CRM-off box", () => {
    const visible = visibleItems(businessItems(), "owner", openCapabilities, only("projects"));
    expect(visible.map((i) => i.href)).toEqual(["/business", "/projects", "/practice"]);
  });

  it("shows Money alone on a books-on, CRM-off, Projects-off box", () => {
    // WARP-2581 — /money is module-gated like Customers and Projects, so it
    // disappears entirely on a box that keeps its books elsewhere. The two
    // role-gated entries stand either side of it regardless, which is the
    // whole point of the split.
    const visible = visibleItems(businessItems(), "owner", openCapabilities, only("money"));
    expect(visible.map((i) => i.href)).toEqual(["/business", "/money", "/practice"]);
  });

  it("keeps Practice with every module off — it is role-gated, not module-gated", () => {
    // WARP-2560 — there is no `erp` module, and this is the assertion that
    // stops one being invented by accident. Tagging Practice with somebody
    // else's module id would delete the practice's whole day the moment that
    // module was toggled, which is the /reports lesson one surface over.
    const visible = visibleItems(businessItems(), "owner", openCapabilities, only());
    expect(visible.map((i) => i.href)).toEqual(["/business", "/practice"]);
  });

  it("shows all three when the modules are on", () => {
    const visible = visibleItems(
      businessItems(),
      "owner",
      openCapabilities,
      only("crm", "projects"),
    );
    expect(visible.map((i) => i.href)).toEqual(["/business", "/customers", "/projects", "/practice"]);
  });

  it("shows the whole group when every module gate is on", () => {
    const visible = visibleItems(
      businessItems(),
      "owner",
      openCapabilities,
      only("crm", "projects", "money"),
    );
    expect(visible.map((i) => i.href)).toEqual([
      "/business",
      "/customers",
      "/projects",
      "/money",
      "/practice",
    ]);
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

  it("has left the Integrations subtree, which keeps only the plumbing", () => {
    const ops = NAV_GROUPS.find((g) => g.label === "Operations");
    const integrations = ops?.items.find((i) => i.href === "/integrations");
    expect(integrations).toBeDefined();
    expect((integrations?.children ?? []).map((c) => c.href)).toEqual([
      "/integrations/credentials",
    ]);
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

  it("is labelled Planning — the nav label and the page header are one word", () => {
    expect(businessItems().find((i) => i.href === "/business")?.label).toBe("Planning");
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
