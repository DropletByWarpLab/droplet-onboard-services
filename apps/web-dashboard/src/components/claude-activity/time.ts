/**
 * WARP-279 — Relative-time helper for the dashboard. Pure, no deps.
 */

export function relativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";
  const diff = (now.getTime() - then) / 1000; // seconds
  if (diff < 0) {
    // Future timestamps shouldn't really happen on the dashboard but the
    // signal is informative either way; render as "in N".
    return inFuture(-diff);
  }
  if (diff < 60) return "just now";
  if (diff < 60 * 60) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 24 * 60 * 60) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 7 * 24 * 60 * 60) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function inFuture(seconds: number): string {
  if (seconds < 60) return "in seconds";
  if (seconds < 3600) return `in ${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `in ${Math.floor(seconds / 3600)}h`;
  return `in ${Math.floor(seconds / 86400)}d`;
}
