/**
 * WARP-225 — relative-timestamp helper.
 *
 * Renders an ISO timestamp (or ms epoch) as a coarse human string:
 * "just now" | "3 minutes ago" | "2 hours ago" | "yesterday" |
 * "3 days ago". For older items we fall back to the locale date so
 * the UI never says "62 days ago", which reads as low-quality copy.
 *
 * Pure — no React, no Intl side-effects beyond `toLocaleDateString`.
 */

export function formatRelativeTime(
  ts: string | number | Date,
  now: Date = new Date(),
): string {
  const then = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(then.getTime())) return "unknown";
  const ms = now.getTime() - then.getTime();
  const sec = Math.round(ms / 1000);

  if (sec < 0) return "just now"; // future timestamps clamp; clock skew tolerance
  if (sec < 30) return "just now";
  if (sec < 90) return "1 minute ago";
  const minutes = Math.round(sec / 60);
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(sec / 3600);
  if (hours < 24)
    return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.round(sec / 86400);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  // Fall back to a stable locale date for anything older than a week.
  return then.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year:
      now.getUTCFullYear() === then.getUTCFullYear() ? undefined : "numeric",
  });
}
