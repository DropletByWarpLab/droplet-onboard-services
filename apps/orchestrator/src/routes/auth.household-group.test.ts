/**
 * WARP-883 (ADR-027 WS-5) — household-group membership on user provisioning.
 *
 * The shared "Household" space is a Nextcloud `groupfolders` group folder
 * assigned to a household group. groupfolders mounts the folder into the home
 * of every member of that group — so for the shared space to appear, each
 * provisioned user (owner/admin and every invited member) must be added to the
 * household group at create time. `ncCreateUser` already accepts a `groups[]`
 * list, so the only new logic is computing that list. This pins the pure
 * group-list builder:
 *
 *   - Every role gets the household group (so the shared folder mounts for
 *     everyone in the household).
 *   - owner/admin keep their existing Nextcloud "admin" group; guest keeps
 *     "guest"; family adds no role group — exactly the pre-WARP-883 mapping,
 *     PLUS the household group.
 *   - The household group name is stable + lowercased so it can't collide with
 *     the role groups and matches what the occ provisioning script assigns.
 */
import { describe, it, expect } from "vitest";
import { buildNcGroups, householdGroupName } from "./auth-groups.js";

describe("WARP-883 — buildNcGroups (household membership)", () => {
  const HOUSEHOLD = householdGroupName("Household");

  it("derives a stable lowercased household group from the folder name", () => {
    expect(HOUSEHOLD).toBe("household");
    expect(householdGroupName("Family Drive")).toBe("family-drive");
  });

  it("owner lands in admin + household", () => {
    expect(buildNcGroups("owner", HOUSEHOLD)).toEqual(["admin", HOUSEHOLD]);
  });

  it("admin lands in admin + household", () => {
    expect(buildNcGroups("admin", HOUSEHOLD)).toEqual(["admin", HOUSEHOLD]);
  });

  it("guest lands in guest + household", () => {
    expect(buildNcGroups("guest", HOUSEHOLD)).toEqual(["guest", HOUSEHOLD]);
  });

  it("family lands in household only (no role group)", () => {
    expect(buildNcGroups("family", HOUSEHOLD)).toEqual([HOUSEHOLD]);
  });

  it("never duplicates the household group", () => {
    const groups = buildNcGroups("family", HOUSEHOLD);
    expect(groups.filter((g) => g === HOUSEHOLD)).toHaveLength(1);
  });
});
