/**
 * WARP-3511 — what the camera surfaces say about a camera's recording.
 *
 * Pure functions, so the wording rules live in one place and the tile, the
 * detail rail and the settings header cannot describe the same camera two
 * different ways.
 *
 * Two rules run through all of it:
 *
 *  - `null` is "not known", never zero. A figure the box could not give is
 *    left out; it is not rendered as "0 B" or "never".
 *  - A DEGRADED camera (the camera service could not be read) is never
 *    described as recording, and never as "not saving" either. Both are
 *    claims, and the box has just said it cannot back either of them — the
 *    camera-tile honesty guideline: never paint a state there is no reading
 *    behind.
 *
 * No retention figure is hard-coded here or in the copy built from it: the
 * numbers come from the camera's own windows, which are changing by box and
 * by release.
 */
import type {
  CameraInfo,
  CameraRecordingState,
  RecordingDay,
  RecordingMode,
  RetentionBackfillDefaults,
  RetentionWindows,
} from "./types";

type HasRecording = Pick<CameraInfo, "recording">;

/**
 * A camera keeping 24/7 footage writes a segment about every ten seconds.
 * Two minutes without one means the writer has stalled, which is the case
 * worth a warning. Motion and event cameras write only when something
 * happens, so for them an old last write is simply a quiet camera.
 */
export const STALE_CONTINUOUS_SAVE_SEC = 120;

// --- degraded -------------------------------------------------------------

/** The camera service could not be read for this camera. */
export function isRecordingDegraded(camera: HasRecording): boolean {
  return camera.recording?.degraded === true;
}

/**
 * Every camera shares one Frigate reading, so a degraded camera means a
 * degraded service. A payload with no recording block is an older box, not a
 * degraded one.
 */
export function isServiceDegraded(cameras: ReadonlyArray<HasRecording>): boolean {
  return cameras.some(isRecordingDegraded);
}

// --- words ----------------------------------------------------------------

/** The short chip on a tile. */
export const MODE_CHIP_LABEL: Record<RecordingMode, string> = {
  continuous: "24/7",
  motion: "Motion",
  events: "Events",
  off: "Off",
};

/** The same mode, as a sentence a household member can read. */
export const MODE_SENTENCE: Record<RecordingMode, string> = {
  continuous: "Saves everything, around the clock.",
  motion: "Saves footage when something moves.",
  events: "Saves clips of detected events only.",
  off: "Not saving footage.",
};

const STATUS_LABEL: Record<CameraInfo["status"], string> = {
  recording: "Recording",
  detecting: "Detecting",
  live: "Live · not saving",
  idle: "Idle",
  offline: "Offline",
};

/** What a status badge reads. Degraded wins: the status itself is unknown. */
export function statusLabel(camera: Pick<CameraInfo, "status" | "recording">): string {
  return isRecordingDegraded(camera) ? "Status unavailable" : STATUS_LABEL[camera.status];
}

// --- retention ------------------------------------------------------------

const WINDOW_LABEL: Record<keyof RetentionWindows, string> = {
  continuous: "24/7 footage",
  motion: "Motion footage",
  alerts: "Alert clips",
  detections: "Other detections",
};

const WINDOW_ORDER: Array<keyof RetentionWindows> = ["continuous", "motion", "alerts", "detections"];

/** "1 day" / "3 days" / "0.5 days" — Frigate stores days as a float. */
export function formatDays(days: number): string {
  const text = Number.isInteger(days) ? String(days) : days.toFixed(1);
  return `${text} ${days === 1 ? "day" : "days"}`;
}

/**
 * The windows that are open, in a fixed order, with the camera's own numbers.
 * Empty when nothing is kept or nothing is known: a configured window on a
 * camera that is switched off keeps nothing, and listing it would claim it did.
 */
export function describeRetention(
  recording: CameraRecordingState | null | undefined,
): Array<{ key: keyof RetentionWindows; label: string; days: number }> {
  if (!recording || recording.degraded || recording.mode === null || recording.mode === "off") return [];
  const windows = recording.retentionDays;
  if (!windows) return [];
  return WINDOW_ORDER.filter((key) => windows[key] > 0).map((key) => ({
    key,
    label: WINDOW_LABEL[key],
    days: windows[key],
  }));
}

/**
 * What the retention repair would keep, as one line, from the box's own
 * figures: "24/7 footage: 7 days · Motion footage: 30 days · …". Empty when the
 * box reported none (an older box) or every window is closed, so the caller says
 * nothing rather than guessing a number.
 */
export function describeRepairWindows(defaults: RetentionBackfillDefaults | null | undefined): string {
  if (!defaults) return "";
  const windows: RetentionWindows = {
    continuous: defaults.continuousDays,
    motion: defaults.motionDays,
    alerts: defaults.alertsRetainDays,
    detections: defaults.detectionsRetainDays,
  };
  return WINDOW_ORDER.filter((key) => windows[key] > 0)
    .map((key) => `${WINDOW_LABEL[key]}: ${formatDays(windows[key])}`)
    .join(" · ");
}

/** The longest open window: how far back anything might be. 0 when nothing is kept or known. */
export function maxRetentionDays(recording: CameraRecordingState | null | undefined): number {
  return describeRetention(recording).reduce((max, w) => Math.max(max, w.days), 0);
}

/**
 * The hover text on a tile's mode chip: the mode as a sentence, then each open
 * window with the camera's own days. Empty when there is nothing to say.
 */
export function modeTooltip(recording: CameraRecordingState | null | undefined): string {
  if (!recording || recording.degraded || recording.mode === null) return "";
  const sentence = MODE_SENTENCE[recording.mode];
  const windows = describeRetention(recording);
  if (windows.length === 0) return sentence;
  return `${sentence} Keeps ${windows.map((w) => `${w.label}: ${formatDays(w.days)}`).join(" · ")}.`;
}

// --- the newest write ------------------------------------------------------

/** "just now", "12s ago", "5 min ago", "3 h ago", "2 d ago". */
export function formatSavedAgo(iso: string, nowMs: number = Date.now()): string {
  const sec = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000));
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

export type SavedTone = "ok" | "warn" | "muted";

/**
 * What the tile says about the newest write, or null for nothing to say.
 *
 * Silent for a camera that is not saving (the badge and the mode chip already
 * say so), is offline (nothing is writing), is degraded (nothing can be
 * claimed) or comes from a box that does not report it.
 */
export function describeLastSaved(
  camera: Pick<CameraInfo, "status" | "recording">,
  nowMs: number = Date.now(),
): { text: string; tone: SavedTone } | null {
  const rec = camera.recording;
  if (!rec || rec.degraded || rec.mode === null || rec.mode === "off") return null;
  if (camera.status === "offline") return null;
  if (rec.lastSegmentReadFailed) return { text: "Last save unavailable", tone: "muted" };

  if (rec.lastSegmentAt) {
    const ageSec = (nowMs - Date.parse(rec.lastSegmentAt)) / 1000;
    const stalled = rec.mode === "continuous" && ageSec > STALE_CONTINUOUS_SAVE_SEC;
    return { text: `Saved ${formatSavedAgo(rec.lastSegmentAt, nowMs)}`, tone: stalled ? "warn" : "ok" };
  }
  // Nothing found in the recent window. For a 24/7 camera that is a fault;
  // for one that saves on motion or events it is just a quiet camera.
  return rec.mode === "continuous"
    ? { text: "Nothing saved recently", tone: "warn" }
    : { text: "No recent footage", tone: "muted" };
}

// --- storage ----------------------------------------------------------------

/**
 * Binary maths with binary labels.
 *
 * This divided by 1024 while labelling the result "KB"/"MB"/"GB" — SI names
 * for binary quantities, so every drive figure read ~2.4% low against the
 * label it carried (WARP-1960). Frigate reports MiB and the array is sized in
 * TiB, so binary is the right base; the labels are what were wrong.
 *
 * Shared by the tile, the rails and the Camera system page so a camera's
 * usage reads the same everywhere.
 */
export function formatStorageBytes(b: number): string {
  if (!Number.isFinite(b) || b < 0) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = b;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

/** A measured rate scaled to a day: approximate, and said so. */
export function formatBytesPerDay(bytesPerDay: number): string {
  return `≈ ${formatStorageBytes(bytesPerDay)}/day`;
}

// --- days stored --------------------------------------------------------------

/**
 * How far back there is actual footage, from the recordings summary (which the
 * Recordings page already reads): measured from the oldest hour that has
 * duration, not from the retention setting. An hour with no duration is not
 * stored footage.
 */
export function summarizeStoredFootage(
  days: ReadonlyArray<RecordingDay>,
  now: Date = new Date(),
): { since: Date; days: number } | null {
  let oldest: Date | null = null;
  for (const entry of days) {
    const [y, m, d] = String(entry.day).split("-").map(Number);
    if (!y || !m || !d) continue;
    for (const hour of entry.hours ?? []) {
      if (!(hour.duration > 0)) continue;
      const at = new Date(y, m - 1, d, hour.hour, 0, 0);
      if (!oldest || at < oldest) oldest = at;
    }
  }
  if (!oldest) return null;
  return { since: oldest, days: Math.max(0, (now.getTime() - oldest.getTime()) / 86_400_000) };
}

/** "Under a day", "2.6 days", "30 days" — a span, not a precise count. */
export function formatStoredDays(days: number): string {
  if (days < 1) return "Under a day";
  if (days < 10) return `${days.toFixed(1)} days`;
  return `${Math.round(days)} days`;
}
