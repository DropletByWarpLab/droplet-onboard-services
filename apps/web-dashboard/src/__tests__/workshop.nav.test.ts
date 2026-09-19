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
 */
import { describe, it, expect } from "vitest";
import { NAV_GROUPS, visibleItems, moduleForPath } from "@/components/nav-config";

const openCapabilities = { claudeActivity: true, ragEval: true, medicalConnector: true };
const everyModuleOn = () => true;
const everyModuleOff = () => false;

function workspaceItems() {
  const group = NAV_GROUPS.find((g) => g.label === "Workspace");
  if (!group) throw new Error("Workspace nav group is gone");
  return group.items;
}

describe("Workshop nav entry (WARP-2925)", () => {
  it("sits in Workspace, directly after Routines", () => {
    const hrefs = workspaceItems().map((i) => i.href);
    expect(hrefs).toContain("/workshop");
    expect(hrefs.indexOf("/workshop")).toBe(hrefs.indexOf("/routines") + 1);
    const admin = NAV_GROUPS.find((g) => g.label === "Admin");
    expect(admin?.items.map((i) => i.href) ?? []).not.toContain("/workshop");
  });

  it("does not disturb the WARP-1992 Overview → Reports → Ask AI adjacency", () => {
    const hrefs = workspaceItems().map((i) => i.href);
    expect(hrefs.indexOf("/reports")).toBe(hrefs.indexOf("/") + 1);
    expect(hrefs.indexOf("/chat")).toBe(hrefs.indexOf("/reports") + 1);
  });

  it("is visible to owner and admin — the roles that may start a run", () => {
    // Mirrors RUN_STARTER_ROLES on the orchestrator's agent-runs routes.
    for (const role of ["owner", "admin"] as const) {
      const visible = visibleItems(workspaceItems(), role, openCapabilities, everyModuleOn);
      expect(visible.map((i) => i.href)).toContain("/workshop");
    }
  });

  it("is hidden from family and guest — the routes would 403 them", () => {
    for (const role of ["family", "guest"] as const) {
      const visible = visibleItems(workspaceItems(), role, openCapabilities, everyModuleOn);
      expect(visible.map((i) => i.href)).not.toContain("/workshop");
    }
  });

  it("survives every module being off — a run may touch any surface", () => {
    const visible = visibleItems(workspaceItems(), "owner", openCapabilities, everyModuleOff);
    expect(visible.map((i) => i.href)).toContain("/workshop");
  });

  it("claims no module for its route, so the route gate can't 404 it", () => {
    expect(moduleForPath("/workshop")).toBeNull();
  });

  it("is not tucked — it renders on the real nav surfaces", () => {
    const item = workspaceItems().find((i) => i.href === "/workshop");
    expect(item?.hidden).toBeFalsy();
    expect(item?.label).toBe("Workshop");
  });
});
