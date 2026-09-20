/**
 * WARP-2676 / ADR-046 — Square, as a declarative REST profile.
 *
 * ## Custody: a clean ADR-042 model 3
 *
 * The seller signs in at `developer.squareup.com` with the SAME Square account
 * they already use, creates an application in THEIR console, and copies the
 * production access token from its Credentials page. Warp Lab registers nothing,
 * reviews nothing and holds nothing. No plan tier gates it and no vendor review
 * stands between the owner and the key.
 *
 * The official Node SDK is MIT, so it clears `permissive-licences-only` — but
 * the declarative track needs no SDK and does not take the dependency.
 *
 * ## 🔴 What this profile deliberately does NOT serve, and why
 *
 * Square's catalog reaches eight of the twenty-three canonical datasets. Five of
 * them are NOT here, and each omission is a decision with a reason. Listing them
 * is the point — ADR-046's "no silent caps" rule applies to coverage as much as
 * to pagination, and a reader who finds only three datasets deserves to know the
 * other five were considered rather than missed.
 *
 * * **`order`** — the only way to list orders is `POST /v2/orders/search`, with
 *   the watermark at `query.filter.date_time_filter.updated_at.start_at` INSIDE
 *   a JSON request body, and the cursor and limit in the body too. This track
 *   issues GETs. A POST-with-body arm is a real and justified extension (Square
 *   is not the only vendor shaped this way), but it is a change to the shared
 *   connector's control flow and belongs on WARP-2707, not smuggled in behind
 *   one vendor. Three of `order`'s eleven canonical columns are also unreachable
 *   by any path: `subtotal_amount` and `refunded_amount` are computed, and
 *   `fulfillment_status` needs an array index.
 * * **`invoice`** — `GET /v2/invoices` REQUIRES a `location_id`, so the dataset
 *   is a fan-out over `GET /v2/locations` first. A profile describes one
 *   endpoint per dataset and cannot express a join. Worse, the Invoice object
 *   has NO total money field at all, so the canonical `amount` is not reachable
 *   even in principle — it must be summed over `payment_requests[]` or fetched
 *   from the linked order. A money dataset missing its total is not a partial
 *   win; it is a wrong answer.
 * * **`product`** — `inventory_quantity` lives behind
 *   `POST /v2/inventory/counts/batch-retrieve`, `status` has to be derived from
 *   `is_deleted`/`present_at_all_locations`, `created_at` does not exist on a
 *   `CatalogObject` at all, and `title` needs a client-side join from
 *   ITEM_VARIATION to its parent ITEM. Four of nine columns, three mechanisms.
 * * **`customer`** — `GET /v2/customers` has NO time filter of any kind, and
 *   `sort_field` offers only DEFAULT and CREATED_AT, so it cannot even be
 *   ORDERED by modification. Every sync would be a full scan of the seller's
 *   whole customer book. Shippable, but it should be a deliberate decision
 *   about polling cost rather than a side effect of this file.
 * * **`appointment`** — Square Appointments fits the shape, but the canonical
 *   `appointment` vocabulary is the PRACTICE-MANAGEMENT one (WARP-1964,
 *   dental): its columns are `patient_id` and `operatory_id`. A Square customer
 *   is not a patient and a Square location is not an operatory. Mapping them
 *   would put non-clinical rows into a PHI-shaped vocabulary, which is a
 *   vocabulary decision for Romain, not a mapping detail for this file.
 *
 * What remains — `charge`, `refund`, `payout` — is the money story, and it is
 * the part Square answers cleanly: a real `updated_at` filter on two of three,
 * reachable paths for every column, and one endpoint each.
 */
import type { RestVendorProfile } from "../profile.js";

export const SQUARE_PROVIDER = "square";

/**
 * Square's production API host. ONE STATIC HOST — no region code, no seller
 * subdomain, no self-hosted option, and no host handed back in a token
 * response. So this is a plain `kind: egress` allowlist entry that the static
 * scanner can actually read, and the whole-string literal below is what it
 * reads.
 */
export const SQUARE_API_ORIGIN = "https://connect.squareup.com";

/**
 * 🔴 MANDATORY. Square pins behaviour to a dated API version, and omitting the
 * header does not 400 — it serves the seller's application's DEFAULT version,
 * which is whatever was current when they created the application. That means
 * an unversioned request returns a shape this profile was not written against,
 * silently, and differently per seller.
 *
 * Pinned by a test that cites Square's version page, exactly as
 * `graph-resources.test.ts` pins Microsoft Graph's.
 */
export const SQUARE_API_VERSION = "2026-08-19";

/**
 * Square's own cursor rules, recorded because they decide the paging loop:
 * `limit` default and max are both 100 on these endpoints, values above 100 are
 * IGNORED rather than rejected, and a cursor lives 5 minutes.
 *
 * 🔴 Deliberately NOT a constant. It was `export const SQUARE_PAGE_SIZE = 100`,
 * referenced by nothing but its own test (`expect(SQUARE_PAGE_SIZE).toBe(100)`)
 * — a constant compared to its own definition, which cannot fail for any reason
 * a reader would care about and made the profile look as though it configured a
 * page size it does not send.
 *
 * Nothing sends `limit`: these endpoints default to 100 anyway, and
 * `GET /v2/catalog/list` — which a future dataset here would use — accepts no
 * `limit` at all, so making it a habit would send a parameter that endpoint does
 * not document. That absence is what the test asserts now.
 */

export const SQUARE_PROFILE: RestVendorProfile = {
  provider: SQUARE_PROVIDER,
  baseUrl: { kind: "static", origin: SQUARE_API_ORIGIN },
  // A genuine RFC-6750 Bearer scheme — one of the few vendors on ADR-046 §2's
  // six-shape table where the naive guess would have been right.
  auth: { headerName: "Authorization", valueTemplate: "Bearer {{accessToken}}" },
  constantHeaders: { "Square-Version": SQUARE_API_VERSION },
  // `GET /v2/locations` is Square's cheapest authenticated read: it takes no
  // parameters, is NOT paginated, and a seller has a handful of locations at
  // most. It is also the endpoint every other Square integration probes with,
  // so a 401 here is unambiguous evidence about the token rather than about
  // one product's permissions.
  probePath: "/v2/locations",
  // 🔴 NO `minRequestIntervalMs`, and this is a decision rather than an
  // omission. Square publishes no rate ceiling AND no rate-limit response
  // headers — its documented behaviour is to answer `RATE_LIMITED` when it
  // decides to. Inventing a number here would be a policy wearing a fact's
  // clothes, which is the same reasoning that leaves Dentrix Ascend with no
  // `ProviderRateLimit`. The connector reacts to the 429 it is given.
  datasets: [
    {
      dataset: "charge",
      path: "/v2/payments",
      // `sort_field=UPDATED_AT` is REQUIRED alongside the filter, not a nicety:
      // paging must advance monotonically on the SAME field the watermark
      // narrows, or a row updated mid-walk can be skipped or repeated.
      query: { sort_field: "UPDATED_AT", sort_order: "ASC" },
      watermark: {
        name: "updated_at_begin_time",
        location: "query",
        format: "iso",
        // A genuine last-modified filter, added for ListPayments in the
        // 2024-12-18 API version.
        complete: true,
      },
      pagination: { kind: "cursor", nextCursorPath: "cursor", cursorParam: "cursor" },
      rowsPath: "payments",
      // Square omits the array entirely on an empty result.
      absentRowsMeansEmpty: true,
      fieldMap: {
        charge_id: "id",
        created_at: "created_at",
        customer_id: "customer_id",
        // 🔴 MINOR UNITS. `amount_money.amount` is in cents for USD — and is
        // NOT cents for JPY. Converted against the row's own currency.
        amount: { path: "amount_money.amount", transform: "minor-units", currencyFrom: "amount_money.currency" },
        amount_refunded: {
          path: "refunded_money.amount",
          transform: "minor-units",
          currencyFrom: "amount_money.currency",
        },
        currency: "amount_money.currency",
        status: "status",
        updated_at: "updated_at",
      },
    },
    {
      dataset: "refund",
      path: "/v2/refunds",
      query: { sort_field: "UPDATED_AT", sort_order: "ASC" },
      watermark: {
        name: "updated_at_begin_time",
        location: "query",
        format: "iso",
        // Complete, and it is the one that matters most on this dataset: a
        // refund's status moves PENDING → COMPLETED after creation, so a
        // creation-time filter would freeze every refund at PENDING forever.
        complete: true,
      },
      pagination: { kind: "cursor", nextCursorPath: "cursor", cursorParam: "cursor" },
      rowsPath: "refunds",
      absentRowsMeansEmpty: true,
      fieldMap: {
        refund_id: "id",
        created_at: "created_at",
        charge_id: "payment_id",
        amount: { path: "amount_money.amount", transform: "minor-units", currencyFrom: "amount_money.currency" },
        currency: "amount_money.currency",
        status: "status",
        reason: "reason",
        updated_at: "updated_at",
      },
    },
    {
      dataset: "payout",
      path: "/v2/payouts",
      watermark: {
        name: "begin_time",
        location: "query",
        format: "iso",
        // 🔴 INCOMPLETE — the ADR-046 §2 Postmark case, verbatim. Square
        // defines `begin_time` as the beginning of the payout CREATION time,
        // not its modification time, so a payout that moves SENT → PAID after
        // the window closes is never re-read. `updated_at` IS on the object,
        // just not filterable. Declaring this false is what keeps the periodic
        // full sweep MANDATORY on this dataset rather than a safety net.
        complete: false,
      },
      pagination: { kind: "cursor", nextCursorPath: "cursor", cursorParam: "cursor" },
      rowsPath: "payouts",
      absentRowsMeansEmpty: true,
      fieldMap: {
        payout_id: "id",
        created_at: "created_at",
        // A calendar DATE (`YYYY-MM-DD`) in a column `COLUMN_KIND` calls a
        // timestamp. Widened to UTC midnight explicitly rather than passed
        // through for every downstream `Date.parse` to guess at.
        arrival_at: { path: "arrival_date", transform: "date-to-instant" },
        // 🔴 MAY BE NEGATIVE. Square: "a positive amount indicates a deposit,
        // and a negative amount indicates a withdrawal". The canonical
        // `payout` comment describes a positive magnitude, so a withdrawal
        // lands here as a negative number. That is the honest projection —
        // taking an absolute value would report money leaving the account as
        // money arriving in it.
        amount: { path: "amount_money.amount", transform: "minor-units", currencyFrom: "amount_money.currency" },
        currency: "amount_money.currency",
        status: "status",
        updated_at: "updated_at",
      },
    },
  ],
};
