/**
 * WARP-3747 — the time / label / score filters `list_camera_events` and
 * `search_camera_events` forward to the orchestrator's event routes, parsed
 * and validated in one place so the two tools cannot disagree.
 *
 * Before this the tools exposed only camera + limit, so "what did the front
 * door see between 6 and 8 yesterday evening?" could not be asked: the model
 * got the newest N events and a pile of epoch numbers to convert by hand.
 *
 * Helper file only: no HTTP call here, so no TOOL_ROUTES row.
 */
import type { ToolContext } from "../../types.js";
import { AFTER_PROP, BEFORE_PROP, parseTimeInput, resolveWorkspaceTimezone } from "./_time.js";

/** Frigate labels: the same shape the route enforces. */
const LABEL_RE = /^[a-z0-9_-]{1,32}$/i;
const MAX_LABELS = 10;
/** Widest span one event query may cover (matches the recordings routes' 31-day cap). */
const MAX_WINDOW_SECONDS = 31 * 24 * 3600;
/** Skew allowed before a start time counts as "in the future". */
const FUTURE_SKEW_SECONDS = 120;

export const EVENT_FILTER_PROPERTIES = { after: AFTER_PROP, before: BEFORE_PROP } as const;

export interface EventFilters {
  /** Zone the times were read in and are reported in. */
  timezone: string;
  /** Query-string params for the orchestrator route (epoch seconds, csv labels). */
  params: Record<string, string | number>;
  after?: number;
  before?: number;
  /** True when any time/label/score filter was supplied. */
  active: boolean;
}

export type EventFiltersResult = { ok: true; filters: EventFilters } | { ok: false; message: string };

function labelList(raw: unknown): string[] | string {
  if (raw === undefined || raw === null || raw === "") return [];
  const items = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : null;
  if (items === null) return "labels must be a comma-separated string or a list of strings";
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== "string") return "labels must be a comma-separated string or a list of strings";
    const label = item.trim();
    if (label === "") continue;
    if (!LABEL_RE.test(label)) return `"${label.slice(0, 40)}" is not a valid label (letters, digits, underscore, hyphen)`;
    if (!out.includes(label.toLowerCase())) out.push(label.toLowerCase());
  }
  if (out.length > MAX_LABELS) return `at most ${MAX_LABELS} labels`;
  return out;
}

/**
 * @param includeLabelsAndScore  false for tools that only take a time range.
 */
export async function parseEventFilters(
  args: Record<string, unknown>,
  ctx: ToolContext,
  includeLabelsAndScore: boolean,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<EventFiltersResult> {
  const timezone = await resolveWorkspaceTimezone(ctx);
  const params: Record<string, string | number> = {};
  let after: number | undefined;
  let before: number | undefined;

  const present = (v: unknown) => v !== undefined && v !== null && v !== "";
  if (present(args.after)) {
    const a = parseTimeInput(args.after, timezone, "after");
    if (!a.ok) return { ok: false, message: a.message };
    after = a.epoch;
  }
  if (present(args.before)) {
    const b = parseTimeInput(args.before, timezone, "before");
    if (!b.ok) return { ok: false, message: b.message };
    before = b.epoch;
  }
  if (after !== undefined && after > nowSeconds + FUTURE_SKEW_SECONDS) {
    return { ok: false, message: "after is in the future; there are no events yet" };
  }
  if (after !== undefined && before !== undefined) {
    if (before <= after) return { ok: false, message: "before must be later than after" };
    if (before - after > MAX_WINDOW_SECONDS) {
      return { ok: false, message: "the period is longer than 31 days; ask for a shorter window" };
    }
  }
  if (after !== undefined) params.after = after;
  if (before !== undefined) params.before = before;

  if (includeLabelsAndScore) {
    const labels = labelList(args.labels);
    if (typeof labels === "string") return { ok: false, message: labels };
    if (labels.length > 0) params.labels = labels.join(",");
    if (present(args.min_score)) {
      const n = typeof args.min_score === "number" ? args.min_score : typeof args.min_score === "string" ? Number(args.min_score) : NaN;
      if (!Number.isFinite(n) || n < 0 || n > 1) return { ok: false, message: "min_score must be a number between 0 and 1" };
      params.min_score = n;
    }
  }
  return { ok: true, filters: { timezone, params, after, before, active: Object.keys(params).length > 0 } };
}
