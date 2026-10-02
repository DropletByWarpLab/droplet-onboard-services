/**
 * WARP-2981 (ADR-059 §6.1, §7.1, DS-003) — `/api/me/active-department`, the
 * department a person's shell is arranged around, on every device.
 *
 *   P6-1  GET /me/active-department   → {scope, department: View | null}
 *   P6-2  PUT /me/active-department   {departmentId: uuid | null} → same
 *
 * `scope` is explicit: `unset` (never chosen, on any device), `whole_business`
 * or `department`, and `department` is the View exactly when it is
 * `department`. View = {id, slug, name, profile: {template, icon} | null}.
 * Whole business is what the shell shows for both `unset` and
 * `whole_business` (DS-014); only a chosen scope replaces a choice a browser
 * kept from before P6. PUT null chooses Whole business.
 *
 * The choice is the CALLER's own and nobody else's: both routes key on
 * `req.user.id` and the strict body names no person. Service principals have
 * no shell to arrange and are refused before anything is read (403
 * HUMAN_ONLY). A department the caller may not choose — missing, not theirs,
 * archived, archiving, a TEAM, the HOUSEHOLD — is one 404
 * DEPARTMENT_NOT_AVAILABLE body in every case, so the route never confirms a
 * department exists. GET re-checks a stored department and answers
 * `whole_business` when it no longer holds, without writing.
 *
 * Behind authMiddleware (core, not module-gated: every person has a shell).
 * Errors are `{error: {code, message}}`. Nothing is audited — a display
 * preference, like CameraPin (spec §3, D4).
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import {
  chooseActiveDepartment,
  readActiveDepartment,
  type ChoiceViewer,
} from "../services/department-choice.js";

type ErrorCode = "VALIDATION_ERROR" | "HUMAN_ONLY" | "DEPARTMENT_NOT_AVAILABLE";

function fail(res: Response, status: number, code: ErrorCode, message: string): void {
  res.status(status).json({ error: { code, message } });
}

const putBodySchema = z.object({ departmentId: z.string().uuid().nullable() }).strict();

/**
 * The person asking, or null once a refusal has been sent. authMiddleware
 * guarantees `req.user` here; its absence is an invariant break, not a
 * default (ORCH-007 fail-open).
 */
function personOf(req: Request, res: Response): ChoiceViewer | null {
  const user = req.user;
  if (!user) throw new Error("authenticated user required");
  if (user.role === "service") {
    fail(res, 403, "HUMAN_ONLY", "Only a person has a department to show.");
    return null;
  }
  return { id: user.id, role: user.role };
}

export function createMeDepartmentRouter(prisma: PrismaClient): Router {
  const router = Router();

  // P6-1
  router.get("/me/active-department", async (req, res, next) => {
    try {
      const viewer = personOf(req, res);
      if (!viewer) return;
      res.json(await readActiveDepartment(prisma, viewer));
    } catch (err) {
      next(err);
    }
  });

  // P6-2
  router.put("/me/active-department", async (req, res, next) => {
    try {
      const viewer = personOf(req, res);
      if (!viewer) return;
      const body = putBodySchema.safeParse(req.body);
      if (!body.success) {
        fail(res, 400, "VALIDATION_ERROR", "`departmentId` must be a department's id, or null for Whole business.");
        return;
      }
      const out = await chooseActiveDepartment(prisma, viewer, body.data.departmentId);
      if (!out.ok) {
        // Missing, not theirs, archived, a TEAM or the HOUSEHOLD: one body.
        fail(res, 404, "DEPARTMENT_NOT_AVAILABLE", "That department isn't available to choose.");
        return;
      }
      res.json(out.answer);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
