/**
 * WARP-3514 / ADR-070 — the camera bitrate sampler: the measurements the
 * recordings allocation sizes itself from.
 *
 * Hourly (index.ts schedules it as `droplet:camera-bitrate-sample`),
 * `sampleCameraBitrates` reads the rate Frigate measured for each camera and
 * stores one `CameraBitrateSample` per camera; the allocator then takes the p95
 * over the last 72 hours (recordings-sizing.ts). Samples older than 14 days are
 * deleted in the same call, so the table never grows without bound.
 *
 * Three things are deliberate:
 *
 *   - THE UNIT. Frigate reports MiB and `CameraBitrateSample.mbPerHour` keeps
 *     MiB/hour, so the conversion is `bytesPerHour / MIB` (1 048 576). Dividing
 *     by 1 000 000 would under-reserve every customer's drive by ~5 %.
 *
 *   - UNKNOWN IS NOT ZERO. A camera with no measured rate (Frigate seeds
 *     `bandwidth` to 0 until it has segments, which `getCameraStorage` reports
 *     as null) records NOTHING. A stored 0 would drag the p95 down and
 *     under-reserve exactly the camera that has not shown its rate yet.
 *
 *   - AN UNREACHABLE FRIGATE THROWS. Like the near-full check, the call fails
 *     rather than reporting an empty hour, so the cron canary counts it — and
 *     nothing is written or pruned on the failed tick.
 *
 * `getCameraStorage()` already maps Frigate's friendly names back to camera
 * names, so the samples are keyed by the same name the sizing and the
 * dashboard use.
 */
import type { PrismaClient } from "@prisma/client";
import { getCameraStorage } from "./camera-storage.service.js";
import { MIB, SAMPLE_RETENTION_DAYS, type BitrateSample } from "./recordings-sizing.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("camera-bitrate-sampler");

const DAY_MS = 86_400_000;

type SampleDb = Pick<PrismaClient, "cameraBitrateSample">;

export interface SampleCameraBitratesDeps {
  /** Defaults to the shared `getCameraStorage` (throws when Frigate is unreachable). */
  getStorage?: typeof getCameraStorage;
  now?: () => Date;
}

/** A rate worth recording: finite and above zero. Anything else is "not measured yet". */
function isMeasured(bytesPerHour: number | null): bytesPerHour is number {
  return typeof bytesPerHour === "number" && Number.isFinite(bytesPerHour) && bytesPerHour > 0;
}

/**
 * One sampling tick: record every camera that has a measured rate, then prune
 * what is older than the retention. Returns how many rows were recorded and
 * pruned. Throws when Frigate is unreachable (writing nothing) or when the
 * database refuses a write.
 */
export async function sampleCameraBitrates(
  prisma: SampleDb,
  deps: SampleCameraBitratesDeps = {},
): Promise<{ recorded: number; pruned: number }> {
  const getStorage = deps.getStorage ?? getCameraStorage;
  const now = (deps.now ?? (() => new Date()))();

  const storage = await getStorage();

  const rows = storage.cameras.flatMap((c) =>
    isMeasured(c.bytesPerHour) ? [{ camera: c.camera, sampledAt: now, mbPerHour: c.bytesPerHour / MIB }] : [],
  );
  const recorded = rows.length > 0 ? (await prisma.cameraBitrateSample.createMany({ data: rows })).count : 0;

  // After recording, never before: a failed insert must not leave the table shorter than it found it.
  const { count: pruned } = await prisma.cameraBitrateSample.deleteMany({
    where: { sampledAt: { lt: new Date(now.getTime() - SAMPLE_RETENTION_DAYS * DAY_MS) } },
  });

  logger.debug({ recorded, pruned, cameras: storage.cameras.length }, "sampled camera bitrates");
  return { recorded, pruned };
}

/**
 * Every retained sample (the last 14 days) grouped by camera, oldest first —
 * the input `computeSizing` takes. Ordered by camera name then time so the
 * result is deterministic whatever order the database returns rows in.
 */
export async function loadSamplesByCamera(prisma: SampleDb, now: Date): Promise<Map<string, BitrateSample[]>> {
  const rows = await prisma.cameraBitrateSample.findMany({
    where: { sampledAt: { gte: new Date(now.getTime() - SAMPLE_RETENTION_DAYS * DAY_MS) } },
    orderBy: [{ camera: "asc" }, { sampledAt: "asc" }],
    select: { camera: true, sampledAt: true, mbPerHour: true },
  });

  const byCamera = new Map<string, BitrateSample[]>();
  for (const row of rows) {
    const sample: BitrateSample = { sampledAt: row.sampledAt, mbPerHour: row.mbPerHour };
    const list = byCamera.get(row.camera);
    if (list) list.push(sample);
    else byCamera.set(row.camera, [sample]);
  }
  return byCamera;
}
