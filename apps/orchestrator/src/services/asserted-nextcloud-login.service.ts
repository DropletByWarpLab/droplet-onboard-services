/**
 * WARP-3117 — the Nextcloud LOGIN of the person behind an `_service:mcp` call.
 *
 * `X-Nextcloud-User` names a person, not a Nextcloud account: it is
 * `User.username` on stdio and `User.id` over the HTTP transport
 * (asserted-user.service.ts). A route that talks WebDAV/OCS as that person
 * must not hand the header to Nextcloud. Over HTTP that aims every call at
 * `/remote.php/dav/files/<User.id>/…`, a user Nextcloud has never seen.
 *
 * The person is resolved exactly as `resolveAssertedUser` resolves them (one
 * active row, or refused). Their Nextcloud login is `User.nextcloudUsername`,
 * the OCS mapping key that ADR-013 keeps decoupled from `username`.
 *
 * A person with no `nextcloudUsername` has NO Nextcloud account: SSO- and
 * SCIM-provisioned rows are never created in Nextcloud (WARP-2858). They are
 * refused, never retried as `username`. No Nextcloud account was ever made
 * for that name, and if one exists it belongs to someone else.
 *
 * A separate read, not a wider `select` in `resolveAssertedUser`: the login
 * is only needed by the three Nextcloud readers, and the resolver's shape is
 * shared by every access decision.
 */
import type { PrismaClient } from "@prisma/client";
import { resolveAssertedUser, type AssertedUserFailure } from "./asserted-user.service.js";

export type AssertedNextcloudLoginFailure = AssertedUserFailure | "no_nextcloud_account";

export type AssertedNextcloudLoginResolution =
  | { ok: true; login: string; userId: string }
  | { ok: false; reason: AssertedNextcloudLoginFailure };

export async function resolveAssertedNextcloudLogin(
  prisma: PrismaClient,
  asserted: string,
): Promise<AssertedNextcloudLoginResolution> {
  const resolved = await resolveAssertedUser(prisma, asserted);
  if (!resolved.ok) return resolved;
  const row = await prisma.user.findUnique({
    where: { id: resolved.user.id },
    select: { nextcloudUsername: true },
  });
  const login = row?.nextcloudUsername;
  if (!login) return { ok: false, reason: "no_nextcloud_account" };
  return { ok: true, login, userId: resolved.user.id };
}

/** The 403 body a route answers a refused assertion with. */
export function assertedNextcloudLoginRefusal(reason: AssertedNextcloudLoginFailure): {
  error: string;
  reason?: AssertedUserFailure;
  message: string;
} {
  if (reason === "no_nextcloud_account") {
    return {
      error: "no_nextcloud_account",
      message: "The acting person has no Nextcloud account, so there are no files to act on.",
    };
  }
  return {
    error: "asserted_user_unresolved",
    reason,
    message: "X-Nextcloud-User must name exactly one active person.",
  };
}
