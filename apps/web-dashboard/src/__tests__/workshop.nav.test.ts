/**
 * WARP-2925 (ADR-056) — nav pins for the Workshop entry.
 *
 * Mirrors routines.nav.test.ts: WHERE the item sits and WHO sees it, stated
 * sharply enough that a later re-grouping has to change this on purpose.
 *
 * The placement argument: a routine is a sequence a person composed; a run is
 * a goal the box pursues on its own. Both are that person's work, so both
 * live in Workspace — Workshop directly after Routines. It is NOT an Admin
 * item even though the runs panel used to render on /admin/audit: the audit
 * log is where a run's rows are verified, not where a person goes to start
 * one.
 *
 * WARP-2967 moved it BEHIND SETTINGS rather than into Admin: the tree is four
 * groups now and this is not daily operation. The placement argument above is
 * intact — Workshop lands under Settings → **Automation** beside Routines,
 * and still not under /admin/audit. The gates are unchanged, and that is what
 * most of this file still pins.
 */
import { describe, it, expect } from "vitest";
import {
  NAV_GROUPS,
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

const settingsHrefs = (
  role: Parameters<typeof visibleItems>[1],
  isOn = everyModuleOn,
) =>
  settingsGroups(role, openCapabilities, isOn).flatMap((g) =>
    g.items.map((i) => i.href),
  );

describe("Workshop nav entry (WARP-2925)", () => {
  it("stays filed as the person's own work, directly after Routines", () => {
    const hrefs = workItems().map((i) => i.href);
    expect(hrefs).toContain("/workshop");
    expect(hrefs.indexOf("/workshop")).toBe(hrefs.indexOf("/routines") + 1);
    const admin = NAV_GROUPS.find((g) => g.label === "Admin");
    expect(admin?.items.map((i) => i.href) ?? []).not.toContain("/workshop");
  });

  it("is tucked behind Settings → Automation, beside Routines", () => {
    expect(workshop()?.hidden).toBe(true);
    expect(workshop()?.settingsSection).toBe("Automation");
    const automation = settingsGroups("owner", openCapabilities, everyModuleOn).find(
      (g) => g.label === "Automation",
    );
    expect(automation?.items.map((i) => i.href)).toContain("/workshop");
    expect(automation?.items.map((i) => i.href)).toContain("/routines");
  });

  it("is offered to owner and admin — the roles that may start a run", () => {
    // Mirrors RUN_STARTER_ROLES on the orchestrator's agent-runs routes.
    for (const role of ["owner", "admin"] as const)
      expect(settingsHrefs(role), role).toContain("/workshop");
  });

  it("is hidden from family and guest — the routes would 403 them", () => {
    for (const role of ["family", "guest"] as const) {
      expect(settingsHrefs(role), role).not.toContain("/workshop");
      const visible = visibleItems(workItems(), role, openCapabilities, everyModuleOn);
      expect(visible.map((i) => i.href)).not.toContain("/workshop");
    }
  });

  it("survives every module being off — a run may touch any surface", () => {
    expect(settingsHrefs("owner", everyModuleOff)).toContain("/workshop");
  });

  it("claims no module for its route, so the route gate can't 404 it", () => {
    expect(moduleForPath("/workshop")).toBeNull();
  });

  it("keeps its label and a blurb through the tuck", () => {
    expect(workshop()?.label).toBe("Workshop");
    expect(workshop()?.settingsBlurb).toBeTruthy();
  });
});
