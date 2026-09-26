/**
 * WARP-2925 (ADR-056) → WARP-3063 — nav pins for the Workshop entry.
 *
 * Mirrors routines.nav.test.ts: WHERE the item sits and WHO sees it, stated
 * sharply enough that a later re-grouping has to change this on purpose.
 *
 * The placement argument: a run is a goal the box pursues on its own, and a
 * custom tool is something the owner has it build. Both are that person's
 * work, so Workshop is filed in Work. It is NOT an Admin item even though the
 * runs panel used to render on /admin/audit: the audit log is where a run's
 * rows are verified, not where a person goes to start one.
 *
 * WARP-2967 tucked it behind Settings → Automation beside Routines. WARP-3063
 * reverses that for Workshop alone. Nobody looks in Settings for the place
 * they build things, and a tucked route also swaps the sidebar to the
 * Settings panel on arrival, so the tuck removed Workshop from the product.
 * It is a visible Work row again, the last one. The gates are unchanged, and
 * that is what most of this file still pins.
 */
import { describe, it, expect } from "vitest";
import {
  NAV_GROUPS,
  isSettingsContext,
  settingsGroups,
  visibleItems,
  moduleForPath,
} from "@/components/nav-config";

const openCapabilities = { claudeActivity: true, ragEval: true, medicalConnector: true };
const everyModuleOn = () => true;
const everyModuleOff = () => false;

function workItems() {
  const group = NAV_GROUPS.find((g) => g.label === "Work");
  if (!group) throw new Error("Work nav group is gone");
  return group.items;
}

const workshop = () => workItems().find((i) => i.href === "/workshop");

const visibleWork = (
  role: Parameters<typeof visibleItems>[1],
  isOn = everyModuleOn,
) => visibleItems(workItems(), role, openCapabilities, isOn).map((i) => i.href);

const settingsHrefs = (role: Parameters<typeof visibleItems>[1]) =>
  settingsGroups(role, openCapabilities, everyModuleOn).flatMap((g) =>
    g.items.map((i) => i.href),
  );

describe("Workshop nav entry (WARP-2925 → WARP-3063)", () => {
  it("is a visible Work row, the last one, and never an Admin item", () => {
    const hrefs = visibleWork("owner");
    expect(hrefs).toContain("/workshop");
    expect(hrefs[hrefs.length - 1]).toBe("/workshop");
    const admin = NAV_GROUPS.find((g) => g.label === "Admin");
    expect(admin?.items.map((i) => i.href) ?? []).not.toContain("/workshop");
  });

  it("is not tucked: no hidden flag, no Settings row, no Settings panel on arrival", () => {
    expect(workshop()?.hidden).toBeFalsy();
    expect(workshop()?.settingsSection).toBeUndefined();
    expect(settingsHrefs("owner")).not.toContain("/workshop");
    expect(isSettingsContext("/workshop")).toBe(false);
    expect(isSettingsContext("/workshop/ws-1")).toBe(false);
  });

  it("is offered to owner and admin, the roles that may start a run", () => {
    // Mirrors RUN_STARTER_ROLES on the orchestrator's agent-runs routes.
    for (const role of ["owner", "admin"] as const)
      expect(visibleWork(role), role).toContain("/workshop");
  });

  it("is hidden from family and guest, because the routes would 403 them", () => {
    for (const role of ["family", "guest"] as const) {
      expect(visibleWork(role), role).not.toContain("/workshop");
      expect(settingsHrefs(role), role).not.toContain("/workshop");
    }
  });

  it("survives every module being off, because a run may touch any surface", () => {
    expect(visibleWork("owner", everyModuleOff)).toContain("/workshop");
  });

  it("claims no module for its route, so the route gate can't 404 it", () => {
    expect(moduleForPath("/workshop")).toBeNull();
  });

  it("keeps its label", () => {
    expect(workshop()?.label).toBe("Workshop");
  });
});
