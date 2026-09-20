/**
 * WARP-2968 — Integrations and Credentials are two flat destinations.
 *
 * Credentials shipped as a CHILD of Integrations, and the Sidebar only reveals
 * a section's children once that section is open (`isSectionOpen`), so the
 * page existed but nothing in the nav pointed at it until the owner had
 * already clicked Integrations. A destination you can only find by guessing
 * that it is behind another one is not in the nav.
 *
 * The pair is pinned here rather than in a Sidebar render test because it is a
 * fact about the nav DATA: the drawer, the desktop rail and the route gate all
 * read this one array, and a child is unreachable in every one of them.
 */
import { describe, it, expect } from "vitest";
import { NAV_GROUPS, visibleItems } from "@/components/nav-config";

const openCapabilities = { claudeActivity: true, ragEval: true, medicalConnector: true };
const everyModuleOn = () => true;

function operationsItems() {
  const group = NAV_GROUPS.find((g) => g.label === "Operations");
  if (!group) throw new Error("Operations nav group is gone");
  return group.items;
}

const integrations = () => operationsItems().find((i) => i.href === "/integrations");
const credentials = () => operationsItems().find((i) => i.href === "/integrations/credentials");

describe("Integrations is flat (WARP-2968)", () => {
  it("has no children, so nothing hides behind an opened section", () => {
    expect(integrations()).toBeDefined();
    expect(integrations()?.children).toBeUndefined();
  });

  it("lists Credentials as a top-level item of its own", () => {
    expect(credentials()).toBeDefined();
    expect(credentials()?.label).toBe("Credentials");
  });

  it("puts Credentials immediately after Integrations", () => {
    const hrefs = operationsItems().map((i) => i.href);
    expect(hrefs.indexOf("/integrations/credentials")).toBe(hrefs.indexOf("/integrations") + 1);
  });

  it("gates both on owner/admin, mirroring the orchestrator's own guard", () => {
    expect(integrations()?.roles).toEqual(["owner", "admin"]);
    expect(credentials()?.roles).toEqual(["owner", "admin"]);
  });

  it("shows both to an owner and neither to family or guest", () => {
    const hrefsFor = (role: "owner" | "admin" | "family" | "guest") =>
      visibleItems(operationsItems(), role, openCapabilities, everyModuleOn).map((i) => i.href);

    for (const role of ["owner", "admin"] as const) {
      expect(hrefsFor(role)).toContain("/integrations");
      expect(hrefsFor(role)).toContain("/integrations/credentials");
    }
    for (const role of ["family", "guest"] as const) {
      expect(hrefsFor(role)).not.toContain("/integrations");
      expect(hrefsFor(role)).not.toContain("/integrations/credentials");
    }
  });
});
