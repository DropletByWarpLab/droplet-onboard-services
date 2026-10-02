/**
 * WARP-2977 P2b (ADR-059 §3.6) — the site mode, PURE. What the mode IS right
 * now (`resolveMode`) and what a person's action does to it
 * (`planModeAction`). services/security-mode.service.ts does the I/O.
 *
 * The stored row (SecurityModeState) is what was last WRITTEN. The effective
 * mode is resolved on every read, so a lagging or dead ticker can never show
 * a wrong mode: a manual Close up or Open up whose end has passed reads as the
 * opening hours again even before the ticker writes that down.
 *
 * Semantics (spec §3, §6.3):
 *   · Close up = closed until the hours next OPEN the site (`next_opening`);
 *     with no opening ahead, until someone changes it.
 *   · Open up = open for 1, 2 or 4 hours, capped at the next opening — never
 *     indefinite. An override may persist indefinitely only in the
 *     more-watchful direction.
 *   · Away = until someone changes it. The schedule never produces away.
 *   · Actions are INTENTS applied to the current state: a no-op is
 *     `changed:false`, and a stale page never 409s because the ticker ticked.
 */
import type { SecurityManualEnd, SecurityMode, SecurityModeSource } from "@prisma/client";
import {
  lastChangeAtOrBefore,
  openingAfter,
  scheduledModeAt,
  siteClockCopy,
  type SiteHours,
} from "./security-hours.js";

/** The stored mode columns (a SecurityModeState row satisfies it). */
export interface ModeFields {
  mode: SecurityMode;
  modeSource: SecurityModeSource;
  manualEnd: SecurityManualEnd;
  manualUntil: Date | null;
}

/** The effective mode (spec §6.3 `resolveMode`). */
export interface ResolvedMode {
  mode: SecurityMode;
  source: SecurityModeSource;
  manualEnd: SecurityManualEnd;
  manualUntil: Date | null;
}

export type ModeAction =
  | { action: "close" }
  | { action: "open"; for: OpenFor }
  | { action: "away" }
  | { action: "resume" };

export type OpenFor = "1h" | "2h" | "4h";

export const OPEN_FOR_MS: Readonly<Record<OpenFor, number>> = {
  "1h": 3_600_000,
  "2h": 7_200_000,
  "4h": 14_400_000,
};

/** A manual mode that ends at a time (`next_opening`, `at_time`) whose time has come. `>=`: it ends AT manualUntil. */
export function isManualExpired(state: ModeFields, now: Date): boolean {
  return (
    state.modeSource === "manual" &&
    (state.manualEnd === "next_opening" || state.manualEnd === "at_time") &&
    state.manualUntil !== null &&
    now.getTime() >= state.manualUntil.getTime()
  );
}

function scheduleFields(h: SiteHours, now: Date): ModeFields {
  return { mode: scheduledModeAt(h, now), modeSource: "schedule", manualEnd: "none", manualUntil: null };
}

/** The effective mode at `now`. */
export function resolveMode(state: ModeFields, h: SiteHours, now: Date): ResolvedMode {
  if (state.modeSource === "schedule" || isManualExpired(state, now)) {
    return { mode: scheduledModeAt(h, now), source: "schedule", manualEnd: "none", manualUntil: null };
  }
  return { mode: state.mode, source: state.modeSource, manualEnd: state.manualEnd, manualUntil: state.manualUntil };
}

/** A resolved mode as the columns that would store it. */
export function fieldsOf(r: ResolvedMode): ModeFields {
  return { mode: r.mode, modeSource: r.source, manualEnd: r.manualEnd, manualUntil: r.manualUntil };
}

/** Same four columns (manualUntil compared by instant). */
export function sameModeFields(a: ModeFields, b: ModeFields): boolean {
  return (
    a.mode === b.mode &&
    a.modeSource === b.modeSource &&
    a.manualEnd === b.manualEnd &&
    (a.manualUntil === null ? b.manualUntil === null : b.manualUntil !== null && a.manualUntil.getTime() === b.manualUntil.getTime())
  );
}

export interface ModePlan {
  /** The columns to store. Equal to `fieldsOf(effective)` when `changed` is false. */
  next: ModeFields;
  changed: boolean;
  /** The effective mode the plan was made from. */
  effective: ResolvedMode;
}

/**
 * What `action` does to the current state (spec §6.3's table). `changed` is
 * judged against the EFFECTIVE mode, so an action that only restates it —
 * Close up while the hours already have it closed — writes nothing.
 */
export function planModeAction(current: ModeFields, h: SiteHours, action: ModeAction, now: Date): ModePlan {
  const effective = resolveMode(current, h, now);
  const same = fieldsOf(effective);
  const scheduled = scheduledModeAt(h, now);
  let next: ModeFields;
  switch (action.action) {
    case "close": {
      if (effective.source === "schedule" && effective.mode === "closed") {
        next = same;
      } else if (
        h.state === "set" &&
        scheduled === "closed" &&
        effective.source === "manual" &&
        !(effective.mode === "closed" && effective.manualEnd === "next_opening")
      ) {
        // The hours already have it closed: handing back to them IS closing up.
        next = scheduleFields(h, now);
      } else {
        const opening = openingAfter(h, now);
        next = opening
          ? { mode: "closed", modeSource: "manual", manualEnd: "next_opening", manualUntil: opening }
          : { mode: "closed", modeSource: "manual", manualEnd: "until_changed", manualUntil: null };
      }
      break;
    }
    case "open": {
      if (h.state === "not_set" || scheduled === "open") {
        // Open by the hours already: Open up just ends a manual mode.
        next = effective.source === "manual" ? scheduleFields(h, now) : same;
      } else {
        const opening = openingAfter(h, now);
        const until = now.getTime() + OPEN_FOR_MS[action.for];
        next = {
          mode: "open",
          modeSource: "manual",
          manualEnd: "at_time",
          manualUntil: new Date(opening ? Math.min(until, opening.getTime()) : until),
        };
      }
      break;
    }
    case "away":
      next =
        effective.mode === "away"
          ? same
          : { mode: "away", modeSource: "manual", manualEnd: "until_changed", manualUntil: null };
      break;
    case "resume":
      next = effective.source === "schedule" ? same : scheduleFields(h, now);
      break;
  }
  return { next, changed: !sameModeFields(next, same), effective };
}

/**
 * When the EFFECTIVE mode began — the `setAt` a view shows, and the
 * `startedAt` the ticker stamps its catch-up row with:
 *   · stored = effective → the stored setAt;
 *   · an expired manual mode → the moment it ended (manualUntil, or a later
 *     schedule boundary when the ticker was down past one);
 *   · a schedule flip not yet written → the last boundary at or before now,
 *     never earlier than the stored setAt (else now).
 * Always ≤ now.
 */
export function effectiveSince(state: ModeFields & { setAt: Date }, h: SiteHours, now: Date): Date {
  const effective = resolveMode(state, h, now);
  if (sameModeFields(fieldsOf(effective), state)) return state.setAt;
  const last = lastChangeAtOrBefore(h, now);
  let at: number;
  if (isManualExpired(state, now) && state.manualUntil) {
    at = Math.max(state.manualUntil.getTime(), last ? last.getTime() : Number.NEGATIVE_INFINITY);
  } else {
    at = Math.max(last ? last.getTime() : now.getTime(), state.setAt.getTime());
  }
  return new Date(Math.min(at, now.getTime()));
}

/** What caused a change, for the feed row's summary. */
export type ModeChangeCause =
  | { type: "schedule" }
  | { type: "hours_changed" }
  | { type: "user"; name: string };

const MODE_WORD: Readonly<Record<SecurityMode, string>> = { open: "Open", closed: "Closed", away: "Away" };

/**
 * The `mode_changed` feed row's summary, e.g. `Closed (opening hours)`,
 * `Closed up by Maria`, `Opened by Maria until 9:00 PM`, `Set to away by
 * Stefan`, `Back to opening hours (Maria)`. `tz` is the site zone for the
 * clock time (an Open up always has one: it needs hours to be capped by).
 */
export function modeChangeSummary(next: ModeFields, cause: ModeChangeCause, tz: string | null): string {
  if (cause.type === "schedule") return `${MODE_WORD[next.mode]} (opening hours)`;
  if (cause.type === "hours_changed") return `${MODE_WORD[next.mode]} (opening hours changed)`;
  if (next.modeSource === "schedule") return `Back to opening hours (${cause.name})`;
  switch (next.mode) {
    case "closed":
      return `Closed up by ${cause.name}`;
    case "open":
      return next.manualUntil && tz ? `Opened by ${cause.name} until ${siteClockCopy(next.manualUntil, tz)}` : `Opened by ${cause.name}`;
    case "away":
      return `Set to away by ${cause.name}`;
  }
}
