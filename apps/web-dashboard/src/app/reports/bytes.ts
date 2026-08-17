/**
 * WARP-1993 — byte-string arithmetic for the Folders tile.
 *
 * `GET /api/admin/files/usage` returns sizes as DECIMAL STRINGS, not numbers,
 * because a groupfolder quota can exceed `Number.MAX_SAFE_INTEGER`
 * (9.007 PB). Parsing them with `Number()` is correct for every value anyone
 * will actually see and silently wrong for the ones that matter, which is the
 * worst combination — so everything here goes through BigInt.
 *
 * Three values arrive that are NOT numbers and must survive as themselves:
 *
 *   · `quotaBytes: null`     — unlimited. Renders as an em-dash with NO bar;
 *                              a bar with no ceiling is a meter measuring
 *                              nothing.
 *   · `sizeBytes: "—"`       — the groupfolder could not be resolved. The
 *                              route emits the dash literally. Render it,
 *                              never `0 B` — "we couldn't read this" and
 *                              "this is empty" are different facts.
 *   · a non-numeric string   — same treatment as the dash. Defensive, but the
 *                              cost is one branch.
 */

/**
 * Binary units. Nextcloud reports binary sizes, so 1 GB here is 2^30.
 *
 * Written `BigInt(n)` rather than the `1024n` literal on purpose: this
 * package targets ES2017 and `tsc` rejects BigInt literals below ES2020.
 * Vitest transpiles them happily, so a literal passes every test and then
 * fails the build — use the call form.
 */
const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;
const ZERO = BigInt(0);
const TEN = BigInt(10);
const HUNDRED = BigInt(100);
const STEP = BigInt(1024);

/** The route's own "couldn't read this" marker, emitted verbatim. */
export const UNREADABLE = "—";

/**
 * Parse a wire byte value. Returns `null` for anything that is not a
 * non-negative integer string — including the route's em-dash marker.
 */
export function parseBytes(raw: string | null | undefined): bigint | null {
  if (raw === null || raw === undefined) return null;
  const s = raw.trim();
  // BigInt("") is zero and BigInt("-5") is valid; neither is a size.
  if (!/^\d+$/.test(s)) return null;
  try {
    return BigInt(s);
  } catch {
    return null;
  }
}

/**
 * Human-readable size. Returns the em-dash for anything unparseable, so an
 * unreadable folder and an unset quota render identically — both are "we
 * don't know", which is the honest reading of each.
 */
export function formatBytes(raw: string | null | undefined): string {
  const n = parseBytes(raw);
  if (n === null) return UNREADABLE;
  if (n === ZERO) return "0 B";

  // Integer-only unit selection; the remainder is used for one decimal place
  // rather than converting to Number early and losing precision at the top end.
  let unit = 0;
  let whole = n;
  let remainder = ZERO;
  while (whole >= STEP && unit < UNITS.length - 1) {
    remainder = whole % STEP;
    whole = whole / STEP;
    unit += 1;
  }

  if (unit === 0) return `${whole} B`;

  // One decimal, truncated rather than rounded: a folder at 9.99 GB of a
  // 10 GB quota should not read "10.0 GB" and look already-full.
  const tenths = (remainder * TEN) / STEP;
  return `${whole}.${tenths} ${UNITS[unit]}`;
}

/**
 * Percent of quota used, 0–100+, or `null` when there is no meaningful
 * ratio — unlimited quota, unreadable size, or a zero quota (which would be
 * a division by zero, and is not the same as "full").
 *
 * Rounded DOWN: 99.6% of a quota is not yet 100%, and a bar that reads full
 * before it is full is the kind of small lie that costs trust in a number.
 * The value is allowed to exceed 100 — over-quota is a real state and the
 * caller decides how to show it.
 */
export function usedPercent(
  used: string | null | undefined,
  quota: string | null | undefined,
): number | null {
  const u = parseBytes(used);
  const q = parseBytes(quota);
  if (u === null || q === null || q === ZERO) return null;
  // Scale before dividing so integer division doesn't floor everything to 0.
  return Number((u * HUNDRED) / q);
}

/** Bar tone thresholds — brief §4.4. Under 75 accent, 75–95 warn, above red. */
export type QuotaTone = "ok" | "warn" | "over";

export function quotaTone(percent: number): QuotaTone {
  if (percent > 95) return "over";
  if (percent >= 75) return "warn";
  return "ok";
}

/** Sum a column of wire byte strings, skipping the unreadable ones. */
export function sumBytes(values: Array<string | null | undefined>): bigint {
  let total = ZERO;
  for (const v of values) {
    const n = parseBytes(v);
    if (n !== null) total += n;
  }
  return total;
}

/** Format an already-summed BigInt (the footer total). */
export function formatBigint(n: bigint): string {
  return formatBytes(n.toString());
}
