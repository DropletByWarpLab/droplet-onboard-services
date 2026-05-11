/**
 * Camera event gate — per-camera rate limiter for real-time Frigate events.
 *
 * Why this exists
 * ---------------
 * Frigate publishes a stream of `frigate/events` MQTT messages with
 * `type: "new" | "update" | "end"`. Without a gate, every message gets
 * fanned out to the dashboard via SSE (toast + SWR revalidations) and to
 * subscribed users via Web Push. A motion-heavy camera (tree blowing in
 * the wind, person pacing) trivially saturates the notification center
 * and the camera dashboard.
 *
 * Rules (per WARP "camera-event saturation" fix)
 * ----------------------------------------------
 *   1. Per camera, a `new` event is accepted only when there is no
 *      currently-recording event AND at least MIN_GAP_AFTER_RECORDING_MS
 *      have elapsed since the previous event's `type=end` from Frigate.
 *      The first event a camera ever sees is accepted unconditionally.
 *   2. While an event is active, `update` messages whose id matches the
 *      active event are accepted (so the cameras page can show live
 *      confidence). Updates with a different id are dropped as stale.
 *   3. `end` matching the active event releases the gate and starts the
 *      5s cooldown. `end` not matching the active event is ignored.
 *   4. State is per camera — busy front-door does not block back-yard.
 *   5. Safety: if no `end` arrives within MAX_ACTIVE_MS the gate
 *      auto-releases (defends against Frigate crash / dropped MQTT
 *      message wedging the camera forever).
 *
 * The gate is intentionally pure: callers supply `now` and receive a
 * discriminated `Decision`. The only mutable state is a module-level
 * Map<cameraName, CameraGate>, which is fine because the orchestrator
 * runs as a single process with a single MQTT subscriber. Reset helper
 * is exposed for tests only.
 *
 * This is NOT a persistence layer. The canonical event log lives in
 * Frigate's SQLite and is still fully queryable via /api/cameras/events.
 * The gate rate-limits the real-time push/SSE surface only.
 */

export const MIN_GAP_AFTER_RECORDING_MS = 5_000;
export const MAX_ACTIVE_MS = 5 * 60_000; // 5 minutes safety release

type FrigateEventType = "new" | "update" | "end";

interface CameraGate {
  /** Event currently being recorded; null if the camera is idle. */
  activeEventId: string | null;
  /** Wall-clock ms when the active event was accepted. */
  activeStartedAt: number;
  /** Wall-clock ms when the most recent event reached `type=end`. */
  recordingEndedAt: number | null;
}

export type CameraEventDecision =
  | { kind: "accept_new"; eventId: string; cameraName: string }
  | { kind: "accept_update"; eventId: string; cameraName: string }
  | { kind: "accept_end"; eventId: string; cameraName: string }
  | {
      kind: "drop_active";
      eventId: string;
      cameraName: string;
      activeEventId: string;
    }
  | {
      kind: "drop_cooldown";
      eventId: string;
      cameraName: string;
      remainingMs: number;
    }
  | { kind: "drop_stale"; eventId: string; cameraName: string; reason: string };

const gates = new Map<string, CameraGate>();

function getGate(cameraName: string): CameraGate {
  let g = gates.get(cameraName);
  if (!g) {
    g = { activeEventId: null, activeStartedAt: 0, recordingEndedAt: null };
    gates.set(cameraName, g);
  }
  return g;
}

function isFrigateEventType(t: unknown): t is FrigateEventType {
  return t === "new" || t === "update" || t === "end";
}

export function processCameraEvent(opts: {
  cameraName: string;
  eventId: string;
  frigateType: FrigateEventType;
  now: number;
}): CameraEventDecision {
  const { cameraName, eventId, frigateType, now } = opts;

  // Runtime guards — never let a malformed MQTT payload mutate state.
  if (!cameraName || !eventId || !isFrigateEventType(frigateType)) {
    return {
      kind: "drop_stale",
      eventId,
      cameraName,
      reason: "invalid_input",
    };
  }

  const gate = getGate(cameraName);

  // Safety: auto-release a wedged active event before deciding anything
  // else. This covers the "Frigate crashed mid-event / we missed the
  // `end` message" case. We intentionally do NOT stamp recordingEndedAt
  // here — that would impose the post-recording cooldown on top of a
  // five-minute stall, which is punitive. After a stuck release the next
  // `new` is accepted immediately.
  if (
    gate.activeEventId !== null &&
    now - gate.activeStartedAt > MAX_ACTIVE_MS
  ) {
    gate.activeEventId = null;
  }

  if (frigateType === "new") {
    if (gate.activeEventId !== null) {
      return {
        kind: "drop_active",
        eventId,
        cameraName,
        activeEventId: gate.activeEventId,
      };
    }
    if (gate.recordingEndedAt !== null) {
      const elapsed = now - gate.recordingEndedAt;
      if (elapsed < MIN_GAP_AFTER_RECORDING_MS) {
        return {
          kind: "drop_cooldown",
          eventId,
          cameraName,
          remainingMs: MIN_GAP_AFTER_RECORDING_MS - elapsed,
        };
      }
    }
    gate.activeEventId = eventId;
    gate.activeStartedAt = now;
    return { kind: "accept_new", eventId, cameraName };
  }

  if (frigateType === "update") {
    if (gate.activeEventId !== null && gate.activeEventId === eventId) {
      return { kind: "accept_update", eventId, cameraName };
    }
    return {
      kind: "drop_stale",
      eventId,
      cameraName,
      reason: "update_no_active_match",
    };
  }

  // frigateType === "end"
  if (gate.activeEventId !== null && gate.activeEventId === eventId) {
    gate.activeEventId = null;
    gate.recordingEndedAt = now;
    return { kind: "accept_end", eventId, cameraName };
  }
  return {
    kind: "drop_stale",
    eventId,
    cameraName,
    reason: "end_no_active_match",
  };
}

/** Test-only — clears all per-camera state. */
export function resetCameraEventGateForTests(): void {
  gates.clear();
}
