/**
 * WARP-3369 (Romain, 2026-09-30) — the per-record half of "assigning a work item
 * to an external guest shares that one item with them".
 *
 * `modules/guest-shares.ts` lets a guest's request past the `projects` tier
 * floor for five routes; these guards are what makes that safe. A guest passes
 * only when the work item (or, for the state list, a work item in that project)
 * is ASSIGNED TO THEM, and the refusal is the same 404 `module_disabled` the
 * floor answers, whether the record exists or not, so a guest learns nothing
 * about an id they were not given. Everyone who is not a guest passes straight
 * through: this narrows the guest tier and touches no one else.
 *
 * Each handler carries `GUEST_SHARE_GUARD`, readable off the function like the
 * feature-gate and role-guard markers, so a test can assert that every route a
 * guest can reach has one.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { recordAccessDenied } from "./auth.js";

export const GUEST_SHARE_GUARD = Symbol.for("droplet.guestShareGuard");

/** True when `fn` is a guest share guard produced by this module. */
export function isGuestShareGuard(fn: unknown): boolean {
  if (typeof fn !== "function") return false;
  return (fn as unknown as Record<symbol, unknown>)[GUEST_SHARE_GUARD] === true;
}

function mark(fn: RequestHandler): RequestHandler {
  Object.defineProperty(fn, GUEST_SHARE_GUARD, { value: true, enumerable: false, writable: false });
  return fn;
}

type SharedLookup = (prisma: PrismaClient, recordId: string, userId: string) => Promise<boolean>;

function guard(prisma: PrismaClient, lookup: SharedLookup): RequestHandler {
  return mark(async function guestShareGuard(req: Request, res: Response, next: NextFunction): Promise<void> {
    const user = req.user;
    if (!user || user.role !== "guest") {
      next();
      return;
    }
    try {
      if (await lookup(prisma, String(req.params.id ?? ""), user.id)) {
        next();
        return;
      }
    } catch (err) {
      next(err);
      return;
    }
    recordAccessDenied(req, "pm-record-not-shared");
    res.status(404).json({ error: "module_disabled", module: "projects" });
  });
}

/** The work item named by `:id` is assigned to the calling guest. */
export function guestAssignedWorkItem(prisma: PrismaClient): RequestHandler {
  return guard(prisma, async (db, workItemId, userId) => {
    if (!workItemId) return false;
    const row = await db.pmWorkItemAssignee.findFirst({
      where: { workItemId, userId },
      select: { id: true },
    });
    return row !== null && row !== undefined;
  });
}

/** The project named by `:id` holds at least one work item assigned to the calling guest. */
export function guestAssignedInProject(prisma: PrismaClient): RequestHandler {
  return guard(prisma, async (db, projectId, userId) => {
    if (!projectId) return false;
    const row = await db.pmWorkItemAssignee.findFirst({
      where: { userId, workItem: { projectId } },
      select: { id: true },
    });
    return row !== null && row !== undefined;
  });
}
