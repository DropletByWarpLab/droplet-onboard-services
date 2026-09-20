/**
 * WARP-2845 — give the seeded dev owner a Nextcloud account.
 *
 * BEST-EFFORT on purpose: the dashboard authenticates against the local
 * `User` row alone (ADR-013), so a Nextcloud that is slow to install must not
 * fail the seed — it must say what it could not do and move on. It is also
 * the REPAIR path, run on every boot, so a healthy stack must stay quiet.
 *
 * 🔴 Best-effort is not the same as blind. OCS answers **HTTP 200 with a
 * failing `ocs.meta.statuscode`** for logical errors — a missing group, a
 * rejected id, an unauthorised admin. The first version of this decided
 * success from `resp.ok`, so a create that OCS refused was logged as
 * "Nextcloud account provisioned" and /files then 401'd for an owner the log
 * said was fine. Nothing here may infer an outcome from the transport.
 *
 * So every call goes through `nextcloud.client.ts`, which parses the OCS body
 * and throws:
 *   - `ncEnsureGroup`  — 100 (created) and 102 (already exists) both return;
 *                        anything else throws `NextcloudOcsError`.
 *   - `ncCreateUser`   — 100 returns; 102 throws `NextcloudUserExistsError`;
 *                        anything else throws `NextcloudOcsError`.
 *
 * This module's whole job is to sequence those two and report what they said.
 * It lives beside `dev-owner-seed.policy.ts` rather than inside
 * `prisma/seed.dev.ts` for the same reason that module does: a script with a
 * top-level `main()` cannot be imported, and an outcome nothing can assert on
 * is how the swallowed failure got shipped in the first place.
 */

import { config } from "../config.js";
import { ncCreateUser, ncEnsureGroup, NextcloudUserExistsError } from "./nextcloud.client.js";

export type DevOwnerNextcloudOutcome =
  | { status: "skipped"; reason: string }
  | { status: "already_present" }
  | { status: "provisioned"; groups: string[] }
  | { status: "failed"; reason: string };

/**
 * Nextcloud group name for the household space.
 *
 * Deliberately duplicated from `routes/auth-groups.ts:householdGroupName`
 * rather than imported: that module reaches into the department provisioner,
 * and a seed path that drags in the service graph fails for reasons that have
 * nothing to do with seeding. Same rationale auth-groups.ts itself gives for
 * inlining its role check instead of importing ADMIN_TIER_ROLES.
 */
export function householdGroupSlug(sharedFolderName: string | undefined): string {
  return (
    String(sharedFolderName ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "household"
  );
}

export async function provisionDevOwnerNextcloudAccount(
  username: string,
  password: string,
  displayName: string,
): Promise<DevOwnerNextcloudOutcome> {
  // The admin credentials have no `config` entry — `ncEnsureGroup` and
  // `ncInstallAndCreateAdmin` both read them straight from the environment —
  // so the precondition is named in the same terms the operator sets it in.
  // The URL is checked here for the same reason and resolved by the client
  // through the zod-validated `config.NEXTCLOUD_URL`, which is this same value.
  const admin = process.env.NEXTCLOUD_ADMIN_USER ?? "";
  const adminPassword = process.env.NEXTCLOUD_ADMIN_PASSWORD ?? "";
  if (!process.env.NEXTCLOUD_URL || !admin || !adminPassword) {
    return {
      status: "skipped",
      reason: "NEXTCLOUD_URL/ADMIN_USER/ADMIN_PASSWORD unset",
    };
  }

  // `resolveAuthHeader` sends Basic for a `basic:` prefix and Bearer for
  // anything else, so the prefix is load-bearing: a bare base64 blob would go
  // out as a Bearer token and 401 every call.
  const adminToken = `basic:${Buffer.from(`${admin}:${adminPassword}`).toString("base64")}`;

  // An owner's groups, per buildNcGroups(). `droplet-admins` is created lazily
  // by the department provisioner and the household group by the occ init
  // script, so on a fresh dev stack neither exists yet — and OCS REFUSES a
  // create-user naming a group that does not exist (the WARP-990 trigger).
  // Ensure them first, exactly as POST /auth/setup does.
  const groups = ["admin", "droplet-admins", householdGroupSlug(config.DROPLET_SHARED_FOLDER_NAME)];

  for (const groupid of groups) {
    try {
      await ncEnsureGroup(groupid);
    } catch (err) {
      // 🔴 Never swallowed. A group that could not be ensured is the CAUSE of
      // the create failure that would follow, so it is reported by name and
      // the create is not attempted — the old `.catch(() => undefined)` made a
      // real failure indistinguishable from "already exists" and left nothing
      // in the log pointing at the group.
      return {
        status: "failed",
        reason: `group '${groupid}' could not be ensured — ${(err as Error).message}`,
      };
    }
  }

  try {
    await ncCreateUser(adminToken, username, password, displayName, groups);
  } catch (err) {
    // OCS 102 on create is the healthy-restart case: this runs on every boot,
    // so an account that is already there is the answer we wanted, not a
    // failure to shout about. `ncCreateUser` types it so we do not have to
    // string-match the message.
    if (err instanceof NextcloudUserExistsError) return { status: "already_present" };
    return { status: "failed", reason: (err as Error).message };
  }

  return { status: "provisioned", groups };
}
