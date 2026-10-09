/**
 * WARP-3927 / WARP-3747 — time handling shared by the camera tools.
 *
 * The orchestrator's camera routes speak epoch seconds; the model and the
 * household speak wall-clock time ("yesterday evening", "2026-10-07 18:30").
 * Every camera tool therefore (a) accepts ISO 8601 or a natural
 * `YYYY-MM-DD HH:mm` and converts it to epoch seconds, and (b) returns local
 * ISO times next to the epoch fields so the model never has to do zone
 * arithmetic itself.
 *
 * WHICH ZONE. The workspace zone is the one the camera business-hours
 * settings carry (`cameras.business_hours` in `SystemFlag`, the same row the
 * orchestrator's `camera-business-hours.service.ts` reads) once the owner has
 * saved them. Until then — the stored default is a placeholder "UTC" — the
 * box's own zone, which is what `get_current_datetime` reports. A wall time
 * with an explicit offset (`...Z`, `...+02:00`) always wins over both.
 *
 * Helper file only: it makes no HTTP call, so it has no TOOL_ROUTES row.
 */
import type { ToolContext } from "../../types.js";

/** Same key camera-business-hours.service.ts stores the schedule under. */
const BUSINESS_HOURS_KEY = "cameras.business_hours";

function isValidZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The zone every time in a camera tool's input and output is read in. */
export async function resolveWorkspaceTimezone(ctx: ToolContext): Promise<string> {
  try {
    const row = await ctx.prisma.systemFlag.findUnique({ where: { key: BUSINESS_HOURS_KEY } });
    const v = row?.valueJson as { configured?: unknown; timezone?: unknown } | null | undefined;
    if (v && v.configured === true && isValidZone(v.timezone)) return v.timezone;
  } catch {
    // No database handle (or the row is unreadable): fall through to the box zone.
  }
  const system = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return isValidZone(system) ? system : "UTC";
}

// ── shared schema fragments (kept short: every tool is advertised to the model) ──

/** `after` / `before` as every camera tool declares them. */
export const AFTER_PROP = {
  type: "string",
  description: "Start: ISO 8601 or YYYY-MM-DD HH:mm (workspace time zone).",
} as const;
export const BEFORE_PROP = { type: "string", description: "End, same formats." } as const;

// ── formatting ──────────────────────────────────────────────────────────

const formatters = new Map<string, Intl.DateTimeFormat>();
function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    // en-CA renders Y-M-D digit order; h23 avoids the "24:00" midnight quirk.
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Offset in ms such that `utcMs + offset` is the wall clock in `timeZone`. */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const fields: Record<string, number> = {};
  for (const p of zoneFormatter(timeZone).formatToParts(new Date(utcMs))) {
    if (p.type !== "literal") fields[p.type] = Number(p.value);
  }
  const wallAsUtc = Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute, fields.second);
  return wallAsUtc - Math.floor(utcMs / 1000) * 1000;
}

/** `2026-10-07T18:30:05-07:00` — local wall time in `timeZone`, numeric offset. */
export function formatIsoInZone(epochSeconds: number, timeZone: string): string {
  const ms = Math.floor(epochSeconds) * 1000;
  const parts = zoneFormatter(timeZone).formatToParts(new Date(ms));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const offsetMin = Math.round(zoneOffsetMs(ms, timeZone) / 60000);
  const sign = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}${offset}`;
}

/**
 * Add `startTimeIso` / `endTimeIso` beside the epoch fields (kept: nothing
 * downstream may break). `endTimeIso` is null for an event still in progress.
 */
export function withLocalTimes<T extends Record<string, unknown>>(
  row: T,
  timeZone: string,
): T & { startTimeIso: string | null; endTimeIso: string | null } {
  const start = typeof row.startTime === "number" && Number.isFinite(row.startTime) ? row.startTime : null;
  const end = typeof row.endTime === "number" && Number.isFinite(row.endTime) ? row.endTime : null;
  return {
    ...row,
    startTimeIso: start === null ? null : formatIsoInZone(start, timeZone),
    endTimeIso: end === null ? null : formatIsoInZone(end, timeZone),
  };
}

// ── parsing ─────────────────────────────────────────────────────────────

const NATURAL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export type ParsedTime = { ok: true; epoch: number } | { ok: false; message: string };

/**
 * One instant from `value`, as epoch seconds.
 *
 *   - a number: epoch SECONDS (a millisecond value is refused, not guessed at);
 *   - `YYYY-MM-DD` (local midnight), `YYYY-MM-DD HH:mm[:ss]` / `...THH:mm[:ss]`
 *     read as wall time in `timeZone`;
 *   - the same with `Z` or a numeric offset: that offset wins.
 *
 * A wall time the zone skips (spring-forward gap) is refused; one it repeats
 * (fall-back hour) resolves to its FIRST occurrence — give an offset to mean
 * the second.
 */
export function parseTimeInput(value: unknown, timeZone: string, field: string): ParsedTime {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 1e9 || value > 4e9) {
      return {
        ok: false,
        message: `${field} must be epoch SECONDS (a value between 1e9 and 4e9), an ISO 8601 time, or "YYYY-MM-DD HH:mm"`,
      };
    }
    return { ok: true, epoch: Math.floor(value) };
  }
  if (typeof value !== "string" || value.trim() === "") {
    return { ok: false, message: `${field} must be an ISO 8601 time or "YYYY-MM-DD HH:mm"` };
  }
  const m = NATURAL_RE.exec(value.trim());
  if (!m) {
    return { ok: false, message: `${field} "${value.slice(0, 40)}" is not an ISO 8601 time or "YYYY-MM-DD HH:mm"` };
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = m[4] === undefined ? 0 : Number(m[4]);
  const minute = m[5] === undefined ? 0 : Number(m[5]);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  if (
    month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) ||
    hour > 23 || minute > 59 || second > 59 || year < 2000
  ) {
    return { ok: false, message: `${field} "${value.slice(0, 40)}" is not a real calendar time` };
  }
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const explicit = m[7];
  if (explicit !== undefined) {
    if (explicit === "Z") return { ok: true, epoch: Math.floor(wallAsUtc / 1000) };
    const sign = explicit[0] === "-" ? -1 : 1;
    const digits = explicit.slice(1).replace(":", "");
    const offsetMin = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2));
    if (Number(digits.slice(0, 2)) > 14 || Number(digits.slice(2)) > 59) {
      return { ok: false, message: `${field} has an invalid UTC offset` };
    }
    return { ok: true, epoch: Math.floor((wallAsUtc - sign * offsetMin * 60000) / 1000) };
  }
  // Wall time in the workspace zone. The offset is constant except across a
  // transition, which is at most once either side of any day, so probing
  // ±1 day brackets the (up to two) candidate offsets.
  const offsets = new Set([zoneOffsetMs(wallAsUtc - 86_400_000, timeZone), zoneOffsetMs(wallAsUtc + 86_400_000, timeZone)]);
  const candidates = [...offsets]
    .map((o) => wallAsUtc - o)
    .filter((t) => zoneOffsetMs(t, timeZone) === wallAsUtc - t)
    .sort((a, b) => a - b);
  if (candidates.length === 0) {
    return {
      ok: false,
      message: `${field} "${value.slice(0, 40)}" does not exist in ${timeZone} (clocks skip forward at that time); use a time just before or after`,
    };
  }
  return { ok: true, epoch: Math.floor(candidates[0] / 1000) };
}

// ── windows ─────────────────────────────────────────────────────────────

/** Clock skew allowed before a time counts as "in the future". */
const FUTURE_SKEW_SECONDS = 120;

export interface ResolvedWindow {
  after: number;
  before: number;
  /** Set when `before` was pulled back to "now" (a window cannot end in the future). */
  clampedToNow: boolean;
}

export type WindowResult = { ok: true; window: ResolvedWindow } | { ok: false; message: string };

/**
 * Both ends of a window. `after` is required; `before` defaults to now. A
 * `before` in the (near) future is clamped to now and reported, an `after` in
 * the future is refused, `before <= after` is refused, and the span is capped
 * at `maxSeconds`.
 */
export function resolveWindow(
  args: { after?: unknown; before?: unknown },
  timeZone: string,
  nowSeconds: number,
  maxSeconds: number,
  maxLabel: string,
): WindowResult {
  if (args.after === undefined || args.after === null || args.after === "") {
    return { ok: false, message: "after is required (the start of the period)" };
  }
  const a = parseTimeInput(args.after, timeZone, "after");
  if (!a.ok) return { ok: false, message: a.message };
  let before = nowSeconds;
  let clampedToNow = args.before === undefined || args.before === null || args.before === "";
  if (!clampedToNow) {
    const b = parseTimeInput(args.before, timeZone, "before");
    if (!b.ok) return { ok: false, message: b.message };
    before = b.epoch;
  }
  if (before > nowSeconds) {
    before = nowSeconds;
    clampedToNow = true;
  }
  if (a.epoch > nowSeconds + FUTURE_SKEW_SECONDS) {
    return { ok: false, message: "after is in the future; there is no footage or activity to look at yet" };
  }
  if (before <= a.epoch) {
    return { ok: false, message: "before must be later than after" };
  }
  if (before - a.epoch > maxSeconds) {
    return { ok: false, message: `the period is longer than ${maxLabel}; ask for a shorter window (or several)` };
  }
  return { ok: true, window: { after: a.epoch, before, clampedToNow } };
}

/** `1h 05m` / `42m` / `30s` — a duration the model can read aloud. */
export function humanDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}
