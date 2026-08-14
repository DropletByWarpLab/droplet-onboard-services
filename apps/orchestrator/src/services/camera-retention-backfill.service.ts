/**
 * WARP-1974 — repair cameras adopted before WARP-1957.
 *
 * #1565 fixed both adoption writers so a NEW camera gets real retention.
 * It did nothing for cameras already registered, which is every camera on
 * every install that predates it — including the one on the production
 * box. Those keep only clips that overlap an alert, silently, forever.
 *
 * ## The hard part: "never configured" vs "deliberately zero"
 *
 * A retention window of 0 is a legitimate choice. An operator who switched
 * 24/7 recording off must not have it switched back on by a migration —
 * that is precisely the mistake WARP-1851 made from the other direction,
 * where setting a storage budget turned continuous recording ON as a side
 * effect and storage went UP.
 *
 * The distinction is drawn from Frigate's own two configs:
 *
 *   - the RESOLVED tree (`/api/config`) is what Frigate enforces, with
 *     inherited defaults filled in. A camera that never set `continuous`
 *     and one that set it to 0 look **identical** here — both read 0.
 *   - the AUTHORED yaml (`/api/config/raw`) is what someone actually
 *     wrote. A camera that never set `continuous` has **no such key**; a
 *     camera set to 0 has `continuous: {days: 0}`.
 *
 * So: backfill only cameras whose AUTHORED block lacks the keys entirely.
 * Absence there is not a guess — it is the literal record of what was
 * written, and it is the only place the two cases differ.
 *
 * Deliberately a manual, reported operation rather than a startup
 * migration. It restarts every camera it touches, and a repair that runs
 * silently at boot is indistinguishable from one that never ran.
 */

import { parseDocument, isMap } from "yaml";
import type { PrismaClient } from "@prisma/client";
import { fetchRawConfigYaml, saveRawConfig } from "./frigate.client.js";
import {
  resolveRetentionDefaults,
  type CameraRetentionDefaults,
} from "./camera-retention-defaults.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("camera-retention-backfill");

export interface BackfillPlanEntry {
  camera: string;
  /** Why this camera is or isn't being touched — surfaced, not inferred. */
  reason:
    | "no_retention_authored"
    | "already_authored"
    | "explicitly_zero"
    | "not_in_config";
  willWrite: boolean;
}

export interface BackfillResult {
  planned: BackfillPlanEntry[];
  written: string[];
  /** True when nothing needed doing — the second run of an idempotent op. */
  noop: boolean;
}

/**
 * Does this camera's AUTHORED block say anything at all about how long to
 * keep footage?
 *
 * Any of the four windows being present counts. Someone who wrote
 * `motion: {days: 0}` has expressed an intent about retention even though
 * the value is zero, and we do not overwrite an expressed intent.
 */
function hasAuthoredRetention(cameraBlock: unknown): boolean {
  if (!isMap(cameraBlock)) return false;
  const record = cameraBlock.get("record", true);
  if (!isMap(record)) return false;
  for (const key of ["continuous", "motion", "alerts", "detections"]) {
    if (record.has(key)) return true;
  }
  return false;
}

/**
 * Work out what the backfill would do, without doing it.
 *
 * Exported so the route can offer a dry run: an operator should be able to
 * see which cameras a repair will restart before it restarts them.
 */
export async function planRetentionBackfill(
  prisma: PrismaClient,
): Promise<BackfillPlanEntry[]> {
  const [yamlText, dbCameras] = await Promise.all([
    fetchRawConfigYaml(),
    prisma.camera.findMany({ select: { name: true } }),
  ]);

  const doc = parseDocument(yamlText);
  const cameras = doc.get("cameras", true);

  return dbCameras.map(({ name }): BackfillPlanEntry => {
    if (!isMap(cameras) || !cameras.has(name)) {
      return { camera: name, reason: "not_in_config", willWrite: false };
    }
    const block = cameras.get(name, true);
    if (hasAuthoredRetention(block)) {
      // Could be a real window or a deliberate zero — either way it is a
      // choice already made, and not ours to revise.
      return { camera: name, reason: "already_authored", willWrite: false };
    }
    return { camera: name, reason: "no_retention_authored", willWrite: true };
  });
}

/**
 * Apply the appliance defaults to every camera that never had retention
 * authored at all.
 *
 * Idempotent: a second run finds those cameras now authored and writes
 * nothing. `noop` says so explicitly rather than leaving the caller to
 * infer it from an empty list — "nothing to do" and "it failed quietly"
 * must not look the same, which is the WARP-1849 anti-pattern.
 */
export async function backfillCameraRetention(
  prisma: PrismaClient,
  defaults: CameraRetentionDefaults = resolveRetentionDefaults(),
): Promise<BackfillResult> {
  const planned = await planRetentionBackfill(prisma);
  const targets = planned.filter((p) => p.willWrite).map((p) => p.camera);

  if (targets.length === 0) {
    logger.info("retention backfill: nothing to repair");
    return { planned, written: [], noop: true };
  }

  // Edit the AUTHORED yaml. The resolved tree is not save-round-trippable
  // on Frigate 0.17 — writing it back produces 42 validation errors, which
  // frigate.client.ts already learned the hard way.
  const doc = parseDocument(await fetchRawConfigYaml());
  for (const name of targets) {
    doc.setIn(["cameras", name, "record", "enabled"], true);
    doc.setIn(["cameras", name, "record", "continuous", "days"], defaults.continuousDays);
    doc.setIn(["cameras", name, "record", "motion", "days"], defaults.motionDays);
    doc.setIn(
      ["cameras", name, "record", "alerts", "retain", "days"],
      defaults.alertsRetainDays,
    );
    doc.setIn(["cameras", name, "record", "alerts", "pre_capture"], defaults.preCaptureSec);
    doc.setIn(["cameras", name, "record", "alerts", "post_capture"], defaults.postCaptureSec);
    doc.setIn(
      ["cameras", name, "record", "detections", "retain", "days"],
      defaults.detectionsRetainDays,
    );
    doc.setIn(
      ["cameras", name, "record", "detections", "pre_capture"],
      defaults.preCaptureSec,
    );
    doc.setIn(
      ["cameras", name, "record", "detections", "post_capture"],
      defaults.postCaptureSec,
    );
  }

  const resp = await saveRawConfig(String(doc));
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    // Loud. A retention repair that fails silently leaves the operator
    // believing their cameras were fixed.
    throw new Error(
      `Frigate rejected the retention backfill (${resp.status}): ${body.slice(0, 300)}`,
    );
  }

  logger.info({ cameras: targets }, "retention backfill applied");
  return { planned, written: targets, noop: false };
}
