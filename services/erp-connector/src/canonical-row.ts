/**
 * The canonical row projector for the API tracks.
 *
 * A cloud connector's job at the end of a fetch is to turn one vendor record
 * into one row whose keys are EXACTLY `CANONICAL_COLUMNS[dataset]` and whose
 * values are typed by `COLUMN_KIND`. Both halves of that are load-bearing and
 * both used to be done by hand, per dataset, in each track:
 *
 *   - **No extra keys.** A vendor record carries far more than the canonical
 *     shape — a HubSpot contact alone comes back with dozens of properties,
 *     several of them personal data nobody asked for. Spreading the record and
 *     adding the canonical names on top (`{...raw, updated_at}`) is the obvious
 *     way to write it and it persists the whole vendor payload onto the box,
 *     which is the minimum-necessary rule broken in one character of syntax.
 *   - **No missing keys.** A column the mapper forgot is not a visible hole; it
 *     is a row that looks complete and silently answers "no value" to every
 *     question about that field.
 *
 * So the projection is DRIVEN by the vocabulary rather than checked against it:
 * this module writes one key per entry in `CANONICAL_COLUMNS[dataset]` and has
 * no way to write anything else. A track that grows a dataset, or a dataset
 * that grows a column, cannot produce a stale row shape — the loop is over the
 * vocabulary itself, so the two cannot disagree.
 *
 * This mirrors `export-drop/scan.ts`'s `projectRow`, which does exactly this
 * for CSV cells, and exists separately because the export track's coercions are
 * about parsing operator-authored text while these are about normalising JSON
 * a vendor already typed.
 */
import { CANONICAL_COLUMNS, COLUMN_KIND, type DatasetName } from "./export-drop/profiles.js";

/** One canonical row: keys are exactly `CANONICAL_COLUMNS[dataset]`. */
export type CanonicalRow = Record<string, unknown>;

/**
 * Answer "what does this vendor record hold for this canonical column?".
 *
 * Returns the RAW vendor value — coercion is this module's job, not the
 * caller's, so a track cannot accidentally emit a money column as a string in
 * one dataset and a number in another. `undefined` means the vendor has no
 * source for that column, which stays present-and-undefined on the row exactly
 * as `profiles.ts` specifies.
 */
export type VendorLookup = (canonicalColumn: string) => unknown;

/**
 * A vendor timestamp as a full UTC ISO instant.
 *
 * Two wire forms, because the vendors disagree: HubSpot sends epoch
 * milliseconds (as a string, on `createdate` and `hs_lastmodifieddate`) while
 * Mailchimp sends ISO-8601 with an explicit offset. Both normalise here so one
 * `updated_at` column is byte-comparable across tracks — `COLUMN_KIND` types it
 * `timestamp` precisely because a watermark COMPARES these, and two spellings
 * of one moment is how an incremental sync silently stops advancing.
 *
 * The all-digits test is the same heuristic `HubSpotConnector.toRecord` already
 * applies to `hs_lastmodifieddate`, kept identical on purpose: a second, subtly
 * different rule for the same vendor's timestamps is a divergence nobody would
 * think to test for.
 *
 * Absent stays absent and unparseable stays absent. Defaulting to the epoch or
 * to `now` would put a value in a column a watermark TRUSTS.
 */
export function canonicalInstant(value: unknown): string | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? new Date(value).toISOString() : undefined;
  }
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (raw === "") return undefined;
  const ms = /^-?\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/**
 * A vendor money or count value as a number.
 *
 * One coercion for both kinds because they parse identically — the distinction
 * `COLUMN_KIND` draws between them is about whether a sibling `currency` column
 * is required, not about how the digits are read (see
 * `assertMoneyColumnsCarryCurrency`).
 *
 * Comma-tolerant, because HubSpot returns `amount` as a STRING and a portal
 * whose locale formats it groups the thousands: `Number("1,500.00")` is `NaN`,
 * and a deal amount that silently became absent is worse than a loud failure.
 * Not rounded — `roundCents` exists for SUMS, where the error compounds; a
 * single vendor figure is passed through as the vendor stated it.
 */
export function canonicalNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (raw === "") return undefined;
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

/**
 * A vendor text value.
 *
 * An empty or whitespace-only string becomes `undefined` rather than `""`:
 * "the vendor holds no value here" and "the vendor holds the empty string" are
 * the same fact for every column this applies to, and keeping both spellings
 * means every consumer has to test for both. Numbers are stringified because
 * several vendor ids (Mailchimp store and customer ids especially) arrive as
 * JSON numbers for what is semantically an opaque identifier.
 */
export function canonicalText(value: unknown): string | undefined {
  if (typeof value === "string") {
    const raw = value.trim();
    return raw === "" ? undefined : raw;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return undefined;
}

/**
 * Project one vendor record onto exactly `CANONICAL_COLUMNS[dataset]`.
 *
 * The loop is over the VOCABULARY, never over the vendor record, which is what
 * makes both guarantees structural rather than tested: there is no code path
 * that writes a key the vocabulary does not declare, and no path that skips one
 * it does.
 */
export function projectCanonicalRow(dataset: DatasetName, read: VendorLookup): CanonicalRow {
  const row: CanonicalRow = {};
  for (const column of CANONICAL_COLUMNS[dataset]) {
    const raw = read(column);
    switch (COLUMN_KIND[column]) {
      case "timestamp":
        row[column] = canonicalInstant(raw);
        break;
      // Money and count share a coercion; see `canonicalNumber`.
      case "money":
      case "count":
        row[column] = canonicalNumber(raw);
        break;
      default:
        row[column] = canonicalText(raw);
        break;
    }
  }
  return row;
}

/**
 * Project a whole page of vendor records.
 *
 * `read` is built PER RECORD rather than taking `(record, column)` so a track
 * can close over whatever else that record needs — HubSpot's mappers need the
 * object id and the already-parsed `updated_at`, neither of which lives in the
 * property bag.
 */
export function projectCanonicalRows<T>(
  dataset: DatasetName,
  records: readonly T[],
  lookupFor: (record: T) => VendorLookup,
): CanonicalRow[] {
  return records.map((record) => projectCanonicalRow(dataset, lookupFor(record)));
}
