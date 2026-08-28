/**
 * WARP-2218 — the full reconciliation sweep and the drift report it emits.
 *
 * **This is the half the story exists for.** A watermark alone is insufficient,
 * and not marginally: three of the five v1 vendors have delta reads that
 * silently drop records.
 *
 *   Xero     `UpdatedDateUTC` does not move on a DueDate change, a
 *            SentToContact flip, or a contact-balance shift. The record is
 *            genuinely different and the field we filter on says it is not.
 *   HubSpot  the Search API is eventually consistent. A record modified now
 *            may simply not appear in a search issued now — and will not
 *            appear in the next one either, because by then the watermark has
 *            moved past it.
 *   Stripe   event ordering is explicitly not guaranteed, so a page can arrive
 *            with a later marker than a record we have not been handed yet.
 *
 * Each of those produces a sync that reports SUCCESS while missing data, which
 * is strictly worse than a sync that fails: a failure is visible and gets
 * retried, whereas a silent gap is indistinguishable from "nothing changed"
 * and the owner has no way to find out. That is why the incremental path does
 * not ship on its own.
 *
 * ## How the sweep detects what the watermark missed
 *
 * The sweep issues BOTH reads for the same entity in the same pass:
 *
 *   A = the incremental read, exactly as the poller would issue it, filtered
 *       from the persisted watermark.
 *   B = a FULL re-enumeration from the beginning, no watermark at all.
 *
 * Drift is what B knows and A does not. Two classes, distinguished because the
 * remedy and the diagnosis differ:
 *
 *   `missed-newer`      in B, absent from A, marker STRICTLY AFTER the
 *                       watermark. The vendor's own filter told us nothing had
 *                       changed since W and a full read disagrees. This is the
 *                       HubSpot/Stripe class.
 *   `watermark-behind`  B's high-water mark is ahead of A's. The incremental
 *                       path is running behind the account and every
 *                       subsequent tick inherits the gap. This is the Xero
 *                       class, where the marker itself does not move.
 *
 * The critical property, and the one the mutation test pins: **B must be a
 * re-enumeration.** If the sweep resumes from the watermark, B collapses onto
 * A, every difference vanishes, and the report says zero drift forever — a
 * sweep that is green precisely because it stopped looking. That mutation must
 * turn the sweep's test red, and if a future change makes it pass again, the
 * change is wrong, not the test.
 *
 * ## What the report may contain
 *
 * Counts, dataset names and TIMESTAMPS. Never a record identifier, a customer
 * name, an amount or an email — the report is an operator-facing artefact and
 * a drift report full of invoice numbers would be a customer-content export
 * wearing a diagnostics label.
 *
 * "Timestamps" is load-bearing rather than incidental (WARP-2463, which
 * persists this report). A vendor's marker is an ORDERING TOKEN, not
 * necessarily a time: Stripe's cursors are object ids, and any vendor is free
 * to order by its own record key. So a marker never leaves this module as a
 * string — `markerTimestamp` coerces it, and a marker that is not a real
 * timestamp becomes `null`. That is why the persisted row cannot carry an
 * invoice number even for a vendor that orders by one: there is no path from a
 * raw marker to storage.
 */

/** Why a record the full read knows about was missing from the delta read. */
export type ErpDriftClass = "missed-newer" | "watermark-behind";

/**
 * Strict ISO-8601 date / date-time. Deliberately NOT "whatever `new Date()`
 * accepts": `new Date("1001")` is the year 1001, so a bare numeric invoice
 * number would parse as a plausible timestamp and land in a column an
 * operator reads as one. Anchored, fixed-width, and optional-time-only.
 */
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Coerce a vendor marker to a timestamp, or `null` when it is not one.
 *
 * The single gate between a vendor's ordering token and anything that stores
 * or displays it. Returning `null` for a non-timestamp marker loses nothing an
 * operator was going to read — an opaque cursor tells them nothing — and it is
 * what makes the drift record's PHI-free rule structural rather than a
 * convention someone has to remember.
 */
export function markerTimestamp(marker: string | null | undefined): Date | null {
  if (typeof marker !== "string" || !ISO_TIMESTAMP.test(marker)) return null;
  const ms = Date.parse(marker);
  return Number.isNaN(ms) ? null : new Date(ms);
}

/** Per-entity drift. Counts and the dataset name only. */
export interface ErpEntityDrift {
  /** Canonical dataset name (`invoice`, `bill`) — not a record id. */
  entity: string;
  /** Rows the full re-enumeration returned. */
  fullCount: number;
  /** Rows the incremental read returned. */
  incrementalCount: number;
  /** Records present in the full read, absent from the incremental one, whose
   *  marker is after the watermark. */
  missedCount: number;
  /** True when the full read's high-water mark is ahead of the incremental
   *  read's — the incremental path is behind the account. */
  watermarkBehind: boolean;
  /** Which classes fired. Empty means the incremental path was trustworthy for
   *  this entity on this pass, which is itself the useful signal. */
  classes: ErpDriftClass[];
  /**
   * Oldest marker among the missed records, as a TIMESTAMP (WARP-2463).
   *
   * "How far back did the gap start" is the forensic question when an owner
   * reports that the assistant did not know about something. Computed here
   * rather than by the caller so the "which records are missed" predicate has
   * exactly one implementation — a second copy in the persistence layer would
   * be free to disagree with this one, and the disagreement would be silent.
   *
   * `null` when nothing was missed, and also when the missed records' markers
   * are not timestamps at all. See `markerTimestamp`.
   */
  earliestMissedAt: Date | null;
}

/** What one sweep of one connection found. */
export interface ErpDriftReport {
  connectionId: string;
  provider: string;
  sweptAt: string;
  entities: ErpEntityDrift[];
  /** Records the incremental path would have dropped, across all entities. */
  totalMissed: number;
  /** True when any entity drifted. The single field an alert keys on. */
  driftDetected: boolean;
}

/** A row reduced to the two things reconciliation needs. Never the payload. */
export interface RecordIdentity {
  sourceKey: string;
  marker: string | null;
}

/**
 * Project a vendor row onto (id, marker) using the entity's DECLARED fields.
 *
 * A row missing its declared id field is dropped rather than given a
 * synthesised one: a fabricated key would pair with nothing on the other side
 * of the diff and would be reported as drift on every single sweep, which
 * trains an operator to ignore the report.
 */
export function identify(
  rows: readonly unknown[],
  sourceKeyField: string,
  markerField: string,
): RecordIdentity[] {
  const out: RecordIdentity[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const key = rec[sourceKeyField];
    if (key === undefined || key === null || key === "") continue;
    const marker = rec[markerField];
    out.push({
      sourceKey: String(key),
      marker: marker === undefined || marker === null ? null : String(marker),
    });
  }
  return out;
}

/** The largest marker in a set, or null when nothing carried one. */
export function highWaterMark(records: readonly RecordIdentity[]): string | null {
  let best: string | null = null;
  for (const r of records) {
    if (r.marker === null) continue;
    if (best === null || r.marker > best) best = r.marker;
  }
  return best;
}

/**
 * Diff a full re-enumeration against the incremental read that ran beside it.
 *
 * `watermark` is the position the incremental read was issued FROM. A record
 * whose marker is at or before it was correctly filtered out and is not drift;
 * a record after it that the vendor did not hand us is.
 */
export function diffForDrift(
  entity: string,
  watermark: string | null,
  incremental: readonly RecordIdentity[],
  full: readonly RecordIdentity[],
): ErpEntityDrift {
  const seen = new Set(incremental.map((r) => r.sourceKey));

  let missedCount = 0;
  let earliestMissedAt: Date | null = null;
  for (const r of full) {
    if (seen.has(r.sourceKey)) continue;
    // Strictly after: a record exactly at the watermark was already delivered
    // by the run that set it, so counting it would report drift every sweep.
    if (watermark !== null && (r.marker === null || r.marker <= watermark)) continue;
    missedCount += 1;
    // Coerced HERE, so no caller ever sees the raw marker of a missed record.
    const at = markerTimestamp(r.marker);
    if (at !== null && (earliestMissedAt === null || at < earliestMissedAt)) {
      earliestMissedAt = at;
    }
  }

  const fullHigh = highWaterMark(full);
  const incHigh = highWaterMark(incremental);
  const watermarkBehind =
    fullHigh !== null && (incHigh === null ? watermark === null || fullHigh > watermark : fullHigh > incHigh);

  const classes: ErpDriftClass[] = [];
  if (missedCount > 0) classes.push("missed-newer");
  if (watermarkBehind) classes.push("watermark-behind");

  return {
    entity,
    fullCount: full.length,
    incrementalCount: incremental.length,
    missedCount,
    watermarkBehind,
    classes,
    earliestMissedAt,
  };
}

/** Assemble the per-connection report from its per-entity parts. */
export function buildDriftReport(
  connectionId: string,
  provider: string,
  sweptAt: Date,
  entities: ErpEntityDrift[],
): ErpDriftReport {
  const totalMissed = entities.reduce((n, e) => n + e.missedCount, 0);
  return {
    connectionId,
    provider,
    sweptAt: sweptAt.toISOString(),
    entities,
    totalMissed,
    driftDetected: entities.some((e) => e.classes.length > 0),
  };
}
