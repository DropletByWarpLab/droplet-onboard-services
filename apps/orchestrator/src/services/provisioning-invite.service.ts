/**
 * WARP-1265 (T13) — provisioning call-site plumbing for department grants.
 *
 * Handles converting UserInviteDepartment rows to DepartmentMembership rows
 * during invite acceptance, and provides a shared helper for household + dept
 * provisioning across setup, admin create-user, and invite-accept paths.
 */
import type { PrismaClient, DepartmentRight } from "@prisma/client";
import { addMembership } from "./department-membership.service.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("provisioning-invite");

/**
 * Provisions department memberships for a new user by converting pending
 * UserInviteDepartment rows (created at invite time) to active DepartmentMembership rows.
 *
 * Called during invite-accept AFTER the User and Nextcloud account are created.
 * Uses the T7 membership service (addMembership) which handles tx + aclVersion
 * bump + NC sync in one atomic operation.
 *
 * Skips archived departments (state = archived) with a warn log.
 * Throws if a department doesn't exist or validation fails (caught by route).
 */
export async function convertInviteDepartmentGrants(
  prisma: PrismaClient,
  userId: string,
  inviteId: string,
  inviteCreatedBy: string, // username of the invite creator (for grantedBy)
): Promise<void> {
  const grants = await prisma.userInviteDepartment.findMany({
    where: { inviteId },
    include: { department: true },
  });

  for (const grant of grants) {
    const dept = grant.department;

    // Skip archived departments — the invite was issued while active, but
    // the dept was archived before accept.
    if (dept.state === "archived") {
      logger.warn(
        { userId, departmentId: dept.id, deptName: dept.name },
        "invite-accept: target department is archived, skipping membership creation",
      );
      continue;
    }

    try {
      await addMembership(
        prisma,
        dept.id,
        userId,
        grant.right,
        inviteCreatedBy, // the person who issued the invite
      );
    } catch (err) {
      logger.error(
        { err, userId, departmentId: dept.id, right: grant.right },
        "invite-accept: failed to create department membership from grant",
      );
      // Re-throw so the route can handle it — this is a hard error,
      // not a best-effort side effect.
      throw err;
    }
  }
}

/**
 * Shared helper for household + department provisioning across multiple
 * call-sites. Used by:
 *   - /auth/setup (owner bootstrap)
 *   - /auth/users (admin create-user)
 *   - /auth/invites/accept (with department grants via convertInviteDepartmentGrants)
 *
 * This helper ensures consistent household membership provisioning semantics
 * (every new user joins the household with the default contributor right for
 * backward compatibility with legacy household-only systems).
 *
 * TODO T11 (WARP-1266): seed backfill semantics for household. Once landed,
 * call this helper in /auth/setup and /auth/users to ensure both paths
 * bootstrap household membership + any explicit dept grants in one place.
 */
export async function ensureHouseholdMembership(
  prisma: PrismaClient,
  userId: string,
  householdDepartmentId: string,
  grantedBy: string, // user who provisioned this membership (admin, system, etc.)
): Promise<void> {
  // Check if the user already has a household membership (idempotent).
  const existing = await prisma.departmentMembership.findUnique({
    where: {
      departmentId_userId: { departmentId: householdDepartmentId, userId },
    },
  });

  if (existing) {
    logger.debug({ userId, householdDepartmentId }, "household membership already exists");
    return;
  }

  try {
    await addMembership(
      prisma,
      householdDepartmentId,
      userId,
      "contributor", // default right for household members (backward compat)
      grantedBy,
    );
  } catch (err) {
    logger.error(
      { err, userId, householdDepartmentId },
      "failed to create household membership",
    );
    // Re-throw so the caller can handle — household membership is required.
    throw err;
  }
}
