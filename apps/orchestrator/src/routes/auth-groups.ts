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
 */
export function buildNcGroups(role: Role, householdGroup: string): string[] {
  const roleGroups: string[] =
    role === "owner" || role === "admin"
      ? ["admin"]
      : role === "guest"
        ? ["guest"]
        : [];
  return roleGroups.includes(householdGroup)
    ? roleGroups
    : [...roleGroups, householdGroup];
}
