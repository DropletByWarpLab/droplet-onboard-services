/**
 * WARP-2474 — which value a sync watermark advances on, and how two of them
 * are compared.
 *
 * ## What was broken
 *
 * WARP-2464 added a canonical `updated_at` column to thirteen of the twenty
 * datasets (Xero `UpdatedDateUTC`, Stripe `/v1/events`, HubSpot
 * `hs_lastmodifieddate`, Shopify `updated_at`). WARP-2218's scheduled sync
 * never looked at it: the watermark advanced from the dataset's ORDERING key
 * (`issued_at` for both v1 entities), so an incremental pull re-read every row
 * whose only change was a vendor-side modification — precisely the case the
 * column exists for.
 *
 * ## Why the fallback is a branch and not `??`
 *
 * There are two different "no `updated_at`" shapes and they are not the same
 * value:
 *
 *   column ABSENT     the seven datasets WARP-2464 deliberately withheld it
 *                     from — `appointment`, `patient`, `account`,
 *                     `ap_summary`, `campaign`, `audience`,
 *                     `balance_transaction`. No vendor field could honestly
 *                     fill them.
 *   column PRESENT,   QuickBooks Online and Desktop serve `invoice`/`bill`
 *   value UNDEFINED   from hand-written row builders that emit
 *                     `updated_at: undefined`, matching their `status:
 *                     undefined` precedent.
 *
 * A fallback keyed on column PRESENCE handles the first and regresses the
 * second: it reads "there is an `updated_at`" off a key whose value is
 * `undefined`, and hands that to the watermark. Stringified on the way to a
 * TEXT column that is the literal `"undefined"`; left alone it is a null
 * watermark, which re-enumerates the whole QuickBooks account on every tick.
 * So the test below is on DEFINEDNESS, and `identify` normalises undefined and
 * absent to the same `null` before either reaches here.
 *
 * ## Why the comparison parses instead of comparing strings
 *
 * `entities.ts` is explicit that the marker is "the best available ORDERING
 * key, not a correctness guarantee", and a vendor is free to order by its own
 * record key: Stripe's cursors ARE object ids. A `>` between two such tokens
 * is a lexicographic accident, and it silently produces an ANSWER rather than
 * an error — a watermark that goes backwards, or a drift report claiming a lag
 * that means nothing.
 *
 * So this module splits the two cases apart and never lets them meet:
 *
 *   ISO path     values that parse as real timestamps are compared as parsed
 *                `Date`s. `2026-08-09T23:00:00-05:00` is LATER than
 *                `2026-08-10T00:00:00Z` and a string compare says the
 *                opposite, so this is a correctness fix and not a tidy-up.
 *   opaque path  a token that is not a timestamp NEVER enters an ordering
 *                comparison. Its high-water mark is the last one the vendor
 *                enumerated — the vendor's own order is the only order it has
 *                — and it can never be reported as ahead of, or behind,
 *                anything.
 *
 * `reconcile.ts`'s `markerTimestamp` (WARP-2463, PR #1829) coerces markers for
 * the same reason on the persistence side. When that lands, it should delegate
 * to {@link isoInstant} rather than carry a second copy of the pattern.
 */

/**
 * The two positions a row can offer, already normalised by `identify`.
 *
 * `updatedAt` is typed to admit `undefined` deliberately: the QuickBooks shape
 * is a real value this branch must handle, and a type that excluded it would
 * make the branch look like dead code to the next reader.
 */
export interface WatermarkCandidate {
  /** The dataset's declared ordering key (`ErpSyncEntity.markerField`). */
  readonly marker: string | null;
  /** The canonical `updated_at` column, or null when absent or undefined. */
  readonly updatedAt?: string | null;
}

/**
 * Strict ISO-8601 date / date-time. Deliberately NOT "whatever `new Date()`
 * accepts": `new Date("1001")` is the year 1001, so a bare numeric invoice
 * number would parse as a plausible timestamp and be ordered against real
 * ones. Anchored and fixed-width, with the time part optional because Xero and
 * Shopify both emit date-only values.
 */
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Parse a watermark value to an instant, or `null` when it is not one.
 *
 * The single gate between a vendor's ordering token and any comparison. A
 * `null` here is not a failure to handle — it is the answer "this value cannot
 * be ordered", and every caller below has an explicit branch for it.
 */
export function isoInstant(value: string | null | undefined): Date | null {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms);
}

/**
 * The value a watermark advances on for one row: the canonical `updated_at`
 * when the vendor defined one, otherwise the dataset's ordering key.
 *
 * The test is `!== undefined && !== null && !== ""`, never `updatedAt in row`
 * and never `??` on a possibly-absent property. The empty string is excluded
 * because it sorts before every real timestamp, so accepting it would reset
 * the position rather than advance it.
 */
export function watermarkValueOf(record: WatermarkCandidate): string | null {
  const updatedAt = record.updatedAt;
  if (updatedAt !== undefined && updatedAt !== null && updatedAt !== "") return updatedAt;
  return record.marker;
}

/**
 * The highest watermark position in a set, or null when no row carried one.
 *
 * Timestamps win outright. An opaque token is only ever adopted when the set
 * offers no timestamp at all, and then it is the LAST one enumerated rather
 * than the largest — sorting opaque tokens is meaningless, and the vendor's
 * own paging order is the only ordering information they carry.
 *
 * A mixed set (some rows ordered by time, some by an opaque id) is a vendor
 * being inconsistent within one dataset. Preferring the timestamp keeps the
 * stored watermark a value the vendor's own `since:` filter can accept, which
 * is the only choice that leaves the next tick able to run.
 */
export function highestWatermark(records: readonly WatermarkCandidate[]): string | null {
  let bestIso: string | null = null;
  let bestInstant = -Infinity;
  let lastOpaque: string | null = null;

  for (const record of records) {
    const value = watermarkValueOf(record);
    if (value === null || value === "") continue;
    const instant = isoInstant(value);
    if (instant === null) {
      // Opaque. Recorded positionally; never compared.
      lastOpaque = value;
      continue;
    }
    if (bestIso === null || instant.getTime() > bestInstant) {
      bestIso = value;
      bestInstant = instant.getTime();
    }
  }

  return bestIso ?? lastOpaque;
}

/**
 * Is `candidate` strictly ahead of `reference`?
 *
 * The one comparison `watermark-behind` is measured with, so it takes the same
 * values {@link highestWatermark} produces and applies the same ISO-vs-opaque
 * split.
 *
 * `false` when either side is opaque. Not "unknown, so assume drift": a lag
 * reported from a lexicographic accident would fire on every sweep of every
 * Stripe connection, and a drift report that cries wolf teaches an operator to
 * ignore the one that matters. `reconcile.ts` says as much about fabricated
 * keys, for the same reason.
 */
export function isWatermarkAhead(candidate: string | null, reference: string | null): boolean {
  if (candidate === null) return false;
  if (reference === null) return true;
  const a = isoInstant(candidate);
  const b = isoInstant(reference);
  if (a === null || b === null) return false;
  return a.getTime() > b.getTime();
}
