/**
 * Formatting helpers for ERP record values (WARP-1101). Money, times, dates,
 * and "synced N ago" are all *data* — rendered mono + read-only in the UI.
 * Self-contained so the ERP surfaces don't couple to other lib helpers.
 */

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const USD_CENTS = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Cents → "$8,240" (default, whole dollars) or "$8,240.50" with `cents: true`. */
export function formatUsd(cents: number, opts?: { cents?: boolean }): string {
  const dollars = cents / 100;
  return opts?.cents ? USD_CENTS.format(dollars) : USD.format(dollars);
}

/** ISO → "9:00 AM". */
export function formatApptTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/** ISO → "Mar 3, 1985" (DOB, visit dates). */
export function formatDate(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** ISO → "Wed, Jul 7" (schedule date stepper). */
export function formatDayLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/**
 * "synced 2 min ago" — coarse relative time for the sync freshness line.
 * `now` is injectable so tests are deterministic (Date.now() is fine at runtime).
 */
export function syncedAgo(iso?: string, now: number = Date.now()): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "never";
  const secs = Math.max(0, Math.round((now - then) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** "in 3 min" — for the next-sync hint. */
export function inFromNow(iso?: string, now: number = Date.now()): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const secs = Math.round((then - now) / 1000);
  if (secs <= 0) return "shortly";
  const mins = Math.round(secs / 60);
  if (mins < 1) return "under a minute";
  if (mins < 60) return `${mins} min`;
  const hrs = Math.round(mins / 60);
  return `${hrs} hr`;
}
