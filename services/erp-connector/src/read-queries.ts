/**
 * WARP-1094 — read-query registry (brief §10.1, §10.3, §5 rules 3 & 4).
 *
 * The ONLY way data leaves Eaglesoft: a fixed set of named, parameterized
 * queries. Each query declares the tables/columns it touches by LOGICAL name;
 * `buildReadStatement` resolves those to physical identifiers through the
 * introspected schema map (invariant 3) and emits SQL with `?` placeholders
 * for every value (never string-concatenated). The LLM/dashboard names a
 * registered query — it never emits SQL (invariant 4). An unknown name throws.
 *
 * This module is PURE: it builds statements, it does not execute them. The
 * driver is stubbed until the SAP SQL Anywhere client + a copy of
 * PattersonPM.db exist (see connector.ts).
 */
import { resolveTable, resolveColumn, type SchemaMap } from "./schema-map.js";
import type { DatasetName } from "./export-drop/profiles.js";

/**
 * Escape SQL `LIKE` metacharacters (`%`, `_`, and the escape char itself) in a
 * user-supplied search term so it can only match a literal prefix — never a
 * wildcard. Without this, a `find_patient` query of "%" would match every
 * patient row (a PHI minimum-necessary violation, brief §14). The value still
 * binds as `?`; this closes the wildcard-scoping hole, not an injection one.
 * Pairs with `... LIKE ? ESCAPE '\'`.
 */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Translate the `erp_get_schedule_today` tool's `date` (YYYY-MM-DD) input into
 * the half-open `[from, to)` bounds the `get_schedule_today` query binds — the
 * single, tested seam between the tool's contract and the query's, so the two
 * halves can't silently disagree when the live path is wired (WARP-1095+).
 * Returns UTC day bounds; local-timezone day boundaries are a WARP-1095
 * refinement (brief §8.2). Throws on a malformed date rather than silently
 * producing an empty window.
 */
export function scheduleDayBounds(date: string): { from: string; to: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new RangeError(`invalid schedule date "${date}" — expected YYYY-MM-DD`);
  }
  const from = `${date}T00:00:00.000Z`;
  const next = new Date(from);
  next.setUTCDate(next.getUTCDate() + 1);
  return { from, to: next.toISOString() };
}

/** Thrown when a caller names a read query that is not registered. */
export class UnknownReadQueryError extends Error {
  readonly code = "UNKNOWN_READ_QUERY";
  constructor(name: string) {
    super(`unknown read query "${name}" — not in the read-query registry`);
    this.name = "UnknownReadQueryError";
  }
}

/** A built, ready-to-execute parameterized statement. */
export interface BuiltStatement {
  sql: string;
  params: unknown[];
}

/** A named read query. `build` resolves identifiers through the schema map
 *  and binds every value as `?`. `exampleParams` documents the shape and is
 *  used by the unit suite to prove parameterization without a database. */
export interface ReadQuery {
  name: string;
  description: string;
  /** Logical tables this query depends on (for drift/coverage checks).
   *  Typed as the dataset-name union, not `string[]`: a typo here would
   *  silently drop the query out of every capability filter (e.g.
   *  `requiredRouteOps`), and the coverage tests that loop over those filter
   *  results would pass vacuously over the missing entry. */
  dependsOnTables: DatasetName[];
  exampleParams: Record<string, unknown>;
  build(map: SchemaMap, params: Record<string, unknown>): BuiltStatement;
}

const getScheduleToday: ReadQuery = {
  name: "get_schedule_today",
  description: "Today's appointments in a [from, to) time window, ordered by time.",
  dependsOnTables: ["appointment"],
  exampleParams: { from: "2026-07-07T00:00:00Z", to: "2026-07-08T00:00:00Z" },
  build(map, params) {
    const appt = resolveTable(map, "appointment");
    const apptId = resolveColumn(map, "appointment", "appt_id");
    const apptTime = resolveColumn(map, "appointment", "appt_time");
    const providerId = resolveColumn(map, "appointment", "provider_id");
    const operatoryId = resolveColumn(map, "appointment", "operatory_id");
    const status = resolveColumn(map, "appointment", "status");
    const patientId = resolveColumn(map, "appointment", "patient_id");
    const sql =
      `SELECT ${apptId}, ${apptTime}, ${providerId}, ${operatoryId}, ${status}, ${patientId} ` +
      `FROM ${appt} ` +
      `WHERE ${apptTime} >= ? AND ${apptTime} < ? ` +
      `ORDER BY ${apptTime}`;
    return { sql, params: [params.from, params.to] };
  },
};

const findPatient: ReadQuery = {
  name: "find_patient",
  description: "Search patients by last-name prefix (keyset-friendly), minimum-necessary fields.",
  dependsOnTables: ["patient"],
  exampleParams: { query: "smith" },
  build(map, params) {
    const patient = resolveTable(map, "patient");
    const patientId = resolveColumn(map, "patient", "patient_id");
    const firstName = resolveColumn(map, "patient", "first_name");
    const lastName = resolveColumn(map, "patient", "last_name");
    const sql =
      `SELECT ${patientId}, ${firstName}, ${lastName} ` +
      `FROM ${patient} ` +
      `WHERE ${lastName} LIKE ? ESCAPE '\\' ` +
      `ORDER BY ${lastName}, ${firstName}`;
    // Prefix match. LIKE metacharacters in the term are escaped so a "%"/"_"
    // can't turn a name search into a full-table scan (PHI over-fetch); the
    // trailing `%` (the prefix wildcard) is appended after escaping and the
    // value still binds as `?` (never concatenated).
    return { sql, params: [`${escapeLike(String(params.query))}%`] };
  },
};

const getArSummary: ReadQuery = {
  name: "get_ar_summary",
  description: "Accounts-receivable summary: total balance and count, aggregated in SQL.",
  dependsOnTables: ["account"],
  exampleParams: {},
  build(map) {
    const account = resolveTable(map, "account");
    const balance = resolveColumn(map, "account", "balance");
    const accountId = resolveColumn(map, "account", "account_id");
    // Aggregate in SQL (brief §10.1) — never pull raw ledger rows to Node.
    const sql =
      `SELECT COUNT(${accountId}) AS account_count, ` +
      `SUM(${balance}) AS total_balance ` +
      `FROM ${account}`;
    return { sql, params: [] };
  },
};

const getPatient: ReadQuery = {
  name: "get_patient",
  description: "One patient's minimum-necessary summary, by id.",
  dependsOnTables: ["patient"],
  exampleParams: { patientId: "p-123" },
  build(map, params) {
    const patient = resolveTable(map, "patient");
    const patientId = resolveColumn(map, "patient", "patient_id");
    const firstName = resolveColumn(map, "patient", "first_name");
    const lastName = resolveColumn(map, "patient", "last_name");
    const sql =
      `SELECT ${patientId}, ${firstName}, ${lastName} ` +
      `FROM ${patient} ` +
      `WHERE ${patientId} = ?`;
    return { sql, params: [params.patientId] };
  },
};

const getRecallDue: ReadQuery = {
  name: "get_recall_due",
  description:
    "Patients overdue for recare/recall (minimum-necessary). The recall predicate + recall-table join are refined against the live schema in WARP-1096.",
  dependsOnTables: ["patient"],
  exampleParams: {},
  build(map) {
    const patient = resolveTable(map, "patient");
    const patientId = resolveColumn(map, "patient", "patient_id");
    const firstName = resolveColumn(map, "patient", "first_name");
    const lastName = resolveColumn(map, "patient", "last_name");
    const sql =
      `SELECT ${patientId}, ${firstName}, ${lastName} ` +
      `FROM ${patient} ` +
      `ORDER BY ${lastName}, ${firstName}`;
    return { sql, params: [] };
  },
};

// ── WARP-2107 — accounting reads ────────────────────────────────────────────
//
// These depend on datasets no practice-management track serves, which is the
// whole reason `Connector.servesDatasets` exists (see connector.ts): a track is
// asked only for datasets it has declared, and asking for one it has not is a
// typed refusal rather than a resolve failure deep in a build.
//
// The SQL here is written even though no shipping track executes it. The
// registry is the single definition of what a read MEANS, and a future
// accounting provider with a real database must inherit that definition rather
// than invent a second one.

const getOpenInvoices: ReadQuery = {
  name: "get_open_invoices",
  description: "Unpaid/partly-paid customer invoices — money owed TO the business — oldest due first.",
  dependsOnTables: ["invoice"],
  exampleParams: {},
  build(map) {
    const invoice = resolveTable(map, "invoice");
    const invoiceId = resolveColumn(map, "invoice", "invoice_id");
    const issuedAt = resolveColumn(map, "invoice", "issued_at");
    const dueAt = resolveColumn(map, "invoice", "due_at");
    const customerId = resolveColumn(map, "invoice", "customer_id");
    const amount = resolveColumn(map, "invoice", "amount");
    const balance = resolveColumn(map, "invoice", "balance");
    const status = resolveColumn(map, "invoice", "status");
    // "Open" is a non-zero balance, not a status string: status vocabularies
    // differ per product ("Open"/"Overdue"/"Partial"/"Sent"), and every one of
    // them agrees that money is outstanding when the balance is not zero.
    const sql =
      `SELECT ${invoiceId}, ${issuedAt}, ${dueAt}, ${customerId}, ${amount}, ${balance}, ${status} ` +
      `FROM ${invoice} ` +
      `WHERE ${balance} <> 0 ` +
      `ORDER BY ${dueAt}, ${invoiceId}`;
    return { sql, params: [] };
  },
};

const getOpenBills: ReadQuery = {
  name: "get_open_bills",
  description: "Unpaid/partly-paid vendor bills — money owed BY the business — oldest due first.",
  dependsOnTables: ["bill"],
  exampleParams: {},
  build(map) {
    const bill = resolveTable(map, "bill");
    const billId = resolveColumn(map, "bill", "bill_id");
    const issuedAt = resolveColumn(map, "bill", "issued_at");
    const dueAt = resolveColumn(map, "bill", "due_at");
    const vendorId = resolveColumn(map, "bill", "vendor_id");
    const amount = resolveColumn(map, "bill", "amount");
    const balance = resolveColumn(map, "bill", "balance");
    const status = resolveColumn(map, "bill", "status");
    const sql =
      `SELECT ${billId}, ${issuedAt}, ${dueAt}, ${vendorId}, ${amount}, ${balance}, ${status} ` +
      `FROM ${bill} ` +
      `WHERE ${balance} <> 0 ` +
      `ORDER BY ${dueAt}, ${billId}`;
    return { sql, params: [] };
  },
};

const getApSummary: ReadQuery = {
  name: "get_ap_summary",
  description: "Accounts-payable summary: total owed and vendor count, aggregated in SQL.",
  dependsOnTables: ["ap_summary"],
  exampleParams: {},
  build(map) {
    const table = resolveTable(map, "ap_summary");
    const vendorId = resolveColumn(map, "ap_summary", "vendor_id");
    const balance = resolveColumn(map, "ap_summary", "balance");
    // Mirrors get_ar_summary exactly, including aggregating in SQL rather than
    // shipping rows to Node (brief §10.1).
    const sql =
      `SELECT COUNT(${vendorId}) AS vendor_count, ` +
      `SUM(${balance}) AS total_balance ` +
      `FROM ${table}`;
    return { sql, params: [] };
  },
};

// ── WARP-2280 — the SaaS datasets ───────────────────────────────────────────
//
// Same standing as the WARP-2107 accounting reads above: the registry is the
// single definition of what a read MEANS, and the vendor connectors landing
// under WARP-2214 inherit that definition rather than each inventing one. No
// shipping track executes these yet, and each is refused up front by
// `assertDatasetsServed` on every track that does not declare its dataset —
// which is the point of writing them alongside the vocabulary rather than
// after it.
//
// Two conventions, both load-bearing:
//
//  * **A vendor's state vocabulary is a PARAMETER, never a literal in our
//    SQL.** `status` means different words at Stripe, HubSpot and Shopify
//    ("active"/"trialing", "open"/"closed", "paid"/"pending"), and a literal
//    here would silently return nothing the day a vendor renamed one. Where
//    the accounting reads could express "open" numerically (`balance <> 0`)
//    they did; where no number exists, the caller supplies the vendor's own
//    word and it binds as `?`.
//  * **Openness is never derived from a NULL.** `closed_at IS NULL` would be
//    exactly the absence-as-state the house rules forbid, so the deal and
//    ticket reads filter on an explicit stage/status value instead.

const getRecentCharges: ReadQuery = {
  name: "get_recent_charges",
  description: "Customer payments captured in a [from, to) window, newest first.",
  dependsOnTables: ["charge"],
  exampleParams: { from: "2026-08-01T00:00:00Z", to: "2026-09-01T00:00:00Z" },
  build(map, params) {
    const charge = resolveTable(map, "charge");
    const chargeId = resolveColumn(map, "charge", "charge_id");
    const createdAt = resolveColumn(map, "charge", "created_at");
    const customerId = resolveColumn(map, "charge", "customer_id");
    const amount = resolveColumn(map, "charge", "amount");
    const amountRefunded = resolveColumn(map, "charge", "amount_refunded");
    const currency = resolveColumn(map, "charge", "currency");
    const status = resolveColumn(map, "charge", "status");
    // `amount_refunded` travels with the charge rather than being netted off:
    // a caller reporting gross takings and one reporting what was kept need
    // different numbers, and only one of them can be the column.
    const sql =
      `SELECT ${chargeId}, ${createdAt}, ${customerId}, ${amount}, ${amountRefunded}, ` +
      `${currency}, ${status} ` +
      `FROM ${charge} ` +
      `WHERE ${createdAt} >= ? AND ${createdAt} < ? ` +
      `ORDER BY ${createdAt} DESC, ${chargeId}`;
    return { sql, params: [params.from, params.to] };
  },
};

const getRefunds: ReadQuery = {
  name: "get_refunds",
  description: "Money returned to customers in a [from, to) window, newest first.",
  dependsOnTables: ["refund"],
  exampleParams: { from: "2026-08-01T00:00:00Z", to: "2026-09-01T00:00:00Z" },
  build(map, params) {
    const refund = resolveTable(map, "refund");
    const refundId = resolveColumn(map, "refund", "refund_id");
    const createdAt = resolveColumn(map, "refund", "created_at");
    const chargeId = resolveColumn(map, "refund", "charge_id");
    const amount = resolveColumn(map, "refund", "amount");
    const currency = resolveColumn(map, "refund", "currency");
    const status = resolveColumn(map, "refund", "status");
    const reason = resolveColumn(map, "refund", "reason");
    const sql =
      `SELECT ${refundId}, ${createdAt}, ${chargeId}, ${amount}, ${currency}, ${status}, ${reason} ` +
      `FROM ${refund} ` +
      `WHERE ${createdAt} >= ? AND ${createdAt} < ? ` +
      `ORDER BY ${createdAt} DESC, ${refundId}`;
    return { sql, params: [params.from, params.to] };
  },
};

const getPayouts: ReadQuery = {
  name: "get_payouts",
  description: "Transfers from the processor balance to the business's bank, newest first.",
  dependsOnTables: ["payout"],
  exampleParams: { from: "2026-08-01T00:00:00Z", to: "2026-09-01T00:00:00Z" },
  build(map, params) {
    const payout = resolveTable(map, "payout");
    const payoutId = resolveColumn(map, "payout", "payout_id");
    const createdAt = resolveColumn(map, "payout", "created_at");
    const arrivalAt = resolveColumn(map, "payout", "arrival_at");
    const amount = resolveColumn(map, "payout", "amount");
    const currency = resolveColumn(map, "payout", "currency");
    const status = resolveColumn(map, "payout", "status");
    // Windowed on `created_at`, not `arrival_at`: arrival is an estimate the
    // bank can move, so a window over it silently changes which rows a
    // yesterday's report contains.
    const sql =
      `SELECT ${payoutId}, ${createdAt}, ${arrivalAt}, ${amount}, ${currency}, ${status} ` +
      `FROM ${payout} ` +
      `WHERE ${createdAt} >= ? AND ${createdAt} < ? ` +
      `ORDER BY ${createdAt} DESC, ${payoutId}`;
    return { sql, params: [params.from, params.to] };
  },
};

const getProcessingFees: ReadQuery = {
  name: "get_processing_fees",
  description:
    "Gross, fee and net per balance movement in a [from, to) window — the only place the processor's cut is visible.",
  dependsOnTables: ["balance_transaction"],
  exampleParams: { from: "2026-08-01T00:00:00Z", to: "2026-09-01T00:00:00Z" },
  build(map, params) {
    const bt = resolveTable(map, "balance_transaction");
    const btId = resolveColumn(map, "balance_transaction", "balance_transaction_id");
    const createdAt = resolveColumn(map, "balance_transaction", "created_at");
    const type = resolveColumn(map, "balance_transaction", "type");
    const gross = resolveColumn(map, "balance_transaction", "gross_amount");
    const fee = resolveColumn(map, "balance_transaction", "fee_amount");
    const net = resolveColumn(map, "balance_transaction", "net_amount");
    const currency = resolveColumn(map, "balance_transaction", "currency");
    // Rows, not a SUM. The accounting summaries aggregate in SQL because one
    // number is the answer; here the three columns only mean something
    // together, and a total that mixed currencies would be arithmetic on
    // incomparable units.
    const sql =
      `SELECT ${btId}, ${createdAt}, ${type}, ${gross}, ${fee}, ${net}, ${currency} ` +
      `FROM ${bt} ` +
      `WHERE ${createdAt} >= ? AND ${createdAt} < ? ` +
      `ORDER BY ${createdAt} DESC, ${btId}`;
    return { sql, params: [params.from, params.to] };
  },
};

const getSubscriptionsByStatus: ReadQuery = {
  name: "get_subscriptions_by_status",
  description: "Recurring commitments in one vendor-supplied status, soonest renewal first.",
  dependsOnTables: ["subscription"],
  exampleParams: { status: "active" },
  build(map, params) {
    const sub = resolveTable(map, "subscription");
    const subId = resolveColumn(map, "subscription", "subscription_id");
    const customerId = resolveColumn(map, "subscription", "customer_id");
    const status = resolveColumn(map, "subscription", "status");
    const periodStart = resolveColumn(map, "subscription", "current_period_start");
    const periodEnd = resolveColumn(map, "subscription", "current_period_end");
    const amount = resolveColumn(map, "subscription", "amount");
    const currency = resolveColumn(map, "subscription", "currency");
    const interval = resolveColumn(map, "subscription", "interval");
    const sql =
      `SELECT ${subId}, ${customerId}, ${status}, ${periodStart}, ${periodEnd}, ` +
      `${amount}, ${currency}, ${interval} ` +
      `FROM ${sub} ` +
      `WHERE ${status} = ? ` +
      `ORDER BY ${periodEnd}, ${subId}`;
    return { sql, params: [params.status] };
  },
};

const findContact: ReadQuery = {
  name: "find_contact",
  description: "Search CRM contacts by last-name prefix (keyset-friendly).",
  dependsOnTables: ["contact"],
  exampleParams: { query: "smith" },
  build(map, params) {
    const contact = resolveTable(map, "contact");
    const contactId = resolveColumn(map, "contact", "contact_id");
    const firstName = resolveColumn(map, "contact", "first_name");
    const lastName = resolveColumn(map, "contact", "last_name");
    const email = resolveColumn(map, "contact", "email");
    const companyId = resolveColumn(map, "contact", "company_id");
    const stage = resolveColumn(map, "contact", "lifecycle_stage");
    const sql =
      `SELECT ${contactId}, ${firstName}, ${lastName}, ${email}, ${companyId}, ${stage} ` +
      `FROM ${contact} ` +
      `WHERE ${lastName} LIKE ? ESCAPE '\\' ` +
      `ORDER BY ${lastName}, ${firstName}`;
    // Same escaping as `find_patient`: a bare "%" would turn a name search
    // into a full-table scan of everyone the business knows.
    return { sql, params: [`${escapeLike(String(params.query))}%`] };
  },
};

const getCompany: ReadQuery = {
  name: "get_company",
  description: "One CRM company by id.",
  dependsOnTables: ["company"],
  exampleParams: { companyId: "c-123" },
  build(map, params) {
    const company = resolveTable(map, "company");
    const companyId = resolveColumn(map, "company", "company_id");
    const createdAt = resolveColumn(map, "company", "created_at");
    const name = resolveColumn(map, "company", "name");
    const domain = resolveColumn(map, "company", "domain");
    const sql =
      `SELECT ${companyId}, ${createdAt}, ${name}, ${domain} ` +
      `FROM ${company} ` +
      `WHERE ${companyId} = ?`;
    return { sql, params: [params.companyId] };
  },
};

const getDealsByStage: ReadQuery = {
  name: "get_deals_by_stage",
  description: "Pipeline deals in one vendor-supplied stage, largest expected value first.",
  dependsOnTables: ["deal"],
  exampleParams: { stage: "presentationscheduled" },
  build(map, params) {
    const deal = resolveTable(map, "deal");
    const dealId = resolveColumn(map, "deal", "deal_id");
    const createdAt = resolveColumn(map, "deal", "created_at");
    const closedAt = resolveColumn(map, "deal", "closed_at");
    const companyId = resolveColumn(map, "deal", "company_id");
    const name = resolveColumn(map, "deal", "name");
    const stage = resolveColumn(map, "deal", "stage");
    const amount = resolveColumn(map, "deal", "amount");
    const currency = resolveColumn(map, "deal", "currency");
    // Filtered on the stage the caller named, never on `closed_at IS NULL`:
    // deriving "open" from an absent timestamp is the guessed-state pattern
    // the house rules forbid, and it would call a deal open that was closed by
    // a workflow that never stamped the date.
    const sql =
      `SELECT ${dealId}, ${createdAt}, ${closedAt}, ${companyId}, ${name}, ${stage}, ` +
      `${amount}, ${currency} ` +
      `FROM ${deal} ` +
      `WHERE ${stage} = ? ` +
      `ORDER BY ${amount} DESC, ${dealId}`;
    return { sql, params: [params.stage] };
  },
};

const getTicketsByStatus: ReadQuery = {
  name: "get_tickets_by_status",
  description: "Support tickets in one vendor-supplied status, oldest first.",
  dependsOnTables: ["ticket"],
  exampleParams: { status: "open" },
  build(map, params) {
    const ticket = resolveTable(map, "ticket");
    const ticketId = resolveColumn(map, "ticket", "ticket_id");
    const createdAt = resolveColumn(map, "ticket", "created_at");
    const closedAt = resolveColumn(map, "ticket", "closed_at");
    const contactId = resolveColumn(map, "ticket", "contact_id");
    const subject = resolveColumn(map, "ticket", "subject");
    const status = resolveColumn(map, "ticket", "status");
    const priority = resolveColumn(map, "ticket", "priority");
    // Oldest first: the ticket that has been waiting longest is the one an
    // owner needs to see, which is the opposite of every other list here.
    const sql =
      `SELECT ${ticketId}, ${createdAt}, ${closedAt}, ${contactId}, ${subject}, ` +
      `${status}, ${priority} ` +
      `FROM ${ticket} ` +
      `WHERE ${status} = ? ` +
      `ORDER BY ${createdAt}, ${ticketId}`;
    return { sql, params: [params.status] };
  },
};

const getRecentOrders: ReadQuery = {
  name: "get_recent_orders",
  description: "Storefront orders placed in a [from, to) window, newest first.",
  dependsOnTables: ["order"],
  exampleParams: { from: "2026-08-01T00:00:00Z", to: "2026-09-01T00:00:00Z" },
  build(map, params) {
    const order = resolveTable(map, "order");
    const orderId = resolveColumn(map, "order", "order_id");
    const createdAt = resolveColumn(map, "order", "created_at");
    const customerId = resolveColumn(map, "order", "customer_id");
    const total = resolveColumn(map, "order", "total_amount");
    const subtotal = resolveColumn(map, "order", "subtotal_amount");
    const tax = resolveColumn(map, "order", "tax_amount");
    const refunded = resolveColumn(map, "order", "refunded_amount");
    const currency = resolveColumn(map, "order", "currency");
    const financialStatus = resolveColumn(map, "order", "financial_status");
    const fulfillmentStatus = resolveColumn(map, "order", "fulfillment_status");
    // All four money columns are returned rather than a single "revenue":
    // revenue is `total - tax - refunded`, and computing it here would hide
    // the tax that was never the business's money behind one number.
    const sql =
      `SELECT ${orderId}, ${createdAt}, ${customerId}, ${total}, ${subtotal}, ${tax}, ` +
      `${refunded}, ${currency}, ${financialStatus}, ${fulfillmentStatus} ` +
      `FROM ${order} ` +
      `WHERE ${createdAt} >= ? AND ${createdAt} < ? ` +
      `ORDER BY ${createdAt} DESC, ${orderId}`;
    return { sql, params: [params.from, params.to] };
  },
};

const getLowStockProducts: ReadQuery = {
  name: "get_low_stock_products",
  description: "Catalog items at or below a caller-supplied inventory threshold, lowest first.",
  dependsOnTables: ["product"],
  exampleParams: { threshold: 5 },
  build(map, params) {
    const product = resolveTable(map, "product");
    const productId = resolveColumn(map, "product", "product_id");
    const title = resolveColumn(map, "product", "title");
    const sku = resolveColumn(map, "product", "sku");
    const price = resolveColumn(map, "product", "price_amount");
    const currency = resolveColumn(map, "product", "currency");
    const inventory = resolveColumn(map, "product", "inventory_quantity");
    const status = resolveColumn(map, "product", "status");
    // The threshold binds as a value; "low" is the caller's business decision,
    // not a number this registry is entitled to pick for every store.
    const sql =
      `SELECT ${productId}, ${title}, ${sku}, ${price}, ${currency}, ${inventory}, ${status} ` +
      `FROM ${product} ` +
      `WHERE ${inventory} <= ? ` +
      `ORDER BY ${inventory}, ${productId}`;
    return { sql, params: [params.threshold] };
  },
};

const findCustomer: ReadQuery = {
  name: "find_customer",
  description: "Search storefront customers by last-name prefix (keyset-friendly).",
  dependsOnTables: ["customer"],
  exampleParams: { query: "smith" },
  build(map, params) {
    const customer = resolveTable(map, "customer");
    const customerId = resolveColumn(map, "customer", "customer_id");
    const firstName = resolveColumn(map, "customer", "first_name");
    const lastName = resolveColumn(map, "customer", "last_name");
    const email = resolveColumn(map, "customer", "email");
    const ordersCount = resolveColumn(map, "customer", "orders_count");
    const totalSpent = resolveColumn(map, "customer", "total_spent_amount");
    const currency = resolveColumn(map, "customer", "currency");
    const sql =
      `SELECT ${customerId}, ${firstName}, ${lastName}, ${email}, ${ordersCount}, ` +
      `${totalSpent}, ${currency} ` +
      `FROM ${customer} ` +
      `WHERE ${lastName} LIKE ? ESCAPE '\\' ` +
      `ORDER BY ${lastName}, ${firstName}`;
    return { sql, params: [`${escapeLike(String(params.query))}%`] };
  },
};

const getCampaignPerformance: ReadQuery = {
  name: "get_campaign_performance",
  description: "Campaigns sent in a [from, to) window with unique opens and clicks, newest first.",
  dependsOnTables: ["campaign"],
  exampleParams: { from: "2026-08-01T00:00:00Z", to: "2026-09-01T00:00:00Z" },
  build(map, params) {
    const campaign = resolveTable(map, "campaign");
    const campaignId = resolveColumn(map, "campaign", "campaign_id");
    const sentAt = resolveColumn(map, "campaign", "sent_at");
    const audienceId = resolveColumn(map, "campaign", "audience_id");
    const subject = resolveColumn(map, "campaign", "subject");
    const status = resolveColumn(map, "campaign", "status");
    const emailsSent = resolveColumn(map, "campaign", "emails_sent");
    const opens = resolveColumn(map, "campaign", "opens_unique");
    const clicks = resolveColumn(map, "campaign", "clicks_unique");
    // Counts, not rates. An open rate is a division whose denominator can be
    // zero for an unsent campaign, and a rate computed here would arrive as a
    // number with no way to see what it was computed from.
    const sql =
      `SELECT ${campaignId}, ${sentAt}, ${audienceId}, ${subject}, ${status}, ` +
      `${emailsSent}, ${opens}, ${clicks} ` +
      `FROM ${campaign} ` +
      `WHERE ${sentAt} >= ? AND ${sentAt} < ? ` +
      `ORDER BY ${sentAt} DESC, ${campaignId}`;
    return { sql, params: [params.from, params.to] };
  },
};

const getAudiences: ReadQuery = {
  name: "get_audiences",
  description: "Mailing lists with their current member and unsubscribe counts, largest first.",
  dependsOnTables: ["audience"],
  exampleParams: {},
  build(map) {
    const audience = resolveTable(map, "audience");
    const audienceId = resolveColumn(map, "audience", "audience_id");
    const createdAt = resolveColumn(map, "audience", "created_at");
    const name = resolveColumn(map, "audience", "name");
    const memberCount = resolveColumn(map, "audience", "member_count");
    const unsubscribeCount = resolveColumn(map, "audience", "unsubscribe_count");
    const sql =
      `SELECT ${audienceId}, ${createdAt}, ${name}, ${memberCount}, ${unsubscribeCount} ` +
      `FROM ${audience} ` +
      `ORDER BY ${memberCount} DESC, ${audienceId}`;
    return { sql, params: [] };
  },
};

// ── WARP-2466: the three shapes the connector reconciliation added ──────────

const getEngagements: ReadQuery = {
  name: "get_engagements",
  description: "CRM activities — calls, emails, meetings, notes, tasks — in a [from, to) window.",
  dependsOnTables: ["engagement"],
  exampleParams: { from: "2026-08-01T00:00:00Z", to: "2026-09-01T00:00:00Z" },
  build(map, params) {
    const engagement = resolveTable(map, "engagement");
    const engagementId = resolveColumn(map, "engagement", "engagement_id");
    const occurredAt = resolveColumn(map, "engagement", "occurred_at");
    const type = resolveColumn(map, "engagement", "type");
    const contactId = resolveColumn(map, "engagement", "contact_id");
    const dealId = resolveColumn(map, "engagement", "deal_id");
    // Ordered by when the activity HAPPENED, never by when the record was
    // written: a meeting logged the next morning still happened the day
    // before, and sorting a timeline by write time reorders history.
    const sql =
      `SELECT ${engagementId}, ${occurredAt}, ${type}, ${contactId}, ${dealId} ` +
      `FROM ${engagement} ` +
      `WHERE ${occurredAt} >= ? AND ${occurredAt} < ? ` +
      `ORDER BY ${occurredAt} DESC, ${engagementId}`;
    return { sql, params: [params.from, params.to] };
  },
};

const getAudienceMembers: ReadQuery = {
  name: "get_audience_members",
  description: "Members of one mailing list filtered by subscription status.",
  dependsOnTables: ["audience_member"],
  exampleParams: { audienceId: "a-123", status: "subscribed" },
  build(map, params) {
    const member = resolveTable(map, "audience_member");
    const memberId = resolveColumn(map, "audience_member", "audience_member_id");
    const audienceId = resolveColumn(map, "audience_member", "audience_id");
    const email = resolveColumn(map, "audience_member", "email");
    const status = resolveColumn(map, "audience_member", "subscription_status");
    const optedInAt = resolveColumn(map, "audience_member", "opted_in_at");
    const lastChanged = resolveColumn(map, "audience_member", "last_changed_at");
    // The status filter is MANDATORY rather than optional. An unfiltered
    // member list mixes people who unsubscribed in with people who did not,
    // and the caller most likely to forget the distinction is the one about to
    // send them something.
    const sql =
      `SELECT ${memberId}, ${audienceId}, ${email}, ${status}, ${optedInAt}, ${lastChanged} ` +
      `FROM ${member} ` +
      `WHERE ${audienceId} = ? AND ${status} = ? ` +
      `ORDER BY ${lastChanged} DESC, ${memberId}`;
    return { sql, params: [params.audienceId, params.status] };
  },
};

const getEcommerceOrders: ReadQuery = {
  name: "get_ecommerce_orders",
  description:
    "Purchases a marketing platform attributed to a campaign, in a [from, to) window.",
  dependsOnTables: ["ecommerce_order"],
  exampleParams: { from: "2026-08-01T00:00:00Z", to: "2026-09-01T00:00:00Z" },
  build(map, params) {
    const order = resolveTable(map, "ecommerce_order");
    const orderId = resolveColumn(map, "ecommerce_order", "ecommerce_order_id");
    const storeId = resolveColumn(map, "ecommerce_order", "store_id");
    const customerId = resolveColumn(map, "ecommerce_order", "customer_id");
    const total = resolveColumn(map, "ecommerce_order", "total_amount");
    const currency = resolveColumn(map, "ecommerce_order", "currency");
    const processedAt = resolveColumn(map, "ecommerce_order", "processed_at");
    // Deliberately NOT the `order` columns. This shape carries no tax and no
    // refund, so `list_orders`' revenue arithmetic is not available here and
    // must not be implied by selecting columns that look like it.
    const sql =
      `SELECT ${orderId}, ${storeId}, ${customerId}, ${total}, ${currency}, ${processedAt} ` +
      `FROM ${order} ` +
      `WHERE ${processedAt} >= ? AND ${processedAt} < ? ` +
      `ORDER BY ${processedAt} DESC, ${orderId}`;
    return { sql, params: [params.from, params.to] };
  },
};

export const READ_QUERIES: readonly ReadQuery[] = [
  getScheduleToday,
  findPatient,
  getArSummary,
  getPatient,
  getRecallDue,
  getOpenInvoices,
  getOpenBills,
  getApSummary,
  // WARP-2280 — SaaS
  getRecentCharges,
  getRefunds,
  getPayouts,
  getProcessingFees,
  getSubscriptionsByStatus,
  findContact,
  getCompany,
  getDealsByStage,
  getTicketsByStatus,
  getRecentOrders,
  getLowStockProducts,
  findCustomer,
  getCampaignPerformance,
  getAudiences,
  // WARP-2466 — the shapes the HubSpot/Mailchimp reconciliation added.
  getEngagements,
  getAudienceMembers,
  getEcommerceOrders,
];

const BY_NAME: ReadonlyMap<string, ReadQuery> = new Map(READ_QUERIES.map((q) => [q.name, q]));

/** Look up a registered read query by name; throws on an unknown name. */
export function getReadQuery(name: string): ReadQuery {
  const q = BY_NAME.get(name);
  if (!q) throw new UnknownReadQueryError(name);
  return q;
}

/** Build the parameterized statement for a named read query. Identifiers
 *  resolve through the schema map (throws on drift/unmapped); values bind
 *  as `?`. Never executes — that is the (stubbed) driver's job. */
export function buildReadStatement(
  map: SchemaMap,
  name: string,
  params: Record<string, unknown>,
): BuiltStatement {
  return getReadQuery(name).build(map, params);
}
