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

const integrations = () => operationsItems().find((i) => i.href === "/connectors");
const credentials = () => operationsItems().find((i) => i.href === "/connectors/credentials");

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
    expect(hrefs.indexOf("/connectors/credentials")).toBe(hrefs.indexOf("/connectors") + 1);
  });

  // WARP-3965 — members connect their own MCP accounts on /connectors, so the
  // directory admits `family`; the credentials page (keys for business systems)
  // stays owner/admin, mirroring the orchestrator's own guard.
  it("gates Credentials on owner/admin and lets members into the Connectors directory", () => {
    expect(integrations()?.roles).toEqual(["owner", "admin", "family"]);
    expect(credentials()?.roles).toEqual(["owner", "admin"]);
  });

  it("puts both in the same Settings section, so neither hides behind the other", () => {
    expect(integrations()?.hidden).toBe(true);
    expect(credentials()?.hidden).toBe(true);
    expect(integrations()?.settingsSection).toBe("Workspace");
    expect(credentials()?.settingsSection).toBe(integrations()?.settingsSection);
    const rows = settingsHrefs("owner");
    expect(rows.indexOf("/connectors/credentials")).toBe(
      rows.indexOf("/connectors") + 1,
    );
  });

  it("shows both to an owner, only Connectors to family, and neither to a guest", () => {
    const hrefsFor = (role: "owner" | "admin" | "family" | "guest") =>
      settingsHrefs(role);

    for (const role of ["owner", "admin"] as const) {
      expect(hrefsFor(role)).toContain("/connectors");
      expect(hrefsFor(role)).toContain("/connectors/credentials");
    }
    expect(hrefsFor("family")).toContain("/connectors");
    expect(hrefsFor("family")).not.toContain("/connectors/credentials");
    expect(hrefsFor("guest")).not.toContain("/connectors");
    expect(hrefsFor("guest")).not.toContain("/connectors/credentials");
  });
});

// ── WARP-3532 — Work notifications joins the pair ────────────────────────────

const workNotifications = () => operationsItems().find((i) => i.href === "/connectors/work-notifications");

describe("Work notifications is a third flat sibling (WARP-3532)", () => {
  it("is its own top-level item, right after Credentials, tucked behind Settings", () => {
    const item = workNotifications();
    expect(item).toBeDefined();
    expect(item?.label).toBe("Work notifications");
    expect(item?.children).toBeUndefined();
    expect(item?.hidden).toBe(true);
    expect(item?.settingsSection).toBe("Workspace");
    expect(item?.settingsBlurb).toBeTruthy();
    const hrefs = operationsItems().map((i) => i.href);
    expect(hrefs.indexOf("/connectors/work-notifications")).toBe(hrefs.indexOf("/connectors/credentials") + 1);
  });

  it("is owner/admin only, like the server routes behind it", () => {
    expect(workNotifications()?.roles).toEqual(["owner", "admin"]);
    expect(settingsHrefs("owner")).toContain("/connectors/work-notifications");
    expect(settingsHrefs("admin")).toContain("/connectors/work-notifications");
    expect(settingsHrefs("family")).not.toContain("/connectors/work-notifications");
    expect(settingsHrefs("guest")).not.toContain("/connectors/work-notifications");
  });

  it("follows the Projects module: hidden exactly when /api/pm would answer module_disabled", () => {
    expect(workNotifications()?.requiresModule).toBe("projects");
    const projectsOff = (id: string) => id !== "projects";
    const hrefs = settingsGroups("owner", openCapabilities, projectsOff).flatMap((g) => g.items.map((i) => i.href));
    expect(hrefs).not.toContain("/connectors/work-notifications");
    // …while the two plumbing pages it sits beside stay (no module of their own).
    expect(hrefs).toContain("/connectors");
    expect(hrefs).toContain("/connectors/credentials");
  });
});
