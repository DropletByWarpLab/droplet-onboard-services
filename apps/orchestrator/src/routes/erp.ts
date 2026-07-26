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
 * PHI floors (WARP-1530 / ADR-032 §8 decision O-2 — this replaced the flat
 * owner/admin gate this file shipped with, and settles the long-standing
 * header-says-family / code-says-owner-admin discrepancy in favour of the
 * header, gated THROUGH a grant):
 *
 *   reads  = family-and-up WITH an `AccessRoleConnectorGrant` for the
 *            provider. That is what makes a "Reception" role useful.
 *   writes = admin-tier only — UNCHANGED. `IntegrationConnection.writeEnabled`,
 *            the staged `ErpWriteRequest` outbox and the human confirm all
 *            still apply above it, untouched by any role grant.
 *
 * In this DB-independent slice the connector is stubbed, so reads return honest
 * not-connected/empty and a confirmed write records FAILED (never fake APPLIED).
 * The service audits every read + write transition; this layer maps ErpError to
 * its HTTP status.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { requireRole, recordAccessDenied } from "../middleware/auth.js";
import { createErpService, type ErpUser } from "../services/erp.service.js";
import { ErpError } from "../services/erp-error.js";
import { resolveEffectiveAccess } from "../services/effective-access.service.js";
import { EAGLESOFT_PROVIDER } from "../services/erp-provider.js";
import type { ConnectorLevel } from "../services/access-catalog.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("erp-routes");

type AuthedRequest = {
  user?: { id?: string; role?: string };
  /** Resolved by `erpConnectorReadGate` and threaded to the service. */
  erpConnectorLevel?: ConnectorLevel | null;
};

function erpUser(req: Request): ErpUser {
  const u = (req as AuthedRequest).user;
  return {
    id: u?.id ?? "unknown",
    role: u?.role ?? "guest",
    connectorLevel: (req as AuthedRequest).erpConnectorLevel ?? null,
  };
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
  params: z.record(z.unknown()).default({}),
});

/**
 * WARP-1530 (RBAC v2 T6) — the O-2 read gate.
 *
 * Layer 1 stays `requireRole`, exactly as this route registered it. TWO of
 * them, both real middleware, neither re-implemented here:
 *   `tierFloor`   — `requireRole("owner","admin","family")`, the O-2 read
 *                   floor, which refuses everyone below family up front;
 *   `todaysFloor` — `requireRole("owner","admin")`, the pre-O-2 gate, handed
 *                   the request whenever the widening does not reach the
 *                   caller so they see today's byte-for-byte 403 body and the
 *                   same `recordAccessDenied` audit row.
 * Layer 2 only ever runs on top of them, and only ever narrows or widens
 * within the tiers `tierFloor` already admitted.
 *
 * The decision, case by case:
 *
 *   owner              → through. §3: owner is the ONE tier that bypasses
 *                        layer 2. Never resolved, never narrowed.
 *   below family       → today's floor. Guests and service principals are
 *                        refused before any DB read.
 *   admin / family     → the resolver's `connectors[eaglesoft]` decides:
 *                        • present → through, and the level rides down to the
 *                          service as `ErpUser.connectorLevel`;
 *                        • absent + a connection IS configured → refused. For
 *                          family that is the unchanged answer; for an
 *                          Admin-BASED custom role it is the §3 narrowing
 *                          ("admins do not bypass layer 2").
 *                        • absent + NOTHING is configured → today's floor.
 *                          With no `IntegrationConnection` row the resolver
 *                          returns {} for EVERYONE, owner included, so
 *                          treating that as a denial would turn today's honest
 *                          `NOT_CONFIGURED` read into a 403 for every admin on
 *                          every box that has not connected an ERP yet. "There
 *                          is nothing to see" is not an authorization answer —
 *                          the service's honest empty result must win.
 *
 * A resolver failure falls back to today's floor: no reach is invented (family
 * does not get the widening), and none is lost (admins keep what they have).
 * The service's own assertion is the second line either way.
 */
function erpConnectorReadGate(prisma: PrismaClient) {
  // Layer 1, registered exactly as `requireRole` always is. The O-2 tier
  // floor (family-and-up) runs FIRST, so a guest / role-less session is
  // refused by the real middleware before any of this file's logic — same
  // body, same `recordAccessDenied` row, same order as every other route.
  const tierFloor = requireRole("owner", "admin", "family");
  // Today's floor — the pre-O-2 gate, kept verbatim so anyone this widening
  // does not reach still sees the byte-for-byte response they see today.
  const todaysFloor = requireRole("owner", "admin");

  return (req: Request, res: Response, next: NextFunction): void => {
    tierFloor(req, res, () => {
      // `next` on a rejection, never a bare floating promise: an unhandled
      // rejection here would hang the request instead of 500ing through the
      // error handler, and a hung PHI request is the worst failure mode.
      layerTwo(req, res, next).catch(next);
    });
  };

  async function layerTwo(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const user = (req as AuthedRequest).user;
    const tier = user?.role;

    if (tier === "owner") {
      next();
      return;
    }
    if ((tier !== "admin" && tier !== "family") || !user?.id) {
      todaysFloor(req, res, next);
      return;
    }

    let level: ConnectorLevel | undefined;
    try {
      const access = await resolveEffectiveAccess(user.id);
      level = access?.connectors[EAGLESOFT_PROVIDER] as ConnectorLevel | undefined;
    } catch (err) {
      logger.warn(
        { err, userId: user.id },
        "erp read gate: effective-access read failed; falling back to the layer-1 floor",
      );
      todaysFloor(req, res, next);
      return;
    }

    if (level) {
      (req as AuthedRequest).erpConnectorLevel = level;
      next();
      return;
    }

    const configured = await prisma.integrationConnection
      .findFirst({ where: { provider: EAGLESOFT_PROVIDER }, select: { id: true } })
      .catch(() => null);
    if (!configured) {
      todaysFloor(req, res, next);
      return;
    }

    if (tier === "family") {
      // Unchanged for this person: today's floor already refuses them, and it
      // does so with the body and the audit row the rest of the API uses.
      todaysFloor(req, res, next);
      return;
    }
    recordAccessDenied(req, "erp-connector-grant-missing");
    res.status(403).json(
      ErpError.forbidden(
        "forbidden: this role has no connector grant for the ERP integration",
      ).toJSON(),
    );
  }
}

export function createErpRouter(prisma: PrismaClient): Router {
  const router = Router();
  const svc = createErpService(prisma);
  // Reads carry the O-2 gate (tier floor + the resolver's connector reach).
  const canRead = erpConnectorReadGate(prisma);
  // Writes are UNCHANGED: admin-tier only, with `writeEnabled` + the staged
  // outbox + the human confirm still enforced by the service above it.
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
