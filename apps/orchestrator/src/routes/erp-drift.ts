/**
 * WARP-2463 — the admin read surface over stored reconciliation drift.
 *
 *   GET /api/integrations/drift/:connectionId?days=30
 *
 * The hub's connection detail page asks one question of this route: has the
 * incremental path been trustworthy for this connection lately, and is it
 * getting better or worse. `drift-record.service.ts` holds the argument for
 * why that could not be answered before this story.
 *
 * ## Why owner/admin only
 *
 * ADR-004 §3's per-route allowlist matrix. This is operator diagnostics about
 * a customer's money-data pipeline: it says which vendor is dropping records
 * and how far back the gap ran. A `family` role exists to USE the assistant,
 * not to audit the sync engine, and nothing on the family surface degrades
 * without this. Guard is `requireRole("owner", "admin")` AT REGISTRATION —
 * not an `isAdmin()` check inside the handler, which is how a route acquires a
 * path that reaches the data before the guard has run.
 *
 * The 403 body and the `recordAccessDenied` ActivityRow both come from the
 * shared middleware rather than being re-implemented here (WARP-1062 audit
 * item B: local guards that mirror `requireRole` must emit the same
 * policy-violation row, and the surest way to do that is to not mirror it).
 *
 * ## Mounted separately from `createIntegrationsRouter`
 *
 * Its own factory, under the same `/api/integrations` prefix — because the
 * integrations router's floor is family-and-up and this surface is owner/admin,
 * and a guard narrower than its neighbours' is safer as its own registration
 * than as an exception inside someone else's file.
 *
 * No path collides. The integrations router serves `/integrations` and
 * `/integrations/eaglesoft[/...]`; WARP-2275's credentials router serves
 * `/integrations/:provider/credentials`, which needs a literal `credentials`
 * last where this needs a literal `drift` second.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";

import { requireRole } from "../middleware/auth.js";
import {
  driftForConnection,
  type ErpDriftPrisma,
} from "../services/erp-sync/drift-record.service.js";

/**
 * Window in days.
 *
 * Defaults to 30 — the "this month" the ticket's question is phrased in.
 * Capped at 365 because the retention window is operator-tunable and a caller
 * asking for ten years would just scan the whole table to find nothing; the
 * cap makes the cost of the query bounded by the route, not by the caller.
 */
const querySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

export function createErpDriftRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get(
    "/integrations/drift/:connectionId",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next) => {
      try {
        const parsed = querySchema.safeParse(req.query);
        if (!parsed.success) {
          res.status(400).json({ error: "Invalid window", detail: parsed.error.issues });
          return;
        }
        const connectionId = String(req.params.connectionId ?? "");
        if (connectionId.length === 0) {
          res.status(400).json({ error: "Missing connectionId" });
          return;
        }

        // A connection with no stored sweeps returns an empty window with
        // `rowsRecorded: 0`, NOT a 404 and NOT an implied clean bill of
        // health. "We have never measured this" is a distinct answer from
        // "we measured and found nothing", and the hub renders it as such.
        const window = await driftForConnection(
          prisma as unknown as ErpDriftPrisma,
          connectionId,
          parsed.data.days,
        );
        res.json(window);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
