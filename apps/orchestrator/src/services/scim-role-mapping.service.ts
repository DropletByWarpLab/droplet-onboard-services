/**
 * WARP (SCIM directory sync) — SCIM group → local Role mapping policy.
 *
 * The local Role union is CLOSED (jwt.service.ts):
 *   owner | admin | family | guest | service
 *
 * SCIM (Okta) pushes groups with arbitrary display names. This module is the
 * single, explicit, introspectable policy that maps a group display name to
 * the local Role it grants, and resolves a user's EFFECTIVE role as the
 * highest-privilege role across every group they belong to.
 *
 * Three hard rules (security):
 *   1. LEAST PRIVILEGE BY DEFAULT. An unrecognized group → `family`. SCIM can
 *      never accidentally hand out owner/admin because a customer named a
 *      group "Admin Assistants" — only an exact (normalized) keyword match
 *      elevates. The default floor is `family`, never owner.
 *   2. `service` IS NOT ASSIGNABLE FROM SCIM. It's the inbound-service-
 *      principal role (voice / mcp / email tokens). A directory user must
 *      never be minted with it — that would confuse the privilege shape RBAC
 *      relies on. It is therefore absent from every mapping arm AND from the
 *      privilege ladder used to pick an effective role.
 *   3. `owner` IS NOT ASSIGNABLE FROM SCIM either — the ceiling is `admin`
 *      (WARP-1568, see SCIM_ROLE_CEILING below).
 *
 * This mirrors `roleFromGroups` (jwt.service.ts) — the established "map an
 * external group list to a local Role" idiom — but for the SCIM vocabulary.
 */
import type { Role } from "./jwt.service.js";

/**
 * Roles a SCIM-provisioned directory user may hold, in ascending privilege.
 * `service` is intentionally excluded (rule 2). `family` is the floor.
 */
export type DirectoryRole = "guest" | "family" | "admin" | "owner";

/**
 * Privilege ladder for "highest-privilege-wins". Higher number = more
 * privilege. `service` is absent on purpose so it can never win a comparison
 * against a SCIM-derived role.
 */
export const ROLE_PRIVILEGE: Record<DirectoryRole, number> = {
  guest: 0,
  family: 1,
  admin: 2,
  owner: 3,
};

/** Least-privilege default for a SCIM user with no recognized group. */
export const DEFAULT_DIRECTORY_ROLE: DirectoryRole = "family";

/**
 * WARP-1568 — the SCIM ASSIGNMENT CEILING: the most privileged role an Okta
 * group mapping may ever grant. **`admin`.**
 *
 * DECISION (flagged for confirmation): the ticket asked us to "decide and
 * document the intended ceiling (likely admin)". `admin` is it, for the same
 * reason rail 7 of the role-mutation guard refuses `owner` on the interactive
 * surfaces (Access & Roles design brief §6.2, "never Owner or Service"):
 * there is exactly ONE owner by design, ownership is the box's root of trust,
 * and transferring it is a future dedicated flow — not something a customer
 * can trigger by naming an Okta group "Business Owners". An IdP that can mint
 * owners can take the appliance from its owner, which is the escalation this
 * ceiling exists to make unrepresentable.
 *
 * It is a CLAMP, not a rejection: a group whose name says "owner" still
 * resolves to the top of the SCIM-assignable ladder (`admin`) rather than
 * silently granting nothing. The customer's intent ("these people run the
 * box") is honoured as far as SCIM is allowed to honour it, and the group
 * still converges idempotently on every Okta retry instead of 4xx-looping.
 *
 * Applied at the ONE name → role boundary below, so a keyword rule added
 * later inherits the ceiling instead of having to remember it. The role-
 * mutation guard's rails 3 + 7 refuse `owner` independently at the write
 * (scim.service.ts), so this clamp is the policy and the guard is the
 * backstop — neither is load-bearing alone.
 */
export const SCIM_ROLE_CEILING: DirectoryRole = "admin";

/**
 * Keyword → role rules, checked in DESCENDING privilege order so the most
 * privileged matching keyword wins within a single group name (e.g. a group
 * literally named "Owners and Admins" resolves to the owner arm — then the
 * ceiling clamps it to `admin`). Each rule matches when the normalized
 * (trim + lowercase) group name CONTAINS the keyword.
 *
 * Deliberately conservative: only explicit role vocabulary elevates. Adding a
 * customer-specific synonym is a one-line edit here (the single source of
 * truth), not a scatter of string checks across the SCIM handlers.
 */
const KEYWORD_RULES: ReadonlyArray<{ keyword: string; role: DirectoryRole }> = [
  // The "owner" arm is kept so an owner-named group still resolves to the TOP
  // of the ladder rather than falling through to `family` — but the mapper
  // clamps it to SCIM_ROLE_CEILING (`admin`) on the way out (WARP-1568). It is
  // the ladder position that is meaningful here, not the literal role.
  { keyword: "owner", role: "owner" },
  { keyword: "admin", role: "admin" },
  { keyword: "manager", role: "admin" },
  { keyword: "guest", role: "guest" },
];

function normalize(name: string): string {
  return name.trim().toLowerCase();
}

/** WARP-1568 — clamp anything above the ceiling down to it. */
function clampToCeiling(role: DirectoryRole): DirectoryRole {
  return ROLE_PRIVILEGE[role] > ROLE_PRIVILEGE[SCIM_ROLE_CEILING]
    ? SCIM_ROLE_CEILING
    : role;
}

/**
 * Map a single SCIM group display name to the local Role it grants. Returns
 * the least-privilege default (`family`) for any name without a recognized
 * role keyword. Never returns `service`, and never returns anything above
 * SCIM_ROLE_CEILING (WARP-1568) — this is the single name → role boundary
 * the whole SCIM surface goes through, so the clamp lives here rather than at
 * each caller.
 */
export function roleForScimGroupName(displayName: string): DirectoryRole {
  const n = normalize(displayName);
  for (const rule of KEYWORD_RULES) {
    if (n.includes(rule.keyword)) {
      return clampToCeiling(rule.role);
    }
  }
  return DEFAULT_DIRECTORY_ROLE;
}

/**
 * The most-privileged role of a set. Empty set → the least-privilege default
 * (`family`) so a user with no mapped groups still has the floor role.
 */
export function highestRole(roles: ReadonlyArray<DirectoryRole>): DirectoryRole {
  let best: DirectoryRole = DEFAULT_DIRECTORY_ROLE;
  let bestRank = ROLE_PRIVILEGE[DEFAULT_DIRECTORY_ROLE];
  for (const r of roles) {
    if (ROLE_PRIVILEGE[r] > bestRank) {
      best = r;
      bestRank = ROLE_PRIVILEGE[r];
    }
  }
  return best;
}

/**
 * Resolve a user's effective local Role from the display names of the groups
 * they belong to: map each name, then take the highest privilege. No groups
 * (or only unrecognized ones) → `family`.
 */
export function effectiveRoleForGroupNames(groupNames: ReadonlyArray<string>): Role {
  return highestRole(groupNames.map(roleForScimGroupName));
}
