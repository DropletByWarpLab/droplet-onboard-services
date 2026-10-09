/**
 * WARP-3927 — `summarize_camera_activity` LLM tool.
 *
 * The answer to "what happened at the front door overnight?" / "any motion
 * while we were out?": ONE call that reads the three things the Cameras page
 * is built from — detection events (`/api/cameras/events`), graded review
 * items (`/api/cameras/reviews`) and recorded motion
 * (`/api/cameras/motion`) — and returns a compact, bounded summary instead of
 * three raw lists the model would have to merge inside a 16K window.
 *
 * HONESTY IS THE FEATURE. The summary says `incomplete: true`, with the
 * reasons, whenever a source was cut short (page cap, scan limit, a failed
 * lookup) or the footage does not cover the whole period; `coverageNote`
 * always says how much was recorded. A quiet summary over partial footage must
 * never read as an all-clear, so the `headline` repeats the caveat itself.
 *
 * Up to four event stills ride along as `camera_snapshot` media with the
 * event id set (alerts first, then highest score), which is exactly what
 * tool-vision.service.ts (WARP-3692) turns into images for a vision model —
 * this tool does not fetch or embed image bytes itself.
 *
 * Tier-1 read. All three routes are MCP-admitted and scoped to the acting
 * person's cameras (X-Nextcloud-User).
 */
import { eventSnapshotUrl, EVENT_ID_RE } from "@droplet/shared-types";
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { describeCoverage, invalidArgs, parseCameraArg, validMedia } from "./_activity.js";
import { AFTER_PROP, BEFORE_PROP, formatIsoInZone, humanDuration, resolveWindow, resolveWorkspaceTimezone } from "./_time.js";

/** The motion route's ceiling (a day plus a 25-hour DST day). */
const MAX_WINDOW_SECONDS = 26 * 3600;
const EVENT_PAGE_SIZE = 200;
/** Event pages read (newest first); 3 x 200 bounds the work on a busy camera. */
const MAX_EVENT_PAGES = 3;
const MAX_ALERTS_LISTED = 10;
const MAX_NOTABLE = 6;
const MAX_TOP_SPANS = 3;
const MAX_LABELS = 12;
const MAX_CAMERAS_LISTED = 8;
const MAX_STILLS = 4;
const DESCRIPTION_CHARS = 200;

const inputSchema = {
  type: "object",
  properties: {
    camera: { type: "string", description: "Camera name; omit for all." },
    after: AFTER_PROP,
    before: BEFORE_PROP,
  },
  required: ["after"],
  additionalProperties: false,
} as const;

interface EventRow {
  id: string;
  camera: string;
  label: string;
  score: number;
  startTime: number;
  hasSnapshot: boolean;
  description: string | null;
}
interface ReviewRow {
  camera: string;
  severity: string;
  startTime: number;
  endTime: number | null;
  objects: string[];
  zones: string[];
  reviewed: boolean;
  detectionIds: string[];
}
interface SpanRow {
  camera: string;
  startTime: number;
  endTime: number;
  motion: number;
}

type Source<T> = { ok: true; value: T } | { ok: false; reason: string };

const asRecord = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" ? (v as Record<string, unknown>) : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function sortedCounts(m: Map<string, number>, max: number): Record<string, number> {
  return Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max));
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const cam = parseCameraArg(args.camera);
  if (!cam.ok) return invalidArgs(cam.message);
  const timezone = await resolveWorkspaceTimezone(ctx);
  const win = resolveWindow(args, timezone, Math.floor(Date.now() / 1000), MAX_WINDOW_SECONDS, "26 hours");
  if (!win.ok) return invalidArgs(win.message);
  const { after, before } = win.window;
  const scope = cam.camera ? { cameras: cam.camera } : {};
  const json = { Accept: "application/json" };

  // ── events: newest first, a bounded number of pages ─────────────────────
  const readEvents = async (): Promise<Source<{ rows: EventRow[]; capped: boolean; scanLimit: boolean }>> => {
    const rows: EventRow[] = [];
    let cursor = before;
    let capped = false;
    let scanLimit = false;
    for (let page = 0; page < MAX_EVENT_PAGES; page++) {
      const res = await ctx.http.orchestrator.get("/api/cameras/events", {
        headers: json,
        params: { ...scope, after, before: cursor, limit: EVENT_PAGE_SIZE },
      });
      if (!res.ok) {
        if (page === 0) return { ok: false, reason: `detections unavailable (orchestrator returned ${res.status})` };
        capped = true; // later page failed: what we have is partial
        break;
      }
      const body = asRecord(await res.json());
      for (const e of Array.isArray(body?.events) ? (body.events as unknown[]) : []) {
        const r = asRecord(e);
        if (!r || typeof r.id !== "string" || typeof r.camera !== "string" || typeof r.startTime !== "number") continue;
        rows.push({
          id: r.id,
          camera: r.camera,
          label: typeof r.label === "string" ? r.label : "unknown",
          score: typeof r.score === "number" ? r.score : 0,
          startTime: r.startTime,
          hasSnapshot: r.hasSnapshot === true,
          description: typeof r.description === "string" && r.description.trim() !== "" ? r.description.trim() : null,
        });
      }
      if (body?.scanLimitReached === true) scanLimit = true;
      const next = typeof body?.nextCursor === "number" ? body.nextCursor : null;
      if (next === null || next <= after) break;
      if (page === MAX_EVENT_PAGES - 1) capped = true;
      cursor = next;
    }
    return { ok: true, value: { rows, capped, scanLimit } };
  };

  // ── reviews: one page of graded items ───────────────────────────────────
  const readReviews = async (): Promise<Source<{ rows: ReviewRow[]; more: boolean }>> => {
    const res = await ctx.http.orchestrator.get("/api/cameras/reviews", {
      headers: json,
      params: { ...scope, after, before, limit: 200 },
    });
    if (!res.ok) return { ok: false, reason: `review items unavailable (orchestrator returned ${res.status})` };
    const body = asRecord(await res.json());
    const rows: ReviewRow[] = [];
    for (const e of Array.isArray(body?.reviews) ? (body.reviews as unknown[]) : []) {
      const r = asRecord(e);
      if (!r || typeof r.camera !== "string" || typeof r.startTime !== "number") continue;
      rows.push({
        camera: r.camera,
        severity: typeof r.severity === "string" ? r.severity : "detection",
        startTime: r.startTime,
        endTime: typeof r.endTime === "number" ? r.endTime : null,
        objects: strings(r.objects),
        zones: strings(r.zones),
        reviewed: r.hasBeenReviewed === true,
        detectionIds: strings(r.detectionIds),
      });
    }
    const more = (body?.nextCursor !== null && body?.nextCursor !== undefined) || body?.scanLimitReached === true;
    return { ok: true, value: { rows, more } };
  };

  // ── motion: spans + coverage ────────────────────────────────────────────
  const readMotion = async (): Promise<Source<{ rows: SpanRow[]; more: boolean; coverage: unknown }>> => {
    const res = await ctx.http.orchestrator.get("/api/cameras/motion", {
      headers: json,
      params: { ...scope, after, before, limit: 200 },
    });
    if (!res.ok) return { ok: false, reason: `motion unavailable (orchestrator returned ${res.status})` };
    const body = asRecord(await res.json());
    const rows: SpanRow[] = [];
    for (const e of Array.isArray(body?.activity) ? (body.activity as unknown[]) : []) {
      const r = asRecord(e);
      if (!r || typeof r.camera !== "string" || typeof r.startTime !== "number" || typeof r.endTime !== "number") continue;
      rows.push({ camera: r.camera, startTime: r.startTime, endTime: r.endTime, motion: typeof r.motion === "number" ? r.motion : 0 });
    }
    return { ok: true, value: { rows, more: body?.nextCursor !== null && body?.nextCursor !== undefined, coverage: body?.coverage ?? null } };
  };

  const settle = async <T>(p: Promise<Source<T>>, what: string): Promise<Source<T>> => {
    try {
      return await p;
    } catch {
      return { ok: false, reason: `${what} unavailable (orchestrator not reachable)` };
    }
  };
  const [events, reviews, motion] = await Promise.all([
    settle(readEvents(), "detections"),
    settle(readReviews(), "review items"),
    settle(readMotion(), "motion"),
  ]);

  if (!events.ok && !reviews.ok && !motion.ok) {
    return {
      ok: false,
      status: "error",
      error: { code: "SUMMARY_FAILED", message: `could not read any camera data: ${events.reason}; ${reviews.reason}; ${motion.reason}` },
    };
  }

  const reasons: string[] = [];
  for (const s of [events, reviews, motion]) if (!s.ok) reasons.push(s.reason);

  // ── detections ──────────────────────────────────────────────────────────
  const eventRows = events.ok ? events.value.rows : [];
  if (events.ok && events.value.capped) reasons.push(`only the ${MAX_EVENT_PAGES * EVENT_PAGE_SIZE} most recent detections were read`);
  if (events.ok && events.value.scanLimit) reasons.push("the detection scan limit was reached; older matches may exist");
  const byLabel = new Map<string, number>();
  const byCamera = new Map<string, number>();
  const byHour = new Map<string, number>();
  for (const e of eventRows) {
    byLabel.set(e.label, (byLabel.get(e.label) ?? 0) + 1);
    byCamera.set(e.camera, (byCamera.get(e.camera) ?? 0) + 1);
    const hour = `${formatIsoInZone(e.startTime, timezone).slice(0, 13)}:00`.replace("T", " ");
    byHour.set(hour, (byHour.get(hour) ?? 0) + 1);
  }
  const perHour = [...byHour.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([hour, count]) => ({ hour, detections: count }));

  // ── review items: alerts first ──────────────────────────────────────────
  const reviewRows = reviews.ok ? reviews.value.rows : [];
  if (reviews.ok && reviews.value.more) reasons.push("more review items exist than were read");
  const alerts = reviewRows.filter((r) => r.severity === "alert").sort((a, b) => b.startTime - a.startTime);
  const reviewCounts = { alert: alerts.length, detection: 0, significant_motion: 0 };
  for (const r of reviewRows) {
    if (r.severity === "detection") reviewCounts.detection++;
    else if (r.severity === "significant_motion") reviewCounts.significant_motion++;
  }

  // ── motion + coverage ───────────────────────────────────────────────────
  const coverage = motion.ok ? describeCoverage(motion.value.coverage) : null;
  if (coverage) reasons.push(...coverage.reasons);
  if (motion.ok && motion.value.more) reasons.push("more motion spans exist than were read");
  const topSpans = motion.ok
    ? [...motion.value.rows].sort((a, b) => b.motion - a.motion).slice(0, MAX_TOP_SPANS).map((s) => ({
        camera: s.camera,
        start: formatIsoInZone(s.startTime, timezone),
        end: formatIsoInZone(s.endTime, timezone),
        motion: s.motion,
      }))
    : [];

  // ── notable: GenAI descriptions, strongest first ────────────────────────
  const notable = eventRows
    .filter((e) => e.description !== null)
    .sort((a, b) => b.score - a.score || b.startTime - a.startTime)
    .slice(0, MAX_NOTABLE)
    .map((e) => ({
      camera: e.camera,
      label: e.label,
      time: formatIsoInZone(e.startTime, timezone),
      score: Math.round(e.score * 100) / 100,
      description: (e.description as string).slice(0, DESCRIPTION_CHARS),
    }));

  // ── stills: alert-linked events first, then highest score ───────────────
  const alertEventIds = new Set(alerts.flatMap((a) => a.detectionIds));
  const stills = validMedia(
    eventRows
      .filter((e) => e.hasSnapshot && EVENT_ID_RE.test(e.id))
      .sort((a, b) => Number(alertEventIds.has(b.id)) - Number(alertEventIds.has(a.id)) || b.score - a.score || b.startTime - a.startTime)
      .slice(0, MAX_STILLS)
      .map((e) => ({
        kind: "camera_snapshot",
        camera: e.camera,
        eventId: e.id,
        snapshotUrl: eventSnapshotUrl(e.id),
        label: `${e.label} ${formatIsoInZone(e.startTime, timezone).slice(11, 16)}`,
      })),
    MAX_STILLS,
  );

  const incomplete = reasons.length > 0;
  const period = {
    start: formatIsoInZone(after, timezone),
    end: formatIsoInZone(before, timezone),
    length: humanDuration(before - after),
    ...(win.window.clampedToNow ? { endClampedToNow: true } : {}),
  };

  // One sentence the model can lead with, caveat included.
  const labelText = [...byLabel.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([l, n]) => `${l} ${n}`).join(", ");
  const parts: string[] = [];
  if (events.ok) {
    parts.push(eventRows.length === 0 ? "No detections were recorded" : `${eventRows.length} detections (${labelText})`);
  }
  if (reviews.ok) parts.push(alerts.length === 0 ? "no alerts" : `${alerts.length} alert${alerts.length === 1 ? "" : "s"}`);
  if (motion.ok) parts.push(motion.value.rows.length === 0 ? "no motion in the footage that exists" : `motion in ${motion.value.rows.length}${motion.value.more ? "+" : ""} spans`);
  const headline =
    `${parts.join("; ")}.` +
    (incomplete ? ` THIS IS NOT AN ALL-CLEAR: ${reasons.join("; ")}.` : "");

  return {
    ok: true,
    data: {
      type: "summarize_camera_activity",
      timezone,
      period,
      ...(cam.camera ? { camera: cam.camera } : {}),
      headline,
      incomplete,
      ...(incomplete ? { incompleteReasons: reasons } : {}),
      coverageNote: coverage?.note ?? "Recording coverage could not be read, so a quiet result is not an all-clear.",
      ...(motion.ok ? { coverage: motion.value.coverage } : {}),
      detections: {
        total: eventRows.length,
        byLabel: sortedCounts(byLabel, MAX_LABELS),
        ...(byCamera.size > 1 ? { byCamera: sortedCounts(byCamera, MAX_CAMERAS_LISTED) } : {}),
        perHour,
      },
      reviews: {
        ...reviewCounts,
        alerts: alerts.slice(0, MAX_ALERTS_LISTED).map((a) => ({
          camera: a.camera,
          start: formatIsoInZone(a.startTime, timezone),
          end: a.endTime === null ? null : formatIsoInZone(a.endTime, timezone),
          objects: a.objects,
          zones: a.zones,
          reviewed: a.reviewed,
        })),
        ...(alerts.length > MAX_ALERTS_LISTED ? { alertsNotListed: alerts.length - MAX_ALERTS_LISTED } : {}),
      },
      motion: motion.ok ? { spanCount: motion.value.rows.length, moreSpans: motion.value.more, mostActive: topSpans } : null,
      ...(notable.length > 0 ? { notable } : {}),
      ...(stills.length > 0 ? { media: stills } : {}),
    },
  };
}

const tool: Tool = {
  name: "summarize_camera_activity",
  description:
    "What the cameras saw over a period (max 26h, default end now): detections per label and hour, alerts, motion, footage coverage, up to 4 stills. Use for 'what happened / any motion / anyone come by'. If incomplete or coverageNote shows gaps, say so; never call it an all-clear.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
