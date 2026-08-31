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

  it("holds Customers and Projects, in that order", () => {
    expect(businessItems().map((i) => i.href)).toEqual(["/customers", "/projects"]);
  });

  it("no longer keeps Projects in Workspace — the route moved groups, not addresses", () => {
    const workspace = NAV_GROUPS.find((g) => g.label === "Workspace");
    expect(workspace?.items.map((i) => i.href) ?? []).not.toContain("/projects");
  });
});

describe("each entry survives its neighbour being off (WARP-2558)", () => {
  it("shows Customers alone on a CRM-on, Projects-off box", () => {
    const visible = visibleItems(businessItems(), "owner", openCapabilities, only("crm"));
    expect(visible.map((i) => i.href)).toEqual(["/customers"]);
  });

  it("shows Projects alone on a Projects-on, CRM-off box", () => {
    const visible = visibleItems(businessItems(), "owner", openCapabilities, only("projects"));
    expect(visible.map((i) => i.href)).toEqual(["/projects"]);
  });

  it("renders nothing — and so no lone caption — when both are off", () => {
    const visible = visibleItems(businessItems(), "owner", openCapabilities, only());
    expect(visible).toEqual([]);
  });

  it("shows both when both are on", () => {
    const visible = visibleItems(
      businessItems(),
      "owner",
      openCapabilities,
      only("crm", "projects"),
    );
    expect(visible.map((i) => i.href)).toEqual(["/customers", "/projects"]);
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
});

describe("the mobile tab cap is not reopened (WARP-290)", () => {
  it("still names exactly four primaries", () => {
    expect(MOBILE_PRIMARY_HREFS).toHaveLength(4);
  });

  it("does not promote a Business route into the bar", () => {
    expect(MOBILE_PRIMARY_HREFS as readonly string[]).not.toContain("/customers");
    expect(MOBILE_PRIMARY_HREFS as readonly string[]).not.toContain("/projects");
  });
});
