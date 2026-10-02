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
import { NAV_GROUPS, settingsGroups, visibleItems } from "@/components/nav-config";

const openCapabilities = { claudeActivity: true, ragEval: true, medicalConnector: true };
const everyModuleOn = () => true;

/**
 * WARP-2967 renamed Operations to Systems and TUCKED both entries behind
 * Settings: connecting a connector is something you do once per connector,
 * which is configuration, not operation.
 *
 * WARP-2968's ruling survives the move and is what this file still holds —
 * Credentials is a SIBLING, not a child, so it never hides behind an opened
 * section. Under Settings that means two rows of the same section rather than
 * one row you have to guess is behind the other.
 */
function operationsItems() {
  const group = NAV_GROUPS.find((g) => g.label === "Systems");
  if (!group) throw new Error("Systems nav group is gone");
  return group.items;
}

/** The Settings rows a viewer is offered — where both entries live now. */
const settingsHrefs = (role: Parameters<typeof visibleItems>[1]) =>
  settingsGroups(role, openCapabilities, everyModuleOn).flatMap((g) =>
    g.items.map((i) => i.href),
  );

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

  it("puts both in the same Settings section, so neither hides behind the other", () => {
    expect(integrations()?.hidden).toBe(true);
    expect(credentials()?.hidden).toBe(true);
    expect(integrations()?.settingsSection).toBe("Workspace");
    expect(credentials()?.settingsSection).toBe(integrations()?.settingsSection);
    const rows = settingsHrefs("owner");
    expect(rows.indexOf("/integrations/credentials")).toBe(
      rows.indexOf("/integrations") + 1,
    );
  });

  it("shows both to an owner and neither to family or guest", () => {
    const hrefsFor = (role: "owner" | "admin" | "family" | "guest") =>
      settingsHrefs(role);

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
