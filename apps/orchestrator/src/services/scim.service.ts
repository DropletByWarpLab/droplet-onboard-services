/**
 * WARP (SCIM directory sync) — provisioning service: the SCIM ↔ local-User /
 * Group mapping, idempotency, and SOFT deactivation.
 *
 * This is the DB boundary the SCIM route (routes/scim.ts) delegates to. It
 * mirrors the account-linking policy of the SSO callback (routes/sso.ts):
 * a SCIM user is keyed by the NORMALIZED work email and linked through the
 * EXISTING `SsoIdentity` table (provider="okta", subject = the SCIM
 * externalId, falling back to the local User.id when Okta omits externalId).
 * The local `User.id` UUID is always preserved (WARP-485).
 *
 * Idempotency (Okta retries every call): every operation is create-or-update
 * keyed on a stable identifier, never a blind insert. Re-running a POST /
 * PUT / PATCH / DELETE converges to the same state.
 *
 * Deactivation is SOFT (architecture-guard rule 10): `active:false` / DELETE
 * sets `directoryStatus = DEACTIVATED` (an explicit enum), never a row
 * delete — Okta owns the lifecycle and may re-activate the same person later.
 */
import type { PrismaClient, User } from "@prisma/client";
import { findUserByEmail, emailWriteData } from "./user-directory.service.js";
import { effectiveRoleForGroupNames, roleForScimGroupName, ROLE_PRIVILEGE } from "./scim-role-mapping.service.js";
import type { DirectoryRole } from "./scim-role-mapping.service.js";
import type { ParsedScimUser } from "./scim-resource.js";

/** The "okta" provider id — SCIM provisioning links live under it in
 *  SsoIdentity, the same row a later Okta SSO sign-in resolves by sub. */
const OKTA_PROVIDER = "okta";

/** Local-part of an email, sanitized into a username seed (mirrors sso.ts). */
function usernameSeedFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email;
  const cleaned = local.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 48);
  return cleaned.length >= 2 ? cleaned : `scim-${cleaned}`;
}

export interface ProvisionUserResult {
  user: User;
  /** True when a NEW local User row was created; false when an existing row
   *  (matched by email) was updated in place. */
  created: boolean;
}

/**
 * Create-or-update a directory user from a parsed SCIM payload. Keyed by the
 * normalized email:
 *   - existing row → update displayName + active status IN PLACE (id + role
 *     preserved; SCIM never demotes an existing owner/admin).
 *   - no row → create a least-privilege (`family`), `isLocal`, no-passwordHash
 *     (SCIM users can't password-login) row, ACTIVE unless active:false.
 * Either way, ensure the SsoIdentity(okta, externalId|id) link exists (idempotent).
 */
export async function provisionUser(
  prisma: PrismaClient,
  parsed: ParsedScimUser,
): Promise<ProvisionUserResult> {
  const targetStatus = parsed.active ? "ACTIVE" : "DEACTIVATED";

  // WARP-233: blind-index lookup (email at rest is a dcv1 ciphertext).
  const existing = await findUserByEmail(prisma, parsed.email);
  if (existing) {
    const user = await prisma.user.update({
      where: { id: existing.id },
      data: {
        displayName: parsed.displayName,
        directoryStatus: targetStatus,
        // NB: role is intentionally NOT changed here — an existing
        // owner/admin keeps their role; group membership (provisionGroup) is
        // the only thing that elevates, and never via a plain user upsert.
      },
    });
    await ensureOktaLink(prisma, user.id, parsed);
    return { user, created: false };
  }

  const user = await prisma.user.create({
    data: {
      username: usernameSeedFromEmail(parsed.email),
      displayName: parsed.displayName,
      ...emailWriteData(parsed.email),
      role: "family", // least privilege; provisionGroup raises it
      isLocal: true,
      directoryStatus: targetStatus,
      // No passwordHash — SCIM-provisioned users authenticate via Okta SSO
      // only; /auth/login fails closed on a null hash.
    },
  });
  await ensureOktaLink(prisma, user.id, parsed);
  return { user, created: true };
}

/** Ensure exactly one SsoIdentity(okta, subject) link for this user. The
 *  subject is the SCIM externalId when Okta supplies it, else the local
 *  User.id (stable). Idempotent — a retry finds the row and no-ops. */
async function ensureOktaLink(prisma: PrismaClient, userId: string, parsed: ParsedScimUser): Promise<void> {
  const subject = parsed.externalId ?? userId;
  const found = await prisma.ssoIdentity.findUnique({
    where: { provider_subject: { provider: OKTA_PROVIDER, subject } },
  });
  if (found) return;
  await prisma.ssoIdentity.create({
    data: { userId, provider: OKTA_PROVIDER, subject, email: parsed.email },
  });
}

/** Soft-deactivate a user by local id (the SCIM resource id). Sets
 *  DEACTIVATED; never deletes. Idempotent. Returns null for an unknown id. */
export async function deactivateUser(prisma: PrismaClient, id: string): Promise<User | null> {
  const existing = await prisma.user.findUnique({ where: { id } });
  if (!existing) return null;
  return prisma.user.update({ where: { id }, data: { directoryStatus: "DEACTIVATED" } });
}

/** Re-activate a soft-deactivated user (active:true on a DEACTIVATED row). */
export async function reactivateUser(prisma: PrismaClient, id: string): Promise<User | null> {
  const existing = await prisma.user.findUnique({ where: { id } });
  if (!existing) return null;
  return prisma.user.update({ where: { id }, data: { directoryStatus: "ACTIVE" } });
}

/** Apply a SCIM PATCH/PUT `active` change by id (true → ACTIVE, false →
 *  DEACTIVATED). Returns null for an unknown id. */
export async function setUserActive(prisma: PrismaClient, id: string, active: boolean): Promise<User | null> {
  return active ? reactivateUser(prisma, id) : deactivateUser(prisma, id);
}

export async function findUserById(prisma: PrismaClient, id: string): Promise<User | null> {
  return prisma.user.findUnique({ where: { id } });
}

export async function findUserByUserName(prisma: PrismaClient, email: string): Promise<User | null> {
  // WARP-233: SCIM userName IS the email — resolve through the blind index.
  return findUserByEmail(prisma, email);
}

export interface ProvisionGroupInput {
  displayName: string;
  externalId?: string;
  /** Local User.ids of the group's members (SCIM group `members[].value`). */
  memberUserIds: string[];
}

export interface ScimGroupResult {
  id: string;
  displayName: string;
  mappedRole: string;
}

/**
 * Upsert a SCIM group and apply its role mapping to listed members.
 *
 * The group's `mappedRole` is resolved from its display name by the explicit
 * policy (scim-role-mapping.service). Each member's role is RAISED to at
 * least the group's mapped role (highest-privilege-wins floor) — a member of
 * "Admins" becomes admin; a higher-privileged member added to a lower group
 * is NOT demoted. This keeps role mapping idempotent (re-applying is a no-op)
 * without standing up the gated Team-membership UI.
 *
 * NB (documented simplification): without a persisted SCIM membership table,
 * removing a user from a group does NOT auto-lower their role here. Role
 * elevation is sticky until an explicit People-surface change. This matches
 * the AC ("respect the EXISTING role model; do NOT build the gated Team UI")
 * and is called out in the PR handoff.
 */
export async function provisionGroup(
  prisma: PrismaClient,
  input: ProvisionGroupInput,
): Promise<ScimGroupResult> {
  const mappedRole: DirectoryRole = roleForScimGroupName(input.displayName);

  // Upsert by externalId OR displayName (both unique) so Okta retries
  // converge to one row.
  const or: Array<Record<string, string>> = [{ displayName: input.displayName }];
  if (input.externalId) or.unshift({ externalId: input.externalId });
  const existing = await prisma.scimGroup.findFirst({ where: { OR: or } });

  let groupRow;
  if (existing) {
    groupRow = await prisma.scimGroup.update({
      where: { id: existing.id },
      data: { displayName: input.displayName, externalId: input.externalId ?? existing.externalId, mappedRole },
    });
  } else {
    groupRow = await prisma.scimGroup.create({
      data: { displayName: input.displayName, externalId: input.externalId ?? null, mappedRole },
    });
  }

  // Raise each member's role to at least the group's mapped role.
  for (const userId of input.memberUserIds) {
    await raiseUserRoleTo(prisma, userId, mappedRole);
  }

  return { id: groupRow.id, displayName: groupRow.displayName, mappedRole: groupRow.mappedRole };
}

/** Raise a user's role to `target` if `target` is more privileged than their
 *  current role; otherwise leave it (no demotion). The internal `service`
 *  role is never produced by SCIM so it isn't considered here. */
async function raiseUserRoleTo(prisma: PrismaClient, userId: string, target: DirectoryRole): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return;
  const currentRank = ROLE_PRIVILEGE[(user.role as DirectoryRole)] ?? ROLE_PRIVILEGE.family;
  if (ROLE_PRIVILEGE[target] > currentRank) {
    await prisma.user.update({ where: { id: userId }, data: { role: target } });
  }
}

/** Re-export for callers that want to compute a role from a name list. */
export { effectiveRoleForGroupNames };
