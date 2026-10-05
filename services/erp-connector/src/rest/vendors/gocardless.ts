/**
 * WARP-3697 / ADR-046 — GoCardless, as a declarative REST profile.
 *
 * ## Custody: a clean ADR-042 model 3
 *
 * The account owner mints an ACCESS TOKEN entirely inside their own GoCardless
 * dashboard — *Developers* → *API settings* → *Create* → *Access token* — names
 * it, chooses a scope and copies it ("we will not be able to show this again").
 * Only an ADMIN can create one. Warp Lab registers nothing, reviews nothing and
 * holds nothing. GoCardless's OAuth and partner-app paths exist and are NOT used
 * (model 2). [src: GoCardless support article "How to create an access token",
 * accessed 2026-10-04]
 *
 * 🔴 **A READ-ONLY scope exists, and the guide asks for it.** The scope values
 * are `read_only` and `read_write` [src: GoCardless API reference, OAuth
 * reference page, accessed 2026-10-04]. The box is read-only by construction
 * either way — `RestProfileConnector.applyWrite` always refuses — but the TOKEN
 * is only as narrow as the scope the owner picked, which is why the credential
 * help text and the guide say "read-only". The UI label of that choice is NOT
 * on an official page (UNVERIFIED), so the help says "read-only scope" and names
 * no button.
 *
 * 🔴 **Disabling the admin who made a token does NOT revoke it.** The support
 * article says so in as many words; the way to revoke is *Disable access token*
 * on the token itself. No expiry is documented. The guide says both.
 *
 * 🔴 **Do NOT validate the token's shape.** The `live_` / `sandbox_` prefixes
 * are community-reported only (UNVERIFIED) — the Brevo / Square / Cal.com
 * reasoning applies unchanged: a regex anchored on an undocumented shape is a
 * false rejection that blocks a paying merchant for zero security gain.
 * Emptiness is the only thing refused; the probe is what proves a token.
 *
 * 🔴 **Live host ONLY.** A sandbox token authenticates only against the sandbox
 * host, which this box never dials; there is one origin here and the sandbox one
 * is registered nowhere.
 *
 * ## Three datasets, all read-through
 *
 * `charge` ← `GET /payments`, `refund` ← `GET /refunds`, `payout` ← `GET
 * /payouts`. Each is a plain list under its resource name with the same
 * `created_at[gte]` filter and the same `after` cursor, so they share two
 * constants below. None is scheduled: the Stripe constraint on `charge` in
 * `erp-sync/entities.ts` applies by DATASET NAME, and all three watermarks are
 * `complete: false` (below). They are reached on demand through `runRead`, the
 * Square pattern, and `erp-provider.descriptor.test.ts` records them in its
 * `unscheduled` pin beside Square's.
 *
 * ## 🔴 Money is integer MINOR units
 *
 * `amount` and `amount_refunded` are integers "in lowest denomination", and
 * `currency` is an enum (AUD, CAD, DKK, EUR, GBP, NZD, SEK, USD — all exponent
 * 2). The `minor-units` transform reads the ROW'S currency rather than dividing
 * by a constant, so the day a currency with another exponent appears it is still
 * right. [src: GoCardless payment and payout reference pages, accessed
 * 2026-10-04] `arrival_date` is a calendar date, so it takes `date-to-instant`.
 *
 * ## Lists are NEWEST-FIRST
 *
 * "Reverse-chronological by default" [src: GoCardless data-conventions page,
 * accessed 2026-10-04], with no sort parameter in the profile, so a cursor walk
 * yields the newest rows first. Rows are re-ordered by the read semantics, never
 * trusted to the vendor's page order.
 *
 * ## 🔴 What this profile deliberately does NOT do, and why
 *
 * * **`subscription`** — `interval` is a COUNT plus an `interval_unit`, which
 *   cannot be expressed as one canonical `interval` column; mapping the unit
 *   alone would make a quarterly plan read as monthly.
 * * **`customer`** — payer PII with no join to payments, and a created-time
 *   filter that forces `watermark: null` and a full scan every tick.
 * * **`balance_transaction`** — no such list resource on the pages read.
 * * **Payers, mandates and bank accounts** — no canonical home; the catalog card
 *   says so.
 * * **`customer_id` on `charge`** — the documented payment `links` are `mandate`
 *   and `creditor`; no customer link is shown (UNVERIFIED that none ever
 *   appears). A mandate id in a customer column joins to nothing and reads as a
 *   customer, so the column is left UNDEFINED.
 * * **`updated_at`, and `reason` on `refund`** — none of the three resources
 *   carries a modification time, and a refund's reason is only free text under
 *   `metadata.reason` in the example, not a field.
 */
import type { RestVendorProfile } from "../profile.js";

export const GOCARDLESS_PROVIDER = "gocardless";

/**
 * GoCardless's LIVE API origin. ONE STATIC HOST — no region code, no account
 * subdomain, no self-hosted option — so this is a plain `kind: egress`
 * allowlist entry the static scanner reads directly from this literal. The
 * sandbox host is never dialled and never registered. [src: GoCardless API
 * reference, base hosts, accessed 2026-10-04]
 */
export const GOCARDLESS_API_ORIGIN = "https://api.gocardless.com";

/**
 * 🔴 MANDATORY. GoCardless pins behaviour to a dated API version sent as
 * `GoCardless-Version`, and its making-requests page lists the header as
 * required, "Current version" `2015-07-06`. It is a constant header, so it rides
 * on every request including the probe. [src: GoCardless making-requests page,
 * accessed 2026-10-04]
 */
export const GOCARDLESS_API_VERSION = "2015-07-06";

/**
 * "Default 50, max 500, min 1" [src: GoCardless data-conventions page, accessed
 * 2026-10-04]. The maximum, because an on-demand read carries no watermark and
 * is paid in pages. Sent as a CONSTANT QUERY PARAMETER on every dataset — the
 * `cursor` pagination arm carries no page size — and, because that arm echoes
 * every other parameter onto the follow-up, it rides on every page of a walk. A
 * string, because `RestDatasetSpec.query` is `Record<string, string>`.
 */
export const GOCARDLESS_PAGE_LIMIT = "500";

/**
 * 🔴 The LOWER of GoCardless's two published ceilings. The limits page's table
 * says 1,600 requests a minute; its own header example says `ratelimit-limit:
 * 1000` and a note says to "think of 1,000 requests/minute as a performance
 * target". The docs disagree with themselves, so the profile paces at the lower
 * figure — ceil(60,000 / 1,000) = 60 ms — and the descriptor's `rateLimit`
 * states the same 1,000 a minute. [src: GoCardless limits page, accessed
 * 2026-10-04]
 *
 * A 429 is `rate_limit_exceeded` and carries `ratelimit-limit`, `-remaining` and
 * `-reset` (an HTTP-date) and NO `Retry-After`, so the connector's
 * `RestRateLimitedError.retryAfter` is undefined on one and the sync's generic
 * backoff applies; this pacing is what prevents the 429.
 */
export const GOCARDLESS_MIN_REQUEST_INTERVAL_MS = 60;

/**
 * GoCardless's cursor contract, one object reused per dataset because it is one
 * fact: every list carries `meta.cursors` with `before` and `after`, `after` is
 * passed back on the `after` parameter, and the walk ends when the array is
 * empty or shorter than the limit. A `null` `after` is the terminator (the
 * cursor arm stops on anything that is not a non-empty string). [src: GoCardless
 * data-conventions page, accessed 2026-10-04]
 *
 * ⚠ UNVERIFIED whether the last NON-EMPTY page already returns `after: null`.
 * If it does not, the walk costs exactly one extra request returning an empty
 * array with `after: null` — correct either way, never silent.
 */
const AFTER_CURSOR = { kind: "cursor", nextCursorPath: "meta.cursors.after", cursorParam: "after" } as const;

/**
 * The shared `created_at[gte]` watermark, declared per dataset as the profile
 * type requires but the same fact each time: payments, refunds and payouts all
 * carry a `created_at` filter object with `gt`, `gte` ("created on or after"),
 * `lt` and `lte`. [src: GoCardless payment, refund and payout reference pages,
 * rendered, accessed 2026-10-04]
 *
 * 🔴 The WIRE FORM is the bracketed key `created_at[gte]`: the official Node SDK
 * serialises nested filter objects with `qs.stringify`, and its README lists
 * `created_at: { gt: ... }`. [src: GoCardless Node SDK source and README,
 * accessed 2026-10-04] The connector builds the query through `URLSearchParams`,
 * so the key leaves percent-encoded (`created_at%5Bgte%5D=`) where the SDK sends
 * the brackets raw — whether GoCardless accepts the encoded form is UNVERIFIED
 * (standard servers do; one live call settles it). A misspelling here does not
 * 4xx: it reads the whole history and reports an incremental read.
 *
 * 🔴 `complete: false`, and honestly so. The filter is on CREATION, and a payment
 * moves pending → confirmed → paid_out after it is created, so an incremental
 * pass keyed on it never sees the move. That is the Square `payout` case
 * (`begin_time`) — and it is permitted here only because none of the three
 * datasets has an `ERP_SYNC_ENTITIES` row. `erp-provider.descriptor.test.ts`
 * turns scheduling one of them into a build failure until
 * `RestWatermark.complete` has a reader.
 */
const CREATED_AT_GTE = { name: "created_at[gte]", location: "query", format: "iso", complete: false } as const;

export const GOCARDLESS_PROFILE: RestVendorProfile = {
  provider: GOCARDLESS_PROVIDER,
  baseUrl: { kind: "static", origin: GOCARDLESS_API_ORIGIN },
  // A genuine RFC-6750 Bearer scheme: `Authorization: Bearer ...`. [src:
  // GoCardless making-requests page, accessed 2026-10-04]
  auth: { headerName: "Authorization", valueTemplate: "Bearer {{accessToken}}" },
  // The version pin above, and nothing else: `Accept: application/json` is also
  // documented, and the shared connector sets `accept: application/json` itself,
  // so declaring it here could only claim to pin it.
  constantHeaders: { "GoCardless-Version": GOCARDLESS_API_VERSION },
  // `GET /creditors?limit=1` — "your organisation will have a single creditor",
  // so this is one object's worth of read, and a 401 on it is unambiguous
  // evidence about the TOKEN. `probePath` may carry a query string.
  //
  // ⚠ UNVERIFIED that a READ-ONLY token may call it. If a live read-only token
  // is refused here, the fallback is `/payments?limit=1` — at the cost of a
  // payments page as the health check.
  probePath: "/creditors?limit=1",
  minRequestIntervalMs: GOCARDLESS_MIN_REQUEST_INTERVAL_MS,
  datasets: [
    {
      dataset: "charge",
      path: "/payments",
      query: { limit: GOCARDLESS_PAGE_LIMIT },
      watermark: CREATED_AT_GTE,
      pagination: AFTER_CURSOR,
      rowsPath: "payments",
      fieldMap: {
        charge_id: "id",
        created_at: "created_at",
        // `customer_id`: ABSENT. The documented payment `links` are `mandate` and
        // `creditor`; no customer link is shown (UNVERIFIED that none ever
        // appears), and a mandate id is not a customer id.
        amount: { path: "amount", transform: "minor-units", currencyFrom: "currency" },
        amount_refunded: { path: "amount_refunded", transform: "minor-units", currencyFrom: "currency" },
        currency: "currency",
        status: "status",
        // `updated_at`: ABSENT — no modification time on the payment resource.
      },
    },
    {
      dataset: "refund",
      path: "/refunds",
      query: { limit: GOCARDLESS_PAGE_LIMIT },
      watermark: CREATED_AT_GTE,
      pagination: AFTER_CURSOR,
      rowsPath: "refunds",
      fieldMap: {
        refund_id: "id",
        created_at: "created_at",
        // The payment this refund returns money from, which is what `charge_id`
        // means.
        charge_id: "links.payment",
        amount: { path: "amount", transform: "minor-units", currencyFrom: "currency" },
        currency: "currency",
        status: "status",
        // `reason`: ABSENT — only free text under `metadata.reason` in the
        // example, not a field. `updated_at`: ABSENT.
      },
    },
    {
      dataset: "payout",
      path: "/payouts",
      query: { limit: GOCARDLESS_PAGE_LIMIT },
      watermark: CREATED_AT_GTE,
      pagination: AFTER_CURSOR,
      rowsPath: "payouts",
      fieldMap: {
        payout_id: "id",
        created_at: "created_at",
        // A calendar DATE (`YYYY-MM-DD`) in a column `COLUMN_KIND` calls a
        // timestamp. Widened to UTC midnight explicitly rather than passed
        // through for every downstream `Date.parse` to guess at.
        arrival_at: { path: "arrival_date", transform: "date-to-instant" },
        amount: { path: "amount", transform: "minor-units", currencyFrom: "currency" },
        currency: "currency",
        status: "status",
        // `updated_at`: ABSENT.
      },
    },
  ],
};
