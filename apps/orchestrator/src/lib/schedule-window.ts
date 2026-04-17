/**
 * Pure evaluator: is the given moment inside the window?
 *
 * Windows are defined in local time with a day-of-week bitmask
 * (Sun=1, Mon=2, Tue=4, Wed=8, Thu=16, Fri=32, Sat=64).
 * Start/end are minutes since local midnight [0, 1440).
 *
 * Midnight-wrap: when endMin <= startMin, the window extends past
 * midnight into the next day. E.g. {Sun, 21:00, 07:00} covers
 * Sunday 21:00 through Monday 07:00.
 *
 * Boundary convention: start inclusive, end exclusive — so 17:00
 * is NOT inside a 09:00-17:00 window.
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
  const dow = now.getDay(); // 0=Sun..6=Sat (JS Date convention)
  const nowMin = minutesOfDay(now);
  const wraps = w.endMin <= w.startMin;

  if (!wraps) {
    // Same-day window: must be the right day AND within [start, end)
    if ((w.daysOfWeek & DAY_BIT[dow]) === 0) return false;
    return nowMin >= w.startMin && nowMin < w.endMin;
  }

  // Wrap window: active if either
  //   (a) today is a start-day AND nowMin >= startMin, OR
  //   (b) YESTERDAY was a start-day AND nowMin < endMin
  const yesterdayDow = (dow + 6) % 7;
  const startToday = (w.daysOfWeek & DAY_BIT[dow]) !== 0 && nowMin >= w.startMin;
  const tailFromYesterday =
    (w.daysOfWeek & DAY_BIT[yesterdayDow]) !== 0 && nowMin < w.endMin;
  return startToday || tailFromYesterday;
}
