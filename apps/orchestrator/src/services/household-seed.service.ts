/**
 * WARP-1263 (T11) — household absorption seed.
 *
 * Idempotent boot-time seed that absorbs the legacy WS-5 Household NC group
 * into a new Department row with kind=HOUSEHOLD. Zero NC mutations — only
 * reads from gfListFolders() to discover the existing groupfolder id.
 *
 * Logic:
 * 1. Check if a Department with kind=HOUSEHOLD exists.
 *    If yes → ensure membership backfill is current (additive only, never downgrade)
 *    If no → proceed to step 2.
 * 2. Call gfListFolders() to find a folder whose mount_point ===
 *    DROPLET_SHARED_FOLDER_NAME (configured, default "Household").
 *    If found: create Department{kind:HOUSEHOLD, ...} + DepartmentMembership
 *    for each User, role-mapped.
 *    If NOT found: log + return (fresh box before init hook ran; seed retries on each boot).
 *
 * Membership role mapping (guest → reader, family → contributor, owner/admin → manager):
 * - Each User gets ONE membership row per department with right determined by their
 *   box-level Role. Sync state is 'synced' (NC groups already exist, no mutation needed).
 *   Permission mask is 31 (MASK_ADMIN) for all rows — the reconciler later strips
 *   read-only and contributor masks, leaving only managers with 31.
 */

import type { PrismaClient, Role, DepartmentRight } from "@prisma/client";
import { gfListFolders } from "./nextcloud-groups.client.js";
import { adminBasicToken } from "./department-provisioner.service.js";
import { config } from "../config.js";
import { recordActivity } from "./activity.singleton.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("household-seed");

/**
 * Map a User's box-level Role to a Department membership right.
 * - owner / admin → manager
 * - family → contributor
 * - guest → reader
 * - service → reader (service principals read-only on guarded routes)
 */
function roleToRight(userRole: Role): DepartmentRight {
  switch (userRole) {
    case "owner":
    case "admin":
      return "manager";
    case "family":
      return "contributor";
    case "guest":
    case "service":
      return "reader";
    default:
      // Exhaustiveness check for TS
      const _exhaustive: never = userRole;
      return _exhaustive;
  }
}

/**
 * Idempotent household absorption seed. Runs once at boot, before the first
 * department reconciler tick. Adopts an existing Household NC groupfolder
 * verbatim without NC mutation; backfills User memberships on every call.
 *
 * Non-fatal: logs warnings and returns normally if the groupfolder is not
 * found (will retry on next boot).
 */
export async function seedHouseholdDepartment(
  prisma: PrismaClient,
): Promise<void> {
  try {
    // 1. Check if HOUSEHOLD department already exists.
    const existing = await prisma.department.findFirst({
      where: { kind: "HOUSEHOLD" },
    });

    if (existing) {
      // Backfill memberships for any User without one.
      await backfillHouseholdMemberships(prisma, existing.id);
      return;
    }

    // 2. Not found — attempt to discover the Household NC groupfolder.
    const adminToken = adminBasicToken();
    const folders = await gfListFolders(adminToken);
    const householdFolder = folders.find(
      (f) => f.mountPoint === config.DROPLET_SHARED_FOLDER_NAME,
    );

    if (!householdFolder) {
      // Fresh box before the init hook ran — seed retries on every boot via
      // the reconciler's 5-min cadence.
      logger.info(
        { mountPoint: config.DROPLET_SHARED_FOLDER_NAME },
        "household groupfolder not found (fresh box or not yet created by init hook)",
      );
      return;
    }

    // 3. Found — create Department + memberships in a transaction.
    const household = await prisma.$transaction(async (tx) => {
      // Create the HOUSEHOLD department, adopted verbatim from NC.
      const created = await tx.department.create({
        data: {
          name: config.DROPLET_SHARED_FOLDER_NAME,
          slug: "household",
          kind: "HOUSEHOLD",
          state: "active", // Already exists in NC, state is active.
          description: "Legacy household storage",
          ncGroupRw: config.DROPLET_SHARED_FOLDER_NAME, // WS-5 group name (e.g., "household")
          ncGroupRo: null, // No ro-only group for HOUSEHOLD per WS-5
          ncGroupfolderId: householdFolder.id, // Discovered from NC
          createdBy: "system",
        },
      });

      // Backfill all existing Users.
      const users = await tx.user.findMany({
        where: { directoryStatus: "ACTIVE" }, // Only active users
      });

      for (const user of users) {
        // Additive only — skip if membership already exists.
        const existing = await tx.departmentMembership.findUnique({
          where: {
            departmentId_userId: {
              departmentId: created.id,
              userId: user.id,
            },
          },
        });

        if (!existing) {
          await tx.departmentMembership.create({
            data: {
              departmentId: created.id,
              userId: user.id,
              right: roleToRight(user.role),
              syncState: "synced", // NC group already exists, no sync needed.
              ncPermissionMask: 31, // MASK_ADMIN — reconciler will adjust per right.
              grantedBy: "system",
            },
          });
        }
      }

      return created;
    });

    logger.info(
      {
        householdId: household.id,
        mountPoint: householdFolder.mountPoint,
        groupfolderId: householdFolder.id,
      },
      "household department seeded (WS-5 adoption)",
    );

    await recordActivity({
      kind: "system",
      severity: "ok",
      sourceIcon: "folder-check",
      what: "Household department absorbed from Nextcloud",
      sub: config.DROPLET_SHARED_FOLDER_NAME,
      refs: {
        householdId: household.id,
        groupfolderId: householdFolder.id,
      },
      actor: { type: "system" },
    });
  } catch (err) {
    logger.error({ err }, "household seed failed (retrying on next boot)");
    // Non-fatal — the seed retries on each boot via the reconciler cadence.
  }
}

/**
 * Backfill memberships for the HOUSEHOLD department. Called when the
 * household already exists, to ensure any new Users get a membership.
 * Additive only — never downgrades an existing membership.
 */
async function backfillHouseholdMemberships(
  prisma: PrismaClient,
  householdId: string,
): Promise<void> {
  const users = await prisma.user.findMany({
    where: { directoryStatus: "ACTIVE" },
  });

  let backfilled = 0;

  for (const user of users) {
    const existing = await prisma.departmentMembership.findUnique({
      where: {
        departmentId_userId: {
          departmentId: householdId,
          userId: user.id,
        },
      },
    });

    if (!existing) {
      await prisma.departmentMembership.create({
        data: {
          departmentId: householdId,
          userId: user.id,
          right: roleToRight(user.role),
          syncState: "synced",
          ncPermissionMask: 31,
          grantedBy: "system",
        },
      });
      backfilled++;
    }
  }

  if (backfilled > 0) {
    logger.info(
      { householdId, backfilled },
      "household membership backfill complete",
    );
  }
}
