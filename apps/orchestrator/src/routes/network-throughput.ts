/**
 * WARP-470 Phase F2 — Network throughput KPI rollup + 24 h time-series.
 *
 * Three endpoints, all under `/api/network/`:
 *
 *   GET  /api/network/summary           — KPI rollup for §2.6 KPI strip
 *   GET  /api/network/throughput?window — time-series for the 24 h area chart
 *   POST /api/network/throughput-sample — sampler push from services/routing
 *                                          (service-principal auth)
 */
import { Router } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { requireRole } from "../middleware/auth.js";

const sampleSchema = z.object({
  wanDownBps: z.union([
    z.number().int().nonnegative(),
    z.string().regex(/^\d+$/, "wanDownBps must be a non-negative integer"),
  ]),
  wanUpBps: z.union([
    z.number().int().nonnegative(),
    z.string().regex(/^\d+$/, "wanUpBps must be a non-negative integer"),
  ]),
  ts: z.string().datetime().optional(),
});

const throughputQuerySchema = z.object({
  window: z.enum(["1h", "6h", "24h", "7d"]).optional().default("24h"),
});

function windowMs(w: "1h" | "6h" | "24h" | "7d"): number {
  switch (w) {
    case "1h":
      return 60 * 60 * 1000;
    case "6h":
      return 6 * 60 * 60 * 1000;
    case "24h":
      return 24 * 60 * 60 * 1000;
    case "7d":
      return 7 * 24 * 60 * 60 * 1000;
  }
}

function toBigInt(v: number | string): bigint {
  if (typeof v === "string") return BigInt(v);
  return BigInt(Math.floor(v));
}

function fromBigInt(v: bigint): number | string {
  return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
}

export function createNetworkThroughputRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get(
    "/network/summary",
    requireRole("owner", "admin", "family", "guest"),
    async (_req, res, next) => {
      try {
        const [latest, clientCount] = await Promise.all([
          prisma.networkThroughputSample.findFirst({ orderBy: { ts: "desc" } }),
          prisma.networkDevice.count().catch(() => 0),
        ]);
        res.json({
          wanDownBps: latest ? fromBigInt(latest.wanDownBps) : 0,
          wanUpBps: latest ? fromBigInt(latest.wanUpBps) : 0,
          clientCount,
          // Phase E2 OffLanEgressSample dependency — placeholder 0
          // preserves the shape until WARP-468 wires real aggregation.
          dnsBlockedToday: 0,
          offLanBytesThisMonth: 0,
          lastSampleAt: latest ? latest.ts.toISOString() : null,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    "/network/throughput",
    requireRole("owner", "admin", "family", "guest"),
    async (req, res, next) => {
      try {
        const q = throughputQuerySchema.safeParse(req.query);
        if (!q.success) {
          res.status(400).json({ error: "Invalid window", details: q.error.flatten() });
          return;
        }
        const since = new Date(Date.now() - windowMs(q.data.window));
        const rows = await prisma.networkThroughputSample.findMany({
          where: { ts: { gte: since } },
          orderBy: { ts: "asc" },
          take: 24 * 60,
        });
        res.json({
          window: q.data.window,
          samples: rows.map(
            (r: { ts: Date; wanDownBps: bigint; wanUpBps: bigint }) => ({
              ts: r.ts.toISOString(),
              wanDownBps: fromBigInt(r.wanDownBps),
              wanUpBps: fromBigInt(r.wanUpBps),
            }),
          ),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // Service-principal push from the routing service's apscheduler job.
  // Gated on `service` role; the routing sampler authenticates via
  // SERVICE_TOKEN_* bearer (matched in middleware/auth.ts
  // matchServiceToken). Adding a dedicated ORCHESTRATOR_SAMPLER_TOKEN
  // is a small follow-up alongside secrets.sh provisioning.
  router.post(
    "/network/throughput-sample",
    requireRole("service"),
    async (req, res, next) => {
      try {
        const parsed = sampleSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: "Invalid sample", details: parsed.error.flatten() });
          return;
        }
        const ts = parsed.data.ts ? new Date(parsed.data.ts) : new Date();
        await prisma.networkThroughputSample.create({
          data: {
            ts,
            wanDownBps: toBigInt(parsed.data.wanDownBps),
            wanUpBps: toBigInt(parsed.data.wanUpBps),
          },
        });
        res.status(201).json({ ok: true, ts: ts.toISOString() });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

/** Retention helper called from the daily 03:00 cron in index.ts. */
export async function purgeNetworkThroughputSamples(
  prisma: PrismaClient,
  olderThanDays = 30,
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 86400_000);
  const r = await prisma.networkThroughputSample.deleteMany({
    where: { ts: { lt: cutoff } },
  });
  return r.count;
}
