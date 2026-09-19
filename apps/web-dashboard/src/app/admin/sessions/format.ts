/**
 * Relative-time wording for /admin/sessions (WARP-2820).
 *
 * These live beside the page rather than in it because a Next.js page route
 * may only export its default component — a named export from `page.tsx`
 * breaks the build — and because the wording is the part worth testing without
 * mounting anything.
 *
 * THE UNIT IS EPOCH SECONDS, not milliseconds. That is the session store's own
 * unit (`sess:rec:{sid}` records carry `createdAt`/`lastSeenAt` in seconds), and
 * a `new Date(value)` on one of them renders 1970 — which reads as a broken
 * clock rather than as the unit mistake it is.
 */

/** How long ago something happened, in words. Clamped at zero: a record whose
 *  clock is momentarily ahead of the browser's should read "just now", not a
 *  negative age. */
export function ago(epochSeconds: number, now: number): string {
  const secs = Math.max(0, now - epochSeconds);
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** How long is left before a deadline. Never renders a negative remainder: a
 *  session past its deadline has simply not been swept yet, and "-3 min left"
 *  reads as a bug rather than as expiry. */
export function untilPhrase(epochSeconds: number, now: number): string {
  const secs = epochSeconds - now;
  if (secs <= 0) return "expiring now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${Math.max(1, mins)} min left`;
  return `${Math.floor(mins / 60)} h left`;
}
