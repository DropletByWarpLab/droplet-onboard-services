/**
 * The salutation every surface that greets uses — the Home board, its
 * "Ask AI" tile, the workspace shell and the empty /chat. One set of buckets,
 * so two surfaces open at the same hour never disagree (WARP-3043).
 */

/** "Good morning" and friends, by the local hour. */
export function greetingNow(now: Date = new Date()): string {
  const hr = now.getHours();
  if (hr < 5) return "Still up";
  if (hr < 12) return "Good morning";
  if (hr < 18) return "Good afternoon";
  if (hr < 22) return "Good evening";
  return "Working late";
}

/**
 * "Good morning, Alex." — the first word of the name (a username that is an
 * email or dotted handle stops at the `@` / `.`, like the Home board's), or
 * "Good morning." when there is no name to use.
 */
export function greetingLine(name: string | null | undefined, now: Date = new Date()): string {
  const first = (name ?? "").trim().split(/[\s@.]/)[0] ?? "";
  return first ? `${greetingNow(now)}, ${first}.` : `${greetingNow(now)}.`;
}
