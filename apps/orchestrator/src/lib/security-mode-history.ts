/**
 * WARP-2978 (ADR-059 P3 spec §6.4, D20) — the site mode at an INSTANT, pure.
 *
 * P2b's `mode_changed` rows carry `labels = [mode, modeSource, fromMode]`
 * (a CHECK pins the shape) and are stamped at the boundary instant, so the
 * rows alone record every change of the stored mode. The incident engine
 * (services/security-incidents.service.ts, `loadModeTimeline`) reads ONE
 * snapshot — the stored SecurityModeState, the opening hours, and every row
 * from shortly before the oldest event it is about to judge — and asks here.
 *
 * `modeAt(tl, t)`:
 *   · a row with `at > t` exists → the EARLIEST such row's `fromMode`. A row
 *     records the mode just before it, and P2b's `catchUpLaggingMode` writes a
 *     missed flip before any person's change, so the rows are gap-free across
 *     manual actions;
 *   · no row after t → `resolveMode(stored, hours, t)`. The stored MODE has
 *     not changed since t (a change would have written a row), and resolving
 *     it at t gives what the ticker would have written — which covers a ticker
 *     lagging past a boundary, a manual mode that expired (`>=`), and an Open
 *     up that ended;
 *   · hours unreadable → the stored mode, `source: 'stored_fallback'` (the
 *     site_mode health row is already down in that case).
 *
 * NOT "the latest row at or before t": when the ticker lags a boundary that
 * row is the old mode, and an after-hours visit in the minute after closing
 * would read as open (the mutation this file's tests pin).
 *
 * Known imprecision: an hours edit made seconds after t, with no mode row in
 * between, evaluates t against the new hours. Rules run within seconds of an
 * event's arrival, so this is negligible.
 */
import type { SecurityMode, SecurityModeSource } from "@prisma/client";
import { resolveMode, type ModeFields } from "./security-mode.js";
import type { SiteHours } from "./security-hours.js";

/** One `mode_changed` row, parsed. */
export interface ModeHistoryRow {
  /** The row's startedAt — the boundary instant the change took effect. */
  at: Date;
  mode: SecurityMode;
  source: SecurityModeSource;
  fromMode: SecurityMode;
}

export interface ModeTimeline {
  /** The stored SecurityModeState (its defaults when the row does not exist yet). */
  stored: ModeFields;
  /** The opening hours; null when they cannot be evaluated (`loadSiteHours` said ok:false). */
  hours: SiteHours | null;
  /** `mode_changed` rows, ascending by (startedAt, id). */
  rows: readonly ModeHistoryRow[];
}

/**
 * Where an answer came from. `unknown`: a history answer (a row after t)
 * whose own setter row is outside the loaded window — the mode is known, how
 * it was set is not, and it is never guessed.
 */
export type ModeAtSource = SecurityModeSource | "stored_fallback" | "unknown";

export interface ModeAt {
  mode: SecurityMode;
  source: ModeAtSource;
}

export interface NonOpenInstant {
  at: Date;
  mode: Exclude<SecurityMode, "open">;
  source: ModeAtSource;
}

const MODES: ReadonlySet<string> = new Set(["open", "closed", "away"]);
const SOURCES: ReadonlySet<string> = new Set(["schedule", "manual"]);

/** A stored row as the history reads it, or null when its labels are not `[mode, modeSource, fromMode]` (fromMode ≠ mode). */
export function parseModeRow(r: { startedAt: Date; labels: readonly string[] }): ModeHistoryRow | null {
  if (r.labels.length !== 3) return null;
  const [mode, source, fromMode] = r.labels as [string, string, string];
  if (!MODES.has(mode) || !SOURCES.has(source) || !MODES.has(fromMode) || mode === fromMode) return null;
  return { at: r.startedAt, mode: mode as SecurityMode, source: source as SecurityModeSource, fromMode: fromMode as SecurityMode };
}

/** Index of the earliest row with `at > t` (rows.length when none). */
function firstAfter(rows: readonly ModeHistoryRow[], t: number): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (rows[mid]!.at.getTime() > t) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** The site mode at `t` (see the file header for why each branch is right). */
export function modeAt(tl: ModeTimeline, t: Date): ModeAt {
  const i = firstAfter(tl.rows, t.getTime());
  if (i < tl.rows.length) {
    const mode = tl.rows[i]!.fromMode;
    // How that mode was set: the row that set it, when it is in the window.
    const setter = i > 0 ? tl.rows[i - 1]! : null;
    return { mode, source: setter && setter.mode === mode ? setter.source : "unknown" };
  }
  if (tl.hours) {
    const r = resolveMode(tl.stored, tl.hours, t);
    return { mode: r.mode, source: r.source };
  }
  return { mode: tl.stored.mode, source: "stored_fallback" };
}

/**
 * The first instant in `[s, e]` at which the site was not open, or null.
 * Checks `s`, then every mode row with `at ∈ (s, e]` (the mode it switched to,
 * at the instant it switched), then `e` — so a visit that straddles closing,
 * or a closed spell strictly inside an open span, is caught, and so is a
 * straddle whose closing row the ticker has not written yet (at `e`).
 */
export function nonOpenWithin(tl: ModeTimeline, s: Date, e: Date): NonOpenInstant | null {
  const check = (t: Date): NonOpenInstant | null => {
    const m = modeAt(tl, t);
    return m.mode === "open" ? null : { at: t, mode: m.mode, source: m.source };
  };
  const atStart = check(s);
  if (atStart) return atStart;
  const sMs = s.getTime();
  const eMs = e.getTime();
  for (let i = firstAfter(tl.rows, sMs); i < tl.rows.length; i++) {
    const r = tl.rows[i]!;
    if (r.at.getTime() > eMs) break;
    if (r.mode !== "open") return { at: r.at, mode: r.mode, source: r.source };
  }
  return eMs > sMs ? check(e) : null;
}
