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
 * ## The marker field is the ORDERING key, and it is not the only position
 *
 * Each entity declares BOTH: the ordering key it enumerates by, and the
 * canonical column a watermark prefers when the vendor actually filled it
 * (WARP-2474). `watermark.ts` owns the choice between them.
 *
 * ## Why the reconciliation sweep is still mandatory (WARP-2509 corrected this)
 *
 * This paragraph used to open "When this table was written no canonical column
 * carried a vendor-side modification timestamp", and built the whole rationale
 * on that. WARP-2494 had already made it false — `updated_at` exists on
 * fifteen of the twenty-three datasets — and a rationale resting on a claim
 * that is no longer true is worse than no rationale, because the next reader
 * inherits the conclusion without the reasoning.
 *
 * The sweep is mandatory for a different and narrower reason: `updated_at` is
 * ABSENT on some datasets and UNDEFINED on some rows of the ones that have it,
 * and where it is present the vendor's own guarantees are weak.
 *
 *   absent        `campaign` and `ecommerce_order` carry no modification
 *                 column at all — Mailchimp's campaign and e-commerce order
 *                 resources publish none — so their watermarks key on a
 *                 CREATION position (`sent_at`, `processed_at`) that cannot
 *                 see an edit.
 *   undefined     QuickBooks Online and Desktop serve `invoice`/`bill` from
 *                 row builders that emit `updated_at: undefined` when the
 *                 vendor's stamp is naive. `watermark.ts` falls back to the
 *                 marker for exactly those rows.
 *   present but   Xero's `UpdatedDateUTC` does not fire on DueDate,
 *   incomplete    SentToContact, or a contact-balance change. HubSpot's Search
 *                 API is eventually consistent — a record modified now may not
 *                 appear in a search issued now. Stripe does not guarantee
 *                 event ordering.
 *
 * So a watermark built from either position is approximate by construction.
 * That is not a defect to fix here — it is why the full reconciliation sweep
 * ships alongside the incremental path rather than after it. Read
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
  /** Canonical column the rows are ORDERED by. See the caveat above. */
  readonly markerField: string;
  /**
   * Canonical column carrying the vendor's own modification time (WARP-2464),
   * which the watermark prefers over `markerField` when a track defines it.
   *
   * Declared per entity rather than assumed, for the same reason every other
   * field here is: some datasets deliberately have no such column, and a
   * poller that guesses which field means "modified" produces a watermark that
   * is confidently wrong. A dataset whose rows never carry it — or carry it
   * undefined, as the QuickBooks invoice and bill builders do — falls back to
   * `markerField` with no configuration, which is why the two entities that
   * have no modification column at all still name it here: the fallback is the
   * mechanism, not an exception to it.
   */
  readonly updatedAtField: string;
  /**
   * WARP-2509 — may a track that does NOT declare this dataset be given a
   * cursor for it anyway?
   *
   * `entityServedBy` can only read a CLOUD descriptor's `datasets`. A lan
   * track's served set is computed at runtime — the export-drop connector
   * serves invoices and bills whenever the practice's export carries them —
   * so for those, and for a provider with no descriptor at all, the filter has
   * no evidence and this flag decides.
   *
   * `true` for `invoice`/`bill`, which is the behaviour WARP-2533 established
   * and must not regress: filtering a lan track by its static declaration
   * would silently stop the accounting sync that track shipped with.
   *
   * `false` for everything WARP-2509 added, and the asymmetry is the point. No
   * lan track serves a CRM or marketing dataset, and the cost of a wrong guess
   * is not symmetric: a cursor for an unserved entity fails its first tick with
   * `DatasetNotServedError`, is classified FATAL, parks FAILED, and
   * `foldSyncState` then renders the entire connection as a failed sync
   * forever. Eight of those would land on every Eaglesoft box on earth. A
   * missing cursor, by contrast, is one dataset not synced on a track that
   * cannot serve it anyway.
   */
  readonly openToUndeclaredTracks: boolean;
}

/**
 * The sync set: everything a shipped connector can ENUMERATE.
 *
 * ## What "enumerable" means, and why it is the whole membership rule
 *
 * `runOneCursor` calls `runRead(spec.readQuery, {})` or `{ since }` and
 * nothing else. It has no basis to invent any other parameter. So a read
 * belongs here when those two shapes return the dataset, and does not when it
 * needs an argument the poller would have to make up.
 *
 * The cloud tracks satisfy this deliberately rather than by luck: HubSpot's
 * and Mailchimp's `runRead` treat the registry's mandatory filters as
 * OPTIONAL — a filter that is present filters, one that is absent enumerates —
 * so `find_contact` backs both the assistant's name lookup and this poller's
 * sweep without a second query name meaning almost the same thing.
 *
 * ## What is deliberately NOT here
 *
 * `get_schedule_today` is a time-window read needing `from`/`to` bounds a
 * poller has no basis to choose, and `find_patient` / `get_patient` are
 * lookups rather than enumerations. Polling any of them would mean inventing a
 * query the product does not ask.
 *
 * Stripe's `charge` is absent for the same reason and it is worth naming,
 * because Stripe is otherwise a fully wired connector: `get_recent_charges`
 * pushes a half-open `[from, to)` window down to Stripe's own `created` filter
 * precisely so a metered endpoint is not asked for all history. Called with
 * no window it has no query to send. Stripe still syncs — it serves `invoice`,
 * which is the first row below. (`charge` also emits no `updated_at`: that
 * column comes from `/v1/events`, which this read does not touch.)
 *
 * ## WARP-2509 — the eight rows that made the connectors reachable
 *
 * Before them this table held `invoice` and `bill` alone. Every other entity
 * is answered `ENTITY_NOT_SERVED`, and `registerCursors` skips an entity the
 * connection's track does not serve, so a HubSpot or Mailchimp connection got
 * NO cursors at all: connected, healthy, and never once read. Three stories'
 * worth of connector work — the descriptors, the `updated_at` producers, the
 * row mappers — was correct end to end and unreachable from the scheduler.
 *
 * The rows are derived from the connectors' own `servesDatasets` and canonical
 * column lists, not invented: HubSpot serves the five CRM datasets, Mailchimp
 * the three marketing ones.
 */
export const ERP_SYNC_ENTITIES: readonly ErpSyncEntity[] = [
  // ── accounting: Xero, QuickBooks Online/Desktop, Stripe, export-drop ──────
  {
    entity: "invoice",
    readQuery: "get_open_invoices",
    sourceKeyField: "invoice_id",
    markerField: "issued_at",
    updatedAtField: "updated_at",
    openToUndeclaredTracks: true,
  },
  {
    entity: "bill",
    readQuery: "get_open_bills",
    sourceKeyField: "bill_id",
    markerField: "issued_at",
    updatedAtField: "updated_at",
    openToUndeclaredTracks: true,
  },

  // ── CRM: HubSpot (WARP-2509) ─────────────────────────────────────────────
  //
  // All four of these enumerate through HubSpot's Search delta poller, which
  // orders by `hs_lastmodifieddate` — so `updated_at` is the position the
  // watermark actually advances on and is always populated. `created_at` is
  // the declared marker because it is the fallback that has to be honest if a
  // record ever arrives without a modification time: a row positioned by when
  // it was created is approximately right, and a row positioned by nothing
  // resets the watermark to null and re-enumerates the whole portal.
  {
    entity: "contact",
    readQuery: "find_contact",
    sourceKeyField: "contact_id",
    markerField: "created_at",
    updatedAtField: "updated_at",
    openToUndeclaredTracks: false,
  },
  {
    entity: "company",
    readQuery: "get_company",
    sourceKeyField: "company_id",
    markerField: "created_at",
    updatedAtField: "updated_at",
    openToUndeclaredTracks: false,
  },
  {
    entity: "deal",
    readQuery: "get_deals_by_stage",
    sourceKeyField: "deal_id",
    markerField: "created_at",
    updatedAtField: "updated_at",
    openToUndeclaredTracks: false,
  },
  {
    entity: "ticket",
    readQuery: "get_tickets_by_status",
    sourceKeyField: "ticket_id",
    markerField: "created_at",
    updatedAtField: "updated_at",
    openToUndeclaredTracks: false,
  },
  {
    entity: "engagement",
    readQuery: "get_engagements",
    sourceKeyField: "engagement_id",
    // NOT `created_at` — an engagement has no such column. `occurred_at` is
    // when the call or meeting HAPPENED, which is the only position the
    // dataset carries besides the modification time WARP-2509 added to it.
    markerField: "occurred_at",
    updatedAtField: "updated_at",
    openToUndeclaredTracks: false,
  },

  // ── marketing: Mailchimp (WARP-2509) ─────────────────────────────────────
  {
    entity: "audience_member",
    readQuery: "get_audience_members",
    sourceKeyField: "audience_member_id",
    // Marker and modification column coincide here, and that is correct
    // rather than redundant: Mailchimp enumerates members by `last_changed`
    // (`since_last_changed`), so the order the rows arrive in IS the
    // modification order. WARP-2509 renamed that canonical column from
    // `last_changed_at` so this track keys on the same name as every other.
    markerField: "updated_at",
    updatedAtField: "updated_at",
    openToUndeclaredTracks: false,
  },
  {
    entity: "campaign",
    readQuery: "get_campaign_performance",
    sourceKeyField: "campaign_id",
    // A SEND time, not a modification time. Mailchimp publishes no
    // modification field on the campaign resource, so `updatedAtField` below
    // finds nothing on the row and the watermark falls back here — which
    // means an edited campaign's changed stats are invisible to the
    // incremental path and are the sweep's to find.
    markerField: "sent_at",
    updatedAtField: "updated_at",
    openToUndeclaredTracks: false,
  },
  {
    entity: "ecommerce_order",
    readQuery: "get_ecommerce_orders",
    sourceKeyField: "ecommerce_order_id",
    // Same shape as `campaign`, and worse at the source: the orders endpoint
    // exposes no modification field AND no date filter of any kind, so the
    // `since` narrowing is applied after paging rather than pushed down.
    markerField: "processed_at",
    updatedAtField: "updated_at",
    openToUndeclaredTracks: false,
  },
];

const BY_ENTITY = new Map(ERP_SYNC_ENTITIES.map((e) => [e.entity, e]));

/** Look up a sync entity, or undefined for a cursor naming one we do not
 *  serve — which is a real possibility after an entity is retired, and is
 *  handled explicitly rather than crashing the tick. */
export function erpSyncEntity(entity: string): ErpSyncEntity | undefined {
  return BY_ENTITY.get(entity);
}
