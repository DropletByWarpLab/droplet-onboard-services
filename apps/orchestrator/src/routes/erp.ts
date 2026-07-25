/**
 * WARP-1137 — the ERP data + write-request API (brief §13).
 *
 *   GET  /api/erp/schedule?date=YYYY-MM-DD   Today's (or a day's) schedule.
 *   GET  /api/erp/patients?query=…           Patient search (name prefix).
 *   GET  /api/erp/patient/:id                One patient summary.
 *   GET  /api/erp/ar-summary                 Accounts-receivable totals.
 *   GET  /api/erp/recall-due                 Recall/recare due list.
 *   POST /api/erp/write-requests             Stage a write (outbox).
 *   GET  /api/erp/write-requests/:id         Read a write request's status.
 *   POST /api/erp/write-requests/:id/confirm Human-confirm → apply.
 *
 * All PHI: reads gated to owner/admin/family; writes to owner/admin. In this
 * DB-independent slice the connector is stubbed, so reads return honest
 * not-connected/empty and a confirmed write records FAILED (never fake APPLIED).
 * The service audits every read + write transition; this layer maps ErpError to
 * its HTTP status.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { requireRole } from "../middleware/auth.js";
import { createErpService, type ErpUser } from "../services/erp.service.js";
import { ErpError } from "../services/erp-error.js";

type AuthedRequest = { user?: { id?: string; role?: string } };

function erpUser(req: Request): ErpUser {
  const u = (req as AuthedRequest).user;
  return { id: u?.id ?? "unknown", role: u?.role ?? "guest" };
}

function handleErpError(res: Response, err: unknown): boolean {
  if (err instanceof ErpError) {
    res.status(err.status).json(err.toJSON());
    return true;
  }
  return false;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A syntactically-valid ISO date that is ALSO a real calendar date. Rejects
 *  2026-13-45 (which would make scheduleDayBounds throw a 500) and 2026-02-30
 *  (which would silently roll over to March). */
function isRealIsoDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

const writeRequestSchema = z.object({
  command: z.string().min(1),
  params: z.record(z.string(), z.unknown()).default({}),
});

export function createErpRouter(prisma: PrismaClient): Router {
  const router = Router();
  const svc = createErpService(prisma);
  const canRead = requireRole("owner", "admin");
  const canWrite = requireRole("owner", "admin");

  router.get("/erp/schedule", canRead, async (req, res, next) => {
    try {
      const q = req.query.date;
      const date = typeof q === "string" && isRealIsoDate(q) ? q : todayIso();
      res.json(await svc.getSchedule({ date }, erpUser(req)));
    } catch (err) {
      if (!handleErpError(res, err)) next(err);
    }
  });

  router.get("/erp/patients", canRead, async (req, res, next) => {
    try {
      const query = typeof req.query.query === "string" ? req.query.query : "";
      res.json(await svc.searchPatients({ query }, erpUser(req)));
    } catch (err) {
      if (!handleErpError(res, err)) next(err);
    }
  });

  router.get("/erp/patient/:id", canRead, async (req, res, next) => {
    try {
      res.json(await svc.getPatient(req.params.id, erpUser(req)));
    } catch (err) {
      if (!handleErpError(res, err)) next(err);
    }
  });

  router.get("/erp/ar-summary", canRead, async (req, res, next) => {
    try {
      res.json(await svc.getArSummary(erpUser(req)));
    } catch (err) {
      if (!handleErpError(res, err)) next(err);
    }
  });

  router.get("/erp/recall-due", canRead, async (req, res, next) => {
    try {
      res.json(await svc.getRecallDue(erpUser(req)));
    } catch (err) {
      if (!handleErpError(res, err)) next(err);
    }
  });

  router.post("/erp/write-requests", canWrite, async (req, res, next) => {
    try {
      const parsed = writeRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res
          .status(400)
          .json({ error: "Invalid write request", details: parsed.error.flatten() });
        return;
      }
      res.status(201).json(await svc.createWriteRequest(parsed.data, erpUser(req)));
    } catch (err) {
      if (!handleErpError(res, err)) next(err);
    }
  });

  router.get("/erp/write-requests/:id", canWrite, async (req, res, next) => {
    try {
      res.json(await svc.getWriteRequest(req.params.id, erpUser(req)));
    } catch (err) {
      if (!handleErpError(res, err)) next(err);
    }
  });

  router.post(
    "/erp/write-requests/:id/confirm",
    canWrite,
    async (req, res, next) => {
      try {
        res.json(await svc.confirmWriteRequest(req.params.id, erpUser(req)));
      } catch (err) {
        if (!handleErpError(res, err)) next(err);
      }
    },
  );

  return router;
}
