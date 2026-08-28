/**
 * WARP-2218 — which datasets the poller syncs, and how a returned row is
 * identified and ordered.
 *
 * Declared as an explicit table rather than sniffed out of whatever a vendor
 * returns. A poller that guesses which field is "the id" produces a drift
 * report that is confidently wrong, and a wrong drift report is worse than
 * none — it is the thing an owner would use to decide the incremental path is
 * trustworthy.
 *
 * The field names are the canonical columns every track already projects onto
 * (`services/erp-connector/src/export-drop/profiles.ts` `CANONICAL_COLUMNS`),
 * so this table is not a fourth vocabulary; it is a view over the existing one.
 *
 * ## Why the marker field is not an "updated at"
 *
 * There isn't one. No canonical column carries a vendor-side modification
 * timestamp, and for three of the five v1 vendors there is no field that could
 * carry a trustworthy one:
 *
 *   Xero     `UpdatedDateUTC` does not fire on DueDate, SentToContact, or
 *            contact-balance changes.
 *   HubSpot  the Search API is eventually consistent — a record modified now
 *            may not appear in a search issued now.
 *   Stripe   event ordering is explicitly not guaranteed.
 *
 * So the marker below is the best available ORDERING key, not a correctness
 * guarantee, and the watermark built from it is approximate by construction.
 * That is not a defect to fix here — it is the reason the full reconciliation
 * sweep ships alongside the incremental path rather than after it. Read
 * `reconcile.ts` before changing anything in this file.
 */

/** How one synced dataset is read, identified and ordered. */
export interface ErpSyncEntity {
  /** Cursor `entity` key. Matches the canonical dataset name. */
  readonly entity: string;
  /** The named read query this entity enumerates through (invariant 4 — the
   *  assistant and the poller both use NAMED queries, never assembled SQL). */
  readonly readQuery: string;
  /** Canonical column holding the vendor's stable id for the record. */
  readonly sourceKeyField: string;
  /** Canonical column the watermark is built from. See the caveat above. */
  readonly markerField: string;
}

/**
 * The v1 sync set: the two accounting datasets.
 *
 * Deliberately NOT the practice datasets. `get_schedule_today` is a time-window
 * read that needs `from`/`to` bounds a poller has no basis to choose, and
 * `find_patient`/`get_patient` are lookups rather than enumerations — polling
 * them would mean inventing a query the product does not ask. Adding an entity
 * here is a one-line change once its read is enumerable.
 */
export const ERP_SYNC_ENTITIES: readonly ErpSyncEntity[] = [
  {
    entity: "invoice",
    readQuery: "get_open_invoices",
    sourceKeyField: "invoice_id",
    markerField: "issued_at",
  },
  {
    entity: "bill",
    readQuery: "get_open_bills",
    sourceKeyField: "bill_id",
    markerField: "issued_at",
  },
];

const BY_ENTITY = new Map(ERP_SYNC_ENTITIES.map((e) => [e.entity, e]));

/** Look up a sync entity, or undefined for a cursor naming one we do not
 *  serve — which is a real possibility after an entity is retired, and is
 *  handled explicitly rather than crashing the tick. */
export function erpSyncEntity(entity: string): ErpSyncEntity | undefined {
  return BY_ENTITY.get(entity);
}
