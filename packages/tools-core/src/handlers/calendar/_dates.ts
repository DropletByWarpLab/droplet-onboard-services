// Parse a date string from the model into a Date. Accepts ISO-8601 (the
// preferred form) and a few looser shapes the model emits when it forgets
// the time zone. Returns null on garbage so callers can return a clean
// error instead of persisting an Invalid Date.
export function parseModelDate(input: unknown): Date | null {
  if (typeof input !== "string" || input.length === 0) return null;
  const d = new Date(input);
  return isNaN(d.getTime()) ? null : d;
}
