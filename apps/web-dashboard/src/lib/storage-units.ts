/**
 * WARP-1561 — the single storage bytes ⇄ unit contract for the dashboard.
 *
 * Three implementations of this conversion used to ship side by side —
 * `lib/access.ts` (roles & access), `app/users/page.tsx` (per-person usage
 * settings) and `components/Departments/DepartmentsPanel.tsx` (department
 * quotas) — and they did not agree:
 *
 *   • display floor      access.ts stopped at MB, so a 1 KB value read
 *                        "0 MB"; the other two walked down to bytes.
 *   • fraction rounding  the other two rounded anything ≥ 10 to a whole
 *                        number, so a 12.5 GB quota read "13 GB" on the
 *                        people surface and "12.5 GB" on the roles surface.
 *   • empty vs. absent   the departments encoder returned `undefined`
 *                        (omit the field) where the other two returned
 *                        `null` (explicitly: no limit).
 *   • byte fidelity      bytes → editor rounded the GB view to one decimal,
 *                        which is LOSSY. Re-saving an untouched quota drifted
 *                        the stored byte count (~20 MB on a ~1.1 TB value),
 *                        and anything under 0.05 GB rounded to "0" — which
 *                        the reverse direction reads as `null`, silently
 *                        deleting the customer's limit. That is the T8 bug.
 *
 * The rounding policy is now explicit and lives only here:
 *
 *   1. `formatStorageBytes` is DISPLAY ONLY and lossy by design. It picks the
 *      largest unit that leaves a value of at least 1 and renders one decimal
 *      place, or none when the value is whole. It never invents a number:
 *      absent / unparseable / negative input renders an em dash, and zero
 *      does too unless the caller says zero is knowledge rather than absence
 *      (`{ zero: "0 B" }` — used bytes, not a quota).
 *
 *   2. `storageInputToBytes` is the wire encoder: `{value, unit}` → decimal
 *      byte string, or `null` for empty / non-positive input (= no limit).
 *
 *   3. `bytesToStorageInput` is its EXACT inverse. It never rounds a quota
 *      away: it picks the unit and the shortest decimal string that
 *      re-multiplies to the identical byte count, falling back to full
 *      precision rather than drift. Both units are powers of two, so the
 *      quotient is exact in IEEE-754 and the fallback always round-trips.
 *
 * Byte counts cross the wire as decimal strings (the ADR-029 §8 BigInt-string
 * contract). Values above `Number.MAX_SAFE_INTEGER` (≈ 8 PB) cannot survive
 * the `Number()` hop — far beyond any real quota, and the round-trip check
 * below refuses to emit a representation it cannot verify.
 */

/** The units the quota selects offer. Both are powers of two — that is what
 *  makes the round trip exact. */
export const STORAGE_UNIT_BYTES = { GB: 1024 ** 3, TB: 1024 ** 4 } as const;
export type StorageUnit = keyof typeof STORAGE_UNIT_BYTES;

/** Largest-first, so a tie in representation length prefers the larger unit
 *  ("1.2 TB" reads better than the equally short "1228.8 GB"). */
const UNITS_LARGEST_FIRST: readonly StorageUnit[] = ["TB", "GB"];

/** Display ladder — wider than the editor's, because usage figures are not
 *  quotas and legitimately land in bytes or petabytes. */
const DISPLAY_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/** The dashboard-wide "we don't know" glyph (`ACCESS_COPY.unknownValue`,
 *  kept as a literal here so this module stays free of UI imports). */
const UNKNOWN = "—";

/** Decimal places tried before falling back to the exact representation.
 *  Covers everything an admin can plausibly type; beyond it, exactness wins
 *  over prettiness. */
const PRETTY_DECIMALS = 6;

/** Parse a wire byte count. Returns null for anything that is not a finite,
 *  positive number — those all mean "no limit" or "unknown", never zero. */
function parsePositiveBytes(value: string | number | null | undefined): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * Shortest decimal string `s` with `Math.round(Number(s) * unitBytes) === n`,
 * i.e. the prettiest representation that still encodes back to the exact same
 * byte count. `String(q)` is the guaranteed terminator: `q = n / unitBytes` is
 * exact (the unit is a power of two, so the division only shifts the
 * exponent), and `String` emits the shortest decimal that parses back to `q`.
 */
function exactRepresentation(n: number, unitBytes: number): string {
  const quotient = n / unitBytes;
  for (let decimals = 0; decimals <= PRETTY_DECIMALS; decimals++) {
    const candidate = String(Number(quotient.toFixed(decimals)));
    if (Math.round(Number(candidate) * unitBytes) === n) return candidate;
  }
  return String(quotient);
}

/**
 * Byte count → the short human size a surface renders ("25 GB", "4.1 GB").
 *
 * Lossy and one-way — pair it with `bytesToStorageInput` when the value is
 * about to be edited. `zero` picks what a byte count of exactly 0 means on
 * this surface: absence (the default em dash, right for a quota) or the fact
 * that nothing is stored yet (`"0 B"`, right for usage).
 */
export function formatStorageBytes(
  value: string | number | null | undefined,
  { zero = UNKNOWN }: { zero?: typeof UNKNOWN | "0 B" } = {},
): string {
  if (value == null || value === "") return UNKNOWN;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return UNKNOWN;
  if (n === 0) return zero;

  let scaled = n;
  let unit = 0;
  while (scaled >= 1024 && unit < DISPLAY_UNITS.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  // One decimal for fractions, none for whole numbers — `toFixed(1)` then
  // `Number` drops a trailing ".0" without re-introducing float noise.
  return `${Number(scaled.toFixed(1))} ${DISPLAY_UNITS[unit]}`;
}

/**
 * Admin-typed `{value, unit}` → the decimal byte string the API takes.
 * Empty, unparseable or non-positive input is `null` — an explicit "no limit",
 * which is what an empty field means on every quota control in the dashboard.
 */
export function storageInputToBytes(value: string, unit: StorageUnit): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return null;
  return String(Math.round(n * STORAGE_UNIT_BYTES[unit]));
}

/**
 * Byte count → the `{value, unit}` pair the numeric+unit control edits, such
 * that `storageInputToBytes(...)` returns the byte count it started from.
 *
 * Exactness outranks prettiness: a 10 MB quota shows as `0.009765625 GB`
 * rather than the "0" that used to null the limit out on the next save.
 */
export function bytesToStorageInput(
  bytes: string | number | null | undefined,
): { value: string; unit: StorageUnit } {
  const n = parsePositiveBytes(bytes);
  if (n == null) return { value: "", unit: "GB" };

  let best: { value: string; unit: StorageUnit } | null = null;
  for (const unit of UNITS_LARGEST_FIRST) {
    const candidate = exactRepresentation(n, STORAGE_UNIT_BYTES[unit]);
    if (best == null || candidate.length < best.value.length) {
      best = { value: candidate, unit };
    }
  }
  return best!;
}
