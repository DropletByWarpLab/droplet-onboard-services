/**
 * WARP-468 Phase E2 — Off-LAN egress byte-counter read API + sampler push.
 *
 * Three endpoints under `/api/network/`:
 *
 *   GET  /api/network/off-lan            — aggregate bytes per channel
 *                                          over a from/to window.
 *   POST /api/network/off-lan-sample     — service-principal push from
 *                                          services/routing/scheduler.py.
 *   POST /api/network/off-lan-sample-batch — same, but accepts an array
 *                                            so one tick can submit all
 *                                            five channels atomically.
 *
 * Reuses the OffLanChannelKey enum from WARP-467 (E1). The aggregator
 * is intentionally simple: SUM(bytes) GROUP BY channel — the channel
 * cardinality is fixed at 5, so no pagination concerns. The Network
 * page's "Off-LAN this month" chip and the Models page's "Cloud spend"
 * chip both read from this aggregator, passing different from/to
 * ranges (current month vs. current billing window).
 */
import { Router } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { requireRole } from "../middleware/auth.js";

const OFF_LAN_CHANNEL_KEYS = [
  "software_updates",
  "cloud_model_escape",
  "outbound_email",
  "telemetry",
  "web_fetch",
  // WARP-1436 — Weather & currency data (Open-Meteo, European Central Bank).
  "ambient_data",
] as const;
type ChannelKey = (typeof OFF_LAN_CHANNEL_KEYS)[number];
const channelKeyEnum = z.enum(OFF_LAN_CHANNEL_KEYS);

const sampleSchema = z.object({
  channel: channelKeyEnum,
  bytes: z.union([
    z.number().int().nonnegative(),
    z.string().regex(/^\d+$/, "bytes must be a non-negative integer"),
  ]),
  ts: z.string().datetime().optional(),
});

const batchSchema = z.object({
  samples: z.array(sampleSchema).min(1).max(64),
});

const querySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  channel: channelKeyEnum.optional(),
});

function toBigInt(v: number | string): bigint {
  if (typeof v === "string") return BigInt(v);
  return BigInt(Math.floor(v));
}

function fromBigInt(v: bigint): number | string {
  return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
}

export function createOffLanNetworkRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get(
    "/network/off-lan",
    // `service` role is required because ai-gateway's off_lan_gating
    // middleware presents the AI_GATEWAY_SAMPLER_TOKEN here to read
    // cloud_model_escape before allowing a cloud-LLM call. Without
    // `service` on this gate the middleware permanently fails closed
    // (every cloud request 451s) regardless of operator configuration.
    requireRole("owner", "admin", "family", "guest", "service"),
    async (req, res, next) => {
      try {
        const q = querySchema.safeParse(req.query);
        if (!q.success) {
          res
            .status(400)
            .json({ error: "Invalid query", details: q.error.flatten() });
          return;
        }
        // Default window: month-to-date. Matches the Network page's
        // "Off-LAN this month" chip. Caller can override via ?from=&to=
        // for a custom range.
        const now = new Date();
        const monthStart = new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
        );
        const from = q.data.from ? new Date(q.data.from) : monthStart;
        const to = q.data.to ? new Date(q.data.to) : now;
        if (to.getTime() <= from.getTime()) {
          res.status(400).json({ error: "`to` must be after `from`" });
          return;
        }

        const where: { ts: { gte: Date; lte: Date }; channel?: ChannelKey } = {
          ts: { gte: from, lte: to },
        };
        if (q.data.channel) {
          where.channel = q.data.channel;
        }

        const rows = await prisma.offLanEgressSample.findMany({
          where: where as any,
          orderBy: { ts: "asc" },
        });

        // Roll up bytes per channel. Initialize every channel to 0 so
        // the dashboard's bar chart renders every channel's bar even
        // when some channels haven't recorded any traffic yet.
        const totals: Record<ChannelKey, bigint> = {
          software_updates: 0n,
          cloud_model_escape: 0n,
          outbound_email: 0n,
          telemetry: 0n,
          web_fetch: 0n,
          ambient_data: 0n,
        };
        for (const r of rows as Array<{ channel: ChannelKey; bytes: bigint }>) {
          totals[r.channel] += r.bytes;
        }

        res.json({
          from: from.toISOString(),
          to: to.toISOString(),
          totalsByChannel: Object.fromEntries(
            Object.entries(totals).map(([k, v]) => [k, fromBigInt(v)]),
          ),
          sampleCount: rows.length,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/network/off-lan-sample",
    requireRole("service"),
    async (req, res, next) => {
      try {
        const parsed = sampleSchema.safeParse(req.body);
        if (!parsed.success) {
          res
            .status(400)
            .json({ error: "Invalid sample", details: parsed.error.flatten() });
          return;
        }
        const ts = parsed.data.ts ? new Date(parsed.data.ts) : new Date();
        await prisma.offLanEgressSample.create({
          data: {
            ts,
            channel: parsed.data.channel as any,
            bytes: toBigInt(parsed.data.bytes),
          },
        });
        res.status(201).json({ ok: true, ts: ts.toISOString() });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/network/off-lan-sample-batch",
    requireRole("service"),
    async (req, res, next) => {
      try {
        const parsed = batchSchema.safeParse(req.body);
        if (!parsed.success) {
          res
            .status(400)
            .json({ error: "Invalid batch", details: parsed.error.flatten() });
          return;
        }
        // Honor each sample's optional `ts` independently so a slow
        // tick that buffers two reads can still record both with
        // their original timestamps.
        const now = new Date();
        const records = parsed.data.samples.map((s) => ({
          ts: s.ts ? new Date(s.ts) : now,
          channel: s.channel as any,
          bytes: toBigInt(s.bytes),
        }));
        await prisma.offLanEgressSample.createMany({
          data: records,
          skipDuplicates: true,
        });
        res.status(201).json({ ok: true, count: records.length });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

/** Retention helper called from the daily 03:00 cron in index.ts. */
export async function purgeOffLanEgressSamples(
  prisma: PrismaClient,
  olderThanDays = 90,
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 86400_000);
  const r = await prisma.offLanEgressSample.deleteMany({
    where: { ts: { lt: cutoff } },
  });
  return r.count;
}
