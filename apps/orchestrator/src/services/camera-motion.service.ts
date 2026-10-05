import type { PrismaClient } from "@prisma/client";
import { fetchRecordings } from "./frigate.client.js";
import { createBusinessHoursClassifier, getCameraBusinessHours, type BusinessHoursFilter } from "./camera-business-hours.service.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("camera-motion");
export interface MotionActivity {
  id: string;
  camera: string;
  startTime: number;
  endTime: number;
  /** Sum of Frigate's raw retained-segment motion counts, not a percentage. */
  motion: number;
  outsideBusinessHours: boolean | null;
  playbackUrl: string;
}
export interface MotionCoverage {
  camera: string;
  recordedSeconds: number | null;
  hasGaps: boolean;
  available: boolean;
}
export interface MotionActivityResult {
  activity: MotionActivity[];
  nextCursor: number | null;
  scanLimitReached: false;
  coverage: { after: number; before: number; partial: boolean; cameras: MotionCoverage[] };
}
export interface MotionFilter {
  after: number;
  before: number;
  cursor?: number;
  businessHours?: BusinessHoursFilter;
  limit: number;
}

type Segment = { start: number; end: number; motion: number };
function segmentsInWindow(raw: unknown[], after: number, before: number): Segment[] {
  return raw.flatMap((value) => {
    if (!value || typeof value !== "object") throw new Error("invalid_recording_segment");
    const row = value as Record<string, unknown>;
    if (typeof row.start_time !== "number" || !Number.isFinite(row.start_time)
      || typeof row.end_time !== "number" || !Number.isFinite(row.end_time) || row.end_time <= row.start_time
      || typeof row.motion !== "number" || !Number.isFinite(row.motion) || row.motion < 0) {
      // Unknown motion metadata cannot be treated as a covered quiet segment.
      throw new Error("invalid_recording_segment");
    }
    const start = Math.max(after, row.start_time);
    const end = Math.min(before, row.end_time);
    if (end <= start) return [];
    return [{ start, end, motion: row.motion }];
  }).sort((a, b) => a.start - b.start);
}

function recordedSeconds(segments: Segment[]): number {
  let total = 0, coveredUntil = -Infinity;
  for (const segment of segments) {
    total += Math.max(0, segment.end - Math.max(segment.start, coveredUntil));
    coveredUntil = Math.max(coveredUntil, segment.end);
  }
  return total;
}

/** Motion is retained-segment evidence, not object-review severity. Frigate's
 * /review/activity/motion normalizes counts within each hour and can turn a
 * constant positive count into zero; raw /:camera/recordings does not. A bounded
 * day window is fully queried before hours filtering and pagination. */
export async function getMotionActivity(prisma: PrismaClient, cameras: string[], filter: MotionFilter): Promise<MotionActivityResult> {
  const classify = createBusinessHoursClassifier(await getCameraBusinessHours(prisma));
  const outcomes = await Promise.allSettled([...new Set(cameras)].map(async (camera) => {
    const raw = await fetchRecordings(camera, filter.after, filter.before);
    if (!Array.isArray(raw)) throw new Error("invalid_recordings_response");
    const segments = segmentsInWindow(raw, filter.after, filter.before);
    const windows: Array<{ start: number; end: number; motion: number }> = [];
    for (const segment of segments) {
      if (segment.motion <= 0) continue;
      const previous = windows[windows.length - 1];
      if (previous && segment.start <= previous.end) {
        previous.end = Math.max(previous.end, segment.end);
        previous.motion += segment.motion;
      } else windows.push({ ...segment });
    }
    const duration = recordedSeconds(segments);
    const coverage: MotionCoverage = { camera, recordedSeconds: duration,
      hasGaps: duration < filter.before - filter.after, available: true };
    const activity: MotionActivity[] = windows.map((window) => ({
      id: `motion-${camera}-${window.start}`,
      camera, startTime: window.start, endTime: window.end, motion: window.motion,
      outsideBusinessHours: classify(window.start, window.end),
      playbackUrl: `/api/cameras/${encodeURIComponent(camera)}/playback.m3u8?after=${window.start}&before=${window.end}`,
    }));
    return { coverage, activity };
  }));
  const coverage: MotionCoverage[] = [];
  const activity: MotionActivity[] = [];
  const names = [...new Set(cameras)];
  outcomes.forEach((outcome, index) => {
    if (outcome.status === "fulfilled") {
      coverage.push(outcome.value.coverage);
      activity.push(...outcome.value.activity);
    } else {
      logger.warn({ camera: names[index], err: outcome.reason }, "retained motion data unavailable");
      coverage.push({ camera: names[index], recordedSeconds: null, hasGaps: true, available: false });
    }
  });
  const matching = activity.filter((window) =>
    (filter.cursor === undefined || window.startTime < filter.cursor)
    && (!filter.businessHours || window.outsideBusinessHours === (filter.businessHours === "outside")),
  ).sort((a, b) => b.startTime - a.startTime || a.camera.localeCompare(b.camera));
  let end = Math.min(filter.limit, matching.length);
  // Numeric cursors cannot split equal-time windows from different cameras.
  while (end < matching.length && matching[end].startTime === matching[end - 1].startTime) end++;
  const page = matching.slice(0, end);
  return { activity: page, nextCursor: end < matching.length && page.length ? page[page.length - 1].startTime : null,
    scanLimitReached: false, coverage: { after: filter.after, before: filter.before,
      partial: coverage.some((camera) => !camera.available), cameras: coverage } };
}
