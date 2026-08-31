/**
 * WARP-1964 — export profiles: how one PMS's exported columns map onto the
 * canonical row shapes the read registry already returns.
 *
 * A profile is DATA, not code. Adding a practice-management system to this
 * track is a profile entry plus a test — never a new connector class — which is
 * what makes the track vendor-agnostic rather than Eaglesoft-with-extra-steps.
 * Operators can supply their own profiles as JSON (see {@link parseProfileJson})
 * so an install can map a product we have never seen without waiting for a
 * release.
 *
 * Two rules keep a wrong profile from becoming wrong data:
 *
 *  1. **Detection is by header signature, never by filename.** A file is
 *     claimed only if every `required` header is present. A profile that does
 *     not match simply does not claim the file; the file is then reported as
 *     unrecognized *together with the headers it actually had*, which is
 *     exactly what an operator needs to author the right profile.
 *  2. **Ambiguity is refused, not resolved.** Two profiles matching one file is
 *     a profile-authoring bug; picking the first would silently pick a coin
 *     flip. Detection is also scoped to the connection's own vendor, so
 *     unrelated products can never collide in the first place.
 *
 * PURE: no I/O.
 */

/**
 * The logical datasets any ERP track can serve. These are the tables the read
 * registry's queries depend on (`ReadQuery.dependsOnTables`), the things an
 * export profile maps a file onto, and the capability a connector declares
 * through `Connector.servesDatasets`.
 *
 * ## The vocabulary is ONE FLAT LIST — upheld at twenty names (WARP-2280)
 *
 * WARP-2107 widened this from the original dental-only trio to cover
 * accounting and wrote down why the list is flat: *a dataset name is the join
 * between a profile, a read query's `dependsOnTables`, and a connector's
 * declared capability, and splitting it would mean three places to keep in
 * agreement instead of one.* WARP-2280 took the list from six to twenty across
 * five unrelated business domains and re-examined that argument rather than
 * quietly widening around it. **It still holds, and it holds harder.**
 *
 * The alternative considered and REJECTED was namespacing per category
 * (`payments.charge`, `crm.contact`, and by symmetry `practice.appointment`).
 * It loses on three counts:
 *
 *  1. **The six existing names are a wire format, not an implementation
 *     detail.** Operators author their own profiles as JSON on site (see
 *     {@link parseProfileJson}) and those files name datasets as bare strings.
 *     Renaming `bill` to `accounting.bill` breaks every profile already
 *     written at a practice, for no benefit those practices can perceive. No
 *     safe migration path exists, because we do not hold the files.
 *  2. **A half-namespaced vocabulary is worse than either pure shape.**
 *     Namespacing only the new names makes the rule "things added after
 *     August 2026 carry a prefix", which is a fact about our git history, not
 *     about the data.
 *  3. **A namespace segment is not a type.** `"payments.charge"` is one string
 *     literal in the union exactly as `"charge"` is; the dot buys grouping for
 *     a human reader and nothing at all for `tsc`. The grouping a caller
 *     actually needs — "does this connection have accounting data?" — is
 *     already {@link DATASET_CATEGORY}, which is a real, exhaustively-checked
 *     mapping rather than a substring convention.
 *
 * ## The naming rule that keeps a flat list honest
 *
 * Flat only works if a name means exactly one thing. The rule, in force from
 * WARP-2280 onward:
 *
 * > **A dataset name denotes a canonical ROW SHAPE, not a vendor's object.**
 * > Two vendors serve the same dataset name only when their rows are
 * > interchangeable — same canonical columns, same units, same meaning. Where
 * > a vendor's object is not interchangeable with an existing shape, it takes
 * > its own name; where a bare name would collide with an existing shape of a
 * > different meaning, the domain goes INTO the name (`stripe_account`), never
 * > into a namespace segment.
 *
 * Applied to the collisions this widening actually raises:
 *
 *  * **`patient` / `customer` / `contact` are three shapes, not three
 *    spellings of one.** A `patient` is clinical and PHI-bearing, a `customer`
 *    is a commerce buyer with an order history, a `contact` is a CRM person
 *    with a lifecycle stage. They keep separate names because they have
 *    separate canonical columns; nothing merges them and nothing should.
 *  * **`invoice` stays the ACCOUNTING invoice** — money owed to the business,
 *    decimal, carrying a `balance`. Xero's invoice is that shape and serves
 *    this name. Stripe's invoice is not (minor units, its own lifecycle, no
 *    comparable `balance`), so a Stripe track does NOT declare `invoice`; if
 *    one is ever needed it enters as `stripe_invoice`. This is the rule doing
 *    its job: the name refused the vendor, rather than the vendor quietly
 *    redefining the name.
 *  * **`account` stays the practice-AR account.** Stripe's Connect account is
 *    a different thing and would enter as `stripe_account`. Nothing in this
 *    widening claims `account`, so the collision is closed before it opens.
 *
 * Vendor mapping for the names added here: Stripe → `charge`, `refund`,
 * `payout`, `balance_transaction`, `subscription`. HubSpot → `contact`,
 * `company`, `deal`, `ticket`. Shopify → `order`, `product`, `customer`.
 * Mailchimp → `campaign`, `audience`. **Xero adds nothing** — it maps cleanly
 * onto the existing `invoice` / `bill` / `ap_summary`, which is the naming
 * rule's best evidence.
 *
 * ## The WARP-2466 reconciliation — three connectors met the vocabulary
 *
 * HubSpot (WARP-2317) and Mailchimp (WARP-2379) shipped before this union
 * could express what they serve, so both declared their dataset names as bare
 * `readonly string[]` and said in their own docstrings that the reconciliation
 * was owed. WARP-2466 paid it, **by comparing canonical column lists rather
 * than names** — the only comparison the rule above sanctions. Every decision,
 * with the evidence:
 *
 * | Declared | Verdict | Why |
 * |---|---|---|
 * | HubSpot `crm_contact` | **is `contact`** | `[id, email, firstname, lastname, lifecyclestage]` are HubSpot's PROPERTY names for exactly `[contact_id, email, first_name, last_name, lifecycle_stage]`. Same shape, same meaning, no units to disagree about. The `crm_` prefix was a namespace segment, which §2/§3 above already reject. |
 * | HubSpot `crm_company` | **is `company`** | `[id, name, domain]` ≡ `[company_id, name, domain]`. |
 * | HubSpot `crm_deal` | **is `deal`** | `[id, dealname, dealstage, amount]` ≡ `[deal_id, name, stage, amount]`. `pipeline` is a HubSpot extra, not a shape difference — a connector may carry more than the canonical set. |
 * | HubSpot `crm_ticket` | **is `ticket`** | `[id, subject, hs_pipeline_stage, hs_ticket_priority]` ≡ `[ticket_id, subject, status, priority]`. |
 * | HubSpot `crm_engagement` | **new name `engagement`** | A timeline activity — a call, email, meeting, note or task. Nothing in the twenty is that shape: it is not a `ticket` (no status, no resolution), not a `deal`, and carries no money. It takes the bare name because nothing collides with it. |
 * | Mailchimp `campaign` | **is `campaign`** | `[campaign_id, title, status, send_time, emails_sent]` ≡ `[campaign_id, subject, status, sent_at, emails_sent]`. Mailchimp is the vendor this name was designed for. |
 * | Mailchimp `contact` | **new name `audience_member`** | **NOT** the CRM `contact`, and this is the reconciliation's most load-bearing call. A Mailchimp member is `[contact_id, email_address, status, last_changed, opt_in_time]`: a SUBSCRIPTION record. Its `status` is subscribed/unsubscribed/cleaned — not a `lifecycle_stage` — and it has no name, no company and no pipeline position. `find_contact` searches contacts by LAST-NAME PREFIX (`read-queries.ts`); against a Mailchimp connection that query would resolve `last_name` against a schema map that has no such column and fail at read time. Declaring `contact` here would be the "answers `get_open_invoices` with CRM rows" failure with the vendors swapped. Note the vendor mapping above already declined to give Mailchimp `contact`. |
 * | Mailchimp `ecommerce_order` | **stays its own name** | **NOT** the commerce `order`. `order` requires `total_amount` AND `currency` and exists to answer `total_amount - tax_amount - refunded_amount`; a Mailchimp order is `[order_id, store_id, customer_id, order_total, processed_at]` with no tax, no refund and no currency, because it is a marketing-attribution shadow a storefront integration syncs INTO Mailchimp, not the store's order of record. Serving it as `order` would let a revenue calculation run on columns that are not there. It already carries its domain in its name, which is the `stripe_account` form §"naming rule" sanctions. |
 *
 * The twenty become twenty-three. Nothing was renamed to fit and nothing was
 * cast: where a shape matched it took the canonical name, and where it did not
 * it took a new one — which is the rule working in both directions.
 */
export const DATASETS = [
  // practice-management (WARP-1964)
  "appointment",
  "patient",
  "account",
  // accounting (WARP-2107)
  "invoice",
  "bill",
  "ap_summary",
  // payments — Stripe (WARP-2280)
  "charge",
  "refund",
  "payout",
  "balance_transaction",
  "subscription",
  // CRM — HubSpot (WARP-2280; `engagement` added by WARP-2466)
  "contact",
  "company",
  "deal",
  "ticket",
  "engagement",
  // commerce — Shopify (WARP-2280)
  "order",
  "product",
  "customer",
  // marketing — Mailchimp (WARP-2280; the two below added by WARP-2466 after
  // the reconciliation found neither interchangeable with an existing shape)
  "campaign",
  "audience",
  "audience_member",
  "ecommerce_order",
] as const;
export type DatasetName = (typeof DATASETS)[number];

/**
 * Runtime narrowing onto {@link DatasetName}.
 *
 * Exists so a value that arrives as a `string` — an operator's profile JSON,
 * a persisted connection row — becomes a `DatasetName` by being CHECKED rather
 * than by being cast. Every `as DatasetName` is a place where the closed union
 * stops being load-bearing, which is the exact defect WARP-2306 removed from
 * `Connector.servesDatasets`; this is the tool that keeps it removed.
 */
export function isDatasetName(value: unknown): value is DatasetName {
  return typeof value === "string" && (DATASETS as readonly string[]).includes(value);
}

/**
 * The domains a dataset can be *about*.
 *
 * Closed on purpose, and widened by WARP-2280 from `"practice" | "accounting"`
 * to six. The value union being closed is the half that is easy to miss: a
 * widening that adds keys to {@link DATASET_CATEGORY} but leaves this union at
 * two would compile only because every new dataset had been forced into a
 * category that is a lie about it, and nothing would say so.
 */
export type DatasetCategory =
  | "practice"
  | "accounting"
  | "payments"
  | "commerce"
  | "crm"
  | "marketing";

/**
 * What a dataset is *about*.
 *
 * This is descriptive, not a permission: a vendor profile may legitimately
 * span several (a practice-management system that also carries receivables
 * already does — `account` is a practice profile's accounting-shaped dataset).
 * It exists so a caller can say "this connection has no accounting data"
 * without hardcoding a name list, and so the dashboard can group them.
 *
 * Nothing authorizes on this value, and nothing should start: a category is a
 * label on a shape, and a track's right to read a dataset is decided by
 * `Connector.servesDatasets` plus the connection's own configuration. Verified
 * before widening the union — no call site treats a category as an
 * authorization axis (WARP-2301).
 */
export const DATASET_CATEGORY: Readonly<Record<DatasetName, DatasetCategory>> = {
  appointment: "practice",
  patient: "practice",
  account: "accounting",
  invoice: "accounting",
  bill: "accounting",
  ap_summary: "accounting",
  // payments — a money MOVEMENT, as opposed to accounting's money POSITION.
  // A charge is an event that happened; a balance is a state that is.
  charge: "payments",
  refund: "payments",
  payout: "payments",
  balance_transaction: "payments",
  subscription: "payments",
  contact: "crm",
  company: "crm",
  deal: "crm",
  ticket: "crm",
  order: "commerce",
  product: "commerce",
  customer: "commerce",
  engagement: "crm",
  campaign: "marketing",
  audience: "marketing",
  audience_member: "marketing",
  ecommerce_order: "commerce",
};

/**
 * The canonical column names per dataset — the SELECT identifiers the SQL track
 * emits, which the REST track already reproduces (`api-dto.ts`). A row this
 * track returns must be indistinguishable from the same row on either other
 * track, so this list is the contract and not a suggestion.
 *
 * ## Money, units and sign — the rules the new datasets are written to
 *
 * The `invoice` entry below already carries the precedent: a monetary column
 * says inline what its number MEANS, because `amount` and `balance` are both
 * "money on an invoice" and summing the wrong one overstates receivables. The
 * payments and commerce datasets make that harder, so WARP-2280 states the
 * conventions once, here, rather than fourteen times below:
 *
 *  * **Every canonical money column is a DECIMAL amount in MAJOR units** —
 *    `12.34`, never `1234`. Stripe's API is integer minor units and Shopify's
 *    is a decimal string; converting is the vendor connector's job, done at
 *    its boundary before a row reaches canonical shape. This is not a
 *    preference: the whole point of a canonical row is that a consumer cannot
 *    tell which track produced it, and a track that emitted minor units would
 *    report a $12.34 charge as $1,234.
 *  * **A money column is never signed by convention alone.** Where a number
 *    can legitimately be negative (`balance_transaction.net_amount` on a
 *    refund) the entry says so; everywhere else the column is a MAGNITUDE and
 *    the dataset's name carries the direction — a `refund.amount` of `12.34`
 *    is twelve dollars going back, not minus twelve dollars.
 *  * **Multi-currency datasets carry an explicit `currency` column.** Never an
 *    account default read from somewhere else: a Stripe balance holds several
 *    currencies at once and an amount without its currency is not a number, it
 *    is a rumour. {@link assertMoneyColumnsCarryCurrency} enforces this at
 *    module load. The four ledger datasets that predate multi-currency support
 *    are exempt and named explicitly in
 *    {@link SINGLE_CURRENCY_LEDGER_DATASETS} — a practice's own books are kept
 *    in one currency by construction.
 *  * **A count is not money.** Counts (`member_count`, `emails_sent`) are
 *    declared `count` in {@link COLUMN_KIND} so they parse as numbers rather
 *    than serializing as the string `"1,234"`, while staying outside the
 *    currency rule, which they have no business satisfying.
 *
 * ## `updated_at` — present only where a vendor can honestly fill it (WARP-2464)
 *
 * `issued_at` and `due_at` are facts ABOUT a document. `updated_at` is a fact
 * about our copy of it: when the vendor last changed the record. It is the
 * ordering key an incremental sync should advance on, because every other
 * candidate — a created-at, an id sequence — is approximate by construction:
 * a record edited after creation, with an unchanged ordering key, is invisible
 * to an incremental pass. WARP-2218 ships its sweep as mandatory for exactly
 * that reason.
 *
 * Thirteen of the twenty datasets carry it. **Seven deliberately do not**, and
 * that absence is the load-bearing half of this design:
 *
 *  * `appointment`, `patient` — no practice-management track exposes a
 *    modification timestamp at all.
 *  * `account`, `ap_summary` — computed aggregates. There is no vendor OBJECT
 *    to carry a timestamp; the row is derived from other rows. Xero's
 *    `UpdatedDateUTC` notably does NOT move on a contact-balance change
 *    (WARP-2383), so borrowing it here would be the exact lie this column
 *    exists to prevent.
 *  * `balance_transaction` — Stripe emits no `balance_transaction.*` event, so
 *    `/v1/events`, the source for every other Stripe dataset, does not reach
 *    it. Stamping the parent charge's event time on the ledger row would be
 *    another object's timestamp wearing this one's name.
 *  * `campaign`, `audience` — Mailchimp's `last_changed` is on a list MEMBER,
 *    which is not one of these twenty. Neither the campaign resource nor the
 *    list resource carries a modification time of its own.
 *
 * A synthesised `updated_at` is worse than none, because a watermark TRUSTS
 * it: it advances, the sweep starts to look redundant, and edits quietly stop
 * being seen with nothing anywhere reporting a fault. So each entry below
 * states the vendor field it comes from AND its known limits — the same
 * convention the `invoice` money comment set, for the same reason. The five
 * vendors' fields are not equivalent, and "there is an `updated_at`" is not
 * enough to use one safely. `__tests__/canonical-updated-at.test.ts` asserts
 * the comment is really there, and that the seven above stay without it.
 *
 * The column is declared but never {@link REQUIRED_CANONICAL}: a track that
 * has no source for it leaves it present-and-undefined, like any other
 * unmapped canonical column, and a watermark falls back to its ordering key.
 */
export const CANONICAL_COLUMNS: Readonly<Record<DatasetName, readonly string[]>> = {
  appointment: ["appt_id", "appt_time", "provider_id", "operatory_id", "status", "patient_id"],
  patient: ["patient_id", "first_name", "last_name"],
  account: ["account_id", "balance"],
  // Money OWED TO the business. `balance` is what remains unpaid, which is not
  // the same as `amount` — an invoice part-paid still has its original amount,
  // and summing amounts instead of balances overstates receivables.
  invoice: [
    "invoice_id",
    "issued_at",
    "due_at",
    "customer_id",
    "amount",
    "balance",
    "status",
    // THREE vendors serve this dataset, and their timestamps are not
    // interchangeable — read the one that applies to the track in hand.
    //
    // Xero `UpdatedDateUTC`. DOCUMENTED-INCOMPLETE, and this is the one entry
    // whose limits change how the sync must be operated: it does not fire on a
    // DueDate edit, on SentToContact, or on a contact-balance change
    // (WARP-2383). An incremental pass keyed on it therefore misses real edits
    // in silence, which is why WARP-2218's sweep stays MANDATORY for Xero
    // rather than becoming a safety net.
    //
    // QuickBooks Online `MetaData.LastUpdatedTime` and QuickBooks Desktop
    // qbXML `TimeModified` (WARP-2475). Both are complete — they move on any
    // edit — but both are LOCAL WALL-CLOCK PLUS AN OFFSET, normalised to UTC
    // on the way in. QBD sometimes prints no offset at all, and a naive value
    // is refused rather than guessed, so this column is undefined on those
    // rows and the sweep is what catches those edits.
    "updated_at",
  ],
  // Money OWED BY the business — the half WARP-1991 records as having no data
  // source anywhere in the product.
  bill: [
    "bill_id",
    "issued_at",
    "due_at",
    "vendor_id",
    "amount",
    "balance",
    "status",
    // Xero `UpdatedDateUTC`, with the same documented gaps as `invoice`: no
    // fire on DueDate, SentToContact, or a contact-balance change (WARP-2383).
    // The sweep stays mandatory here for the same reason. QuickBooks Online
    // `MetaData.LastUpdatedTime` and QuickBooks Desktop qbXML `TimeModified`
    // fill it on their own tracks (WARP-2475), on the same terms as
    // `invoice`: converted from an offset, refused when naive.
    "updated_at",
  ],
  ap_summary: ["vendor_id", "balance"],

  // ── payments (WARP-2280) ──────────────────────────────────────────────────

  // One customer payment attempt. `amount` is what was CAPTURED, not what was
  // authorized and not what the business kept — `amount_refunded` has since
  // gone back out, and the processing fee is not visible here at all (it lives
  // on `balance_transaction`). Net revenue from a charge is therefore
  // `amount - amount_refunded - fee_amount`, and every one of those three
  // numbers comes from a different place on purpose: a single "net" column
  // here would be a computation wearing a fact's clothes.
  charge: [
    "charge_id",
    "created_at",
    "customer_id",
    "amount",
    "amount_refunded",
    "currency",
    "status",
    // Stripe puts NO modification time on the object — a charge carries only
    // `created`. This comes from the `/v1/events` stream (`charge.updated`,
    // `charge.refunded`), whose own `created` is when the change happened. The
    // practical consequence: a sync must read the event stream, because
    // re-listing charges can never reveal that one of them moved.
    "updated_at",
  ],
  // Money going BACK to a customer. `amount` is a positive magnitude — the
  // direction is the dataset's name, not the number's sign — so summing
  // refunds gives what was returned, and a caller that wants a net figure
  // subtracts deliberately rather than by accident.
  refund: [
    "refund_id",
    "created_at",
    "charge_id",
    "amount",
    "currency",
    "status",
    "reason",
    // From `/v1/events` (`refund.updated`), not from the object. A refund's
    // `status` moves after creation — pending to succeeded, or to failed — and
    // that transition is the whole reason this dataset needs a modification
    // time: the row a sync already holds is the row that changed.
    "updated_at",
  ],
  // Money leaving the processor's balance for the business's bank. Positive
  // magnitude, same reasoning as `refund`. A payout is NOT revenue: it is a
  // transfer of money already earned, so adding payouts to charges
  // double-counts every dollar.
  payout: [
    "payout_id",
    "created_at",
    "arrival_at",
    "amount",
    "currency",
    "status",
    // From `/v1/events` (`payout.paid`, `payout.failed`, `payout.updated`),
    // not from the object. A payout is created `pending` and settles days
    // later, so its ordering key `created_at` is guaranteed stale by the time
    // the row matters — the clearest case in this table for why an incremental
    // pass cannot key on creation.
    "updated_at",
  ],
  // The fee reconciliation row, and the only place the processor's cut is
  // visible. `net_amount` = `gross_amount` - `fee_amount` and is the ONLY
  // canonical money column that may legitimately be NEGATIVE: a refund's
  // balance transaction takes money off the balance. `fee_amount` is a
  // positive magnitude deducted from gross.
  //
  // NO `updated_at` (WARP-2464) — the one Stripe dataset without it. Stripe
  // emits no `balance_transaction.*` event type, so `/v1/events`, the source
  // the other four Stripe datasets use, does not reach this row. Its
  // pending-to-available `status` move is consequently invisible to an
  // incremental pass, and only WARP-2218's sweep catches it. Taking the parent
  // charge's or payout's event time would put another object's timestamp here
  // under this one's name, which is the failure the column exists to avoid.
  balance_transaction: [
    "balance_transaction_id",
    "created_at",
    "type",
    "gross_amount",
    "fee_amount",
    "net_amount",
    "currency",
  ],
  // A recurring commitment, not a payment. `amount` is the RECURRING amount
  // per `interval` (one billing period), never an annualized or lifetime
  // figure — summing it across subscriptions gives revenue per period, and
  // only if every row's `interval` matches, which a caller must check.
  subscription: [
    "subscription_id",
    "customer_id",
    "status",
    "current_period_start",
    "current_period_end",
    "amount",
    "currency",
    "interval",
    // From `/v1/events` (`customer.subscription.updated`), not from the
    // object. A subscription is the longest-lived row in this table and almost
    // every fact about it — status, price, period — changes long after
    // creation, so its `created` is close to useless as an ordering key.
    "updated_at",
  ],

  // ── CRM (WARP-2280) ───────────────────────────────────────────────────────

  // A person in the sales pipeline. Deliberately NOT merged with `patient` or
  // `customer`: a contact may have bought nothing and may not be a person at
  // this business at all. Carries no money.
  contact: [
    "contact_id",
    "created_at",
    "first_name",
    "last_name",
    "email",
    "company_id",
    "lifecycle_stage",
    // HubSpot `hs_lastmodifieddate`, a real property on the object (unlike
    // Stripe's), and the field its `search` endpoint filters and sorts on. It
    // moves on ANY property write, including ones HubSpot's own automation
    // makes — so it is complete, but it is noisy: a workflow touching a
    // property re-surfaces the contact with nothing a reader would call a
    // change.
    "updated_at",
  ],
  // `hs_lastmodifieddate`, as for `contact`.
  company: [
    "company_id",
    "created_at",
    "name",
    "domain",
    // HubSpot `hs_lastmodifieddate`.
    "updated_at",
  ],
  // A pipeline opportunity. `amount` is EXPECTED value, not money that exists:
  // a deal amount is a salesperson's estimate on an open deal and a contract
  // value on a won one. It is in the same major-unit decimal form as every
  // other money column, but summing it with invoice balances mixes forecast
  // with fact — which is the single most common way a revenue number gets
  // reported wrong.
  deal: [
    "deal_id",
    "created_at",
    "closed_at",
    "company_id",
    "name",
    "stage",
    "amount",
    "currency",
    // HubSpot `hs_lastmodifieddate`. A deal's `stage` and `amount` are edited
    // repeatedly over its life, so this is the only ordering key that can see
    // a pipeline move at all.
    "updated_at",
  ],
  ticket: [
    "ticket_id",
    "created_at",
    "closed_at",
    "contact_id",
    "subject",
    "status",
    "priority",
    // HubSpot `hs_lastmodifieddate`.
    "updated_at",
  ],
  // WARP-2466 — a CRM timeline activity: a call, an email, a meeting, a note,
  // a task. `type` is which of those it was, `occurred_at` is when it happened
  // (NOT when the record was written — a meeting logged the next morning
  // happened the day before, and sorting a timeline by write time reorders
  // history). Deliberately not merged into `ticket`: an engagement has no
  // status and nothing to resolve, it is a thing that HAPPENED.
  engagement: [
    "engagement_id",
    "occurred_at",
    "type",
    "contact_id",
    "deal_id",
    // WARP-2509 — HubSpot `hs_lastmodifieddate`, which engagement objects
    // expose like every other CRM object and which WARP-2494 already requests.
    // WARP-2466 declared this dataset with `occurred_at` alone, and the two are
    // NOT the same instant: `occurred_at` is when the call happened, this is
    // when the record last moved. A meeting logged the next morning and
    // corrected a week later has three dates and only one of them tells a
    // poller there is something new to read.
    "updated_at",
  ],

  // ── commerce (WARP-2280) ──────────────────────────────────────────────────

  // A storefront sales order. Four money columns because the differences are
  // the whole point: `total_amount` is what the buyer was charged (subtotal +
  // tax + shipping), `subtotal_amount` excludes tax, `tax_amount` is the
  // portion that is not the business's money, and `refunded_amount` has since
  // gone back. Revenue is `total_amount - tax_amount - refunded_amount`;
  // reporting `total_amount` as revenue overstates it by the tax collected on
  // somebody else's behalf.
  order: [
    "order_id",
    "created_at",
    "customer_id",
    "total_amount",
    "subtotal_amount",
    "tax_amount",
    "refunded_amount",
    "currency",
    "financial_status",
    "fulfillment_status",
    // Shopify's own `updated_at`, filterable as `updated_at_min` — the only
    // vendor here whose field already carries this name and this meaning. It
    // moves on fulfillment and refund writes, which is exactly what makes an
    // order's `created_at` unusable as an ordering key: an order placed on
    // Monday and shipped on Friday changes without moving.
    "updated_at",
  ],
  // A sellable catalog item. `price_amount` is the LIST price for one unit,
  // before any discount and excluding tax — what an order line actually
  // charged is on the order, not here. `inventory_quantity` is a count, not
  // money, and may be negative where the store allows overselling.
  product: [
    "product_id",
    "created_at",
    "title",
    "sku",
    "price_amount",
    "currency",
    "inventory_quantity",
    "status",
    // Shopify `updated_at` (`updated_at_min`). Price and inventory are edited
    // constantly, so a catalog sync keyed on creation would freeze at the
    // first import.
    "updated_at",
  ],
  // A storefront buyer. Distinct from `contact` (a CRM person, who may have
  // bought nothing) and from `patient` (clinical, PHI). `total_spent_amount`
  // is lifetime gross in `currency` and is NOT net of refunds, so it is a
  // ranking signal rather than a revenue figure; `orders_count` is a count.
  customer: [
    "customer_id",
    "created_at",
    "first_name",
    "last_name",
    "email",
    "orders_count",
    "total_spent_amount",
    "currency",
    // Shopify `updated_at` (`updated_at_min`). `orders_count` and
    // `total_spent_amount` are running totals the storefront rewrites on every
    // purchase, so this row changes far more often than the customer does.
    "updated_at",
  ],

  // ── marketing (WARP-2280) ─────────────────────────────────────────────────

  // One send. Every number here is a COUNT, never money, and the engagement
  // counts are UNIQUE recipients rather than raw events — one recipient
  // opening an email four times is one open, because the alternative makes an
  // open rate exceed 100% and quietly discredits the whole row.
  campaign: [
    "campaign_id",
    "sent_at",
    "audience_id",
    "subject",
    "status",
    "emails_sent",
    "opens_unique",
    "clicks_unique",
  ],
  // NO `updated_at` on `campaign` or `audience` (WARP-2464): the campaign
  // resource and the list resource each carry only a creation time, and
  // Mailchimp's e-commerce orders have none either.
  //
  // WARP-2509 corrects the rest of what this note used to say. It read
  // "NO `updated_at` on either marketing dataset ... `last_changed` is a field
  // on a list MEMBER, which is not one of these twenty datasets" — written
  // before WARP-2466 made `audience_member` the twenty-first. It IS one of
  // these datasets, it DOES have a modification time, and that time is now
  // spelled `updated_at` like every other track's.
  //
  // A mailing list. `member_count` is CURRENT subscribed members, not everyone
  // who was ever on the list — `unsubscribe_count` is tracked separately
  // rather than netted off, so neither number has to be reconstructed from the
  // other.
  audience: ["audience_id", "created_at", "name", "member_count", "unsubscribe_count"],
  // WARP-2466 — one person's MEMBERSHIP of one audience, which is why it is
  // not `contact`. `subscription_status` is subscribed / unsubscribed /
  // cleaned / pending and is the column the whole row exists for: mailing
  // somebody who unsubscribed is the one unrecoverable mistake this dataset
  // can cause. `opted_in_at` is consent evidence, kept separate from
  // `updated_at` because "when did they agree" and "when did this row last
  // move" answer different questions — one of them legal.
  audience_member: [
    "audience_member_id",
    "audience_id",
    "email",
    "subscription_status",
    "opted_in_at",
    // WARP-2509 — Mailchimp `last_changed`, and spelled `updated_at` like the
    // modification column on all thirteen other datasets that have one.
    //
    // WARP-2466 named it `last_changed_at`, mirroring the vendor's own field.
    // That is the wrong axis to mirror on: `watermarkValueOf` reads ONE column
    // name, so a vocabulary with two spellings of "when did this row last
    // move" makes a runner row that travels between tracks key on a column
    // that is not there — and a watermark keyed on a missing column does not
    // fail, it stays null and re-enumerates the whole audience every tick.
    // The vendor's spelling still lives where it belongs, in the mapper.
    "updated_at",
  ],
  // WARP-2466 — a purchase as a MARKETING platform recorded it, synced in by
  // a storefront integration. Deliberately NOT `order`: there is no tax split,
  // no refund column and no fulfillment state, so the revenue arithmetic
  // `order`'s docstring specifies cannot be performed on it and must not be
  // attempted. `total_amount` is what the platform was told the buyer paid —
  // an attribution figure, not the store's books.
  ecommerce_order: [
    "ecommerce_order_id",
    "store_id",
    "customer_id",
    "total_amount",
    "currency",
    "processed_at",
  ],
};

/**
 * The canonical columns a dataset cannot be served without. `appt_time` is
 * required because the schedule read is a time-window filter; `last_name`
 * because the patient read is a name prefix search. A profile missing one of
 * these would produce a dataset that parses and then answers every query
 * wrongly, so it is rejected at registration instead.
 *
 * For the accounting datasets the required column is the one the aggregate is
 * computed over. A `bill` dataset without `balance` would sum to zero and
 * report it as fact — the same class of confidently-wrong answer, in the one
 * domain where nobody would notice it was wrong.
 */
export const REQUIRED_CANONICAL: Readonly<Record<DatasetName, readonly string[]>> = {
  appointment: ["appt_id", "appt_time"],
  patient: ["patient_id", "last_name"],
  account: ["balance"],
  invoice: ["invoice_id", "balance"],
  bill: ["bill_id", "balance"],
  ap_summary: ["balance"],

  // WARP-2280 — for the SaaS datasets the required column is the identity plus
  // whichever single column the dataset exists to answer about. A `charge`
  // without `amount` is a payment that happened for an unknown sum, which is
  // worse than no charge dataset at all: it aggregates to zero and says so
  // confidently. `currency` is required wherever money is, for the same
  // reason — an amount whose currency has to be guessed is not a number.
  charge: ["charge_id", "amount", "currency"],
  refund: ["refund_id", "amount", "currency"],
  payout: ["payout_id", "amount", "currency"],
  balance_transaction: ["balance_transaction_id", "net_amount", "currency"],
  subscription: ["subscription_id", "status"],
  // The CRM datasets are people and pipeline, not money. Identity is the
  // requirement; a `deal` may legitimately have no amount yet, which is what
  // an early-stage deal IS, so requiring one would refuse real rows.
  contact: ["contact_id"],
  company: ["company_id"],
  deal: ["deal_id", "stage"],
  ticket: ["ticket_id", "status"],
  // An activity with no time cannot be placed on the timeline that is the only
  // reason to read it.
  engagement: ["engagement_id", "occurred_at"],
  order: ["order_id", "total_amount", "currency"],
  product: ["product_id"],
  customer: ["customer_id"],
  // A campaign with no send count cannot answer the only question anyone asks
  // of it. An audience without `member_count` sums to zero members and reports
  // it as fact — the marketing-domain twin of a bill with no balance.
  campaign: ["campaign_id", "emails_sent"],
  audience: ["audience_id", "member_count"],
  // Identity plus the subscription state. A member row whose status is unknown
  // is worse than no row: it invites a send to somebody who opted out.
  audience_member: ["audience_member_id", "subscription_status"],
  // Same rule as `order` minus the columns this shape does not carry: an
  // amount whose currency has to be guessed is not a number.
  ecommerce_order: ["ecommerce_order_id", "total_amount", "currency"],
};

/**
 * How a canonical column's cell is parsed out of an exported file.
 *
 * Declared here rather than branched on by name in the scanner, which is what
 * `projectRow` did while there were exactly two special cases (`appt_time`,
 * `balance`). With money and dates on four datasets that branch becomes a list
 * of names in a different file from the list of columns — so the kind travels
 * WITH the column, and a new canonical column cannot be added without saying
 * how to read it.
 *
 * Every canonical column must appear here; `assertColumnKindsComplete` proves
 * it at module load, so a missing entry is a startup failure rather than a
 * column that silently parses as text (a money column read as text would
 * serialize an amount as the string "1,234.56" and break every aggregate).
 *
 * WARP-2280 added `count`. It parses identically to `money` — the same
 * comma-tolerant numeric read, because `"1,234"` members is the same wrong
 * string as `"1,234.56"` dollars — and exists as a separate kind because the
 * two are not the same THING: a money column must carry a sibling `currency`
 * (see {@link assertMoneyColumnsCarryCurrency}) and a count must not. Declaring
 * `member_count` as `money` would compile, parse correctly, and then demand a
 * currency for a number of people.
 */
export const COLUMN_KIND: Readonly<Record<string, "text" | "money" | "count" | "timestamp">> = {
  // practice
  appt_id: "text",
  appt_time: "timestamp",
  provider_id: "text",
  operatory_id: "text",
  status: "text",
  patient_id: "text",
  first_name: "text",
  last_name: "text",
  account_id: "text",
  balance: "money",
  // accounting
  invoice_id: "text",
  bill_id: "text",
  issued_at: "timestamp",
  due_at: "timestamp",
  customer_id: "text",
  vendor_id: "text",
  amount: "money",
  // The vendor modification time (WARP-2464). A timestamp, never text: a
  // watermark compares these, and a string comparison orders "2026-9-1" after
  // "2026-10-1" — a sync that silently stops advancing for a month.
  updated_at: "timestamp",
  // payments (WARP-2280)
  charge_id: "text",
  refund_id: "text",
  payout_id: "text",
  balance_transaction_id: "text",
  subscription_id: "text",
  created_at: "timestamp",
  arrival_at: "timestamp",
  current_period_start: "timestamp",
  current_period_end: "timestamp",
  amount_refunded: "money",
  gross_amount: "money",
  fee_amount: "money",
  net_amount: "money",
  currency: "text",
  reason: "text",
  type: "text",
  interval: "text",
  // CRM (WARP-2280)
  contact_id: "text",
  company_id: "text",
  deal_id: "text",
  ticket_id: "text",
  email: "text",
  lifecycle_stage: "text",
  name: "text",
  domain: "text",
  closed_at: "timestamp",
  stage: "text",
  subject: "text",
  priority: "text",
  // commerce (WARP-2280)
  order_id: "text",
  product_id: "text",
  total_amount: "money",
  subtotal_amount: "money",
  tax_amount: "money",
  refunded_amount: "money",
  price_amount: "money",
  total_spent_amount: "money",
  financial_status: "text",
  fulfillment_status: "text",
  title: "text",
  sku: "text",
  inventory_quantity: "count",
  orders_count: "count",
  // marketing (WARP-2280)
  campaign_id: "text",
  audience_id: "text",
  sent_at: "timestamp",
  emails_sent: "count",
  opens_unique: "count",
  clicks_unique: "count",
  member_count: "count",
  unsubscribe_count: "count",
  // WARP-2466
  engagement_id: "text",
  occurred_at: "timestamp",
  audience_member_id: "text",
  subscription_status: "text",
  opted_in_at: "timestamp",
  // WARP-2509 retired `last_changed_at` here — `updated_at` is already
  // declared above with the other modification columns, and one name for one
  // meaning is the point of the change.
  ecommerce_order_id: "text",
  store_id: "text",
  processed_at: "timestamp",
};

/**
 * The datasets exempt from the money-needs-a-currency rule, named explicitly
 * rather than inferred from absence.
 *
 * These four are a practice's OWN books, kept in one currency by construction:
 * a QuickBooks company file has a home currency and the export carries no
 * per-row currency column to map. Adding one would be a column every shipping
 * profile leaves undefined, which is worse than the honest single-currency
 * assumption stated here.
 *
 * It is a fixed list and not a category test on purpose. A new dataset cannot
 * join it by being filed under `"accounting"`; somebody has to add its name
 * here, in a diff a reviewer sees — which is the point, because the next
 * accounting integration (a multi-entity ledger, a non-US practice) very
 * probably should NOT be exempt.
 */
export const SINGLE_CURRENCY_LEDGER_DATASETS: readonly DatasetName[] = [
  "account",
  "invoice",
  "bill",
  "ap_summary",
];

/** Fail at module load if a canonical column has no declared parse kind. */
function assertColumnKindsComplete(): void {
  const missing: string[] = [];
  for (const dataset of DATASETS) {
    for (const column of CANONICAL_COLUMNS[dataset]) {
      if (!(column in COLUMN_KIND)) missing.push(`${dataset}.${column}`);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `COLUMN_KIND is missing an entry for: ${missing.join(", ")} — ` +
        `every canonical column must declare how its cell is parsed`,
    );
  }
}
assertColumnKindsComplete();

/**
 * Fail at module load if a dataset carries money without carrying its currency.
 *
 * A module-load assertion rather than a test because it is a property of the
 * shipped table, not of a scenario: a `charge` whose `currency` column was
 * dropped in a refactor would pass every behavioural test that does not happen
 * to read the currency, and then put a number in front of an owner that is
 * only right if they trade in one currency. The four ledger datasets that
 * predate multi-currency support are exempt by name — see
 * {@link SINGLE_CURRENCY_LEDGER_DATASETS}.
 */
function assertMoneyColumnsCarryCurrency(): void {
  const offenders: string[] = [];
  for (const dataset of DATASETS) {
    if (SINGLE_CURRENCY_LEDGER_DATASETS.includes(dataset)) continue;
    const columns = CANONICAL_COLUMNS[dataset];
    const money = columns.filter((c) => COLUMN_KIND[c] === "money");
    if (money.length > 0 && !columns.includes("currency")) {
      offenders.push(`${dataset} (${money.join(", ")})`);
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `CANONICAL_COLUMNS carries money without a currency column on: ${offenders.join("; ")} — ` +
        `an amount whose currency must be guessed is not a number`,
    );
  }
}
assertMoneyColumnsCarryCurrency();

/** One dataset's mapping within a vendor profile. */
export interface DatasetProfile {
  dataset: DatasetName;
  /** Source headers that must ALL be present for this profile to claim a file. */
  required: readonly string[];
  /** canonical column name -> source header spelling. */
  columns: Readonly<Record<string, string>>;
}

/** One practice-management system's export shape. */
export interface ExportProfile {
  /** Vendor key; the provider is `<vendor>-export`. */
  vendor: string;
  /** Human label for diagnostics and (later) the dashboard hub. */
  label: string;
  /**
   * Whether this mapping has been confirmed against a real export produced by
   * that product. Every built-in ships `false` — we have not had an install in
   * front of us. This is surfaced rather than hidden because an unconfirmed
   * mapping is exactly the thing an operator should check on day one.
   */
  verified: boolean;
  datasets: readonly DatasetProfile[];
}

/** Thrown when a profile is structurally invalid. Registration-time failure —
 *  a malformed profile must never reach the matcher. */
export class ProfileError extends Error {
  readonly code = "EXPORT_PROFILE_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "ProfileError";
  }
}

/**
 * Normalize a header for matching: trim, collapse internal whitespace, lower-case.
 *
 * Exports differ in case and spacing between report versions without the column
 * meaning anything different (`Patient ID`, `PATIENT  ID`, `patient id`).
 * Matching on the normalized form absorbs that; the original spelling is kept
 * for diagnostics.
 */
export function normalizeHeader(header: string): string {
  return header.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Validate one profile, throwing {@link ProfileError} on the first problem. */
export function assertValidProfile(profile: ExportProfile): void {
  if (!profile.vendor || !/^[a-z0-9][a-z0-9-]*$/.test(profile.vendor)) {
    throw new ProfileError(
      `profile vendor "${profile.vendor}" must be lower-case alphanumeric with dashes`,
    );
  }
  if (profile.datasets.length === 0) {
    throw new ProfileError(`profile "${profile.vendor}" declares no datasets`);
  }
  const seen = new Set<string>();
  for (const ds of profile.datasets) {
    if (!(DATASETS as readonly string[]).includes(ds.dataset)) {
      throw new ProfileError(`profile "${profile.vendor}" has unknown dataset "${ds.dataset}"`);
    }
    if (seen.has(ds.dataset)) {
      throw new ProfileError(`profile "${profile.vendor}" declares dataset "${ds.dataset}" twice`);
    }
    seen.add(ds.dataset);

    if (ds.required.length === 0) {
      throw new ProfileError(
        `profile "${profile.vendor}" dataset "${ds.dataset}" has no required headers — ` +
          `it would claim every file`,
      );
    }
    const allowed = CANONICAL_COLUMNS[ds.dataset];
    for (const canonical of Object.keys(ds.columns)) {
      if (!allowed.includes(canonical)) {
        throw new ProfileError(
          `profile "${profile.vendor}" dataset "${ds.dataset}" maps unknown canonical ` +
            `column "${canonical}" (known: ${allowed.join(", ")})`,
        );
      }
    }
    for (const canonical of REQUIRED_CANONICAL[ds.dataset]) {
      if (!ds.columns[canonical]) {
        throw new ProfileError(
          `profile "${profile.vendor}" dataset "${ds.dataset}" must map "${canonical}"`,
        );
      }
    }
    // Every source header a mapping points at has to be one the matcher
    // actually checked for; otherwise the profile could claim a file and then
    // read a column that is not there.
    const requiredSet = new Set(ds.required.map(normalizeHeader));
    for (const [canonical, header] of Object.entries(ds.columns)) {
      if (REQUIRED_CANONICAL[ds.dataset].includes(canonical) && !requiredSet.has(normalizeHeader(header))) {
        throw new ProfileError(
          `profile "${profile.vendor}" dataset "${ds.dataset}" maps required column ` +
            `"${canonical}" to header "${header}", which is not in its required list`,
        );
      }
    }
  }
}

/**
 * Built-in profiles. All ship `verified: false` — see {@link ExportProfile.verified}.
 *
 * These are starting points that make a first site visit productive, not
 * claims about what a given install emits. Report layouts are configurable in
 * every one of these products, so the operator confirms the mapping against a
 * real export and adjusts via an operator profile if it differs. Because a
 * non-matching profile degrades to "unrecognized file, here are its headers",
 * a wrong guess here costs an operator one edit — it can never produce wrong
 * rows.
 *
 * Dentrix is deliberately NOT here — see {@link NAME_ONLY_VENDORS}.
 *
 * The `opendental` mapping is modelled on Open Dental's published schema
 * (`appointment.AptNum` / `AptDateTime` / `AptStatus`, `patient.PatNum` /
 * `FName` / `LName`), which is documented publicly; the other two are shaped
 * from the report columns those products present in their UI.
 */
export const BUILT_IN_PROFILES: readonly ExportProfile[] = [
  {
    vendor: "eaglesoft",
    label: "Eaglesoft (Patterson Dental)",
    verified: false,
    datasets: [
      {
        dataset: "appointment",
        required: ["Appointment ID", "Appointment Time"],
        columns: {
          appt_id: "Appointment ID",
          appt_time: "Appointment Time",
          provider_id: "Provider ID",
          operatory_id: "Operatory",
          status: "Status",
          patient_id: "Patient ID",
        },
      },
      {
        dataset: "patient",
        required: ["Patient ID", "Last Name"],
        columns: { patient_id: "Patient ID", first_name: "First Name", last_name: "Last Name" },
      },
      {
        dataset: "account",
        required: ["Account ID", "Balance"],
        columns: { account_id: "Account ID", balance: "Balance" },
      },
    ],
  },
  {
    // WARP-2107 — the first ACCOUNTING vendor on this track, and the first
    // profile whose datasets are not dental. Shapes are taken from the columns
    // QuickBooks prints in its own report UI; Desktop and Online emit the same
    // report names and broadly the same headers, so one profile covers both
    // products, which is what makes this the cheapest QuickBooks integration
    // available (no SDK, no OAuth, no meter, no vendor approval).
    //
    // Report → dataset mapping this assumes the practice exports:
    //   "Open Invoices"        → invoice
    //   "Unpaid Bills Detail"  → bill
    //   "A/P Aging Summary"    → ap_summary
    //
    // The `required` lists carry DISCRIMINATORS beyond the strictly-required
    // canonical columns, because the three reports overlap heavily. Open
    // Invoices and Unpaid Bills Detail both print `Num` + `Open Balance` and
    // differ only by `Customer` vs `Vendor`; A/P Aging Summary is separated by
    // `Current`, its first ageing bucket. Without those, two profiles would
    // claim one file and the matcher would (correctly) refuse it as ambiguous
    // rather than guess — a refusal is safe, but a needless one wastes a site
    // visit.
    //
    // `status` is deliberately UNMAPPED on both: QuickBooks' open-item reports
    // carry a `Transaction Type` column whose value is the document kind
    // ("Invoice", "Bill"), not a payment status. Mapping it would put a
    // confident wrong value in a field callers read as state — and an unmapped
    // canonical column is present-and-undefined, which is honest.
    vendor: "quickbooks",
    label: "QuickBooks (Intuit) — Desktop or Online",
    verified: false,
    datasets: [
      {
        dataset: "invoice",
        required: ["Num", "Open Balance", "Customer"],
        columns: {
          invoice_id: "Num",
          issued_at: "Date",
          due_at: "Due Date",
          customer_id: "Customer",
          amount: "Amount",
          balance: "Open Balance",
        },
      },
      {
        dataset: "bill",
        required: ["Num", "Open Balance", "Vendor"],
        columns: {
          bill_id: "Num",
          issued_at: "Date",
          due_at: "Due Date",
          vendor_id: "Vendor",
          amount: "Amount",
          balance: "Open Balance",
        },
      },
      {
        dataset: "ap_summary",
        required: ["Vendor", "Total", "Current"],
        columns: { vendor_id: "Vendor", balance: "Total" },
      },
    ],
  },
  {
    vendor: "opendental",
    label: "Open Dental",
    verified: false,
    datasets: [
      {
        dataset: "appointment",
        required: ["AptNum", "AptDateTime"],
        columns: {
          appt_id: "AptNum",
          appt_time: "AptDateTime",
          provider_id: "ProvNum",
          operatory_id: "Op",
          status: "AptStatus",
          patient_id: "PatNum",
        },
      },
      {
        dataset: "patient",
        required: ["PatNum", "LName"],
        columns: { patient_id: "PatNum", first_name: "FName", last_name: "LName" },
      },
      {
        dataset: "account",
        required: ["PatNum", "EstBalance"],
        columns: { account_id: "PatNum", balance: "EstBalance" },
      },
    ],
  },
];

/**
 * The vendor key reserved for installs whose product has no built-in profile.
 * It ships no datasets of its own — an operator profile supplies them — so a
 * `generic-export` connection with no operator profile blocks honestly instead
 * of pretending to support an unknown product.
 */
export const GENERIC_VENDOR = "generic";

/**
 * Vendors that are CONNECTABLE but that we ship no mapping for.
 *
 * A name-only vendor is not the same as an unsupported one. `dentrix-export`
 * stays a valid provider key, the connect flow still works, and the scanner
 * still reports every unrecognised file **together with the headers it actually
 * had** — which is exactly what an operator needs to author the real profile on
 * site. What it does not do is guess.
 *
 * ## Why Dentrix is here rather than carrying a built-in
 *
 * It had one, shaped from the field names Dentrix documents. It was removed
 * because it could produce silently wrong rows, which every other built-in
 * cannot:
 *
 *  * It mapped the canonical **timestamp** column `appt_time` to a header named
 *    `"Appt Date"` — the only built-in whose column KIND disagreed with its
 *    header NAME (Eaglesoft maps `"Appointment Time"`, Open Dental
 *    `"AptDateTime"`). `parseExportTimestamp` accepts a date-only cell and
 *    returns midnight, and the schedule read is a `[from, to)` window filter —
 *    so a real Dentrix export printing a date-only column under that header
 *    would be CLAIMED, parse cleanly, and put every appointment of the day at
 *    00:00 in arbitrary order. Verified against this code, not argued.
 *  * Henry Schein One's documented merge vocabulary carries no appointment
 *    identifier and no operatory identifier at all, so `REQUIRED_CANONICAL
 *    .appointment` (`appt_id` + `appt_time`) cannot honestly be satisfied.
 *  * The `Status` field in that vocabulary is the PATIENT status, not the
 *    appointment's. Mapping canonical `status` to it would match a real file
 *    and carry the wrong meaning silently.
 *
 * A profile that fails to match costs an operator one edit. A profile that
 * matches the WRONG column costs them wrong numbers they have no reason to
 * doubt. Nobody has seen a real Dentrix export — that is the whole premise of
 * `verified: false` — and where the guess could be wrong in that second way, it
 * does not ship.
 *
 * Remove Dentrix from this list the day someone puts a real export in front of
 * it. That is the only thing needed, and it costs nothing.
 */
export const NAME_ONLY_VENDORS: readonly string[] = ["dentrix"];

/** Every vendor this track can be configured for, built-ins plus the generic
 *  escape hatch. Used to validate a provider key before a connection is saved. */
export function knownVendors(extra: readonly ExportProfile[] = []): string[] {
  const vendors = new Set<string>([GENERIC_VENDOR, ...NAME_ONLY_VENDORS]);
  for (const p of BUILT_IN_PROFILES) vendors.add(p.vendor);
  for (const p of extra) vendors.add(p.vendor);
  return [...vendors].sort();
}

/**
 * Profiles in force for one vendor: its built-in (if any) plus operator-supplied
 * ones. An operator profile for a vendor REPLACES the built-in rather than
 * merging with it — a half-overridden mapping is the kind of thing nobody can
 * reason about at 8am at a practice, and replacing is the behaviour an operator
 * writing a profile expects.
 */
export function profilesForVendor(
  vendor: string,
  extra: readonly ExportProfile[] = [],
): ExportProfile[] {
  const overrides = extra.filter((p) => p.vendor === vendor);
  if (overrides.length > 0) return overrides;
  return BUILT_IN_PROFILES.filter((p) => p.vendor === vendor);
}

/** A dataset profile paired with the vendor profile that carried it. */
export interface DatasetCandidate {
  profile: ExportProfile;
  dataset: DatasetProfile;
}

/** The outcome of matching one file's headers against a vendor's profiles. */
export type MatchResult =
  | { kind: "matched"; candidate: DatasetCandidate }
  | { kind: "unrecognized" }
  | { kind: "ambiguous"; datasets: string[] };

/**
 * Match a header row against a vendor's profiles.
 *
 * Every `required` header must be present (normalized comparison). Zero matches
 * is `unrecognized`; more than one is `ambiguous` and is refused — see the
 * module docstring for why neither degrades into a guess.
 */
export function matchDataset(
  headers: readonly string[],
  profiles: readonly ExportProfile[],
): MatchResult {
  const present = new Set(headers.map(normalizeHeader));
  const hits: DatasetCandidate[] = [];

  for (const profile of profiles) {
    for (const dataset of profile.datasets) {
      const allPresent = dataset.required.every((h) => present.has(normalizeHeader(h)));
      if (allPresent) hits.push({ profile, dataset });
    }
  }

  if (hits.length === 0) return { kind: "unrecognized" };
  if (hits.length > 1) {
    return {
      kind: "ambiguous",
      datasets: hits.map((h) => `${h.profile.vendor}.${h.dataset.dataset}`).sort(),
    };
  }
  return { kind: "matched", candidate: hits[0] };
}

/**
 * Parse and validate operator-supplied profiles from JSON.
 *
 * Accepts either a single profile object or an array. Every profile is run
 * through {@link assertValidProfile}, so a typo in a column name is a startup
 * error naming the typo rather than a dataset that silently reads the wrong
 * column. An operator profile is always recorded `verified: true` — an operator
 * writing a mapping against the export in front of them has done exactly the
 * confirmation the built-ins are missing.
 */
export function parseProfileJson(json: string): ExportProfile[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new ProfileError(`operator profiles are not valid JSON: ${(err as Error).message}`);
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const profiles: ExportProfile[] = [];

  for (const raw of list) {
    if (typeof raw !== "object" || raw === null) {
      throw new ProfileError("each operator profile must be a JSON object");
    }
    const rec = raw as Record<string, unknown>;
    const vendor = typeof rec.vendor === "string" ? rec.vendor : "";
    const label = typeof rec.label === "string" ? rec.label : vendor;
    const rawDatasets = Array.isArray(rec.datasets) ? rec.datasets : [];

    const datasets: DatasetProfile[] = rawDatasets.map((d) => {
      if (typeof d !== "object" || d === null) {
        throw new ProfileError(`profile "${vendor}" has a non-object dataset entry`);
      }
      const dr = d as Record<string, unknown>;
      const columnsRaw = dr.columns;
      if (typeof columnsRaw !== "object" || columnsRaw === null) {
        throw new ProfileError(`profile "${vendor}" has a dataset with no columns map`);
      }
      const columns: Record<string, string> = {};
      for (const [k, v] of Object.entries(columnsRaw as Record<string, unknown>)) {
        if (typeof v !== "string") {
          throw new ProfileError(
            `profile "${vendor}" maps canonical column "${k}" to a non-string header`,
          );
        }
        columns[k] = v;
      }
      const required = Array.isArray(dr.required)
        ? dr.required.filter((h): h is string => typeof h === "string")
        : [];
      // Narrowed, not cast (WARP-2306). `assertValidProfile` re-checks
      // membership and produces the operator-facing message; this guard is
      // what makes the value a `DatasetName` at all, so an unknown name can
      // never reach `CANONICAL_COLUMNS[...]` as a typed key that is not there.
      if (!isDatasetName(dr.dataset)) {
        throw new ProfileError(
          `profile "${vendor}" has unknown dataset "${String(dr.dataset)}" ` +
            `(known: ${DATASETS.join(", ")})`,
        );
      }
      return { dataset: dr.dataset, required, columns };
    });

    const profile: ExportProfile = { vendor, label, verified: true, datasets };
    assertValidProfile(profile);
    profiles.push(profile);
  }
  return profiles;
}
