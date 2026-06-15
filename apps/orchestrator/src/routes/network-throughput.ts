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

const dnsBlockSampleSchema = z.object({
  blockedCount: z.number().int().nonnegative(),
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
        // Match the canonical ONLINE_WINDOW_MS = 2min from
        // network-device.service.ts. Without this filter the count
        // returns every device ever registered (blocked, long-inactive),
        // diverging from the network page's "active" label.
        const onlineSince = new Date(Date.now() - 2 * 60_000);
        // Month-to-date for off-LAN bytes, day-to-date for DNS blocks.
        // UTC boundaries match off-lan-network.ts's month-start logic so
        // the summary chip and the dedicated /network/off-lan aggregator
        // never disagree on where "this month" begins. NOTE: "today" is a
        // UTC day here — see the day-boundary flag in the PR notes.
        const now = new Date();
        const monthStart = new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
        );
        const dayStart = new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
        );
        const [latest, clientCount, offLan, dnsBlock] = await Promise.all([
          prisma.networkThroughputSample.findFirst({ orderBy: { ts: "desc" } }),
          prisma.networkDevice
            .count({ where: { lastSeen: { gte: onlineSince } } })
            .catch(() => 0),
          // offLanEgressSample.bytes is BigInt → _sum is bigint | null.
          prisma.offLanEgressSample
            .aggregate({
              _sum: { bytes: true },
              where: { ts: { gte: monthStart, lte: now } },
            })
            .catch(() => ({ _sum: { bytes: null } })),
          // dnsBlockSample.blockedCount is Int → _sum is number | null.
          prisma.dnsBlockSample
            .aggregate({
              _sum: { blockedCount: true },
              where: { ts: { gte: dayStart, lte: now } },
            })
            .catch(() => ({ _sum: { blockedCount: null } })),
        ]);
        res.json({
          wanDownBps: latest ? fromBigInt(latest.wanDownBps) : 0,
          wanUpBps: latest ? fromBigInt(latest.wanUpBps) : 0,
          clientCount,
          dnsBlockedToday: dnsBlock._sum.blockedCount ?? 0,
          offLanBytesThisMonth: fromBigInt(offLan._sum.bytes ?? 0n),
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
        // `take` is window-derived: 1 sample per minute (the routing
        // scheduler tick rate). Hardcoding 24 * 60 truncated `7d` to
        // the first 24 h of the window — caller would ask for 7 days
        // and silently get the oldest day. Cap at 7d worth (10 080)
        // so a runaway window can't drown the response.
        const samplesPerHour = 60;
        const hours = windowMs(q.data.window) / (60 * 60 * 1000);
        const take = Math.min(
          Math.max(60, Math.ceil(hours * samplesPerHour)),
          7 * 24 * samplesPerHour,
        );
        const rows = await prisma.networkThroughputSample.findMany({
          where: { ts: { gte: since } },
          orderBy: { ts: "asc" },
          take,
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

  // Service-principal push from the routing service's dns_block_meter
  // apscheduler job. Same `service` gate + ORCHESTRATOR_SAMPLER_TOKEN
  // bearer as /network/throughput-sample and the off-LAN samplers.
  router.post(
    "/network/dns-block-sample",
    requireRole("service"),
    async (req, res, next) => {
      try {
        const parsed = dnsBlockSampleSchema.safeParse(req.body);
        if (!parsed.success) {
          res
            .status(400)
            .json({ error: "Invalid sample", details: parsed.error.flatten() });
          return;
        }
        const ts = parsed.data.ts ? new Date(parsed.data.ts) : new Date();
        await prisma.dnsBlockSample.create({
          data: {
            ts,
            blockedCount: parsed.data.blockedCount,
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

/** Retention helper called from the daily 03:00 cron in index.ts. */
export async function purgeDnsBlockSamples(
  prisma: PrismaClient,
  olderThanDays = 30,
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 86400_000);
  const r = await prisma.dnsBlockSample.deleteMany({
    where: { ts: { lt: cutoff } },
  });
  return r.count;
}
