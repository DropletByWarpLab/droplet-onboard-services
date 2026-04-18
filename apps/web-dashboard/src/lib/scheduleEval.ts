/**
 * Client-side mirror of `apps/orchestrator/src/lib/schedule-window.ts`.
 *
 * Pure evaluator: is the given moment inside the window?
 *
 * Windows are defined in local time with a day-of-week bitmask
 * (Sun=1, Mon=2, Tue=4, Wed=8, Thu=16, Fri=32, Sat=64).
 * Start/end are minutes since local midnight [0, 1440).
 *
 * Midnight-wrap: when endMin <= startMin, the window extends past
 * midnight into the next day.
 *
 * Boundary convention: start inclusive, end exclusive.
 *
 * This file is duplicated verbatim from the orchestrator so the dashboard
 * can show "Active now" dots + "until next transition" chips without a
 * round-trip to the server. Logic MUST stay in sync with the backend —
 * both sides are covered by mirrored test suites.
 */
export interface ScheduleWindowLike {
  daysOfWeek: number;
  startMin: number;
  endMin: number;
}

const DAY_BIT = [1, 2, 4, 8, 16, 32, 64]; // Sun..Sat

function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

export function isWindowActive(w: ScheduleWindowLike, now: Date): boolean {
  const dow = now.getDay(); // 0=Sun..6=Sat
  const nowMin = minutesOfDay(now);
  const wraps = w.endMin <= w.startMin;

  if (!wraps) {
    if ((w.daysOfWeek & DAY_BIT[dow]) === 0) return false;
    return nowMin >= w.startMin && nowMin < w.endMin;
  }

  const yesterdayDow = (dow + 6) % 7;
  const startToday = (w.daysOfWeek & DAY_BIT[dow]) !== 0 && nowMin >= w.startMin;
  const tailFromYesterday =
    (w.daysOfWeek & DAY_BIT[yesterdayDow]) !== 0 && nowMin < w.endMin;
  return startToday || tailFromYesterday;
}

/** Format a day-of-week bitmask + HH:MM range as "Sun-Thu 21:00-07:00" style. */
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatHHMM(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}

export function formatDaysOfWeek(mask: number): string {
  const days: number[] = [];
  for (let i = 0; i < 7; i++) if ((mask & DAY_BIT[i]) !== 0) days.push(i);
  if (days.length === 0) return "";
  if (days.length === 7) return "Every day";
  // Detect contiguous run.
  const isContiguous =
    days.length >= 2 && days.every((d, i) => i === 0 || d === days[i - 1] + 1);
  if (isContiguous) return `${DAY_NAMES[days[0]]}-${DAY_NAMES[days[days.length - 1]]}`;
  return days.map((d) => DAY_NAMES[d]).join(",");
}

export function formatWindow(w: ScheduleWindowLike): string {
  return `${formatDaysOfWeek(w.daysOfWeek)} ${formatHHMM(w.startMin)}-${formatHHMM(w.endMin)}`.trim();
}

// --- WARP-97: next-transition scan used by the override modal ---

interface ScheduleLike {
  windows: ScheduleWindowLike[];
}

/**
 * Given a set of enabled schedules applicable to a subject, find the next
 * minute where the aggregated active/not-active state flips, scanning forward
 * from `now` up to 7 days ahead. Returns `null` if no transition occurs in
 * that window.
 *
 * `isBlocked` reflects the state at the returned minute (i.e. the state the
 * subject is transitioning INTO).
 *
 * Implementation note: naive minute-by-minute scan. Tops out at 10,080 iters
 * per call, which is fine — the override modal opens infrequently and
 * typically works with ≤3 schedules × ~3 windows each. Can be optimized later
 * to jump by hours when in a stable zone if it shows up on a profile.
 */
export function nextTransitionFor(
  schedules: ScheduleLike[],
  now: Date,
): { at: Date; isBlocked: boolean } | null {
  const startMs = now.getTime();
  const isActiveAt = (d: Date): boolean =>
    schedules.some((s) => s.windows.some((w) => isWindowActive(w, d)));

  const initialBlocked = isActiveAt(now);
  for (let min = 1; min <= 7 * 24 * 60; min++) {
    const at = new Date(startMs + min * 60_000);
    const blocked = isActiveAt(at);
    if (blocked !== initialBlocked) return { at, isBlocked: blocked };
  }
  return null;
}
