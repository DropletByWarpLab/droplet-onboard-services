/**
 * WARP-883 (ADR-027 WS-5) — Nextcloud group membership for the shared
 * "Household" space.
 *
 * The shared space is a Nextcloud `groupfolders` group folder assigned to a
 * household group; groupfolders mounts the folder into the home of every member
 * of that group. So each provisioned user (the first owner via /auth/setup,
 * every invited member via invite-accept, and admin-created users) must join
 * the household group at create time for the shared folder to appear.
 *
 * `ncCreateUser` already accepts a `groups[]` list, so the only new logic is
 * computing it. This module keeps that as a pure, unit-testable helper so the
 * three call sites stay consistent and the mapping is pinned by a test.
 */

import type { Role } from "../services/jwt.service.js";
import { DROPLET_ADMINS_GROUP } from "../services/department-provisioner.service.js";

/**
 * Stable Nextcloud group name for the household, derived from the shared
 * folder name. Lowercased + non-alphanumerics collapsed to single dashes so it
 * can never collide with the role groups ("admin"/"guest") and matches exactly
 * what the occ provisioning script (`docker/nextcloud-init.sh`) assigns to the
 * group folder.
 */
export function householdGroupName(sharedFolderName: string): string {
  // Coerce defensively — a missing/blank config value must never throw here
  // (that would 500 user provisioning); fall back to the canonical default.
  return (
    String(sharedFolderName ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "household"
  );
}

/**
 * Build the `groups[]` list passed to `ncCreateUser` for a given role.
 *
 * Preserves the pre-WARP-883 role→group mapping (owner/admin → "admin",
 * guest → "guest", family → no role group) and ADDS the household group so the
 * shared folder mounts for every household member. The household group is
 * appended without duplication.
 *
 * WARP-1558 — admin-tier roles ALSO join `droplet-admins`.
 *
 * ADR-029 §2.5 Tier 1 makes membership in that box-wide group the entire
 * mechanism for admin see-all: the group is attached at MASK_ADMIN to every
 * active groupfolder (the provisioner/reconciler invariant), so an admin who
 * is IN it gets every department library mounted for their OWN Nextcloud
 * token — "zero special code paths", which is what keeps the byte layer and
 * the policy layer from diverging.
 *
 * Before this, nothing added anyone at CREATE time: the only writer was the
 * role-CHANGE cascade (`runRoleChangePostEffects`, WARP-1259/WARP-1526), so a
 * user who held owner/admin from creation and was never promoted never joined.
 * On the .87 box that meant three admin-tier users and an empty group —
 * Tier-1 see-all was inert on a correctly-provisioned appliance, and a FRESH
 * install had the identical hole, not just legacy ones.
 *
 * The tier tracked here is `owner` + `admin`, matching `ADMIN_TIER_ROLES` in
 * role-mutation-guard.service.ts — the same set the role-change cascade and
 * the reconciler's membership sweep use. (Tier 2 / personal homes, WARP-1272,
 * is the owner-only one; do not conflate.) Kept as a literal role check rather
 * than an import of `ADMIN_TIER_ROLES` so this module stays free of the
 * service graph; `auth.household-group.test.ts` pins the two in agreement.
 *
 * NOTE FOR CALLERS: `ncCreateUser`/`ncInstallAndCreateAdmin` fail outright if
 * a listed group does not exist (OCS "Group … does not exist" — the WARP-990
 * trigger), and `droplet-admins` is created lazily by the department
 * provisioner, so a box with no departments yet has never seen it. Every
 * create path must `ncEnsureGroup(DROPLET_ADMINS_GROUP)` first, exactly as
 * /auth/setup already does for the household group.
 */
export function buildNcGroups(role: Role, householdGroup: string): string[] {
  const roleGroups: string[] =
    role === "owner" || role === "admin"
      ? ["admin", DROPLET_ADMINS_GROUP]
      : role === "guest"
        ? ["guest"]
        : [];
  return roleGroups.includes(householdGroup)
    ? roleGroups
    : [...roleGroups, householdGroup];
}
