/**
 * WARP-475 (G3) — nightly camera-retention purge.
 *
 * Reads `hardware.camera_retention_days` + `hardware.event_retention_days`
 * from the WorkspaceSetting table on every tick. These rows are
 * operator-editable from the dashboard via `PATCH /api/settings`, so
 * the cron does NOT cache them in-process — a value changed in the UI
 * at 03:25 must take effect at the 03:30 fire. workspace-settings.service.ts
 * seeds the rows on first boot:
 *
 *   hardware.camera_retention_days = 14   (number; the §2.5
 *                                          first-boot default — operator
 *                                          can raise to 90, drop to 7,
 *                                          or set anything in between)
 *   hardware.event_retention_days  = null (json; "kept forever" — the
 *                                          §2.5 default, also editable)
 *
 * Calls Frigate's delete API to remove clips older than whatever the
 * current `camera_retention_days` row says; events stay untouched
 * when `event_retention_days` is `null`.
 *
 * `null` is the explicit "kept forever" state — NOT IS NULL ambiguity
 * per CLAUDE.md. The seeder writes `null` deliberately so the dashboard
 * can render "forever" without inventing a sentinel value.
 *
 * Emits one ActivityRow per purge run with the deleted counts. A run
 * that finds nothing still emits a row (severity: info, count: 0) so
 * the operator has an audit trail of "we checked, nothing to delete"
 * — same posture as the WARP-455 guest-expiry sweep.
 *
 * Architecture rules honored:
 *   - Uses cron-runtime.service.ts scheduleCron (no while True).
 *   - Frigate API failures are logged but never throw — the cron
 *     keeps ticking. A wedged Frigate must NOT block the orchestrator.
 *   - Settings reads always pull a fresh row — no in-process cache
 *     that could drift past an operator change in the dashboard.
 */
import type { PrismaClient } from "@prisma/client";
import { config } from "../config.js";
import { recordActivity } from "./activity.singleton.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("camera-retention-purge");

// Read from `config.FRIGATE_URL` so we go through Zod validation and
// share the same env-var contract as every other Frigate caller
// (e.g. `frigate.client.ts:13`). Romain on PR #292 round 2: the
// previous `process.env.FRIGATE_API_URL` bypassed validation, was
// undocumented, and silently ignored the operator's `FRIGATE_URL`
// setting in `.env` — falling back to a hardcoded host.
const FRIGATE_BASE_URL = config.FRIGATE_URL.replace(/\/+$/, "");

export interface CameraRetentionPolicy {
  /** Days to keep recorded clips. `null` = forever. */
  clipsDays: number | null;
  /**
   * Days to keep recorded events (motion / detection records).
   * `null` = forever — the WARP-475 default per §2.5.
   */
  eventsDays: number | null;
}

interface SettingRow {
  key: string;
  valueJson: unknown;
}

/**
 * Read the current retention policy from WorkspaceSetting.
 *
 * Missing rows resolve to `{ clipsDays: null, eventsDays: null }` —
 * i.e. "keep forever for both" — NOT to the seeded `14 / null`
 * defaults. This is deliberate first-boot race-safety: if the
 * settings seeder hasn't run yet (or the row was deleted manually),
 * the safe stance is "delete nothing" rather than "delete with an
 * assumed window the operator never agreed to". Romain on PR #292
 * round 2 caught a previous version of this comment that claimed the
 * opposite — the test at `camera-retention-purge.test.ts:57`
 * ("treats missing rows as null (forever) — first-boot race-safe")
 * locks in the actual behavior.
 *
 * Also collapses `0` / negative / non-number values to `null`
 * (forever) — those aren't valid retention windows and the seeded
 * default for "forever" IS null.
 */
export async function loadCameraRetentionPolicy(
  prisma: PrismaClient,
): Promise<CameraRetentionPolicy> {
  const rows = (await prisma.workspaceSetting.findMany({
    where: {
      key: {
        in: ["hardware.camera_retention_days", "hardware.event_retention_days"],
      },
    },
  })) as unknown as SettingRow[];

  const byKey = new Map(rows.map((r) => [r.key, r.valueJson]));
  const clips = byKey.get("hardware.camera_retention_days");
  const events = byKey.get("hardware.event_retention_days");

  return {
    clipsDays: typeof clips === "number" && clips > 0 ? clips : null,
    eventsDays: typeof events === "number" && events > 0 ? events : null,
  };
}

/**
 * Hit Frigate's delete-by-window endpoint. Returns the count of deleted
 * items reported by the API, or `null` if the call failed (logged at
 * WARN; the caller treats null as "couldn't verify" and proceeds).
 *
 * Frigate's stable API surface as of v0.13 exposes:
 *   DELETE /api/recordings?before=<unix_seconds>
 *   DELETE /api/events?before=<unix_seconds>
 *
 * Both return JSON `{ success: bool, deleted: number }`. We tolerate
 * an older Frigate that 404s these routes — the cron logs the gap and
 * moves on.
 */
async function frigateDelete(
  path: string,
  beforeUnixSec: number,
): Promise<number | null> {
  const url = `${FRIGATE_BASE_URL}${path}?before=${beforeUnixSec}`;
  try {
    const res = await fetch(url, { method: "DELETE" });
    if (!res.ok) {
      logger.warn(
        { url, status: res.status },
        "Frigate delete returned non-2xx",
      );
      return null;
    }
    const body = (await res.json()) as { deleted?: number };
    return typeof body.deleted === "number" ? body.deleted : 0;
  } catch (err) {
    logger.warn(
      { url, err: (err as Error).message },
      "Frigate delete request failed",
    );
    return null;
  }
}

export interface PurgeResult {
  clipsDeleted: number;
  eventsDeleted: number;
  clipsSkipped: boolean;
  eventsSkipped: boolean;
}

/**
 * Run one purge pass against the current retention policy. Idempotent
 * by construction — Frigate is the source of truth for what survives
 * and a second run on the same minute walks zero items.
 */
export async function purgeCameraArtifacts(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<PurgeResult> {
  const policy = await loadCameraRetentionPolicy(prisma);
  let clipsDeleted = 0;
  let eventsDeleted = 0;
  let clipsSkipped = true;
  let eventsSkipped = true;

  if (policy.clipsDays !== null) {
    const cutoff = Math.floor(
      (now.getTime() - policy.clipsDays * 86400_000) / 1000,
    );
    const result = await frigateDelete("/api/recordings", cutoff);
    if (result !== null) {
      clipsDeleted = result;
      clipsSkipped = false;
    }
  }

  if (policy.eventsDays !== null) {
    const cutoff = Math.floor(
      (now.getTime() - policy.eventsDays * 86400_000) / 1000,
    );
    const result = await frigateDelete("/api/events", cutoff);
    if (result !== null) {
      eventsDeleted = result;
      eventsSkipped = false;
    }
  }

  // One ActivityRow per run — operator audit trail of "we checked".
  await recordActivity({
    kind: "camera",
    severity: "info",
    sourceIcon: "video",
    what: "Camera retention purge",
    sub: `${clipsDeleted} clips · ${eventsDeleted} events`,
    refs: {
      clipsDays: policy.clipsDays,
      eventsDays: policy.eventsDays,
      clipsDeleted,
      eventsDeleted,
      clipsSkipped,
      eventsSkipped,
    },
  });

  return { clipsDeleted, eventsDeleted, clipsSkipped, eventsSkipped };
}
