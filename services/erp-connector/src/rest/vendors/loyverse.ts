/**
 * WARP-2919 / ADR-046 — Loyverse POS, as a declarative REST profile.
 *
 * ## Custody: a clean ADR-042 model 3
 *
 * The account owner mints a Personal Access Token entirely inside their own
 * Loyverse Back Office — *Integrations → Access tokens → + Add access token*,
 * naming the token and optionally giving it an expiry. Warp Lab registers
 * nothing, reviews nothing and holds nothing. "Integrations" is a FREE feature
 * on Loyverse's pricing page, so no plan tier gates the token itself.
 *
 * Loyverse also has an OAuth 2.0 path (a developer-dashboard app with a
 * `client_secret` and a 43 200 s access-token refresh). It is NOT used: it is
 * ADR-042 model 2 — a Warp-Lab-registered app — and it needs a token exchange
 * the declarative track deliberately lacks.
 *
 * 🔴 **The PAT is unlimited, read AND write.** Loyverse's own words: "personal
 * access token gives unlimited access to the targeted account". There is no
 * read-only scope on the PAT path (scopes exist only on OAuth), so the token
 * in the box could create receipts, edit items and delete customers. The box
 * is read-only by construction — `RestProfileConnector.applyWrite` always
 * refuses, and there is no profile field that could change that — but the
 * TOKEN is not, which is why the credential help text tells the owner to set
 * an expiration date and why a 302 is refused rather than followed.
 *
 * 🔴 **Do NOT validate the token's shape.** Loyverse documents no prefix and
 * no length for a PAT. A regex anchored on an undocumented shape is the
 * Brevo/Square/Cal.com false rejection. Emptiness is the only thing refused.
 *
 * No official SDK exists (the surface is the REST API, a Postman collection
 * and an OpenAPI 3.0 YAML), so `permissive-licences-only` has nothing to
 * clear and the track takes no dependency.
 *
 * ## The version lives in the PATH, not on the origin
 *
 * The OpenAPI `servers` entry is `https://api.loyverse.com/v1.0`.
 * `assertValidRestProfile` refuses a path on a static origin (it would
 * silently prefix every dataset path), so `/v1.0` is repeated on `probePath`
 * and on every dataset `path` below, and NOT on {@link LOYVERSE_API_ORIGIN}.
 * A build copying Square's `/v2/...` shape must do the same. There is no
 * version header of any kind — `constantHeaders` is empty on purpose.
 *
 * ## Money is ALREADY in major units
 *
 * `total_money: 17.52`, `total_spent: 120.55`, `default_price: 10.00` — every
 * amount is a decimal in the merchant's currency, and the schema's own note
 * ("for Japan there is no decimals in money amounts") is the tell that the
 * vendor has applied the exponent. No `minor-units` transform anywhere here;
 * adding one "for symmetry with Square" divides every amount by 100.
 *
 * ## 🔴 Receipts are NOT served — currency is per MERCHANT, and `order` requires it
 *
 * No receipt, customer or item row carries a currency. It is account-wide, on
 * `GET /v1.0/merchant/` as `currency.code` (with `decimal_places`), and this
 * track has no way to inject a per-account constant into every row.
 *
 * On `customer` and `product` that is a blank column and nothing more: their
 * `currency` is optional in the vocabulary (`REQUIRED_CANONICAL` asks only for
 * the identity), so `total_spent_amount` / `price_amount` beside an empty
 * currency is an honest, declared gap. On `order` it is disqualifying: `REQUIRED_CANONICAL.order`
 * names `currency`, on the vocabulary's own rule that "an amount without its
 * currency is not a number, it is a rumour", and `assertValidRestProfile`
 * refuses a dataset that leaves a required column unmapped. An earlier cut of
 * this profile served receipts with `currency` undefined; a `cloud_query_dataset`
 * row of `total_amount: 17.52, currency: undefined` reached the model as a
 * dollar-shaped answer for a merchant in Tokyo or Lagos, and the review that
 * caught it is the reason the guard now exists. Brevo's bespoke connector meets
 * the same vendor shape and solves it with a second call to the account's
 * display currency; this track has no such call yet.
 *
 * So `order` is not in `datasets` below, and asking Loyverse for receipts is a
 * `DatasetNotServedError` costing zero fetch calls — pinned by test, beside the
 * facts the receipts endpoint was researched to, so that the day the track
 * gains a probe-derived per-account constant (ADR-046 §2's admission criterion
 * is met: this is a verified failure, not a hypothetical) the dataset returns
 * as `GET /v1.0/receipts`, `updated_at_min`, cursor-in-body, `limit=250`,
 * `receipt_number` as the id and `total_money` already in MAJOR units, with
 * `currency` read off the probe. What that future dataset must ALSO carry
 * forward, recorded here so it is not re-learned: `/receipts` returns SALE and
 * REFUND receipts in ONE list with no type filter, so a refund would land as an
 * `order` row with a POSITIVE total; and only PAID receipts are exposed.
 *
 * ## Lists are NEWEST-FIRST
 *
 * `/customers` and `/items` (and `/receipts`) are "sorted by created_at
 * property in descending order" with no sort parameter, so a cursor walk
 * yields the newest rows first. The next watermark must be the maximum
 * `updated_at` seen across ALL pages of a walk, and an interrupted walk must
 * not advance it at all — which is how the shared sync already behaves,
 * recorded here because a per-page "last row" shortcut would be wrong on this
 * vendor.
 *
 * ## 🔴 What this profile deliberately does NOT do, and why
 *
 * * **`order`** — receipts, for the currency reason in the header: a money
 *   dataset without its required `currency` column is refused at module load,
 *   and a hardcoded "USD" would be worse than the refusal.
 * * **`refund` as its own dataset** — Loyverse has no refund endpoint; a
 *   refund is a receipt with `receipt_type: REFUND` in the same list, and the
 *   track cannot route one endpoint to two datasets by row value. Not invented
 *   here, and moot while receipts themselves are not served.
 * * **`charge` / `payout`** — payments are `receipt.payments[]`, an array on
 *   the receipt, not a resource; there is no payout concept in the API.
 * * **`employee`** — `GET /v1.0/employees` exists, but the Loyverse
 *   "Employee Management" that gives it meaning is a paid add-on
 *   ($25/store/month), and the canonical `employee` vocabulary is HR-shaped.
 *   Not researched to build depth on this ticket; a decision for its own.
 * * **`inventory_quantity` on `product`** — stock is `GET /v1.0/inventory`,
 *   per variant per store: a second endpoint and a join, neither of which
 *   one dataset spec can express. Left undefined rather than fabricated, and
 *   the consequence (a low-stock question answers zero rows) is pinned.
 * * **A name split, a currency constant, a per-receipt-type filter** — each
 *   would be a transform or a control-flow branch this track does not have.
 *   Each is a widening with its own verified failure, not a hidden default;
 *   the currency constant is the one with a dataset waiting on it.
 *
 * ## The 31-day sales-history gate — a receipts fact, kept for the day they ship
 *
 * Loyverse's free tier limits sales-report access to the last 31 days
 * (pricing page: "Unlimited Sales History", $5 per store per month, to see
 * beyond it). Whether `GET /v1.0/receipts` answers an older range with
 * `402 PAYMENT_REQUIRED` (the only 402 the reference documents is "The
 * subscription of account has lapsed") or with a silently truncated list is
 * attested only by a forum post, not by Loyverse staff. Customers and items
 * are not behind it. It does not touch this profile today, because receipts
 * are not read; it is recorded so the future `order` dataset's first backfill
 * — which runs with NO watermark — is watched for it, and a 402 surfaces as a
 * plan gate, never as a broken credential.
 */
import type { RestVendorProfile } from "../profile.js";

export const LOYVERSE_PROVIDER = "loyverse";

/**
 * Loyverse's ONE static API host. No region code, no merchant subdomain, no
 * self-hosted option, no host handed back in a token response. So this is a
 * plain `kind: egress` allowlist entry the static scanner reads directly, and
 * the whole-string literal below is what it reads.
 *
 * 🔴 NO `/v1.0` here — see the header. The version rides on every path.
 */
export const LOYVERSE_API_ORIGIN = "https://api.loyverse.com";

/**
 * "The current limit is 300 requests per 300 sec per account", verbatim from
 * Loyverse's API rate limits section → one request per 1000 ms.
 *
 * A published ceiling, so this profile paces against it. ⚠ It is PER ACCOUNT:
 * every other integration the merchant runs shares it, and Loyverse mentions
 * "additional resource-based rate limits" it does not quantify. 1 s is the
 * floor the box assumes; the connector still backs off on the 429.
 */
export const LOYVERSE_MIN_REQUEST_INTERVAL_MS = 1000;

/**
 * The documented maximum page: `components.parameters.limit` is default 50,
 * maximum 250. Sent as a CONSTANT QUERY PARAMETER on every dataset — the
 * `cursor` pagination arm carries no page size (only `limit-offset` and
 * `page-number` do), which is the same shape Square uses. A string, because
 * `RestDatasetSpec.query` is `Record<string, string>`.
 */
export const LOYVERSE_PAGE_LIMIT = "250";

/**
 * Loyverse's cursor contract, one object reused per dataset because it is one
 * fact: "Paginated results include a cursor field as part of the response
 * body. To fetch the next set of results, send a followup request to the same
 * endpoint and provide the cursor value returned in the previous response as
 * a query parameter. When the endpoint sends the final set of results, the
 * response body will not include a cursor field." The ABSENT key on the final
 * page is what `nextPageUrl` treats as end-of-walk (non-string → stop).
 */
const CURSOR_IN_BODY = { kind: "cursor", nextCursorPath: "cursor", cursorParam: "cursor" } as const;

/**
 * The shared `updated_at_min` watermark, declared per dataset as the
 * profile type requires but the same fact each time: "Show resources
 * updated after date (ISO 8601 format, e.g: 2020-03-30T18:30:00.000Z)".
 * `formatWatermark("iso")` emits exactly that shape, millis included.
 *
 * `complete: true` on both, and each is verified on its own endpoint rather
 * than assumed from the shared parameter: Customer carries `updated_at` and
 * `customers.update` fires on create/update/delete; Item carries `updated_at`
 * and `deleted_at` and `items.update` fires "when an item is created, updated
 * or deleted". (Receipt `updated_at` moves on edit and cancellation too —
 * `receipts.update` fires "when a receipt is created or updated" — for the
 * day `order` ships.)
 */
const UPDATED_AT_MIN = { name: "updated_at_min", location: "query", format: "iso", complete: true } as const;

export const LOYVERSE_PROFILE: RestVendorProfile = {
  provider: LOYVERSE_PROVIDER,
  baseUrl: { kind: "static", origin: LOYVERSE_API_ORIGIN },
  // securitySchemes.BearerAuth: `type: http, scheme: bearer`. A genuine
  // RFC-6750 Bearer scheme.
  auth: { headerName: "Authorization", valueTemplate: "Bearer {{accessToken}}" },
  // 🔴 Empty ON PURPOSE. Loyverse versions by URL and documents no version,
  // revision or accept header. An invented header is a contract nobody
  // published. Pinned empty by test.
  constantHeaders: {},
  // `GET /merchant/` — trailing slash as documented — returns the one merchant
  // profile the token belongs to (business name, currency, decimal places):
  // no pagination, no parameters, so a 401 here is unambiguous evidence about
  // the TOKEN. Kept with the slash rather than normalised: whether Loyverse
  // redirects `/merchant` is undocumented and this connector refuses
  // redirects.
  probePath: "/v1.0/merchant/",
  minRequestIntervalMs: LOYVERSE_MIN_REQUEST_INTERVAL_MS,
  datasets: [
    // 🔴 NO `order`. See the header: receipts carry no currency, and a money
    // dataset without its required `currency` column is refused at module
    // load. The endpoint's facts are recorded there for the day the track can
    // read the merchant's currency off the probe.
    {
      dataset: "customer",
      path: "/v1.0/customers",
      // NO `show_deleted`: `GET /customers` declares no such parameter.
      // Customer deletion visibility is UNDOCUMENTED either way — the Soft
      // deletion prose says customers "don't use soft deletion due to
      // personal data restrictions", while the Customer schema carries
      // `deleted_at` and `permanent_deletion_at` ("usually 24 hours after
      // soft deletion") and the `customers.update` webhook fires on delete.
      // Whether a customer in that window is returned under `updated_at_min`
      // is not stated. The reconciliation sweep is the control that notices a
      // vanished customer; this watermark is not.
      query: { limit: LOYVERSE_PAGE_LIMIT },
      watermark: UPDATED_AT_MIN,
      // ⚠ The `/customers` 200 schema declares only `customers` and omits
      // `cursor`, while `/receipts` and `/items` declare it. The generic
      // Pagination section and the declared `cursor` REQUEST parameter say it
      // is there. Pinned by fixture; confirm on the first live read.
      pagination: CURSOR_IN_BODY,
      rowsPath: "customers",
      fieldMap: {
        customer_id: "id",
        created_at: "created_at",
        // `first_name` / `last_name`: ABSENT. Loyverse has ONE `name` field
        // ("The customer's name", max 64), the track has no split transform,
        // and splitting free text is a guess. Consequence, pinned by test: a
        // NAMED `find_customer` search (a `last_name` prefix) returns zero
        // rows from Loyverse, while an unqualified one lists everyone.
        email: "email",
        // `orders_count`: ABSENT. `total_visits` is "the total number of
        // visits", not documented as a receipt count.
        total_spent_amount: "total_spent",
        // `currency`: ABSENT — per merchant, see the header.
        updated_at: "updated_at",
      },
    },
    {
      dataset: "product",
      path: "/v1.0/items",
      // 🔴 `show_deleted=true`: deleted items "will not be returned by
      // default, but can be accessed using show_deleted = true filter and
      // have deleted_at parameter". Without it a deleted item never arrives
      // as a change — it simply stops appearing — and the box keeps selling
      // it. ⚠ The shared parameter's description is copy-pasted ("Show
      // deleted modifiers and modifier options") although `/items` references
      // it and `Item` carries `deleted_at`; pinned by fixture, not by that
      // sentence.
      query: { limit: LOYVERSE_PAGE_LIMIT, show_deleted: "true" },
      watermark: UPDATED_AT_MIN,
      pagination: CURSOR_IN_BODY,
      rowsPath: "items",
      fieldMap: {
        product_id: "id",
        created_at: "created_at",
        title: "item_name",
        // 🔴 LOSSY by construction, and knowingly so: an item with
        // size/colour options has SEVERAL variants, each with its own sku and
        // `default_price`, and a canonical row holds one of each. The first
        // variant is kept and the others are NOT representable here.
        // `default_price` is null when `default_pricing_type` is VARIABLE
        // (the price is typed at the till) and stays undefined — never 0,
        // which would read as "free".
        sku: "variants[0].sku",
        price_amount: "variants[0].default_price",
        // `currency`: per merchant, see the header. `inventory_quantity`: on
        // `GET /v1.0/inventory`, per variant per store — a second endpoint.
        // `status`: no such field; `deleted_at` is a timestamp, not a status.
        // All three ABSENT and pinned undefined.
        updated_at: "updated_at",
      },
    },
  ],
};
