/**
 * WARP-237 — read surface for device-key-signed daily audit roots.
 *
 *   GET /api/audit/roots            — newest-first list (default 90)
 *   GET /api/audit/roots/:date      — one root, JSON
 *   GET /api/audit/roots/:date.sig  — raw DER ECDSA signature bytes
 *
 * Owner/admin gated like the activity routes: roots reveal audit-volume
 * metadata. The `.sig` shape exists so an operator can `curl -O` the
 * day's signature next to an exported bundle, per the WARP-237 spec.
 * Verification key: GET /api/admin/device-identity/status (cert), or the
 * device cert via device-identity-svc GetCert.
 */
import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";

function requireOwnerOrAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const role = req.user?.role;
  if (role === "owner" || role === "admin") {
    next();
    return;
  }
  res.status(403).json({ error: "owner or admin role required" });
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(365).optional(),
});

function serializeRoot(r: {
  date: string;
  firstRowId: bigint;
  lastRowId: bigint;
  rowCount: number;
  tailSignatureHash: string;
  prevRootHash: string;
  rootHash: string;
  signature: string;
  algorithm: string;
  createdAt: Date;
}) {
  return {
    date: r.date,
    firstRowId: r.firstRowId.toString(),
    lastRowId: r.lastRowId.toString(),
    rowCount: r.rowCount,
    tailSignatureHash: r.tailSignatureHash,
    prevRootHash: r.prevRootHash,
    rootHash: r.rootHash,
    signature: r.signature,
    algorithm: r.algorithm,
    createdAt: r.createdAt.toISOString(),
  };
}

export function createAuditRootsRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get("/audit/roots", requireOwnerOrAdmin, async (req, res, next) => {
    try {
      const parsed = listQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res
          .status(400)
          .json({ error: "Invalid query", details: parsed.error.flatten() });
        return;
      }
      const limit = parsed.data.limit ?? 90;
      const roots = await prisma.activityDailyRoot.findMany({
        orderBy: { date: "desc" },
        take: limit,
      });
      res.json({ items: roots.map(serializeRoot) });
    } catch (err) {
      next(err);
    }
  });

  // NOTE: `:date.sig` must be registered BEFORE `:date` — Express matches
  // in registration order and `:date` would swallow "2026-07-05.sig".
  router.get(
    "/audit/roots/:date.sig",
    requireOwnerOrAdmin,
    async (req, res, next) => {
      try {
        const date = req.params.date!;
        if (!DATE_RE.test(date)) {
          res.status(400).json({ error: "date must be YYYY-MM-DD" });
          return;
        }
        const root = await prisma.activityDailyRoot.findUnique({
          where: { date },
        });
        if (!root) {
          res.status(404).json({ error: "no signed root for this date" });
          return;
        }
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="droplet-audit-root-${date}.sig"`,
        );
        res.send(Buffer.from(root.signature, "base64"));
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    "/audit/roots/:date",
    requireOwnerOrAdmin,
    async (req, res, next) => {
      try {
        const date = req.params.date!;
        if (!DATE_RE.test(date)) {
          res.status(400).json({ error: "date must be YYYY-MM-DD" });
          return;
        }
        const root = await prisma.activityDailyRoot.findUnique({
          where: { date },
        });
        if (!root) {
          res.status(404).json({ error: "no signed root for this date" });
          return;
        }
        res.json(serializeRoot(root));
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
