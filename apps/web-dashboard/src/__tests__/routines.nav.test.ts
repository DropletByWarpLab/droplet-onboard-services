/**
 * WARP-2671 — nav pins for the Routines entry.
 *
 * Mirrors reports.nav.test.ts: WHERE the item sits and WHO sees it, stated
 * sharply enough that a later re-grouping has to change this on purpose.
 *
 * The placement argument, since it is the part most likely to be "tidied"
 * later: `/tools` lives under Admin because a catalog of the box's built-in
 * capabilities is administrative reference material. A routine is a sequence
 * somebody composed to do their own job — their work, not an admin artefact —
 * so it belongs in Workspace and NOT bolted onto `/tools`, whose SEED-not-run
 * contract (WARP-829) must survive this feature intact.
 *
 * WARP-2967 moved it BEHIND SETTINGS rather than into Admin: the tree is four
 * groups now and this is not daily operation. The placement argument above is
 * intact — it lands under Settings → **Automation**, its own section, and
 * explicitly NOT folded under Ask AI, which would make a composed sequence
 * look like a mode of the chat box, nor bolted onto /tools, whose
 * SEED-not-run contract (WARP-829) must survive this feature intact.
 *
 * The gates are unchanged, and that is what most of this file still pins.
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

const routines = () => workItems().find((i) => i.href === "/routines");

/** The Settings rows a viewer would be offered — the tuck's other half. */
const settingsHrefs = (
  role: Parameters<typeof visibleItems>[1],
  isOn = everyModuleOn,
) =>
  settingsGroups(role, openCapabilities, isOn).flatMap((g) =>
    g.items.map((i) => i.href),
  );

describe("Routines nav entry (WARP-2671)", () => {
  it("stays filed as the person's own work, not as an Admin row", () => {
    expect(workItems().map((i) => i.href)).toContain("/routines");
    const admin = NAV_GROUPS.find((g) => g.label === "Admin");
    expect(admin?.items.map((i) => i.href) ?? []).not.toContain("/routines");
  });

  it("is tucked behind Settings → Automation, and reachable from there", () => {
    expect(routines()?.hidden).toBe(true);
    expect(routines()?.settingsSection).toBe("Automation");
    expect(settingsHrefs("owner")).toContain("/routines");
  });

  it("is NOT nested under Ask AI — a composed sequence is not a chat mode", () => {
    const chat = workItems().find((i) => i.href === "/chat");
    expect(chat?.children).toBeUndefined();
  });

  it("leaves the /tools catalog exactly where it was", () => {
    // The routine surface must not annex /tools. That page is a read-only
    // catalog with a deliberate SEED-not-run contract. It is tucked now too,
    // but it is still its own destination with its own row.
    const tools = NAV_GROUPS.flatMap((g) => g.items).find((i) => i.href === "/tools");
    expect(tools).toBeDefined();
    expect(settingsHrefs("owner")).toContain("/tools");
  });

  it("is offered to owner, admin and family", () => {
    for (const role of ["owner", "admin", "family"] as const)
      expect(settingsHrefs(role), role).toContain("/routines");
  });

  it("is hidden from guest — a guest can neither run nor publish a routine", () => {
    expect(settingsHrefs("guest")).not.toContain("/routines");
    // …on the nav surfaces too, for the same reason.
    const visible = visibleItems(workItems(), "guest", openCapabilities, everyModuleOn);
    expect(visible.map((i) => i.href)).not.toContain("/routines");
  });

  it("survives every module being off — routines span every surface", () => {
    // The regression this pins: tagging Routines with one module (say `files`)
    // would delete the page the moment that module is toggled off, even
    // though a routine may touch none of it.
    expect(settingsHrefs("owner", everyModuleOff)).toContain("/routines");
  });

  it("claims no module for its route, so the route gate can't 404 it", () => {
    expect(moduleForPath("/routines")).toBeNull();
  });

  it("keeps its label and its glyph through the tuck", () => {
    expect(routines()?.label).toBe("Routines");
    expect(routines()?.settingsBlurb).toBeTruthy();
  });
});
