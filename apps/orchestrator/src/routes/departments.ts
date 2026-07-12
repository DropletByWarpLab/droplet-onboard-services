/**
 * WARP-1258 (T6) — departments CRUD routes.
 *
 * Implements the department/team lifecycle API per ADR-029 §4:
 *   GET    /api/departments              — list departments/teams, scoped + myRight (any authenticated role)
 *   GET    /api/departments/:id          — detail: row + member roster + child teams + usedBytes
 *   POST   /api/departments              — create department (owner+admin)
 *   POST   /api/departments/:id/teams    — create team under department (owner+admin)
 *   PATCH  /api/departments/:id          — update department (owner+admin)
 *   DELETE /api/departments/:id          — archive department (owner+admin)
 *   POST   /api/departments/:id/restore  — restore an archived department (owner+admin, WARP-1270)
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
import { kickReconcile } from "../services/department-reconciler.service.js";
import { bumpAclVersion } from "../services/department-tx.js";
import {
  departmentManagerOrAdmin,
  addMembership,
  updateMembershipRight,
  removeMembership,
  UserNotFoundError,
  DepartmentNotFoundError,
  DuplicateMembershipError,
  MembershipNotFoundError,
  LastManagerError,
} from "../services/department-membership.service.js";
import {
  gfListFolders,
  type GroupfolderInfo,
} from "../services/nextcloud-groups.client.js";
import { adminBasicToken } from "../services/department-provisioner.service.js";
import { config } from "../config.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("departments-route");

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

// Reserved names that cannot be used as department/team names or slugs.
//
// The reserved-name check (in the POST handlers) compares BOTH
// `name.toLowerCase()` and the lowercase-dash `slug` against this set, so the
// configured shared-folder name must be inserted in the SAME normalized forms —
// its lowercased display name AND its slug — not the raw verbatim string.
// Otherwise a non-default, mixed-case/multi-word DROPLET_SHARED_FOLDER_NAME
// (e.g. "Family Drive") would be stored verbatim while the check produces
// "family drive"/"family-drive", never match, and let a department collide with
// the real shared folder's Nextcloud groupfolder/mount point.
//
// Read the value once, defensively. In production zod defaults
// DROPLET_SHARED_FOLDER_NAME to "Household" (config.ts) so it is always a
// non-empty string; this `?? "Household"` only guards the case where a partial
// config object omits the field entirely (e.g. a test's `vi.mock("../config.js")`
// that transitively loads this router) so module evaluation can't crash on
// `undefined.toLowerCase()`. For the real, always-defined production value the
// behavior is identical to WARP-1258 — the configured name's lowercased display
// form and its slug are both reserved. (WARP-1292)
const sharedFolderName = config.DROPLET_SHARED_FOLDER_NAME ?? "Household";
const RESERVED_NAMES = new Set([
  sharedFolderName.toLowerCase(),
  nameToSlug(sharedFolderName),
  "household",
  "admin",
  "system",
]);

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

const departmentRightSchema = z.enum(["reader", "contributor", "manager"]);

const addMemberSchema = z.object({
  userId: z.string().uuid(),
  right: departmentRightSchema,
});

const updateMemberSchema = z.object({
  right: departmentRightSchema,
});

/**
 * Format a DepartmentMembership row for API response.
 */
function formatMembershipResponse(m: {
  id: string;
  departmentId: string;
  userId: string;
  right: string;
  syncState: string;
  ncPermissionMask?: number | null;
}) {
  return {
    id: m.id,
    departmentId: m.departmentId,
    userId: m.userId,
    right: m.right,
    syncState: m.syncState,
    ncPermissionMask: m.ncPermissionMask ?? null,
  };
}

/**
 * Helper to format a Department row for API response.
 * BigInt fields are encoded as strings per the schema.
 *
 * `myRight` (WARP-1270, T18) — the CALLER's own membership right on this
 * row, or null if they hold none. Populated by the list/detail routes from
 * a batch membership lookup; used by the dashboard to (a) decide whether a
 * non-admin manager may see/manage a unit at all (manager-delegation view,
 * design brief §3) and (b) render the caller's own rights chip. Never
 * derived from role — a plain owner/admin has `myRight: null` unless they
 * also hold an explicit membership row (admin see-all is a separate,
 * loud, audited path, not a membership fabrication).
 */
function formatDepartmentResponse(
  dept: Department & { _count?: { teams?: number; memberships?: number } },
  myRight: string | null = null,
  usedBytes: string | null = null,
) {
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
    myRight,
    usedBytes,
  };
}

export function createDepartmentsRouter(prisma: PrismaClient): Router {
  const router = Router();

  // ── GET /api/departments ────────────────────────────────────
  // List departments and teams. Any authenticated role.
  // Returns {id, name, slug, kind, parentId, state, quotaBytes, memberCount, teamCount, myRight}.
  // BigInt fields are string-encoded.
  //
  // WARP-1270 (T18) scoping, layered on top of the T6-shipped shape:
  //   - owner/admin: EVERY department/team, every state (including
  //     archived) — admin see-all (ADR-029 §3.5) needs the archived rows
  //     too so the Departments tab can render the Archive chip + Restore.
  //   - everyone else: only units they hold a membership row in (the
  //     manager-delegation view, brief §3 — "sees ONLY their unit's
  //     panel"), archived rows hidden (nothing to manage once archived).
  // `myRight` is populated for every caller from one batch membership
  // query — used by the dashboard to gate the manager-delegation view and
  // render the caller's own rights chip; never derived from role.
  router.get(
    "/departments",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const isAdminTier = req.user?.role === "owner" || req.user?.role === "admin";

        const ownMemberships = req.user
          ? await prisma.departmentMembership.findMany({
              where: { userId: req.user.id },
              select: { departmentId: true, right: true },
            })
          : [];
        const myRightById = new Map(ownMemberships.map((m) => [m.departmentId, m.right]));

        const departments = await prisma.department.findMany({
          where: isAdminTier
            ? {}
            : {
                state: { not: "archived" },
                id: { in: [...myRightById.keys()] },
              },
          include: {
            _count: {
              select: { memberships: true, teams: true },
            },
          },
        });

        // Best-effort usedBytes for the card quota meters — one NC call for
        // the whole list (mirrors admin-files.ts's sizing), never fabricated
        // on failure. Skipped entirely when nothing has a discovered
        // groupfolder yet (avoids a pointless NC round-trip on an empty list).
        let foldersById = new Map<number, GroupfolderInfo>();
        if (departments.some((d) => d.ncGroupfolderId !== null)) {
          try {
            const folders = await gfListFolders(adminBasicToken());
            foldersById = new Map(folders.map((f) => [f.id, f]));
          } catch (err) {
            logger.warn({ err }, "GET /departments: could not read groupfolder sizes");
          }
        }

        res.json({
          departments: departments.map((d) => {
            const gf = d.ncGroupfolderId !== null ? foldersById.get(d.ncGroupfolderId) : undefined;
            return formatDepartmentResponse(
              d,
              myRightById.get(d.id) ?? null,
              gf ? String(gf.size) : null,
            );
          }),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── GET /api/departments/:id ─────────────────────────────────
  // Detail for one department/team: the row itself, its member roster
  // (id, displayName, right, syncState — no email; the member table
  // (brief §3) doesn't need it and the column is encrypted-at-rest), its
  // child teams (summary only, for a DEPARTMENT), and a best-effort
  // `usedBytes` read from the discovered NC groupfolder (mirrors the
  // admin usage-roster sizing in admin-files.ts — "—" via null on any
  // read failure, never a fabricated 0).
  //
  // Authz: owner/admin see any unit (admin see-all). Everyone else must
  // hold a membership row on THIS unit, or — for a TEAM — on its parent
  // DEPARTMENT (inherited-manager rule extends to read access here too;
  // a parent manager needs to see the child team's roster to manage it).
  router.get(
    "/departments/:id",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!req.user) {
          return res.status(401).json({ error: "Authentication required" });
        }

        const departmentId = req.params.id;
        const dept = await prisma.department.findUnique({
          where: { id: departmentId },
          include: {
            _count: { select: { memberships: true, teams: true } },
            teams: {
              include: { _count: { select: { memberships: true, teams: true } } },
            },
          },
        });
        if (!dept) {
          return res.status(404).json({ error: "Department not found", code: "NOT_FOUND" });
        }

        const isAdminTier = req.user.role === "owner" || req.user.role === "admin";
        let authorized = isAdminTier;
        let ownMembership = await prisma.departmentMembership.findUnique({
          where: { departmentId_userId: { departmentId, userId: req.user.id } },
          select: { right: true },
        });
        if (!authorized && ownMembership) authorized = true;
        if (!authorized && dept.parentId) {
          const parentMembership = await prisma.departmentMembership.findUnique({
            where: { departmentId_userId: { departmentId: dept.parentId, userId: req.user.id } },
            select: { right: true },
          });
          if (parentMembership) authorized = true;
        }
        if (!authorized) {
          return res.status(403).json({
            error: "Forbidden: not a member of this department",
            code: "NOT_A_MEMBER",
          });
        }

        const memberships = await prisma.departmentMembership.findMany({
          where: { departmentId },
          include: { user: { select: { id: true, displayName: true, username: true } } },
          orderBy: { grantedAt: "asc" },
        });

        let usedBytes: string | null = null;
        if (dept.ncGroupfolderId !== null) {
          try {
            const folders = await gfListFolders(adminBasicToken());
            const gf = folders.find((f: GroupfolderInfo) => f.id === dept.ncGroupfolderId);
            if (gf) usedBytes = String(gf.size);
          } catch (err) {
            logger.warn({ err, departmentId }, "GET /departments/:id: could not read groupfolder size");
          }
        }

        res.json({
          department: formatDepartmentResponse(dept, ownMembership?.right ?? null),
          usedBytes,
          members: memberships.map((m) => ({
            userId: m.userId,
            displayName: m.user.displayName || m.user.username,
            right: m.right,
            syncState: m.syncState,
          })),
          teams: dept.teams.map((t) => formatDepartmentResponse(t)),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── POST /api/departments/:id/restore ───────────────────────
  // Restore an archived (or archiving) department/team back to the
  // provisioning lifecycle. owner + admin only. Sets state to `pending`
  // so the reconciler re-provisions the NC side (group + groupfolder +
  // masks + quota) exactly like a fresh create — the department's row and
  // its existing DepartmentMembership rows (never deleted by archive) are
  // the desired state the reconciler converges NC toward. Copy on the
  // caller side: "Members regain access with the rights they had before
  // it was archived."
  router.post(
    "/departments/:id/restore",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const departmentId = req.params.id;
        const existing = await prisma.department.findUnique({ where: { id: departmentId } });
        if (!existing) {
          return res.status(404).json({ error: "Department not found", code: "NOT_FOUND" });
        }
        if (existing.state !== "archived" && existing.state !== "archiving") {
          return res.status(400).json({
            error: `Only an archived department can be restored (current state: ${existing.state})`,
            code: "NOT_ARCHIVED",
          });
        }

        const restored = await prisma.$transaction(async (tx) => {
          const result = await tx.department.update({
            where: { id: departmentId },
            data: { state: "pending", archivedAt: null },
            include: { _count: { select: { memberships: true, teams: true } } },
          });
          await bumpAclVersion(tx, departmentId);
          return result;
        });

        await recordActivity({
          kind: "system",
          severity: "ok",
          sourceIcon: "folder-plus",
          what: "Department restored",
          sub: `${restored.name}`,
          refs: {
            actor: req.user?.username ?? null,
            departmentId,
            departmentName: restored.name,
          },
          actor: actorFromRequest(req),
        });

        kickReconcile();

        res.json({ department: formatDepartmentResponse(restored) });
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
            (f: GroupfolderInfo) => f.mountPoint === name,
          );
          if (existingMount) {
            ncWarning = `Nextcloud groupfolder with mount point "${name}" already exists (will be reused)`;
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

  // ── POST /api/departments/:id/members ───────────────────────
  // Add a member to a department (or team). Authorized for owner/admin
  // OR a `manager` of the department itself OR its PARENT department
  // (inherited-manager rule, ADR-029 2026-07-11 amendment). Any other
  // authenticated caller (including a plain department member) is 403.
  router.post(
    "/departments/:id/members",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!req.user) {
          return res.status(401).json({ error: "Authentication required" });
        }

        const departmentId = req.params.id;
        const authorized = await departmentManagerOrAdmin(
          prisma,
          departmentId,
          req.user,
        );
        if (!authorized) {
          return res.status(403).json({
            error: "Forbidden: requires owner/admin or manager of this department",
            code: "NOT_DEPARTMENT_MANAGER",
          });
        }

        const parsed = addMemberSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({
            error: "Invalid request",
            details: parsed.error.flatten(),
          });
        }

        const { userId, right } = parsed.data;

        let membership;
        try {
          membership = await addMembership(
            prisma,
            departmentId,
            userId,
            right,
            req.user.id,
          );
        } catch (err) {
          if (err instanceof UserNotFoundError) {
            return res.status(404).json({ error: err.message, code: "USER_NOT_FOUND" });
          }
          if (err instanceof DepartmentNotFoundError) {
            return res.status(404).json({ error: err.message, code: "NOT_FOUND" });
          }
          if (err instanceof DuplicateMembershipError) {
            return res.status(409).json({ error: err.message, code: "DUPLICATE_MEMBERSHIP" });
          }
          throw err;
        }

        await recordActivity({
          kind: "system",
          severity: "ok",
          sourceIcon: "user-plus",
          what: "Department member added",
          sub: `${userId} · ${right}`,
          refs: {
            actor: req.user.username ?? null,
            departmentId,
            targetUserId: userId,
            right,
          },
          actor: actorFromRequest(req),
        });

        res.status(201).json({ membership: formatMembershipResponse(membership) });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── PATCH /api/departments/:id/members/:userId ──────────────
  // Change a member's right. Same authz as POST /members.
  // reader<->contributor/manager transitions push an ordered NC group
  // change (upgrade: add-then-remove; downgrade: remove-then-add);
  // contributor<->manager is policy-only (no NC call).
  // WARP-1263 (T11): HOUSEHOLD departments reject right changes with 400
  // (post-GA convergence D-5, membership rights on the household are
  // immutable — role-driven at seed time and backfilled on membership add).
  router.patch(
    "/departments/:id/members/:userId",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!req.user) {
          return res.status(401).json({ error: "Authentication required" });
        }

        const departmentId = req.params.id;
        const targetUserId = req.params.userId;

        const authorized = await departmentManagerOrAdmin(
          prisma,
          departmentId,
          req.user,
        );
        if (!authorized) {
          return res.status(403).json({
            error: "Forbidden: requires owner/admin or manager of this department",
            code: "NOT_DEPARTMENT_MANAGER",
          });
        }

        // WARP-1263: HOUSEHOLD department right changes are immutable
        const dept = await prisma.department.findUnique({
          where: { id: departmentId },
        });
        if (dept?.kind === "HOUSEHOLD") {
          return res.status(400).json({
            error: "Cannot change member rights for the Household department (rights are role-driven)",
            code: "HOUSEHOLD_RIGHTS_IMMUTABLE",
          });
        }

        const parsed = updateMemberSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({
            error: "Invalid request",
            details: parsed.error.flatten(),
          });
        }

        let membership;
        try {
          membership = await updateMembershipRight(
            prisma,
            departmentId,
            targetUserId,
            parsed.data.right,
          );
        } catch (err) {
          if (err instanceof DepartmentNotFoundError) {
            return res.status(404).json({ error: err.message, code: "NOT_FOUND" });
          }
          if (err instanceof MembershipNotFoundError) {
            return res.status(404).json({ error: err.message, code: "MEMBERSHIP_NOT_FOUND" });
          }
          if (err instanceof LastManagerError) {
            return res.status(409).json({
              error: err.message,
              code: "LAST_MANAGER_INVARIANT",
            });
          }
          throw err;
        }

        await recordActivity({
          kind: "system",
          severity: "ok",
          sourceIcon: "user-cog",
          what: "Department member right changed",
          sub: `${targetUserId} → ${parsed.data.right}`,
          refs: {
            actor: req.user.username ?? null,
            departmentId,
            targetUserId,
            right: parsed.data.right,
          },
          actor: actorFromRequest(req),
        });

        res.json({ membership: formatMembershipResponse(membership) });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── DELETE /api/departments/:id/members/:userId ─────────────
  // Remove a member. Same authz as POST /members. Removing the last
  // `manager` of a department (self-removal or otherwise) returns 409 —
  // mirrors the WARP-480 last-owner invariant in routes/people.ts.
  router.delete(
    "/departments/:id/members/:userId",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!req.user) {
          return res.status(401).json({ error: "Authentication required" });
        }

        const departmentId = req.params.id;
        const targetUserId = req.params.userId;

        const authorized = await departmentManagerOrAdmin(
          prisma,
          departmentId,
          req.user,
        );
        if (!authorized) {
          return res.status(403).json({
            error: "Forbidden: requires owner/admin or manager of this department",
            code: "NOT_DEPARTMENT_MANAGER",
          });
        }

        try {
          await removeMembership(prisma, departmentId, targetUserId);
        } catch (err) {
          if (err instanceof DepartmentNotFoundError) {
            return res.status(404).json({ error: err.message, code: "NOT_FOUND" });
          }
          if (err instanceof MembershipNotFoundError) {
            return res.status(404).json({ error: err.message, code: "MEMBERSHIP_NOT_FOUND" });
          }
          if (err instanceof LastManagerError) {
            return res.status(409).json({
              error: err.message,
              code: "LAST_MANAGER_INVARIANT",
            });
          }
          throw err;
        }

        await recordActivity({
          kind: "system",
          severity: "warn",
          sourceIcon: "user-minus",
          what: "Department member removed",
          sub: targetUserId,
          refs: {
            actor: req.user.username ?? null,
            departmentId,
            targetUserId,
          },
          actor: actorFromRequest(req),
        });

        res.status(204).send();
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
