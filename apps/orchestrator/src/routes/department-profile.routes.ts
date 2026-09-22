/**
 * WARP-2976 (ADR-059 P1) — a department's dashboard arrangement.
 *
 *   GET /api/departments/:id/profile — the profile (a TEAM reads its parent's)
 *                                      plus whether the caller may edit it
 *   PUT /api/departments/:id/profile — set it up / change it (owner, admin, or
 *                                      a manager of that department)
 *
 * A profile SHOWS, it never GRANTS. It says which destinations the department
 * switcher arranges for this department and which widgets its /d/<slug> home
 * carries. The dashboard intersects `navHrefs` with the viewer's existing
 * role / capability / module gates, and ADR-032 + CameraAccessGrant still
 * decide every route — so nothing written here can widen what anyone reaches.
 * That is also why validation is SHAPE-only: the nav definition lives in the
 * dashboard (components/nav-config.ts), an href it does not know renders
 * nothing, and an unknown widget id is skipped. Mirroring that list here
 * would be a second copy to drift.
 *
 * Only DEPARTMENT rows carry a profile. A TEAM reads its parent's (one level,
 * the ADR-029 nesting), and HOUSEHOLD has none — a household box has one
 * department and so no switcher (ADR-059 DS-012). A missing row is the
 * explicit "not set up" state; nothing infers a template from a name.
 *
 * Mounted from createDepartmentsRouter so it shares that router's mount point
 * and auth; `/departments/:id/profile` cannot collide with `/departments/:id`
 * (Express matches the whole path).
 */

import type { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { PrismaClient, DepartmentProfile } from "@prisma/client";
import { recordActivity } from "../services/activity.singleton.js";
import { actorFromRequest } from "../services/activity.service.js";
import { departmentManagerOrAdmin } from "../services/department-membership.service.js";

export const DEPARTMENT_TEMPLATES = [
  "security",
  "sales",
  "finance",
  "operations",
  "front_desk",
  "it",
  "custom",
] as const;

/** Ceilings are generous for a sidebar and a home board, and exist so a
 *  malformed client cannot park an unbounded array in a row every nav render
 *  reads. */
export const MAX_NAV_HREFS = 40;
export const MAX_HOME_WIDGETS = 24;

// "/" or lowercase-dash segments joined by single slashes — so no query, no
// fragment, no scheme, and no protocol-relative "//host" (which a Link would
// treat as another origin).
const hrefSchema = z
  .string()
  .max(80)
  .regex(/^\/(?:[a-z0-9-]+(?:\/[a-z0-9-]+)*)?$/, "must be a dashboard path");

export const departmentProfileBodySchema = z
  .object({
    template: z.enum(DEPARTMENT_TEMPLATES),
    icon: z.string().regex(/^[a-z0-9-]{1,40}$/, "must be a lucide icon name"),
    navHrefs: z
      .array(hrefSchema)
      .max(MAX_NAV_HREFS)
      .refine((hrefs) => new Set(hrefs).size === hrefs.length, "hrefs must be unique"),
    homeWidgets: z
      .array(
        z
          .object({
            widget: z.string().regex(/^[a-z0-9_-]{1,40}$/),
            size: z.enum(["s", "m", "l"]),
          })
          .strict(),
      )
      .max(MAX_HOME_WIDGETS),
  })
  .strict();

export type DepartmentProfileBody = z.infer<typeof departmentProfileBodySchema>;

export function formatDepartmentProfile(p: DepartmentProfile) {
  return {
    departmentId: p.departmentId,
    template: p.template,
    icon: p.icon,
    navHrefs: p.navHrefs,
    homeWidgets: p.homeWidgets,
    updatedBy: p.updatedBy,
    updatedAt: p.updatedAt,
  };
}

const NO_PROFILE_STATES = new Set(["archived", "archiving"]);

/**
 * Read access mirrors GET /api/departments/:id exactly: owner/admin see any
 * unit, anyone else needs a membership row on it or — for a TEAM — on its
 * parent. Kept in step with that route on purpose; a profile is no more
 * private than the roster beside it.
 */
async function mayReadDepartment(
  prisma: PrismaClient,
  dept: { id: string; parentId: string | null },
  user: { id: string; role: string },
): Promise<boolean> {
  if (user.role === "owner" || user.role === "admin") return true;
  const own = await prisma.departmentMembership.findUnique({
    where: { departmentId_userId: { departmentId: dept.id, userId: user.id } },
    select: { right: true },
  });
  if (own) return true;
  if (!dept.parentId) return false;
  const parent = await prisma.departmentMembership.findUnique({
    where: { departmentId_userId: { departmentId: dept.parentId, userId: user.id } },
    select: { right: true },
  });
  return parent !== null;
}

export function mountDepartmentProfileRoutes(router: Router, prisma: PrismaClient): void {
  router.get(
    "/departments/:id/profile",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!req.user) {
          return res.status(401).json({ error: "Authentication required" });
        }
        const dept = await prisma.department.findUnique({
          where: { id: req.params.id },
          select: { id: true, kind: true, parentId: true, state: true },
        });
        if (!dept) {
          return res.status(404).json({ error: "Department not found", code: "NOT_FOUND" });
        }
        if (!(await mayReadDepartment(prisma, dept, req.user))) {
          return res.status(403).json({
            error: "Forbidden: not a member of this department",
            code: "NOT_A_MEMBER",
          });
        }

        const sourceId = dept.kind === "TEAM" && dept.parentId ? dept.parentId : dept.id;
        const profile =
          dept.kind === "HOUSEHOLD"
            ? null
            : await prisma.departmentProfile.findUnique({ where: { departmentId: sourceId } });
        const canEdit =
          dept.kind === "DEPARTMENT" &&
          !NO_PROFILE_STATES.has(dept.state) &&
          (await departmentManagerOrAdmin(prisma, dept.id, req.user));

        res.json({
          profile: profile ? formatDepartmentProfile(profile) : null,
          inheritedFrom: sourceId !== dept.id ? sourceId : null,
          canEdit,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  router.put(
    "/departments/:id/profile",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!req.user) {
          return res.status(401).json({ error: "Authentication required" });
        }
        const parsed = departmentProfileBodySchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({
            error: "Invalid department profile",
            code: "VALIDATION_ERROR",
            issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
          });
        }

        const departmentId = req.params.id;
        const dept = await prisma.department.findUnique({
          where: { id: departmentId },
          select: { id: true, name: true, kind: true, state: true },
        });
        if (!dept) {
          return res.status(404).json({ error: "Department not found", code: "NOT_FOUND" });
        }
        // Authorise before describing the row any further: a caller who may
        // not edit it learns nothing about its kind or state from the error.
        if (!(await departmentManagerOrAdmin(prisma, departmentId, req.user))) {
          return res.status(403).json({
            error: "Only an owner, an admin or this department's manager can change how it is arranged",
            code: "FORBIDDEN",
          });
        }
        if (dept.kind === "TEAM") {
          return res.status(400).json({
            error: "A team uses its department's arrangement",
            code: "TEAM_INHERITS_PROFILE",
          });
        }
        if (dept.kind === "HOUSEHOLD") {
          return res.status(400).json({
            error: "The household has no department arrangement",
            code: "HOUSEHOLD_HAS_NO_PROFILE",
          });
        }
        if (NO_PROFILE_STATES.has(dept.state)) {
          return res.status(409).json({
            error: "Restore the department before arranging it",
            code: "ARCHIVED",
          });
        }

        const body = parsed.data;
        const existing = await prisma.departmentProfile.findUnique({
          where: { departmentId },
          select: { departmentId: true },
        });
        const data = {
          template: body.template,
          icon: body.icon,
          navHrefs: body.navHrefs,
          homeWidgets: body.homeWidgets,
          updatedBy: req.user.id,
        };
        const profile = await prisma.departmentProfile.upsert({
          where: { departmentId },
          create: { departmentId, ...data },
          update: data,
        });

        await recordActivity({
          kind: "system",
          severity: "ok",
          sourceIcon: "layout-dashboard",
          what: existing ? "Department arrangement updated" : "Department set up",
          sub: `${dept.name} (${body.template})`,
          refs: {
            actor: req.user.username ?? null,
            departmentId,
            departmentName: dept.name,
            template: body.template,
            navHrefCount: body.navHrefs.length,
            homeWidgetCount: body.homeWidgets.length,
          },
          actor: actorFromRequest(req),
        });

        res.json({ profile: formatDepartmentProfile(profile) });
      } catch (err) {
        next(err);
      }
    },
  );
}
