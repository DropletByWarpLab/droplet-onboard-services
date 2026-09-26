/**
 * WARP-3103 — who watched which camera, and when.
 *
 * The box serving footage inline (a live view, an event clip, a recording)
 * writes one signed activity row (kind `camera`): the actor, the camera, what
 * was fetched and when. Reading the log is owner/admin only (routes/activity.ts).
 *
 * The row says "Fetched … (inline)", not "played" or "watched": the box knows
 * it sent the bytes, not what the client did with them. Inline bytes are the
 * whole clip, so a client can keep them; only `?download=1` is a save the box
 * can see and gate.
 *
 * One row per (actor, camera, kind) per WATCH_DEDUPE_MS, not per request: a
 * `<video>` element re-requests on seek, HLS re-fetches its playlist, and
 * an MJPEG tile reconnects on every network blip. The log answers "who
 * looked at the loading dock on Tuesday", not "how many TCP connections".
 *
 * Saving footage (a `?download=1` attachment) is a custody act and is never
 * deduped: every save is its own row.
 *
 * Best-effort, like every `recordActivity` caller: a failed row is logged by
 * the recorder and never blocks the footage. The dedupe window lives in
 * process memory.
 * ponytail: per-process map, so a restart forgets it and writes at most one
 * extra row per active viewer; move it to Redis if the orchestrator ever
 * runs as more than one replica.
 */
import { actorFromRequest } from "./activity.service.js";
import { recordActivity } from "./activity.singleton.js";

/** `snapshot` is only ever written as a save; viewing a still is not audited. */
export type CameraWatchKind = "live" | "clip" | "recording" | "snapshot";

export const WATCH_DEDUPE_MS = 5 * 60 * 1000;

const lastWritten = new Map<string, number>();

const WHAT: Record<CameraWatchKind, string> = {
  live: "Fetched a live view (inline)",
  clip: "Fetched an event clip (inline)",
  recording: "Fetched a camera recording (inline)",
  snapshot: "Fetched a camera snapshot (inline)",
};

const SAVED: Record<CameraWatchKind, string> = {
  live: "Saved a live view",
  clip: "Saved an event clip",
  recording: "Saved a camera recording",
  snapshot: "Saved a camera snapshot",
};

/** Test seam: forget every dedupe entry. */
export function resetCameraWatchDedupe(): void {
  lastWritten.clear();
}

export async function auditCameraWatch(
  req: { user?: { id: string; role?: string; username?: string } },
  camera: string,
  kind: CameraWatchKind,
  opts: { saved?: boolean; eventId?: string; now?: number } = {},
): Promise<void> {
  const actorId = req.user?.id;
  if (!actorId) return;
  const now = opts.now ?? Date.now();
  const key = `${actorId}\u0000${camera}\u0000${kind}`;
  if (!opts.saved) {
    const last = lastWritten.get(key);
    if (last !== undefined && now - last < WATCH_DEDUPE_MS) return;
  }
  const row = await recordActivity({
    kind: "camera",
    severity: "info",
    sourceIcon: "video",
    what: opts.saved ? SAVED[kind] : WHAT[kind],
    sub: camera,
    refs: {
      surface: "camera_watch",
      camera,
      watch: kind,
      saved: opts.saved === true,
      delivery: opts.saved ? "attachment" : "inline",
      eventId: opts.eventId ?? null,
      actor: req.user?.username ?? null,
    },
    actor: actorFromRequest(req),
  });
  // Arm the window only once a row exists: a failed write must not silence
  // the next fetch. ponytail: two concurrent first fetches can both write;
  // harmless, one extra row.
  if (row && !opts.saved) {
    lastWritten.set(key, now);
    if (lastWritten.size > 5000) {
      for (const [k, t] of lastWritten) if (now - t >= WATCH_DEDUPE_MS) lastWritten.delete(k);
    }
  }
}
