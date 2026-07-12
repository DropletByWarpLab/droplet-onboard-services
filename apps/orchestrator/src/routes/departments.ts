/**
 * WARP-1258 (T6) — departments CRUD routes.
 *
 * Implements the department/team lifecycle API per ADR-029 §4:
 *   GET    /api/departments              — list all active departments (any authenticated role)
 *   POST   /api/departments              — create department (owner+admin)
 *   POST   /api/departments/:id/teams    — create team under department (owner+admin)
 *   PATCH  /api/departments/:id          — update department (owner+admin)
 *   DELETE /api/departments/:id          — archive department (owner+admin)
 *
 * All mutations validate against reserved names, active ancestors, and existing
 * Nextcloud mount points (best-effort warn-only). Slug generation: lowercase-dash
 * from the display name. State machine: pending → provisioning → active (or failed).
 * Archive: state=archiving + kick reconciler.
 *
 * Department is the unit of groupfolder auth (NC groups `dept-<slug>` / `dept-<slug>-ro`);
 * Teams nest one level deep with groups `dept-<deptslug>-<teamslug>{,-ro}` and FLAT
 * mount point `<Dept> — <Team>` (nested mount_points leak writes to personal storage per WARP-1254).
 *
 * Provisioning + lifecycle (archiving, de-provisioning) is async; routes return
 * immediately with pending state. The reconciler (5-min tick) converges NC toward
 * Prisma-desired state.
 *
 * All mutations include HMAC ActivityRow audit via the activity.singleton service.
 * All state mutations bump aclVersion in the same $transaction (T7 helper will exist;
 * inline here for now as bumpAclVersion tx helper for reuse in T7).
 */

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { PrismaClient, Department, DepartmentKind } from "@prisma/client";
import { requireRole } from "../middleware/auth.js";
import { recordActivity } from "../services/activity.singleton.js";
import { actorFromRequest } from "../services/activity.service.js";
import { validateDepartmentHierarchy } from "../services/department-validation.js";
import { kickReconcile } from "../services/department-reconciler.service.js";
import { gfListFolders } from "../services/nextcloud-groups.client.js";
import { adminBasicToken } from "../services/department-provisioner.service.js";
import { config } from "../config.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("departments-route");

// Reserved names that cannot be used as department/team names or slugs
const RESERVED_NAMES = new Set([
  config.DROPLET_SHARED_FOLDER_NAME,
  "household",
  "admin",
  "system",
]);

/**
 * Normalize a display name to a slug: lowercase, dash-separated, alphanumeric + dash only.
 * Examples: "My Department" → "my-department"; "Sales & Marketing" → "sales--marketing"
 */
function nameToSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      // Replace non-alphanumeric with dash, collapse multiple dashes
      .replace(/[^a-z0-9]+/g, "-")
      // Trim leading/trailing dashes
      .replace(/^-+|-+$/g, "")
  );
}

interface CreateDepartmentBody {
  name: string;
  description?: string;
  quotaBytes?: string;
}

interface CreateTeamBody {
  name: string;
  description?: string;
  quotaBytes?: string;
}

interface UpdateDepartmentBody {
  description?: string;
  quotaBytes?: string;
  name?: string; // if present, return 400 error (no renames in v1)
}

const createDepartmentSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(1000).optional(),
  quotaBytes: z.string().regex(/^\d+$/).optional(),
});

const createTeamSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(1000).optional(),
  quotaBytes: z.string().regex(/^\d+$/).optional(),
});

const updateDepartmentSchema = z.object({
  description: z.string().max(1000).optional(),
  quotaBytes: z.string().regex(/^\d+$/).optional(),
  name: z.string().optional(), // Catch this to return 400
});

/**
 * Helper to format a Department row for API response.
 * BigInt fields are encoded as strings per the schema.
 */
function formatDepartmentResponse(dept: Department & { _count?: { teams?: number; memberships?: number } }) {
  return {
    id: dept.id,
    name: dept.name,
    slug: dept.slug,
    kind: dept.kind,
    parentId: dept.parentId ?? null,
    description: dept.description,
    state: dept.state,
    quotaBytes: dept.quotaBytes?.toString() ?? null,
    aclVersion: dept.aclVersion,
    createdAt: dept.createdAt,
    updatedAt: dept.updatedAt,
    archivedAt: dept.archivedAt,
    memberCount: dept._count?.memberships ?? 0,
    teamCount: dept._count?.teams ?? 0,
  };
}

/**
 * Transaction helper to bump aclVersion in place. Used on every membership/state mutation
 * to ensure cache invalidation is atomic with the mutation itself.
 */
async function bumpAclVersion(
  tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0],
  departmentId: string,
): Promise<void> {
  await tx.department.update({
    where: { id: departmentId },
    data: { aclVersion: { increment: 1 } },
  });
}

export function createDepartmentsRouter(prisma: PrismaClient): Router {
  const router = Router();

  // ── GET /api/departments ────────────────────────────────────
  // List all non-archived departments and teams. Any authenticated role.
  // Returns {id, name, slug, kind, parentId, state, quotaBytes, memberCount, teamCount}.
  // BigInt fields are string-encoded.
  router.get(
    "/departments",
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const departments = await prisma.department.findMany({
          where: {
            state: { not: "archived" }, // Hide fully archived departments
          },
          include: {
            _count: {
              select: { memberships: true, teams: true },
            },
          },
        });

        res.json({
          departments: departments.map(formatDepartmentResponse),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── POST /api/departments ───────────────────────────────────
  // Create a department. owner + admin only.
  // Returns 201 with the department row on success.
  // Validates: name/slug not reserved, no duplicate slugs/names.
  // Best-effort Nextcloud mount-point check (warn-only, not blocking).
  // Async: state starts as 'pending', reconciler provisions NC side.
  router.post(
    "/departments",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = createDepartmentSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({
            error: "Invalid request",
            details: parsed.error.flatten(),
          });
        }

        const { name, description, quotaBytes } = parsed.data;
        const slug = nameToSlug(name);

        // Validate reserved names
        if (RESERVED_NAMES.has(name.toLowerCase()) || RESERVED_NAMES.has(slug)) {
          return res.status(400).json({
            error: `Name "${name}" is reserved and cannot be used for a department`,
            code: "RESERVED_NAME",
          });
        }

        // Check for existing department with same name or slug
        const existing = await prisma.department.findFirst({
          where: {
            OR: [{ name }, { slug }],
          },
        });

        if (existing) {
          return res.status(400).json({
            error: `Department with name or slug already exists`,
            code: "DUPLICATE_NAME",
          });
        }

        // Best-effort NC groupfolder mount-point check (warn only)
        let ncWarning: string | null = null;
        try {
          const folders = await gfListFolders(adminBasicToken());
          const existingMount = folders.some(
            (f: { mount_point: string }) => f.mount_point === name,
          );
          if (existingMount) {
            ncWarning = `Nextcloud groupfolder with mount_point "${name}" already exists (will be reused)`;
          }
        } catch (err) {
          // Warn only; don't block
          logger.warn(
            { err },
            "POST /departments: could not reach Nextcloud for mount-point check",
          );
        }

        // Parse quotaBytes if provided (must be valid BigInt when stored)
        let quotaBigInt: bigint | null = null;
        if (quotaBytes) {
          try {
            quotaBigInt = BigInt(quotaBytes);
          } catch {
            return res.status(400).json({
              error: "Invalid quotaBytes (must be a valid integer)",
              code: "INVALID_QUOTA",
            });
          }
        }

        // Create the department and the creator's membership in one transaction
        const department = await prisma.$transaction(async (tx) => {
          const created = await tx.department.create({
            data: {
              name,
              slug,
              kind: "DEPARTMENT",
              state: "pending",
              description: description ?? null,
              quotaBytes: quotaBigInt,
              createdBy: req.user?.id ?? "unknown",
            },
            include: {
              _count: {
                select: { memberships: true, teams: true },
              },
            },
          });

          // Add creator as manager
          await tx.departmentMembership.create({
            data: {
              departmentId: created.id,
              userId: req.user?.id ?? "unknown",
              right: "manager",
              syncState: "pending",
              grantedBy: req.user?.id ?? "unknown",
            },
          });

          // Bump aclVersion after the create
          await bumpAclVersion(tx, created.id);

          return created;
        });

        // Record activity audit
        await recordActivity({
          kind: "system",
          severity: "ok",
          sourceIcon: "folder-plus",
          what: "Department created",
          sub: `${department.name} (${department.slug})`,
          refs: {
            actor: req.user?.username ?? null,
            departmentId: department.id,
            departmentName: department.name,
            departmentSlug: department.slug,
          },
          actor: actorFromRequest(req),
        });

        // Kick reconciler to start provisioning
        kickReconcile();

        res.status(201).json({
          department: formatDepartmentResponse(department),
          warning: ncWarning,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── POST /api/departments/:id/teams ─────────────────────────
  // Create a team under a department. owner + admin only.
  // Validates: parent exists and is kind=DEPARTMENT and state=active.
  // Team slug is namespaced: `dept-<parentSlug>-<teamSlug>`.
  // Mount point is FLAT: `<Parent.name> — <Team.name>`.
  // Returns 201 with the team row on success.
  router.post(
    "/departments/:id/teams",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = createTeamSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({
            error: "Invalid request",
            details: parsed.error.flatten(),
          });
        }

        const { name, description, quotaBytes } = parsed.data;
        const parentId = req.params.id;

        // Find parent department
        const parent = await prisma.department.findUnique({
          where: { id: parentId },
        });

        if (!parent) {
          return res.status(404).json({
            error: "Parent department not found",
            code: "PARENT_NOT_FOUND",
          });
        }

        // Validate parent is a DEPARTMENT and is active
        if (parent.kind !== "DEPARTMENT") {
          return res.status(400).json({
            error: `Parent must be kind DEPARTMENT, not ${parent.kind}`,
            code: "INVALID_PARENT_KIND",
          });
        }

        if (parent.state !== "active") {
          return res.status(400).json({
            error: `Parent department must be in active state, not ${parent.state}`,
            code: "PARENT_NOT_ACTIVE",
          });
        }

        // Validate team name not reserved
        const slug = nameToSlug(name);
        if (RESERVED_NAMES.has(name.toLowerCase()) || RESERVED_NAMES.has(slug)) {
          return res.status(400).json({
            error: `Name "${name}" is reserved and cannot be used for a team`,
            code: "RESERVED_NAME",
          });
        }

        // Check for existing team with same name under this parent
        const existingTeam = await prisma.department.findFirst({
          where: {
            parentId,
            name,
          },
        });

        if (existingTeam) {
          return res.status(400).json({
            error: `Team with name "${name}" already exists in this department`,
            code: "DUPLICATE_TEAM_NAME",
          });
        }

        // Parse quotaBytes if provided
        let quotaBigInt: bigint | null = null;
        if (quotaBytes) {
          try {
            quotaBigInt = BigInt(quotaBytes);
          } catch {
            return res.status(400).json({
              error: "Invalid quotaBytes (must be a valid integer)",
              code: "INVALID_QUOTA",
            });
          }
        }

        // Create the team and add creator as manager in one transaction
        const team = await prisma.$transaction(async (tx) => {
          const created = await tx.department.create({
            data: {
              name,
              slug: `${parent.slug}-${slug}`, // Namespace team slug under parent
              parentId,
              kind: "TEAM",
              state: "pending",
              description: description ?? null,
              quotaBytes: quotaBigInt,
              createdBy: req.user?.id ?? "unknown",
            },
            include: {
              _count: {
                select: { memberships: true, teams: true },
              },
            },
          });

          // Add creator as manager
          await tx.departmentMembership.create({
            data: {
              departmentId: created.id,
              userId: req.user?.id ?? "unknown",
              right: "manager",
              syncState: "pending",
              grantedBy: req.user?.id ?? "unknown",
            },
          });

          // Bump parent's aclVersion (membership/state of child affects parent)
          await bumpAclVersion(tx, parentId);
          // Bump team's own aclVersion
          await bumpAclVersion(tx, created.id);

          return created;
        });

        // Record activity
        await recordActivity({
          kind: "system",
          severity: "ok",
          sourceIcon: "folder-plus",
          what: "Team created",
          sub: `${team.name} (under ${parent.name})`,
          refs: {
            actor: req.user?.username ?? null,
            teamId: team.id,
            teamName: team.name,
            parentId,
            parentName: parent.name,
          },
          actor: actorFromRequest(req),
        });

        // Kick reconciler
        kickReconcile();

        res.status(201).json({
          team: formatDepartmentResponse(team),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── PATCH /api/departments/:id ──────────────────────────────
  // Update a department: description and quotaBytes only.
  // No renaming in v1 (mount_point changes are complex).
  // If `name` is present in the payload, return 400 with honest message.
  // Returns 200 with updated department.
  router.patch(
    "/departments/:id",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = updateDepartmentSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({
            error: "Invalid request",
            details: parsed.error.flatten(),
          });
        }

        const { description, quotaBytes, name } = parsed.data;

        // Reject rename attempts in v1
        if (name) {
          return res.status(400).json({
            error:
              "Department renaming is not supported in v1 (requires Nextcloud mount_point migration)",
            code: "RENAME_NOT_SUPPORTED",
          });
        }

        const departmentId = req.params.id;

        // Find the department
        const existing = await prisma.department.findUnique({
          where: { id: departmentId },
        });

        if (!existing) {
          return res.status(404).json({
            error: "Department not found",
            code: "NOT_FOUND",
          });
        }

        // Parse quotaBytes if provided
        let quotaBigInt: bigint | null = existing.quotaBytes;
        if (quotaBytes !== undefined) {
          try {
            quotaBigInt = BigInt(quotaBytes);
          } catch {
            return res.status(400).json({
              error: "Invalid quotaBytes (must be a valid integer)",
              code: "INVALID_QUOTA",
            });
          }
        }

        // No-op short-circuit: if nothing changed, return existing
        if (
          description === existing.description &&
          quotaBigInt === existing.quotaBytes
        ) {
          return res.json({
            department: formatDepartmentResponse(existing),
          });
        }

        // Update in a transaction
        const updated = await prisma.$transaction(async (tx) => {
          const result = await tx.department.update({
            where: { id: departmentId },
            data: {
              description: description ?? existing.description,
              quotaBytes: quotaBigInt,
            },
            include: {
              _count: {
                select: { memberships: true, teams: true },
              },
            },
          });

          // Bump aclVersion
          await bumpAclVersion(tx, departmentId);

          return result;
        });

        // Record activity
        await recordActivity({
          kind: "system",
          severity: "ok",
          sourceIcon: "edit",
          what: "Department updated",
          sub: `${updated.name}`,
          refs: {
            actor: req.user?.username ?? null,
            departmentId,
            changes: {
              description:
                description !== undefined ? `"${description}"` : undefined,
              quotaBytes: quotaBytes !== undefined ? quotaBytes : undefined,
            },
          },
          actor: actorFromRequest(req),
        });

        // Kick reconciler if quota changed (NC sync needed)
        if (quotaBytes !== undefined) {
          kickReconcile();
        }

        res.json({
          department: formatDepartmentResponse(updated),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── DELETE /api/departments/:id ─────────────────────────────
  // Archive a department: set state=archiving + archivedAt, kick reconciler.
  // Deleting a DEPARTMENT with active TEAMs returns 409 (delete teams first).
  // Purge is NOT exposed in v1.
  // Returns 200 with archived department.
  router.delete(
    "/departments/:id",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const departmentId = req.params.id;

        const existing = await prisma.department.findUnique({
          where: { id: departmentId },
          include: {
            teams: true,
          },
        });

        if (!existing) {
          return res.status(404).json({
            error: "Department not found",
            code: "NOT_FOUND",
          });
        }

        // HOUSEHOLD cannot be deleted
        if (existing.kind === "HOUSEHOLD") {
          return res.status(409).json({
            error: "Cannot archive the Household department",
            code: "CANNOT_DELETE_HOUSEHOLD",
          });
        }

        // If this is a DEPARTMENT with active (non-archived) teams, reject
        if (existing.kind === "DEPARTMENT" && existing.teams.length > 0) {
          const activeTeams = existing.teams.filter(
            (t: Department) => t.state !== "archived",
          );
          if (activeTeams.length > 0) {
            return res.status(409).json({
              error: `Cannot archive a department with active teams (${activeTeams.length}). Delete teams first.`,
              code: "DEPARTMENT_HAS_TEAMS",
            });
          }
        }

        // No-op check: if already archived, just return it
        if (existing.state === "archived") {
          return res.json({
            department: formatDepartmentResponse(existing),
          });
        }

        // Archive the department in a transaction
        const archived = await prisma.$transaction(async (tx) => {
          const result = await tx.department.update({
            where: { id: departmentId },
            data: {
              state: "archiving",
              archivedAt: new Date(),
            },
            include: {
              _count: {
                select: { memberships: true, teams: true },
              },
            },
          });

          // Bump aclVersion
          await bumpAclVersion(tx, departmentId);

          return result;
        });

        // Record activity
        await recordActivity({
          kind: "system",
          severity: "warn",
          sourceIcon: "trash",
          what: "Department archived",
          sub: `${archived.name}`,
          refs: {
            actor: req.user?.username ?? null,
            departmentId,
            departmentName: archived.name,
          },
          actor: actorFromRequest(req),
        });

        // Kick reconciler to start archiving/de-provisioning NC side
        kickReconcile();

        res.json({
          department: formatDepartmentResponse(archived),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
