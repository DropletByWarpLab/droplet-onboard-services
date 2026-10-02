/**
 * WARP-1992 → WARP-2967 — nav pins for the Reports entry.
 *
 * Two things this holds that a render test can't state as sharply: WHERE the
 * item sits and WHO sees it. WARP-1992 pinned it as a PEER of Overview — "the
 * how-did-it-go view next to the what's-happening-now view" — and said a later
 * re-grouping should have to change this test on purpose. This is that
 * re-grouping, changed on purpose: /reports is a business report, and it now
 * sits under Insights beside Brief, where the three tenses (what is coming,
 * what the box noticed, how it went) read together.
 *
 * What did NOT change is the gate, and that is the half this file still
 * guards: Reports is role-gated rather than module-gated, because it composes
 * ten tiles from separately-gated surfaces and each degrades on its own — a
 * module gate would hide the whole page because one tile's module is off.
 */
import { describe, it, expect } from "vitest";
import { NAV_GROUPS, visibleItems, moduleForPath } from "@/components/nav-config";

const openCapabilities = { claudeActivity: true, ragEval: true, medicalConnector: true };
const everyModuleOn = () => true;
const everyModuleOff = () => false;

/** The Business group's items — where Insights, and Reports beneath it, live. */
function businessItems() {
  const group = NAV_GROUPS.find((g) => g.label === "Business");
  if (!group) throw new Error("Business nav group is gone");
  return group.items;
}

/** Reports as the viewer would see it: a child of Insights, after both the
 *  parent's gates and its own have been applied (WARP-1528). */
function visibleReports(role: Parameters<typeof visibleItems>[1], isOn = everyModuleOn) {
  const insights = visibleItems(businessItems(), role, openCapabilities, isOn).find(
    (i) => i.href === "/business",
  );
  return insights?.children?.find((c) => c.href === "/reports");
}

describe("Reports nav entry (WARP-1992)", () => {
  it("sits under Insights, after Brief — the three business tenses in order", () => {
    const insights = businessItems().find((i) => i.href === "/business");
    expect(insights?.children?.map((c) => c.href)).toEqual(["/brief", "/reports"]);
  });

  it("is no longer a top-level row anywhere", () => {
    // WARP-2967's whole claim is ~14 top-level rows; a Reports row that
    // survived the move would be the fifteenth.
    expect(NAV_GROUPS.flatMap((g) => g.items).map((i) => i.href)).not.toContain(
      "/reports",
    );
  });

  it("is NOT in the Admin group — it is business reading, not an admin tool", () => {
    const admin = NAV_GROUPS.find((g) => g.label === "Admin");
    const adminHrefs = admin?.items.flatMap((i) => [
      i.href,
      ...(i.children ?? []).map((c) => c.href),
    ]) ?? [];
    expect(adminHrefs).not.toContain("/reports");
  });

  it("is not tucked — it renders on the real nav surfaces", () => {
    const item = businessItems()
      .find((i) => i.href === "/business")
      ?.children?.find((c) => c.href === "/reports");
    expect(item?.hidden).toBeFalsy();
    expect(item?.label).toBe("Reports");
  });

  it("is visible to owner, admin and family", () => {
    for (const role of ["owner", "admin", "family"] as const)
      expect(visibleReports(role), role).toBeDefined();
  });

  it("is hidden from guest — the nav never advertises a page that would be mostly locked", () => {
    // Its own gate says so, and so does its new parent's: a guest sees neither
    // Insights nor anything under it.
    expect(visibleReports("guest")).toBeUndefined();
  });

  it("survives EVERY module being off — it is role-gated, not module-gated", () => {
    // The regression this pins: tagging Reports with one tile's module (say
    // `files`) would delete the whole page the moment that module is toggled
    // off, taking Money, Integrations and Activity with it. Its new parent
    // carries no module gate either, so nesting did not smuggle one in.
    expect(visibleReports("owner", everyModuleOff)).toBeDefined();
  });

  it("claims no module for its route, so the route gate can't 404 it", () => {
    expect(moduleForPath("/reports")).toBeNull();
  });

});
