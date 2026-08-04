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
import { DROPLET_ADMINS_GROUP } from "../services/department-provisioner.service.js";
import { ADMIN_TIER_ROLES } from "../services/role-mutation-guard.service.js";
import type { Role } from "../services/jwt.service.js";

describe("WARP-883 — buildNcGroups (household membership)", () => {
  const HOUSEHOLD = householdGroupName("Household");

  it("derives a stable lowercased household group from the folder name", () => {
    expect(HOUSEHOLD).toBe("household");
    expect(householdGroupName("Family Drive")).toBe("family-drive");
  });

  it("owner lands in admin + droplet-admins + household", () => {
    expect(buildNcGroups("owner", HOUSEHOLD)).toEqual([
      "admin",
      DROPLET_ADMINS_GROUP,
      HOUSEHOLD,
    ]);
  });

  it("admin lands in admin + droplet-admins + household", () => {
    expect(buildNcGroups("admin", HOUSEHOLD)).toEqual([
      "admin",
      DROPLET_ADMINS_GROUP,
      HOUSEHOLD,
    ]);
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

/**
 * WARP-1558 — `droplet-admins` on the user-CREATE path.
 *
 * ADR-029 §2.5 Tier 1: membership in the box-wide `droplet-admins` group IS
 * admin see-all. The group is attached at MASK_ADMIN to every active
 * groupfolder, so an admin who is in it gets department libraries mounted for
 * their own Nextcloud token — no special code path, and therefore no way for
 * the byte layer and the policy layer to disagree.
 *
 * The bug: only the role-CHANGE cascade ever added anyone. A user created as
 * owner/admin who was never promoted never joined, so on the .87 box the group
 * was attached everywhere and had ZERO members — Tier-1 see-all was inert. A
 * fresh install had the same hole, so this is a create-path defect, not merely
 * a backfill gap for legacy boxes.
 *
 * These pin the mapping in both directions, and pin it against the SAME tier
 * definition the role-change cascade and the reconciler sweep use — the three
 * writers of this group must never disagree about who belongs in it.
 */
describe("WARP-1558 — buildNcGroups (droplet-admins / ADR-029 Tier-1 see-all)", () => {
  const HOUSEHOLD = householdGroupName("Household");
  const ALL_ROLES: Role[] = ["owner", "admin", "family", "guest"];

  it("every admin-tier role created gets droplet-admins", () => {
    for (const role of ADMIN_TIER_ROLES) {
      expect(buildNcGroups(role, HOUSEHOLD)).toContain(DROPLET_ADMINS_GROUP);
    }
  });

  it("no non-admin-tier role gets droplet-admins", () => {
    const adminTier = new Set<Role>(ADMIN_TIER_ROLES);
    for (const role of ALL_ROLES.filter((r) => !adminTier.has(r))) {
      expect(buildNcGroups(role, HOUSEHOLD)).not.toContain(DROPLET_ADMINS_GROUP);
    }
  });

  /**
   * The create path deliberately keeps a literal owner/admin check rather than
   * importing ADMIN_TIER_ROLES (auth-groups.ts stays free of the service
   * graph). This is the pin that keeps that duplication honest: if someone
   * widens or narrows the operator tier in role-mutation-guard.service.ts, the
   * create path must move with it, or a promoted user would get see-all that a
   * freshly-created one silently does not.
   */
  it("the create-path tier is exactly ADMIN_TIER_ROLES (the role-change cascade + reconciler tier)", () => {
    const createPathTier = ALL_ROLES.filter((r) =>
      buildNcGroups(r, HOUSEHOLD).includes(DROPLET_ADMINS_GROUP),
    );
    expect(new Set(createPathTier)).toEqual(new Set(ADMIN_TIER_ROLES));
    // Guards the WARP-1272 conflation: Tier 2 (personal homes) is owner-only,
    // Tier 1 is the broader admin tier. Narrowing this to owner would make an
    // `admin` lose department see-all.
    //
    // This assertion is now the enforcement point of a ratified decision, not
    // just a guard against drift. ADR-032 §7 / O-5 (2026-07-27) resolved the
    // apparent conflict between ADR-032 §3 ("Admins do not bypass layer 2")
    // and ADR-029's Tier-1 bullet in favour of ADR-029: `admin` is an
    // UNCONDITIONAL see-all tier at the byte layer, and no custom role may
    // narrow it. If someone must not see a department's files, they must not
    // be admin tier. So this line failing means the product changed, and O-5
    // has to be revisited before it is "fixed".
    expect(createPathTier).toContain("admin");
  });

  it("never duplicates droplet-admins, and keeps the household group alongside it", () => {
    const groups = buildNcGroups("owner", HOUSEHOLD);
    expect(groups.filter((g) => g === DROPLET_ADMINS_GROUP)).toHaveLength(1);
    expect(groups).toContain(HOUSEHOLD);
    expect(groups).toContain("admin");
  });
});
