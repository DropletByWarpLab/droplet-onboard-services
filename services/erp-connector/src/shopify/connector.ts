/**
 * WARP-2296 — `ShopifyConnector`: the storefront commerce track.
 *
 * Reads a small business's Shopify store — what was sold, what is in the
 * catalogue, and (plan permitting) who bought it — over the **GraphQL Admin
 * API**, on client credentials the merchant mints in their own Shopify
 * organization. Same {@link Connector} interface, same blocked-error contract,
 * same read-through posture as every other cloud track.
 *
 * ## Four facts that make this track unlike the others
 *
 * **1. The flow everybody remembers was removed on 2026-01-01.** Admin-created
 * custom apps — Settings → Apps → Develop apps, and the `shpat_…` token they
 * minted — no longer exist and cannot be re-created. Any guide, blog post or
 * remembered procedure older than that date describes a screen that is gone.
 * The replacement is a **merchant-owned Dev Dashboard app** plus the
 * **client-credentials grant**, which is a better fit for this product than
 * what it replaced: no redirect, no consent screen, and no Warp Lab app
 * identity anywhere in the trust path (ADR-042 §2, §3). A `shpat_` value is
 * therefore refused at intake — not as a preference, but because the flow that
 * minted it is gone and it cannot be re-issued if it stops working.
 *
 * **2. The host is ASSEMBLED AT RUNTIME**, exactly as on the Mailchimp track.
 * Every request — the token mint included — goes to
 * `<shop>` + {@link SHOPIFY_SHOP_DOMAIN_SUFFIX}, where `<shop>` is this
 * connection's own store handle. There is no single hostname to write down.
 * The consequences are the ones `docs/SECURITY.md:174-185` states and the
 * Mailchimp connector already learned the hard way:
 *
 *   1. The `allowed-egress.yaml` entry is `kind: dynamic` with a `config_key`.
 *      It is DOCUMENTATION AND REVIEW, not enforcement. A `kind: egress` entry
 *      with a wildcard would be worse than useless — a green `egress-gate`
 *      over a host nothing constrains.
 *   2. **Nothing in CI verifies where this connector dials.**
 *      {@link assertSafeShopifyBaseUrl} is the ENTIRE control, which is why its
 *      tests assert on the injected `fetch` having ZERO calls rather than on a
 *      returned value: a test that inspects the outcome still passes when the
 *      request already went out carrying the merchant's client secret.
 *   3. This file carries no `https://…myshopify.com` scheme-URL literal. The
 *      invariant SUFFIX is kept as a whole-string literal for the guard to
 *      anchor on, and `ref-shopify-shop-domain` registers that NAME without
 *      granting any egress.
 *
 * **3. There is no fixed Shopify OAuth host.** The client-credentials grant
 * posts to `<shop>.myshopify.com` + {@link SHOPIFY_TOKEN_PATH} — the same
 * per-store host as the API — so this track registers no second, static
 * destination. `shopify.dev` is where the MERCHANT'S BROWSER goes to create the
 * app; the box never dials it, and it is registered `kind: reference` for that
 * reason (ADR-042 §Egress).
 *
 * **4. Two vendor gates decide what this connector can see, and both are
 * silent by default.** Neither is a Droplet limitation and neither can be
 * worked around from here; what this connector owes the owner is to name them
 * instead of returning a plausible-looking short answer:
 *
 *   • **Protected customer data.** Names, emails, phones and addresses are
 *     Shopify **Level 2** data, gated on the store's **Grow** plan. An app
 *     without it does not get an error — it gets HTTP 200 with the fields
 *     blanked. See {@link ShopifyConnector.probeProtectedCustomerData} and
 *     {@link detectProtectedDataRedaction}.
 *   • **The 60-day order wall.** `read_orders` reaches only the last 60 days;
 *     everything older needs `read_all_orders`, which Shopify grants by
 *     request. A store without it returns a truncated order list with no error
 *     anywhere — "we made no sales before July" — which is the single worst
 *     answer this connector could give. See {@link SHOPIFY_ORDER_HISTORY_WALL_DAYS}.
 *
 * Both are detected from the GRANTED SCOPE LIST the token mint returns, plus a
 * probe, rather than guessed. WARP-2299's spike record — what a live store must
 * show, and what to check on day one — is in `docs/integrations/shopify.md`.
 *
 * ## The ADR-041 conditions, as they land here
 *
 *   1. **Only ever dials out.** The box accepts no inbound connections, so
 *      Shopify webhooks (and the `bulk_operations/finish` topic) are
 *      structurally unavailable; polling is the only ingestion path.
 *   2. **Ships off; owner consent is the enabling event.** With no credential
 *      resolved the connector blocks honestly rather than half-authenticating.
 *   3. **Every destination registered.** See above.
 *   4. **Persistence: none.** ADR-041 §4 / WARP-2028 — this track is
 *      read-through and writes nothing: not `ErpEntityCache`, not
 *      `ErpSyncCursor`, not `secretRef`. Even the MINTED access token lives on
 *      an instance field for the life of one connector and is never persisted.
 *   5. **The credential is the merchant's app identity.** Never logged, never
 *      in a tracked file, never echoed back in an error, never in `status()`.
 *
 * ## Read-only is a property of the DOCUMENT, not of the path
 *
 * Every Shopify Admin GraphQL call — read and write — is a POST to ONE path.
 * A path allowlist (the Mailchimp pattern) therefore buys nothing at all here.
 * The equivalent control is {@link assertReadOnlyShopifyDocument}, which
 * refuses any document carrying a `mutation` whose root field is not in
 * {@link SHOPIFY_ALLOWED_MUTATIONS} — and that set holds only the two bulk
 * operations, which create no store data. Order cancellation, refunds,
 * fulfilment and product edits are absent by shape, not by intention.
 */
import {
  ConnectorBlockedError,
  assertDatasetsServed,
  type Connector,
  type IntrospectionResult,
} from "../connector.js";
import { getReadQuery } from "../read-queries.js";
import { assertTargetAllowed, getWriteCommand } from "../write-commands.js";
import { computeSchemaFingerprint, type IntrospectedTable } from "../schema-map.js";
import { CANONICAL_COLUMNS, type DatasetName } from "../export-drop/profiles.js";
import {
  canonicalInstant,
  projectCanonicalRow,
  type CanonicalRow,
  type VendorLookup,
} from "../canonical-row.js";
import { sortByKey } from "../api-dto.js";
// IMPORTED, not re-typed. A second regex-metacharacter escaper is a second
// thing to get subtly wrong, and this one already carries the CodeQL
// "incomplete string escaping" fix from the WARP-2379 review. The dependency
// direction is deliberate and one-way: a pure string helper, no vendor state.
import { escapeRegExpLiteral } from "../mailchimp/connector.js";

/** Provider key for this track. */
export const SHOPIFY_PROVIDER = "shopify";

/**
 * The invariant tail of every Shopify store host.
 *
 * A WHOLE-STRING LITERAL on purpose, and deliberately NOT a scheme URL. The
 * store handle in front of it is per-connection and unknowable at build time,
 * so this is the most the static egress scanner can ever be given for this
 * vendor (`docs/SECURITY.md:183-185`). Do not "clean this up" into a template,
 * a join, or a config read — and do not add a scheme-URL literal naming a
 * sampled store anywhere in this directory: the `kind: dynamic` allowlist
 * entry registers no hosts, so the scanner would read one as an unregistered
 * destination and fail `egress-gate`. Examples belong in the tests, which the
 * scanner excludes by construction.
 */
export const SHOPIFY_SHOP_DOMAIN_SUFFIX = ".myshopify.com";

/**
 * A Shopify store handle, on its own.
 *
 * The handle is the leftmost DNS label of the store domain, so it is pinned to
 * exactly what a label may hold: lowercase alphanumerics and internal hyphens,
 * no leading or trailing hyphen, 1–63 characters. Keeping this identical to the
 * label {@link SHOPIFY_ALLOWED_HOST_PATTERN} accepts is load-bearing for the
 * same reason Mailchimp's datacentre token is: the value validated at intake
 * BECOMES the leftmost label of a host. A looser intake than the host guard
 * lets a crafted value smuggle a hostname; a stricter one stores a domain the
 * connector then refuses on every read.
 */
export const SHOPIFY_SHOP_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The ONLY host shape this connector will ever send a credential to.
 *
 * ANCHORED AT BOTH ENDS. The anchoring is the whole point: an unanchored check
 * or an `endsWith` accepts `acme.myshopify.com.evil.test`, which is the attack
 * this guard exists to stop. Built from {@link SHOPIFY_SHOP_DOMAIN_SUFFIX}
 * through {@link escapeRegExpLiteral} rather than re-typed, so the literal and
 * the guard cannot drift apart and the suffix is matched as TEXT.
 */
export const SHOPIFY_ALLOWED_HOST_PATTERN = new RegExp(
  `^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?${escapeRegExpLiteral(SHOPIFY_SHOP_DOMAIN_SUFFIX)}$`,
);

/**
 * The pinned, date-based API version — the ONLY place this string is written.
 *
 * Every request path is built from it, so upgrading the pin is one deliberate
 * edit with its own test run. `shopify.test.ts` asserts no second version
 * literal exists anywhere in this directory, because a second one is a version
 * that can drift out of the pin silently. Shopify retires a version roughly a
 * year after release; ADR-041's "pin API versions in config and review them
 * annually" is the standing instruction.
 */
export const SHOPIFY_API_VERSION = "2026-07";

/** The one Admin GraphQL endpoint. Reads and writes share it, which is why the
 *  read-only control is {@link assertReadOnlyShopifyDocument} and not a path
 *  allowlist. */
export const SHOPIFY_GRAPHQL_PATH = `/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

/**
 * The client-credentials token endpoint.
 *
 * On the STORE's own host, not on a central Shopify OAuth host — which is why
 * this track registers no fixed egress destination. Un-versioned by Shopify's
 * own design, so it deliberately does not interpolate
 * {@link SHOPIFY_API_VERSION}.
 */
export const SHOPIFY_TOKEN_PATH = "/admin/oauth/access_token";

/** Shopify's bearer header. Not `Authorization` — a reader who assumes the
 *  usual scheme gets a 401 with nothing to explain it. */
export const SHOPIFY_ACCESS_TOKEN_HEADER = "X-Shopify-Access-Token";

/**
 * The credential shapes removed on 2026-01-01, refused at intake.
 *
 * `shpat_` is the admin-created custom app token ADR-042 §4 names; the
 * remaining prefixes are the older private-app and custom-app families from the
 * same retired flow. Matched as a FAMILY rather than only the one prefix the
 * ADR spells, because they all fail for the same reason — the console that
 * issued them is gone — and a merchant who finds any of them in a password
 * manager deserves the same explanation.
 */
export const SHOPIFY_LEGACY_ADMIN_TOKEN_PATTERN = /^shp(at|ca|pa|ss)_/;

/**
 * The pasted credential's accepted shape: any non-blank, whitespace-free value
 * that is not one of the retired token families.
 *
 * DELIBERATELY LOOSE on the positive side, and this is the same call the
 * Mailchimp track made about its secret half. Shopify publishes no format
 * guarantee for a Dev Dashboard client id or secret, and a false rejection here
 * blocks a paying customer's onboarding for no security gain — the value is
 * presented as a form field to the vendor and never becomes part of a hostname,
 * so its character budget is not a security property. What IS pinned is the
 * negative: the retired prefixes, which are a real, checkable mistake.
 *
 * The same source string is the descriptor's `pattern` for both credential
 * fields, so the form and the connector cannot disagree about what is
 * acceptable.
 */
export const SHOPIFY_CLIENT_CREDENTIAL_PATTERN = /^(?!shp(at|ca|pa|ss)_)\S+$/;

/**
 * A minted access token's documented lifetime, in seconds.
 *
 * Recorded because it is the number ADR-042 §2 pinned (`expires_in: 86399`) and
 * because it is one second under 24 hours, which is a detail a reader who
 * assumes 86400 gets wrong at exactly the wrong moment. The connector does NOT
 * trust it: {@link ShopifyConnector.mintAccessToken} uses the `expires_in` the
 * vendor actually returned, and falls back to this only when the response omits
 * it.
 */
export const SHOPIFY_TOKEN_LIFETIME_SECONDS = 86_399;

/**
 * How early a token is treated as expired.
 *
 * A token that expires mid-flight produces a 401 on a request that was correct
 * when it was built, and the connector would then classify a healthy connection
 * as needing a new credential. One minute is comfortably longer than any single
 * request this connector makes and costs 0.07% of the token's life.
 */
export const SHOPIFY_TOKEN_REFRESH_SKEW_MS = 60_000;

/** Shopify's GraphQL page ceiling for a connection field. */
export const SHOPIFY_MAX_PAGE_SIZE = 250;

/** Hard ceiling on pages one read may fetch, so a store that never reports
 *  `hasNextPage: false` cannot spin forever. */
export const SHOPIFY_MAX_PAGES = 400;

/** Request timeout. Shopify documents no server-side ceiling for the Admin API,
 *  so this is OURS: long enough for a 250-node page on a large store, short
 *  enough that a wedged socket does not hold a sync worker for a minute. */
export const SHOPIFY_REQUEST_TIMEOUT_MS = 30_000;

/** How many times a THROTTLED query is retried before it is reported. The wait
 *  is DERIVED from the response's own `throttleStatus`, never a guessed
 *  constant — see {@link throttleWaitMs}. */
export const SHOPIFY_MAX_THROTTLE_RETRIES = 4;

/** Ceiling on the derived throttle wait, so a store reporting an absurd
 *  `restoreRate` cannot park a sync worker indefinitely. */
export const SHOPIFY_MAX_THROTTLE_WAIT_MS = 10_000;

/**
 * The datasets this track can serve.
 *
 * Typed `readonly DatasetName[]` and NOT cast: each name is a member of the
 * closed union in `../export-drop/profiles.ts`.
 *
 * These three were RESERVED FOR SHOPIFY when the vocabulary was widened
 * (WARP-2280) — that file's vendor mapping reads "Shopify → `order`, `product`,
 * `customer`", and three of its `updated_at` entries name "Shopify's own
 * `updated_at`, filterable as `updated_at_min`" as their source. The columns
 * were compared before this list was written, as the naming rule requires:
 *
 *  • `order` — `[order_id, created_at, customer_id, total_amount,
 *    subtotal_amount, tax_amount, refunded_amount, currency, financial_status,
 *    fulfillment_status, updated_at]` is the Admin API's `Order` exactly, down
 *    to the four separate money columns and the two display statuses.
 *  • `product` — `[product_id, created_at, title, sku, price_amount, currency,
 *    inventory_quantity, status, updated_at]` ≡ `Product` plus its first
 *    variant's SKU.
 *  • `customer` — `[customer_id, created_at, first_name, last_name, email,
 *    orders_count, total_spent_amount, currency, updated_at]` ≡ `Customer`,
 *    where `orders_count` is `numberOfOrders` and `total_spent_amount` is
 *    `amountSpent`.
 *
 * **NOT `ecommerce_order`**, and the difference matters enough that
 * `profiles.ts` states it in the dataset's own docstring: `ecommerce_order` is
 * the marketing-attribution shadow a storefront integration syncs INTO
 * Mailchimp — no tax split, no refund column, no fulfilment state — so the
 * revenue arithmetic `order` documents cannot be run on it. Serving Shopify's
 * order of record under that name would let `total_amount - tax_amount -
 * refunded_amount` be attempted against columns that are not there.
 *
 * **NOT `contact`** either: a `contact` is a CRM person with a lifecycle stage
 * who may have bought nothing. A Shopify buyer is `customer`, which is the
 * dataset that carries `orders_count` and `total_spent_amount`.
 */
export const SHOPIFY_DATASETS: readonly DatasetName[] = ["order", "product", "customer"];

/**
 * The access scope each dataset needs, checked against the scopes the TOKEN
 * MINT actually granted.
 *
 * This is the mechanism that turns ADR-042 §6's "an under-scoped key is a named
 * failure, never an empty result" from an intention into a check. The
 * client-credentials response carries a `scope` string listing exactly what the
 * merchant ticked, so the connector knows before it asks — no probing, no
 * guessing, and no `[]` that reads as "you sold nothing".
 */
export const SHOPIFY_DATASET_SCOPES: Readonly<Record<string, readonly string[]>> = {
  order: ["read_orders"],
  product: ["read_products"],
  customer: ["read_customers"],
};

/** The scope that lifts the 60-day order wall. Granted by Shopify on request,
 *  per app — never automatically, and never on a store that has not asked. */
export const SHOPIFY_ORDER_HISTORY_SCOPE = "read_all_orders";

/**
 * How far back `read_orders` alone reaches, in days.
 *
 * Shopify's own number, and the reason {@link ShopifyOrderHistoryWallError}
 * exists: past this boundary an app without {@link SHOPIFY_ORDER_HISTORY_SCOPE}
 * receives a SHORTER LIST, not an error. A revenue answer computed from a
 * silently truncated window is confidently wrong in the one domain where
 * nobody checks.
 */
export const SHOPIFY_ORDER_HISTORY_WALL_DAYS = 60;

/**
 * The customer fields Shopify classifies as **Level 2 protected customer
 * data** and blanks for an unapproved app.
 *
 * Named as a set because {@link detectProtectedDataRedaction} needs ALL of them
 * to be empty across ALL returned rows before it will call a denial: a single
 * customer with no recorded surname is ordinary, and treating that as a
 * permission failure would tell a Grow-plan merchant to upgrade a plan they
 * already have.
 */
export const SHOPIFY_PROTECTED_CUSTOMER_FIELDS: readonly string[] = [
  "email",
  "firstName",
  "lastName",
];

/** The plan that gates {@link SHOPIFY_PROTECTED_CUSTOMER_FIELDS}. A Basic-plan
 *  store cannot grant it — not partially, not with an exception. */
export const SHOPIFY_PROTECTED_DATA_PLAN = "Grow";

/**
 * The GraphQL root fields this connector may send inside a `mutation`.
 *
 * Both create a bulk EXPORT and nothing else — no order, product, customer or
 * fulfilment is created, changed or cancelled by either. Everything else is
 * absent by shape rather than by intention, which is what makes "destructive
 * actions are blocked" a property of this set instead of a promise somebody
 * held while writing the code.
 */
export const SHOPIFY_ALLOWED_MUTATIONS: ReadonlySet<string> = new Set([
  "bulkOperationRunQuery",
  "bulkOperationCancel",
]);

/** What this track is waiting on. Deliberately unlike the other tracks', so an
 *  installer triaging this is not sent looking for a Mailchimp datacentre. */
export const SHOPIFY_TRACK_REMEDIATION =
  "needs the client id and client secret of a Dev Dashboard app the MERCHANT created in " +
  "their own Shopify organization and installed on their own store, plus that store's " +
  "<store>.myshopify.com domain, stored on the integration row — and the shopify-admin-api " +
  "entry in allowed-egress.yaml, since this connector leaves the customer LAN. Admin-created " +
  "custom apps (the shpat_ token) were removed on 2026-01-01 and cannot be re-created";

/** What the owner must do about a protected-customer-data denial. Names the
 *  plan and the app setting, because those are two separate ticks and doing
 *  only one of them is the common failure. */
export const SHOPIFY_GROW_PLAN_REMEDIATION =
  `customer names, emails and phone numbers are Shopify Level 2 protected customer data. ` +
  `Reading them needs BOTH the store on the ${SHOPIFY_PROTECTED_DATA_PLAN} plan AND the app's ` +
  `protected-customer-data access request granted at that level in the Dev Dashboard. ` +
  `Orders, products and inventory are unaffected and keep working`;

/** What the owner must do about the 60-day wall. */
export const SHOPIFY_ORDER_HISTORY_REMEDIATION =
  `orders older than ${SHOPIFY_ORDER_HISTORY_WALL_DAYS} days need the ` +
  `${SHOPIFY_ORDER_HISTORY_SCOPE} access scope, which Shopify grants by request on the app. ` +
  `Without it the store returns a SHORTER LIST rather than an error, so this read is refused ` +
  `instead of answered from a window that silently stops`;

// ─────────────────────────────────────────────────────────────────────────────
// Errors — distinct classes with distinct codes, so a caller tells them apart
// without string-matching a message.
// ─────────────────────────────────────────────────────────────────────────────

/** Thrown when a connection names a destination this track will not dial. */
export class UnsafeShopifyBaseUrlError extends Error {
  readonly code = "UNSAFE_BASE_URL";
  constructor(reason: string) {
    super(`refusing to send Shopify client credentials there: ${reason}`);
    this.name = "UnsafeShopifyBaseUrlError";
  }
}

/** Why a credential was refused at intake. An explicit enum, never inferred. */
export type ShopifyCredentialRejection =
  | "empty"
  | "contains_whitespace"
  | "legacy_admin_api_token"
  | "unrecognized";

/**
 * Thrown when a credential is not a usable Dev Dashboard client credential.
 *
 * The message NEVER contains the offered value — a validation error that quotes
 * the credential writes it into every log line that renders the error (rule 19,
 * `apps/orchestrator/src/lib/log-redaction.ts`). Only the rejection CLASS is
 * reported, which is what the connect wizard needs to say something useful.
 */
export class InvalidShopifyCredentialError extends Error {
  readonly code = "INVALID_SHOPIFY_CREDENTIAL";
  constructor(readonly reason: ShopifyCredentialRejection) {
    super(`Shopify credential rejected (${reason}): ${CREDENTIAL_ADVICE[reason]}`);
    this.name = "InvalidShopifyCredentialError";
  }
}

const CREDENTIAL_ADVICE: Readonly<Record<ShopifyCredentialRejection, string>> = {
  empty: "no value was supplied",
  contains_whitespace:
    "the value carries whitespace, which a Shopify client id or secret never does — the " +
    "usual cause is a copy that picked up a line break",
  legacy_admin_api_token:
    "that is an admin-created custom app token (the shp… family). Shopify REMOVED that flow " +
    "on 2026-01-01: the token cannot be re-created if it stops working, and there is no field " +
    "it belongs in. Create a Dev Dashboard app in your own Shopify organization, install it on " +
    "your store, and paste its client id and client secret instead",
  unrecognized: "a Shopify Dev Dashboard credential is a client id and a client secret",
};

/** Thrown when only a person creating new credentials can restore the
 *  connection — the app was uninstalled, or the secret was rotated. */
export class ShopifyReauthorizationRequiredError extends Error {
  readonly code = "REAUTHORIZE_REQUIRED";
  constructor(readonly reason: string) {
    super(
      `Shopify rejected the client credentials (${reason}). Retrying cannot fix this — the app ` +
        `was uninstalled from the store, the client secret was rotated, or the app and the ` +
        `store are no longer in the same Shopify organization. Re-create or re-copy the ` +
        `credentials in the Dev Dashboard and reconnect. Note the PASTED credential never ` +
        `expires; only the 24-hour token the box mints from it does, and that is re-minted ` +
        `automatically.`,
    );
    this.name = "ShopifyReauthorizationRequiredError";
  }
}

/**
 * Thrown when the app was never granted a scope this read needs.
 *
 * Its own class rather than folded into re-authorization, because the
 * credentials are fine and making new ones would waste the merchant's time
 * without fixing anything. Surfacing it is mandatory: ADR-041's never-empty
 * contract means a dataset the scopes withhold must render THIS, never `[]`,
 * which reads as "you have no orders".
 */
export class ShopifyScopeMissingError extends Error {
  readonly code = "SCOPE_MISSING";
  constructor(
    readonly dataset: string,
    readonly requiredScopes: readonly string[],
    readonly grantedScopes: readonly string[],
  ) {
    super(
      `the Shopify app is not granted ${requiredScopes.join(", ")}, which "${dataset}" needs. ` +
        `This is a scope the merchant ticks on the app in the Dev Dashboard, not a broken ` +
        `credential — new client credentials will not change it. Reported rather than ` +
        `returned empty: an empty list here would read as "this store has no ${dataset}s". ` +
        `Granted today: ${grantedScopes.length === 0 ? "(none)" : grantedScopes.join(", ")}.`,
    );
    this.name = "ShopifyScopeMissingError";
  }
}

/**
 * Thrown when Shopify withheld protected customer data.
 *
 * Covers BOTH shapes the vendor uses, which is the whole reason this class
 * exists rather than a boolean somewhere: an explicit `ACCESS_DENIED` error in
 * an HTTP 200 body, and a silent redaction where the same HTTP 200 carries rows
 * whose protected fields are simply null. The second is the dangerous one — it
 * looks like a store whose customers have no names.
 */
export class ShopifyProtectedDataDeniedError extends Error {
  readonly code = "PROTECTED_CUSTOMER_DATA_DENIED";
  constructor(
    readonly shape: "vendor_error" | "silent_redaction",
    readonly detail: string,
  ) {
    super(
      `Shopify withheld protected customer data (${shape}: ${detail}). ` +
        `${SHOPIFY_GROW_PLAN_REMEDIATION}. Reported rather than returned as rows with blank ` +
        `names, which would read as a customer list this store does not have.`,
    );
    this.name = "ShopifyProtectedDataDeniedError";
  }
}

/**
 * Thrown when a read would cross the 60-day order wall without the scope that
 * lifts it.
 *
 * Refusing is the only honest option. Shopify does not error at the wall — it
 * returns fewer orders — so answering would mean reporting a truncated window
 * as a complete one.
 */
export class ShopifyOrderHistoryWallError extends Error {
  readonly code = "ORDER_HISTORY_WALL";
  constructor(readonly requestedFrom: string) {
    super(
      `the read asks for orders from ${requestedFrom}, which is beyond Shopify's ` +
        `${SHOPIFY_ORDER_HISTORY_WALL_DAYS}-day order history boundary: ` +
        `${SHOPIFY_ORDER_HISTORY_REMEDIATION}.`,
    );
    this.name = "ShopifyOrderHistoryWallError";
  }
}

/**
 * Thrown when Shopify's leaky-bucket cost limiter refused the query after the
 * connector had already waited out {@link SHOPIFY_MAX_THROTTLE_RETRIES}.
 *
 * DEGRADED, not an error the owner can act on: it clears on its own as the
 * bucket refills. Named separately from every other failure precisely so the
 * hub does not tell somebody to re-paste a working credential because we were
 * briefly over budget.
 */
export class ShopifyThrottledError extends Error {
  readonly code = "THROTTLED";
  constructor(
    readonly attempts: number,
    readonly detail: string,
  ) {
    super(
      `Shopify throttled this query after ${attempts} attempts (${detail}). The GraphQL Admin ` +
        `API meters by QUERY COST against a refilling bucket, so this resolves itself as the ` +
        `bucket restores — nobody needs to do anything.`,
    );
    this.name = "ShopifyThrottledError";
  }
}

/**
 * Thrown when a request outlived {@link SHOPIFY_REQUEST_TIMEOUT_MS}.
 *
 * A NAMED state, and the reason it exists: the ADR-041 contract is that none of
 * the failure states may ever render as an empty result. A timeout that
 * returned `[]` would tell the owner their store sold nothing, which is both
 * false and unfalsifiable from the outside.
 */
export class ShopifyTimeoutError extends Error {
  readonly code = "REQUEST_TIMEOUT";
  constructor(
    readonly op: string,
    readonly timeoutMs: number,
  ) {
    super(
      `Shopify request "${op}" exceeded the ${timeoutMs}ms timeout and was abandoned. ` +
        `Reported rather than returned empty: an empty result here would read as "nothing to ` +
        `sync" when the truth is that nothing was read.`,
    );
    this.name = "ShopifyTimeoutError";
  }
}

/** Thrown when a bulk operation failed, was cancelled, or expired. */
export class ShopifyBulkOperationError extends Error {
  readonly code = "BULK_OPERATION_FAILED";
  constructor(
    readonly status: string,
    readonly detail: string,
  ) {
    super(`Shopify bulk operation ended ${status} (${detail}).`);
    this.name = "ShopifyBulkOperationError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Guards — the real enforcement, because CI cannot see this host
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate a customer-supplied client id or secret, or throw — before anything
 * is persisted, and again on every resolve.
 *
 * Re-validating on resolve rather than only at intake matters because these
 * credentials NEVER EXPIRE: there is no natural moment at which a wrong or
 * retired value announces itself (ADR-042 §6), and a row edited out of band
 * must not be able to put a retired `shpat_` token on the wire.
 *
 * Returns the value unchanged. Nothing here writes, logs or renders it.
 */
export function assertShopifyClientCredential(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new InvalidShopifyCredentialError("empty");
  }
  // NOT trimmed before the whitespace check: a value that needed trimming was
  // pasted wrong, and silently repairing it hides a copy that may equally have
  // lost a character off the other end.
  if (/\s/.test(raw)) {
    throw new InvalidShopifyCredentialError("contains_whitespace");
  }
  if (SHOPIFY_LEGACY_ADMIN_TOKEN_PATTERN.test(raw)) {
    throw new InvalidShopifyCredentialError("legacy_admin_api_token");
  }
  // The pattern above is the gate; this is the same rule stated once more as
  // the catch-all, so loosening SHOPIFY_CLIENT_CREDENTIAL_PATTERN is what turns
  // the intake test red.
  if (!SHOPIFY_CLIENT_CREDENTIAL_PATTERN.test(raw)) {
    throw new InvalidShopifyCredentialError("unrecognized");
  }
  return raw;
}

/**
 * Assert that a stored shop domain is one this connector will build a host
 * from, and return it normalised to lowercase.
 *
 * `providerConfig` is free-text JSON on the integration row. Nothing but this
 * stands between a tampered row and a credential-carrying request to an
 * arbitrary host, so the domain is re-validated on the way OUT of storage and
 * not merely on the way in.
 *
 * Accepts the store handle with or without the suffix, because that is the
 * difference between what a merchant reads off their address bar and what they
 * type — but it never DEFAULTS anything: an empty value is refused rather than
 * guessed, which is the "no guessing state" rule at the one point where
 * guessing would send a live credential to a host that is not the customer's.
 */
export function assertShopifyShopDomain(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new UnsafeShopifyBaseUrlError("no store domain is configured for this connection");
  }
  const value = raw.trim().toLowerCase();
  const handle = value.endsWith(SHOPIFY_SHOP_DOMAIN_SUFFIX)
    ? value.slice(0, -SHOPIFY_SHOP_DOMAIN_SUFFIX.length)
    : value;
  if (!SHOPIFY_SHOP_NAME_PATTERN.test(handle)) {
    throw new UnsafeShopifyBaseUrlError(
      `"${value}" is not a <store>${SHOPIFY_SHOP_DOMAIN_SUFFIX} domain (a store handle is ` +
        `lowercase letters, digits and internal hyphens). A custom domain pointed at the ` +
        `store is NOT this value — Shopify authenticates on the myshopify one`,
    );
  }
  return `${handle}${SHOPIFY_SHOP_DOMAIN_SUFFIX}`;
}

/**
 * The exact host set this connection may dial — the ticket's
 * `SHOPIFY_ALLOWED_API_HOSTS`, as a FUNCTION of the connection.
 *
 * It cannot be the module-level constant the other tracks carry (HubSpot's
 * `HUBSPOT_ALLOWED_API_HOSTS`, QuickBooks' `QBO_ALLOWED_API_HOSTS`) because
 * there is no fixed Shopify host to put in one: every store is its own origin,
 * and the token endpoint lives on the same origin as the API. Writing a
 * constant here would mean writing a wildcard or a sampled store, which is the
 * exact mistake `allowed-egress.yaml` warns about — a green check over a host
 * nothing constrains.
 *
 * So the set is exact and per-connection, derived from the validated domain,
 * and {@link assertSafeShopifyBaseUrl} is the thing that consults it.
 */
export function shopifyAllowedApiHosts(shopDomain: string): ReadonlySet<string> {
  return new Set([assertShopifyShopDomain(shopDomain)]);
}

/**
 * Build this connection's origin, or throw. THE control for this connector.
 *
 * Exact-host equality against the store domain this connection stores, checked
 * BOTH ways:
 *
 *   - the host must match {@link SHOPIFY_ALLOWED_HOST_PATTERN}, anchored, so
 *     `acme.myshopify.com.evil.test` is refused. A suffix match, an `endsWith`,
 *     or an unanchored regex would accept it.
 *   - and it must equal THIS connection's store host, so a tampered
 *     `providerConfig` cannot redirect one merchant's traffic to another store,
 *     and an operator-supplied `baseUrl` cannot silently disagree with the
 *     credentials that will be sent to it.
 *
 * HTTPS only — client credentials over http is the app given away. Userinfo is
 * rejected because some HTTP clients resolve a userinfo-bearing `https://evil@`
 * origin to a different authority than a reader expects. Any port but 443 is refused
 * because that is all the egress registry contemplates.
 *
 * Called at CONSTRUCTION and again on every request build, before the request
 * object exists — so a bad destination costs zero fetch calls and never touches
 * a credential.
 */
export function assertSafeShopifyBaseUrl(raw: string, shopDomain: string): string {
  const allowed = shopifyAllowedApiHosts(shopDomain);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeShopifyBaseUrlError(`"${raw}" is not a URL`);
  }
  if (url.protocol !== "https:") {
    throw new UnsafeShopifyBaseUrlError(`"${url.protocol}//" is not https`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new UnsafeShopifyBaseUrlError("the URL carries userinfo");
  }
  const host = url.hostname.toLowerCase();
  if (!SHOPIFY_ALLOWED_HOST_PATTERN.test(host)) {
    throw new UnsafeShopifyBaseUrlError(`"${host}" is not a Shopify store host`);
  }
  if (!allowed.has(host)) {
    throw new UnsafeShopifyBaseUrlError(
      `"${host}" is not this connection's store host ("${[...allowed][0]}")`,
    );
  }
  // The URL parser drops an explicit :443, so any port left standing is one
  // the egress registry does not declare.
  if (url.port !== "" && url.port !== "443") {
    throw new UnsafeShopifyBaseUrlError(
      `port ${url.port} — the egress registry allows this host on 443 only`,
    );
  }
  return `${url.protocol}//${url.host}`;
}

/**
 * Derive this connection's origin from its store domain alone.
 *
 * The normal path: there is no operator-supplied base URL to trust, so the
 * origin is built from the validated domain and then re-checked by the same
 * guard the operator-supplied path uses. Building and then validating (rather
 * than trusting the construction) means one code path is under test, not two.
 */
export function shopifyBaseUrlFor(shopDomain: string): string {
  const domain = assertShopifyShopDomain(shopDomain);
  return assertSafeShopifyBaseUrl(`https://${domain}`, domain);
}

/**
 * Refuse a GraphQL document this connector may not send.
 *
 * The one control that matters on a single-endpoint API. Two properties, and
 * both are needed:
 *
 *   1. a document may carry a `mutation` operation only when EVERY root field
 *      it selects is in {@link SHOPIFY_ALLOWED_MUTATIONS}, and
 *   2. the check is an ALLOWLIST at the point of use, never a denylist of
 *      forbidden words in source. That distinction is a rule this codebase
 *      learned on the Stripe track: documents are assembled at runtime, so a
 *      denylist only ever catches the literals someone happened to type.
 *
 * Deliberately a lexical check rather than a parse. Pulling a GraphQL parser
 * into `erp-connector` to validate documents this file itself authors would be
 * a dependency bought to check our own strings; what the guard has to stop is a
 * REFACTOR that starts assembling a mutation from parts, and a lexical check
 * catches that at exactly the same moment a parser would.
 */
export function assertReadOnlyShopifyDocument(document: string): void {
  // Strip GraphQL `#` comments so a mutation named in a comment is not read as
  // one, and so a `# mutation` note cannot be used to hide a real one either
  // way round.
  const source = document.replace(/#[^\n]*/g, "");
  const mutation = /\bmutation\b/.exec(source);
  if (!mutation) return;
  const body = source.slice(mutation.index);
  const open = body.indexOf("{");
  if (open === -1) {
    throw new ConnectorBlockedError(
      "refusing an unparseable Shopify mutation",
      "the document declares a mutation with no selection set. Refusing rather than guessing " +
        "what it would have sent.",
    );
  }
  // Root fields are the identifiers at brace-depth 1 of the operation's
  // selection set, OUTSIDE any argument list. Tracked with two counters rather
  // than a regex, because both of the things a regex gets wrong here are real:
  // a nested field sharing a name with an allowed mutation must not launder the
  // check, and an ARGUMENT name must not be mistaken for a root field
  // (`bulkOperationRunQuery(query: $q)` selects one field and names an argument
  // `query`, and reading the second as a root refuses every legitimate export).
  //
  // A root selection may be written `alias: field`. Both identifiers are
  // collected and both must be allowed, which is deliberately stricter than
  // GraphQL requires: an alias that could be anything is a name a reader of
  // this document would trust, and nothing this connector sends needs one.
  const roots: string[] = [];
  let depth = 0;
  let paren = 0;
  const token = /[{}()]|\$?[A-Za-z_][A-Za-z0-9_]*/g;
  token.lastIndex = open;
  for (let m = token.exec(body); m; m = token.exec(body)) {
    const t = m[0];
    if (t === "(") {
      paren += 1;
      continue;
    }
    if (t === ")") {
      paren -= 1;
      continue;
    }
    if (paren > 0) continue;
    if (t === "{") {
      depth += 1;
      continue;
    }
    if (t === "}") {
      depth -= 1;
      if (depth <= 0) break;
      continue;
    }
    // `$var` is a variable reference, never a field.
    if (depth === 1 && !t.startsWith("$")) roots.push(t);
  }
  const refused = roots.filter((r) => !SHOPIFY_ALLOWED_MUTATIONS.has(r));
  if (roots.length === 0 || refused.length > 0) {
    throw new ConnectorBlockedError(
      `refusing the Shopify mutation "${refused[0] ?? "(none selected)"}"`,
      "this connector may only send the bulk-export mutations named in " +
        "SHOPIFY_ALLOWED_MUTATIONS. Order cancellation, refunds, fulfilment and product " +
        "edits are absent from that set on purpose — adding one is a deliberate, reviewed " +
        "change, not something a new document can do incidentally.",
    );
  }
}

/**
 * Decide whether a page of customer rows is a protected-data REDACTION rather
 * than a store whose customers happen to have sparse records.
 *
 * The rule is deliberately conservative: EVERY returned record must have EVERY
 * protected field empty. One customer with no surname is ordinary; a hundred
 * customers with no name, no surname and no email is Shopify blanking the
 * fields, because a store cannot transact with a hundred anonymous buyers.
 *
 * Returns `false` for an empty page, and that is the important half. A store
 * with no customers yet produces exactly the same shape as a denial, and
 * calling that a denial would tell a brand-new Grow-plan merchant to upgrade a
 * plan they already have. "No evidence" is a distinct answer from "denied" —
 * see {@link ShopifyProtectedDataProbe}'s `no_customers`.
 */
export function detectProtectedDataRedaction(
  records: readonly Record<string, unknown>[],
): boolean {
  if (records.length === 0) return false;
  return records.every((record) =>
    SHOPIFY_PROTECTED_CUSTOMER_FIELDS.every((field) => {
      const value = record[field];
      return value === null || value === undefined || value === "";
    }),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Wiring types
// ─────────────────────────────────────────────────────────────────────────────

type FetchLike = (input: string, init?: Record<string, unknown>) => Promise<Response>;

/** Resolve one half of the merchant's client credentials from the
 *  orchestrator's encrypted store. Cleartext for the life of one call only;
 *  never cached to disk here. */
export type ShopifyCredentialResolver = (field: "clientId" | "clientSecret") => Promise<string>;

/** The default resolver: nothing wired, so the track blocks honestly. */
export const blockedShopifyCredentialResolver: ShopifyCredentialResolver = async () => {
  throw new ConnectorBlockedError(
    "resolve the Shopify client credentials",
    SHOPIFY_TRACK_REMEDIATION,
  );
};

export interface ShopifyConnectorConfig {
  /** Pointer into the encrypted secret store — NEVER a credential. */
  credentialsSecretRef: string;
  /**
   * The store domain, persisted in `providerConfig` at intake.
   *
   * Read from there, never derived from the credentials: the client id says
   * nothing about which store the app is installed on, and answering "where
   * does this connection dial?" must never require decrypting a secret
   * (ADR-042 §5).
   */
  shopDomain: string;
  /** The connection row's id. Identity only; nothing is persisted here. */
  connectionId: string;
  /** Optional operator override. Guarded on construction, and must agree with
   *  {@link shopDomain}. */
  baseUrl?: string;
}

export interface ShopifyConnectorDeps {
  fetchImpl?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  resolveCredential?: ShopifyCredentialResolver;
  timeoutMs?: number;
}

/**
 * The ADR-041 §5 connection-state vocabulary, plus the one state this vendor
 * forces.
 *
 * `capability_limited` is NOT `error` and the distinction is the product. A
 * Basic-plan store is a WORKING connection: orders, products, inventory and
 * fulfilment all read correctly, and only the customer identities are withheld.
 * Rendering that as a broken integration would send a merchant to re-paste
 * credentials that are fine, and would hide the one thing they can act on — the
 * plan. `docs/integrations/shopify.md` makes the same promise to the customer:
 * a Basic store "still gets a genuinely useful connection".
 */
export type ShopifyConnectionState =
  | "disconnected"
  | "connected"
  | "needs_reconnect"
  | "capability_limited";

/**
 * The empirical answer to "can this app read protected customer data?".
 *
 * `unverified` is the SHIPPED default and a first-class value, not a null;
 * `no_customers` is the honest answer for a store with nothing to probe, and it
 * is deliberately NOT folded into either `granted` or `denied` — an absence of
 * evidence is not evidence, and both of the other answers would be a guess
 * presented to a merchant as a fact.
 */
export type ShopifyProtectedDataProbe =
  | { state: "unverified"; prerequisite: string }
  | { state: "granted"; probedAt: number }
  | { state: "no_customers"; probedAt: number }
  | { state: "denied"; shape: "vendor_error" | "silent_redaction"; detail: string; remediation: string; probedAt: number };

/** What the connector knows about the order-history boundary, explicitly. */
export interface ShopifyOrderHistoryAccess {
  /** Whether {@link SHOPIFY_ORDER_HISTORY_SCOPE} is among the granted scopes. */
  readonly allOrders: boolean;
  /** How far back a read may reach without it. */
  readonly windowDays: number;
}

export interface ShopifyStatus {
  state: ShopifyConnectionState;
  ok: boolean;
  /** Whether credentials resolve. NEVER the client id, and NEVER the secret or
   *  the minted access token — the SMTP settings view's `hasPassword`
   *  convention (ADR-042 §4). */
  hasCredentials: boolean;
  shopDomain: string;
  apiVersion: string;
  /** The scopes the token mint reported. Not secret — they are what the
   *  merchant ticked, and the owner needs to see them to fix a gap. */
  grantedScopes: readonly string[];
  protectedCustomerData: ShopifyProtectedDataProbe;
  orderHistory: ShopifyOrderHistoryAccess;
  requestTimeoutMs: number;
}

/**
 * A started bulk export, as a REFERENCE.
 *
 * The completed JSONL is served from a signed URL on a DIFFERENT host — object
 * storage, not `<shop>.myshopify.com` — which is NOT in
 * `docs/security/allowed-egress.yaml`. So this connector returns the reference
 * and does not dial it, exactly as the HubSpot track does with a completed
 * export ("the connector returns that reference rather than dialing it, because
 * that host is not registered here and downloading it is a separate decision
 * with its own security review"). Downloading it is a separate ticket with its
 * own egress entry and its own review, not something this connector can decide.
 */
export interface ShopifyBulkExportRef {
  id: string;
  status: string;
  objectCount: number | null;
  /** The signed JSONL URL Shopify issued. Passed through verbatim, never
   *  fetched from here. */
  url: string | null;
}

/** One page of vendor records plus the cursor that continues it. */
interface Page {
  nodes: Record<string, unknown>[];
  cursor: string | undefined;
  hasNext: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// The GraphQL documents — authored here, never assembled from caller input
// ─────────────────────────────────────────────────────────────────────────────

/** The connection field each dataset enumerates through. */
const CONNECTION_FIELD: Readonly<Record<string, string>> = {
  order: "orders",
  product: "products",
  customer: "customers",
};

/**
 * The node selection per dataset — exactly the fields the canonical columns
 * need, and nothing else.
 *
 * Minimum-necessary by construction rather than by a mapper's discretion: a
 * Shopify `Order` carries the shipping address, the buyer's IP and the full
 * line-item bag, none of which this product asked for, and the way that ends up
 * on the box is a selection written as "give me the order". So the selection is
 * derived from what `CANONICAL_COLUMNS` declares, and `shopify.test.ts` asserts
 * every canonical column has a source here.
 *
 * `customer { id }` on an order is Level 1 protected data. On a store without
 * even that grant it comes back null, and the order's `customer_id` is then
 * undefined — which is correct: an order whose buyer we may not see is still a
 * real order with a real total, and refusing the whole dataset over an
 * attribution column would withhold the commerce answers a Basic-plan store
 * connected Shopify for.
 */
const NODE_SELECTION: Readonly<Record<string, string>> = {
  order: `
    id
    createdAt
    updatedAt
    displayFinancialStatus
    displayFulfillmentStatus
    currencyCode
    customer { id }
    currentTotalPriceSet { shopMoney { amount currencyCode } }
    currentSubtotalPriceSet { shopMoney { amount } }
    currentTotalTaxSet { shopMoney { amount } }
    totalRefundedSet { shopMoney { amount } }
  `,
  product: `
    id
    createdAt
    updatedAt
    title
    status
    totalInventory
    priceRangeV2 { minVariantPrice { amount currencyCode } }
    variants(first: 1) { nodes { sku } }
  `,
  customer: `
    id
    createdAt
    updatedAt
    firstName
    lastName
    email
    numberOfOrders
    amountSpent { amount currencyCode }
  `,
};

/**
 * The sort key each dataset's delta read orders by.
 *
 * `UPDATED_AT` everywhere it exists, because that is the position an
 * incremental sync can actually advance on — the canonical `updated_at` these
 * three datasets carry is Shopify's own field, and `profiles.ts` says why
 * `created_at` cannot stand in for it: "an order placed on Monday and shipped
 * on Friday changes without moving".
 */
const SORT_KEY: Readonly<Record<string, string>> = {
  order: "UPDATED_AT",
  product: "UPDATED_AT",
  customer: "UPDATED_AT",
};

/**
 * One Shopify record → canonical-column lookup, per dataset.
 *
 * Returns the RAW vendor value; `projectCanonicalRow` owns the coercion and
 * owns the row's key set, so a mapper can neither leak a vendor field onto a
 * row nor drop a canonical one.
 *
 * ## Money
 *
 * Shopify's `MoneyV2.amount` is a DECIMAL STRING in major units
 * (`"12.34"`), which is already the canonical form `profiles.ts` mandates —
 * unlike Stripe's integer minor units, this track has no conversion to get
 * wrong. `shopMoney` (the store's own currency) is read rather than
 * `presentmentMoney` (whatever the buyer saw), because a revenue report that
 * mixes presentment currencies is not a number.
 *
 * ## Ids
 *
 * Shopify ids are GLOBAL IDs (`gid://shopify/Order/123`). Kept verbatim: they
 * are the stable vendor identifier, they are what a bulk export emits, and they
 * are what an id-set diff has to compare. Stripping the prefix to "tidy" them
 * would produce ids that collide across types — `Order/5` and `Product/5` both
 * become `5`.
 */
function shopifyLookup(dataset: DatasetName, record: Record<string, unknown>): VendorLookup {
  const nested = (key: string, field: string): unknown => {
    const node = record[key];
    return node && typeof node === "object" ? (node as Record<string, unknown>)[field] : undefined;
  };
  const money = (setKey: string, field: "amount" | "currencyCode"): unknown => {
    const set = record[setKey];
    const shop =
      set && typeof set === "object" ? (set as Record<string, unknown>).shopMoney : undefined;
    return shop && typeof shop === "object" ? (shop as Record<string, unknown>)[field] : undefined;
  };
  return (column: string): unknown => {
    switch (column) {
      case "order_id":
      case "product_id":
        return record.id;
      // On the `customer` dataset the record IS the customer; on `order` it is
      // the nested buyer, which is null when protected data is withheld.
      case "customer_id":
        return dataset === "customer" ? record.id : nested("customer", "id");

      case "created_at":
        return record.createdAt;
      case "updated_at":
        return record.updatedAt;

      // ── order ────────────────────────────────────────────────────────────
      case "total_amount":
        return money("currentTotalPriceSet", "amount");
      case "subtotal_amount":
        return money("currentSubtotalPriceSet", "amount");
      case "tax_amount":
        return money("currentTotalTaxSet", "amount");
      case "refunded_amount":
        return money("totalRefundedSet", "amount");
      case "financial_status":
        return record.displayFinancialStatus;
      case "fulfillment_status":
        return record.displayFulfillmentStatus;

      // ── product ──────────────────────────────────────────────────────────
      case "title":
        return record.title;
      case "sku": {
        const variants = record.variants;
        const nodes =
          variants && typeof variants === "object"
            ? (variants as Record<string, unknown>).nodes
            : undefined;
        const first = Array.isArray(nodes) ? (nodes[0] as Record<string, unknown> | undefined) : undefined;
        return first?.sku;
      }
      case "price_amount": {
        const range = record.priceRangeV2;
        const min =
          range && typeof range === "object"
            ? (range as Record<string, unknown>).minVariantPrice
            : undefined;
        return min && typeof min === "object" ? (min as Record<string, unknown>).amount : undefined;
      }
      // `totalInventory` is the store's own roll-up across locations, and it
      // may be NEGATIVE where the store allows overselling — which
      // `profiles.ts` explicitly permits for this column.
      case "inventory_quantity":
        return record.totalInventory;
      case "status":
        return record.status;

      // ── customer ─────────────────────────────────────────────────────────
      case "first_name":
        return record.firstName;
      case "last_name":
        return record.lastName;
      case "email":
        return record.email;
      case "orders_count":
        return record.numberOfOrders;
      case "total_spent_amount":
        return nested("amountSpent", "amount");

      // Three datasets, three places the currency lives, and reading the wrong
      // one produces an amount with somebody else's currency attached.
      case "currency":
        if (dataset === "order") return record.currencyCode;
        if (dataset === "customer") return nested("amountSpent", "currencyCode");
        return (() => {
          const range = record.priceRangeV2;
          const min =
            range && typeof range === "object"
              ? (range as Record<string, unknown>).minVariantPrice
              : undefined;
          return min && typeof min === "object"
            ? (min as Record<string, unknown>).currencyCode
            : undefined;
        })();

      default:
        return undefined;
    }
  };
}

/** The shape of a Shopify GraphQL error entry we actually read. */
interface GraphqlError {
  message?: unknown;
  extensions?: { code?: unknown; documentation?: unknown } | null;
}

/**
 * Shopify's "you asked for a field your app is not approved for" message.
 *
 * Matched as well as `extensions.code`, because the code is `ACCESS_DENIED` for
 * BOTH a missing access scope and a protected-data refusal and the two need
 * opposite advice — one is a tick on the app, the other is a plan upgrade plus
 * a data-access request. The message is the only thing that tells them apart.
 */
const PROTECTED_FIELD_MESSAGE = /not approved to use the/i;

/** Shopify's "you are missing an access scope" message. */
const SCOPE_MESSAGE = /required access|access scope/i;

/**
 * How long to wait before retrying a THROTTLED query.
 *
 * DERIVED from the response Shopify sent, never a constant: the reply carries
 * `throttleStatus.currentlyAvailable` and `restoreRate`, so the wait is
 * arithmetic on the vendor's own numbers rather than a guess that is wrong on
 * every plan but one. Capped by {@link SHOPIFY_MAX_THROTTLE_WAIT_MS} so a store
 * reporting a nonsense restore rate cannot park a sync worker.
 */
export function throttleWaitMs(extensions: unknown, requestedCost: number): number {
  const cost =
    extensions && typeof extensions === "object"
      ? (extensions as Record<string, unknown>).cost
      : undefined;
  const throttle =
    cost && typeof cost === "object"
      ? (cost as Record<string, unknown>).throttleStatus
      : undefined;
  const available =
    throttle && typeof throttle === "object"
      ? Number((throttle as Record<string, unknown>).currentlyAvailable)
      : NaN;
  const restore =
    throttle && typeof throttle === "object"
      ? Number((throttle as Record<string, unknown>).restoreRate)
      : NaN;
  if (!Number.isFinite(available) || !Number.isFinite(restore) || restore <= 0) {
    // No usable numbers: one second, which is Shopify's own documented refill
    // granularity, rather than zero (a hot retry loop) or a long sleep.
    return 1_000;
  }
  const deficit = Math.max(0, requestedCost - available);
  return Math.min(SHOPIFY_MAX_THROTTLE_WAIT_MS, Math.ceil((deficit / restore) * 1_000) + 100);
}

export class ShopifyConnector implements Connector {
  readonly provider = SHOPIFY_PROVIDER;
  readonly servesDatasets = SHOPIFY_DATASETS;

  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly resolveCredential: ShopifyCredentialResolver;
  private readonly fetchImpl?: FetchLike;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly shopDomain: string;

  /** The minted token, in memory only. NEVER persisted — ADR-041 §4 and
   *  WARP-2028: this connector must not become the first writer of a store
   *  whose encryption promises are not yet kept. A restart re-mints, which
   *  costs one request. */
  private token: { accessToken: string; expiresAt: number } | null = null;
  private grantedScopes: readonly string[] = [];
  private credentialsResolved = false;
  private fingerprint: string | null = null;
  private probe: ShopifyProtectedDataProbe = {
    state: "unverified",
    prerequisite: `${SHOPIFY_PROTECTED_DATA_PLAN} plan + granted protected-customer-data access`,
  };

  constructor(
    private readonly config: ShopifyConnectorConfig,
    deps: ShopifyConnectorDeps = {},
  ) {
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.resolveCredential = deps.resolveCredential ?? blockedShopifyCredentialResolver;
    this.fetchImpl = deps.fetchImpl;
    this.timeoutMs = deps.timeoutMs ?? SHOPIFY_REQUEST_TIMEOUT_MS;
    // Validated at CONSTRUCTION: a connection naming a destination we will not
    // dial should fail to build, loudly, rather than look fine until the first
    // read ships a client secret.
    this.shopDomain = assertShopifyShopDomain(config.shopDomain);
    this.baseUrl = config.baseUrl
      ? assertSafeShopifyBaseUrl(config.baseUrl, this.shopDomain)
      : shopifyBaseUrlFor(this.shopDomain);
  }

  private blocked(op: string, detail?: string): ConnectorBlockedError {
    return new ConnectorBlockedError(
      detail ? `${op} (${detail})` : op,
      SHOPIFY_TRACK_REMEDIATION,
    );
  }

  // ── the token minter (WARP-2310) ──────────────────────────────────────────

  /**
   * Mint a 24-hour access token from the merchant's client credentials.
   *
   * The client-credentials grant, and the whole of this track's authentication.
   * Four properties are load-bearing and each has a test:
   *
   *   • **No refresh token exists.** Shopify issues none for this grant, so
   *     there is nothing to refresh and {@link refresh} throws rather than
   *     pretending — ADR-042 §6: "a short-lived minted token is RE-MINTED,
   *     never refreshed". A `refresh()` that quietly re-minted would hide the
   *     difference between a grant that rotates and one that does not, which is
   *     the distinction the next vendor's implementer needs.
   *   • **The destination is re-guarded here**, not inherited from the read
   *     path. This is the ONE request that carries the client secret, so it is
   *     the last place to take the origin on trust.
   *   • **The response's `scope` is captured.** It is the exact list of what
   *     the merchant ticked, which is what makes
   *     {@link ShopifyScopeMissingError} and the 60-day-wall check possible
   *     without probing.
   *   • **Nothing here is logged or returned.** Not the secret, not the token.
   *     The token goes on an instance field and leaves this object only inside
   *     a request header (rule 19).
   */
  private async mintAccessToken(): Promise<string> {
    const base = assertSafeShopifyBaseUrl(this.baseUrl, this.shopDomain);
    const clientId = assertShopifyClientCredential(await this.resolveCredential("clientId"));
    const clientSecret = assertShopifyClientCredential(
      await this.resolveCredential("clientSecret"),
    );
    this.credentialsResolved = true;

    const doFetch = this.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    if (!doFetch) throw this.blocked("mintAccessToken", "no fetch implementation available");

    // `URLSearchParams` rather than a hand-built string: the secret is
    // form-encoded exactly once, by a component that cannot forget to escape a
    // character, and it never exists as an interpolated template a logger could
    // pick up.
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    });

    let res: Response;
    try {
      res = await this.withTimeout("mintAccessToken", (signal) =>
        doFetch(`${base}${SHOPIFY_TOKEN_PATH}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body: body.toString(),
          // Never follow a 3xx: the fetch spec strips credentials on
          // cross-origin redirects, but the secret's safety must not rest on
          // every runtime implementing that correctly. This endpoint has no
          // legitimate redirect, so one is a fault, not a hop.
          redirect: "error",
          signal,
        }),
      );
    } catch (err) {
      if (err instanceof ShopifyTimeoutError) throw err;
      if (ShopifyConnector.isTimeout(err)) {
        throw new ShopifyTimeoutError("mintAccessToken", this.timeoutMs);
      }
      throw this.blocked("mintAccessToken", `Shopify unreachable: ${(err as Error).message}`);
    }

    if (res.status === 400 || res.status === 401 || res.status === 403) {
      // The response body for a bad client id/secret is `{"error":
      // "invalid_client"}` — a CLASS, not the value we sent, so it is safe to
      // repeat. Nothing derived from the credential is echoed.
      throw new ShopifyReauthorizationRequiredError(
        `the token endpoint returned ${res.status}`,
      );
    }
    if (!res.ok) {
      throw this.blocked("mintAccessToken", `Shopify token endpoint returned ${res.status}`);
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = (await res.json()) as Record<string, unknown>;
    } catch (err) {
      throw this.blocked("mintAccessToken", `unparseable token response: ${(err as Error).message}`);
    }

    const accessToken = parsed.access_token;
    if (typeof accessToken !== "string" || accessToken === "") {
      throw this.blocked(
        "mintAccessToken",
        "the token response carried no access_token — refusing to continue with nothing rather " +
          "than sending an empty credential and collecting an opaque 401",
      );
    }
    const expiresIn =
      typeof parsed.expires_in === "number" && Number.isFinite(parsed.expires_in)
        ? parsed.expires_in
        : SHOPIFY_TOKEN_LIFETIME_SECONDS;
    this.grantedScopes = ShopifyConnector.parseScopes(parsed.scope);
    this.token = {
      accessToken,
      expiresAt: this.now() + expiresIn * 1_000 - SHOPIFY_TOKEN_REFRESH_SKEW_MS,
    };
    return accessToken;
  }

  /**
   * The current access token, minting one when there is none or it is within
   * {@link SHOPIFY_TOKEN_REFRESH_SKEW_MS} of expiry.
   *
   * Expiry is compared against the clock, never against "did the last call
   * fail" — deriving liveness from a 401 is the guessing-from-absence rule
   * broken in the one place where the guess costs a wasted request AND a
   * misclassified connection state.
   */
  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > this.now()) return this.token.accessToken;
    return this.mintAccessToken();
  }

  /**
   * There is no refresh. Shopify issues no refresh token for the
   * client-credentials grant, so this throws rather than silently re-minting.
   *
   * Modelled on `online-connector.ts:497-509`, which ADR-042 §6 names as the
   * shape for exactly this case.
   */
  async refresh(): Promise<never> {
    throw this.blocked(
      "refresh",
      "the Shopify client-credentials grant issues NO refresh token. The 24-hour access token " +
        "is re-minted from the stored client credentials, never refreshed — call a read and " +
        "the connector mints as needed",
    );
  }

  /** The granted scope list, from the mint response's space-separated `scope`.
   *  An absent or non-string value yields an EMPTY list, never an assumed one:
   *  assuming a grant is how an under-scoped read becomes an empty result. */
  private static parseScopes(raw: unknown): readonly string[] {
    if (typeof raw !== "string") return [];
    return raw
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter((s) => s !== "");
  }

  // ── requests ──────────────────────────────────────────────────────────────

  /**
   * One GraphQL request.
   *
   * Order is load-bearing. The document guard and the host guard both run
   * BEFORE the credentials are resolved and before the request object exists,
   * so a refused document or destination costs zero fetch calls and never
   * touches a credential — which is what the tests assert on.
   */
  private async graphql(
    op: string,
    document: string,
    variables: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    assertReadOnlyShopifyDocument(document);
    // Re-checked per request, not only at construction: `providerConfig` is
    // free-text JSON and this is the only thing standing between a tampered row
    // and a credential-carrying request to an arbitrary host.
    const base = assertSafeShopifyBaseUrl(this.baseUrl, this.shopDomain);
    const url = `${base}${SHOPIFY_GRAPHQL_PATH}`;

    const doFetch = this.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    if (!doFetch) throw this.blocked(op, "no fetch implementation available");

    let lastThrottle = "no throttleStatus reported";
    for (let attempt = 1; attempt <= SHOPIFY_MAX_THROTTLE_RETRIES + 1; attempt += 1) {
      const token = await this.accessToken();
      let res: Response;
      try {
        res = await this.withTimeout(op, (signal) =>
          doFetch(url, {
            method: "POST",
            headers: {
              [SHOPIFY_ACCESS_TOKEN_HEADER]: token,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({ query: document, variables }),
            redirect: "error",
            signal,
          }),
        );
      } catch (err) {
        if (err instanceof ShopifyTimeoutError) throw err;
        if (ShopifyConnector.isTimeout(err)) throw new ShopifyTimeoutError(op, this.timeoutMs);
        throw this.blocked(op, `Shopify API unreachable: ${(err as Error).message}`);
      }

      if (res.status === 401 || res.status === 403) {
        // The app was uninstalled or the secret rotated. Drop the cached token
        // so a later reconnect does not present a dead one.
        this.token = null;
        throw new ShopifyReauthorizationRequiredError(`Shopify returned ${res.status}`);
      }
      if (res.status === 402 || res.status === 423) {
        throw this.blocked(
          op,
          `Shopify returned ${res.status} — the store is frozen or locked, which is a billing ` +
            `or account state at the merchant's end and not a credential problem`,
        );
      }
      if (res.status === 429) {
        lastThrottle = "HTTP 429";
        if (attempt > SHOPIFY_MAX_THROTTLE_RETRIES) break;
        await this.sleep(1_000 * attempt);
        continue;
      }
      if (!res.ok) throw this.blocked(op, `Shopify API returned ${res.status}`);

      let body: Record<string, unknown>;
      try {
        body = (await res.json()) as Record<string, unknown>;
      } catch (err) {
        throw this.blocked(op, `unparseable Shopify response: ${(err as Error).message}`);
      }

      const errors = Array.isArray(body.errors) ? (body.errors as GraphqlError[]) : [];
      if (errors.length > 0) {
        const throttled = errors.find(
          (e) => e.extensions && (e.extensions as { code?: unknown }).code === "THROTTLED",
        );
        if (throttled) {
          lastThrottle = String(throttled.message ?? "THROTTLED");
          if (attempt > SHOPIFY_MAX_THROTTLE_RETRIES) break;
          await this.sleep(throttleWaitMs(body.extensions, 0));
          continue;
        }
        this.classifyGraphqlErrors(op, errors);
      }

      const data = body.data;
      if (!data || typeof data !== "object") {
        throw this.blocked(op, "the Shopify response carried no data object");
      }
      return data as Record<string, unknown>;
    }
    throw new ShopifyThrottledError(SHOPIFY_MAX_THROTTLE_RETRIES + 1, lastThrottle);
  }

  /**
   * Turn Shopify's HTTP-200 error array into a named failure.
   *
   * This is where the vendor's "success with an error inside" shape stops being
   * a trap. `ACCESS_DENIED` covers BOTH a missing access scope and a
   * protected-customer-data refusal, and the two want opposite advice, so the
   * MESSAGE is what separates them — checked in the order that puts the more
   * specific pattern first.
   */
  private classifyGraphqlErrors(op: string, errors: readonly GraphqlError[]): never {
    const first = errors[0];
    const message = String(first?.message ?? "unspecified GraphQL error");
    const code = first?.extensions && (first.extensions as { code?: unknown }).code;

    if (PROTECTED_FIELD_MESSAGE.test(message)) {
      throw new ShopifyProtectedDataDeniedError("vendor_error", message);
    }
    if (code === "ACCESS_DENIED" || SCOPE_MESSAGE.test(message)) {
      throw new ShopifyScopeMissingError(op, [], this.grantedScopes);
    }
    if (code === "MAX_COST_EXCEEDED") {
      throw this.blocked(
        op,
        `${message} — the query is too expensive for a single Shopify request. That is a ` +
          `defect in the document this connector authored, not something the merchant can fix`,
      );
    }
    throw this.blocked(op, `Shopify GraphQL error: ${message}`);
  }

  /**
   * Bound one call at {@link SHOPIFY_REQUEST_TIMEOUT_MS}, belt AND braces —
   * an `AbortSignal` so a real `fetch` tears the socket down, and a race
   * against our own timer so the deadline holds even when the fetch
   * implementation ignores the signal.
   *
   * The second is not paranoia about hypotheticals: it is what makes the
   * deadline OURS rather than a delegated hope. The ADR-041 contract is that a
   * stalled request surfaces as {@link ShopifyTimeoutError} — never as an empty
   * result, and never as a promise that simply never settles.
   */
  private async withTimeout<T>(op: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ShopifyTimeoutError(op, this.timeoutMs));
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([fn(controller.signal), deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** An aborted `fetch` rejects with a `TimeoutError` or `AbortError`
   *  DOMException depending on the runtime. Matched on the name, which both
   *  set, rather than on a message. */
  private static isTimeout(err: unknown): boolean {
    const name = (err as { name?: unknown } | null)?.name;
    return name === "TimeoutError" || name === "AbortError";
  }

  // ── enumeration ───────────────────────────────────────────────────────────

  /**
   * Assert the app was granted what this dataset needs, before any request.
   *
   * Runs against the scope list the TOKEN MINT returned, so it costs nothing
   * and cannot be wrong about what the merchant ticked. ADR-042 §6's
   * never-an-empty-result rule lands here.
   */
  private assertScopeFor(dataset: string): void {
    const required = SHOPIFY_DATASET_SCOPES[dataset] ?? [];
    const missing = required.filter((s) => !this.grantedScopes.includes(s));
    if (missing.length > 0) {
      throw new ShopifyScopeMissingError(dataset, missing, this.grantedScopes);
    }
  }

  /**
   * The `query:` filter for a delta read, and the 60-day-wall check.
   *
   * Two things happen here and both are the point:
   *
   *   1. `updated_at:>='<iso>'` is Shopify's own documented search filter — the
   *      GraphQL spelling of `updated_at_min`. Omitting it does NOT fail; it
   *      silently becomes a full scan returning correct-looking rows, which is
   *      why the tests assert on the outgoing DOCUMENT and not on the rows that
   *      came back.
   *   2. For `order` without {@link SHOPIFY_ORDER_HISTORY_SCOPE}, a `since`
   *      older than the wall is REFUSED rather than answered. Shopify would
   *      return the last 60 days with no error, and reporting that as the
   *      answer to "everything since January" is a confident false statement
   *      about revenue.
   *
   * An UNBOUNDED enumeration (the sync runner's `{}`) is clamped to the wall
   * instead of refused, and that asymmetry is deliberate: the poller is asking
   * "what changed", for which 60 days is a complete answer, while a caller who
   * named an older `from` asked a question this connection cannot answer.
   */
  private deltaFilter(dataset: string, since: string | undefined): string | undefined {
    if (dataset !== "order") return since === undefined ? undefined : `updated_at:>='${since}'`;
    if (this.grantedScopes.includes(SHOPIFY_ORDER_HISTORY_SCOPE)) {
      return since === undefined ? undefined : `updated_at:>='${since}'`;
    }
    const wall = new Date(
      this.now() - SHOPIFY_ORDER_HISTORY_WALL_DAYS * 24 * 60 * 60 * 1_000,
    ).toISOString();
    if (since === undefined) return `updated_at:>='${wall}'`;
    if (since < wall) throw new ShopifyOrderHistoryWallError(since);
    return `updated_at:>='${since}'`;
  }

  /**
   * One page of a connection field.
   *
   * Cursor pagination, which is the only kind Shopify's GraphQL API has — there
   * is no offset anywhere, and that is a property worth having: a cursor is
   * stable across a page boundary where an offset re-reads or skips a row the
   * store mutated mid-scan.
   */
  private async page(
    op: string,
    dataset: string,
    filter: string | undefined,
    cursor: string | undefined,
    pageSize: number,
  ): Promise<Page> {
    const field = CONNECTION_FIELD[dataset];
    const document = `
      query DropletRead($first: Int!, $after: String, $query: String) {
        ${field}(first: $first, after: $after, query: $query, sortKey: ${SORT_KEY[dataset]}) {
          nodes { ${NODE_SELECTION[dataset]} }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;
    const data = await this.graphql(op, document, {
      first: Math.min(Math.max(1, Math.trunc(pageSize)), SHOPIFY_MAX_PAGE_SIZE),
      after: cursor ?? null,
      query: filter ?? null,
    });
    const connection = data[field];
    if (!connection || typeof connection !== "object") {
      throw this.blocked(op, `Shopify returned no "${field}" connection`);
    }
    const nodes = (connection as Record<string, unknown>).nodes;
    if (!Array.isArray(nodes)) {
      throw this.blocked(
        op,
        `Shopify's "${field}" connection carried a non-array nodes field. Refusing to ` +
          `interpret it rather than guessing at a shape`,
      );
    }
    const info = (connection as Record<string, unknown>).pageInfo;
    const pageInfo = info && typeof info === "object" ? (info as Record<string, unknown>) : {};
    return {
      nodes: nodes as Record<string, unknown>[],
      cursor: typeof pageInfo.endCursor === "string" ? pageInfo.endCursor : undefined,
      hasNext: pageInfo.hasNextPage === true,
    };
  }

  /** Every record of one dataset matching the delta filter, as raw vendor
   *  records. Bounded by {@link SHOPIFY_MAX_PAGES} so a store that never
   *  reports `hasNextPage: false` cannot spin forever. */
  private async enumerate(
    op: string,
    dataset: string,
    since: string | undefined,
  ): Promise<Record<string, unknown>[]> {
    this.assertScopeFor(dataset);
    const filter = this.deltaFilter(dataset, since);
    const out: Record<string, unknown>[] = [];
    let cursor: string | undefined;
    for (let page = 1; page <= SHOPIFY_MAX_PAGES; page += 1) {
      const result = await this.page(op, dataset, filter, cursor, SHOPIFY_MAX_PAGE_SIZE);
      out.push(...result.nodes);
      if (!result.hasNext || result.cursor === undefined) return out;
      cursor = result.cursor;
    }
    throw new ConnectorBlockedError(
      `${op} stopped after ${SHOPIFY_MAX_PAGES} pages`,
      "the connection kept reporting another page; aborting rather than paging forever.",
    );
  }

  // ── Connector interface ───────────────────────────────────────────────────

  /**
   * Open the connection: mint a token, and PROBE the protected-data grant
   * rather than assume it.
   *
   * The mint proves three things at once — the credentials work, egress to this
   * store is permitted, and (from its `scope`) exactly what the app may read.
   * The probe answers the one question the scope list cannot: `read_customers`
   * being granted does NOT mean protected customer data is approved, because
   * the plan gate is a separate mechanism.
   */
  async connect(): Promise<void> {
    await this.mintAccessToken();
    await this.probeProtectedCustomerData();
    this.fingerprint = computeSchemaFingerprint(this.tables());
  }

  /**
   * Empirically establish whether this app can read protected customer data.
   *
   * One customer, three fields. Cheap, and it is the only way to know: the
   * grant is not in the scope list, Shopify publishes no capability endpoint
   * for it, and the failure mode is a silent blank.
   *
   * FOUR outcomes, all first-class:
   *
   *   • `denied` / `vendor_error` — Shopify said so in an HTTP 200 body.
   *   • `denied` / `silent_redaction` — rows came back with every protected
   *     field empty. This is the shape the customer guide warns about.
   *   • `no_customers` — the store has no customers to probe. NOT "granted":
   *     an absence of evidence would become a promise the next read breaks.
   *   • `granted` — at least one protected field had a value.
   *
   * A missing `read_customers` scope is NOT a denial and does not reach here:
   * {@link assertScopeFor} refuses first, because "you did not tick the scope"
   * and "your plan does not include the data" need different advice.
   */
  async probeProtectedCustomerData(): Promise<ShopifyProtectedDataProbe> {
    const required = SHOPIFY_DATASET_SCOPES.customer;
    if (required.some((s) => !this.grantedScopes.includes(s))) {
      // Leave the probe `unverified`: without the scope there is nothing to
      // learn, and recording a denial would blame the plan for a tick.
      return this.probe;
    }
    try {
      const page = await this.page("probeProtectedCustomerData", "customer", undefined, undefined, 1);
      if (page.nodes.length === 0) {
        this.probe = { state: "no_customers", probedAt: this.now() };
      } else if (detectProtectedDataRedaction(page.nodes)) {
        this.probe = {
          state: "denied",
          shape: "silent_redaction",
          detail: `every ${SHOPIFY_PROTECTED_CUSTOMER_FIELDS.join(", ")} field came back empty`,
          remediation: SHOPIFY_GROW_PLAN_REMEDIATION,
          probedAt: this.now(),
        };
      } else {
        this.probe = { state: "granted", probedAt: this.now() };
      }
    } catch (err) {
      if (err instanceof ShopifyProtectedDataDeniedError) {
        this.probe = {
          state: "denied",
          shape: err.shape,
          detail: err.detail,
          remediation: SHOPIFY_GROW_PLAN_REMEDIATION,
          probedAt: this.now(),
        };
        return this.probe;
      }
      throw err;
    }
    return this.probe;
  }

  async close(): Promise<void> {
    this.token = null;
  }

  /**
   * The health probe — and the Grow-plan preflight (WARP-2338).
   *
   * `health()` runs {@link probeProtectedCustomerData} so the named state
   * exists before anything reads customers. It deliberately does NOT throw when
   * the probe says `denied`, and that is the design decision worth stating:
   *
   * A Basic-plan store is a WORKING connection. Orders, products, inventory and
   * fulfilment all read correctly; only the customer identities are withheld.
   * `integrations.service` classifies a rejected `health()` into the row's
   * status, so throwing here would render the whole integration ERROR — which
   * tells the merchant to go and fix a connection that has nothing wrong with
   * it, and hides the one thing they can act on. The denial is carried by
   * `status().protectedCustomerData` and enforced where it bites, in
   * {@link runRead} on the `customer` dataset, which throws rather than
   * returning rows with blank names.
   *
   * The failures that DO reject here are the ones where nothing can be read:
   * no credential resolved, a credential the vendor refuses, or a destination
   * we will not dial.
   */
  async health(): Promise<{ ok: boolean }> {
    await this.accessToken();
    await this.probeProtectedCustomerData();
    return { ok: true };
  }

  /** The canonical shape this track serves. Synthesized rather than
   *  introspected: Shopify's schema is Shopify's, published and versioned, so
   *  there is nothing to discover — but the fingerprint still has to exist so
   *  drift-freeze semantics stay coherent across every track. */
  private tables(): IntrospectedTable[] {
    return SHOPIFY_DATASETS.map((dataset) => ({
      name: dataset,
      owner: SHOPIFY_PROVIDER,
      columns: CANONICAL_COLUMNS[dataset].map((name) => ({ name, type: "text" })),
    }));
  }

  async introspect(): Promise<IntrospectionResult> {
    const tables = this.tables();
    const fingerprint = computeSchemaFingerprint(tables);
    this.fingerprint = fingerprint;
    return { tables, fingerprint };
  }

  /**
   * Serve a named commerce read as canonical rows.
   *
   * Filter params are OPTIONAL for the same reason as on the HubSpot and
   * Mailchimp tracks: the registry's queries carry mandatory filters written
   * for the SQL track, while the sync runner passes `{}` or `{ since }` and
   * wants the dataset enumerated. A param that is present filters; one that is
   * absent enumerates. That is what puts these three datasets in
   * `ERP_SYNC_ENTITIES` without a second query name meaning almost the same
   * thing.
   *
   * `since` reaches the vendor as `updated_at:>='…'` — Shopify's own documented
   * search filter, pushed DOWN rather than applied to the returned rows, so an
   * incremental poll costs one page instead of the store's whole history.
   */
  async runRead(name: string, params: Record<string, unknown>): Promise<unknown[]> {
    const query = getReadQuery(name);
    assertDatasetsServed(this.provider, this.servesDatasets, name, query.dependsOnTables);
    const dataset = query.dependsOnTables[0];
    const op = `runRead:${name}`;
    const since = canonicalInstant(params.since);

    // The plan gate, enforced where it bites. A `customer` read on a store
    // without protected-data access must never return rows: the rows exist and
    // parse, and every name on them is blank, which reads as a customer list
    // this business does not have.
    if (dataset === "customer" && this.probe.state === "denied") {
      throw new ShopifyProtectedDataDeniedError(this.probe.shape, this.probe.detail);
    }

    const records = await this.enumerate(op, dataset, since);
    if (dataset === "customer" && detectProtectedDataRedaction(records)) {
      // Caught on the READ as well as on the probe: a store that downgrades
      // from Grow to Basic keeps working and simply starts blanking fields, and
      // the connect-time probe may be hours old by then.
      const denial = new ShopifyProtectedDataDeniedError(
        "silent_redaction",
        `every ${SHOPIFY_PROTECTED_CUSTOMER_FIELDS.join(", ")} field came back empty`,
      );
      this.probe = {
        state: "denied",
        shape: "silent_redaction",
        detail: denial.detail,
        remediation: SHOPIFY_GROW_PLAN_REMEDIATION,
        probedAt: this.now(),
      };
      throw denial;
    }

    const rows = records.map((record) =>
      projectCanonicalRow(dataset, shopifyLookup(dataset, record)),
    );

    switch (name) {
      case "get_recent_orders": {
        // `WHERE created_at >= ? AND created_at < ?`, applied to the MAPPED
        // rows: the vendor filter above is on `updated_at` (the sync position),
        // and this query's window is on `created_at` (when the order was
        // placed). Conflating them would answer "what did we sell in August"
        // with orders placed in July and refunded in August.
        const windowed = ShopifyConnector.inWindow(rows, "created_at", params.from, params.to);
        // `ORDER BY created_at DESC, order_id`.
        const byId = sortByKey(windowed, "order_id");
        return [...byId].sort((a, b) =>
          String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")),
        );
      }

      case "get_low_stock_products": {
        const threshold = Number(params.threshold);
        const matched = Number.isFinite(threshold)
          ? rows.filter((r) => typeof r.inventory_quantity === "number" && r.inventory_quantity <= threshold)
          : rows;
        // `ORDER BY inventory_quantity, product_id`.
        const byId = sortByKey(matched, "product_id");
        return [...byId].sort(
          (a, b) => Number(a.inventory_quantity ?? 0) - Number(b.inventory_quantity ?? 0),
        );
      }

      case "find_customer": {
        const prefix = ShopifyConnector.lowerText(params.query);
        const matched =
          prefix === undefined
            ? rows
            : rows.filter((r) => ShopifyConnector.lowerText(r.last_name)?.startsWith(prefix));
        // `ORDER BY last_name, first_name`.
        return sortByKey(sortByKey(matched, "first_name"), "last_name");
      }

      default:
        // Unreachable while every served read is handled above; a new registry
        // entry on a served dataset lands here rather than silently returning
        // nothing, which would read as "this store sold nothing".
        throw this.blocked(op, "read is not served by the Shopify track");
    }
  }

  /**
   * The id set of one dataset — the cheap listing WARP-2503's reconciliation
   * sweep needs, and NOTHING else (WARP-2344).
   *
   * ## Why this exists here and the sweep does not
   *
   * Shopify does not publish deletions. There is no `deleted_at`, no tombstone
   * collection, and no "changed since" feed that includes removals — an order
   * cancelled and deleted, or a product removed from the catalogue, simply
   * stops appearing. An incremental read keyed on `updated_at` can therefore
   * NEVER see a delete: the row it would have to notice is the one that is not
   * there.
   *
   * The only mechanism that can is an ID-SET DIFF — enumerate the vendor's
   * current ids, compare against the ids the box holds, and treat the
   * difference as gone. That machinery is identity-set drift, it is shared
   * across every track, and it belongs to WARP-2503. **This connector does not
   * implement it**, deliberately: a per-vendor sweep is how two tracks end up
   * with two different definitions of "missing".
   *
   * What the sweep needs from a connector is exactly one thing, and this is it:
   * a listing that is cheap enough to run over the WHOLE dataset on a schedule.
   * Cheap here means one field per node — Shopify's cost model charges per
   * field, so an id-only query is roughly an order of magnitude cheaper than
   * the read above, which is the difference between a nightly sweep that fits
   * in the bucket and one that throttles.
   *
   * The contract, so the sweep can rely on it:
   *
   *   • returns EVERY id of the dataset the app may see, not a delta — a diff
   *     against a partial list would report live rows as deleted;
   *   • ids are the same GLOBAL IDs `runRead` puts in the id column, so the two
   *     sets are comparable without translation;
   *   • it THROWS on a scope gap or a protected-data denial, and never returns
   *     a short list — an id-set diff over a truncated list deletes real rows,
   *     which is the one failure in this area that destroys data;
   *   • for `order` on a store without {@link SHOPIFY_ORDER_HISTORY_SCOPE} it
   *     is bounded by the 60-day wall like every other order read, so a sweep
   *     MUST NOT treat an absent older order as deleted. That is stated here
   *     because it is the trap: the wall makes the list legitimately
   *     incomplete, and the sweep is the only place that can know it.
   */
  async listEntityIds(dataset: DatasetName): Promise<string[]> {
    assertDatasetsServed(this.provider, this.servesDatasets, `listEntityIds:${dataset}`, [dataset]);
    this.assertScopeFor(dataset);
    if (dataset === "customer" && this.probe.state === "denied") {
      throw new ShopifyProtectedDataDeniedError(this.probe.shape, this.probe.detail);
    }
    const field = CONNECTION_FIELD[dataset];
    const op = `listEntityIds:${dataset}`;
    const filter = this.deltaFilter(dataset, undefined);
    const ids: string[] = [];
    let cursor: string | undefined;
    for (let page = 1; page <= SHOPIFY_MAX_PAGES; page += 1) {
      const document = `
        query DropletIds($first: Int!, $after: String, $query: String) {
          ${field}(first: $first, after: $after, query: $query, sortKey: ${SORT_KEY[dataset]}) {
            nodes { id }
            pageInfo { hasNextPage endCursor }
          }
        }
      `;
      const data = await this.graphql(op, document, {
        first: SHOPIFY_MAX_PAGE_SIZE,
        after: cursor ?? null,
        query: filter ?? null,
      });
      const connection = data[field] as Record<string, unknown> | undefined;
      const nodes = connection?.nodes;
      if (!Array.isArray(nodes)) throw this.blocked(op, `Shopify returned no "${field}" nodes`);
      for (const node of nodes as Record<string, unknown>[]) {
        if (typeof node.id === "string") ids.push(node.id);
      }
      const info = connection?.pageInfo as Record<string, unknown> | undefined;
      if (info?.hasNextPage !== true || typeof info.endCursor !== "string") return ids;
      cursor = info.endCursor;
    }
    throw new ConnectorBlockedError(
      `${op} stopped after ${SHOPIFY_MAX_PAGES} pages`,
      "the connection kept reporting another page; aborting rather than paging forever.",
    );
  }

  /**
   * Start a bulk export of one dataset and poll it to completion.
   *
   * Shopify's answer to a FULL sync: `bulkOperationRunQuery` runs the query
   * server-side with no pagination and no cost ceiling, and writes JSONL to a
   * signed URL. It is the right mechanism for a first backfill of a store with
   * a hundred thousand orders, where cursor paging would spend hours inside the
   * cost bucket.
   *
   * **The result is a REFERENCE, not rows**, and that is a deliberate boundary
   * rather than an unfinished feature — see {@link ShopifyBulkExportRef}. The
   * JSONL lives on object storage, a host `docs/security/allowed-egress.yaml`
   * does not register, and dialing an unregistered host from a connector is
   * exactly what that registry exists to prevent. The HubSpot track draws the
   * same line for the same reason.
   *
   * Polling, not a webhook: Shopify's own recommendation is the
   * `bulk_operations/finish` topic, which needs a publicly reachable HTTPS
   * endpoint. ADR-041 §1 says the box will never have one, so this is a
   * constraint rather than a preference.
   */
  async runBulkExport(
    dataset: DatasetName,
    options: { pollIntervalMs?: number; maxPolls?: number } = {},
  ): Promise<ShopifyBulkExportRef> {
    assertDatasetsServed(this.provider, this.servesDatasets, `runBulkExport:${dataset}`, [dataset]);
    this.assertScopeFor(dataset);
    const op = `runBulkExport:${dataset}`;
    const field = CONNECTION_FIELD[dataset];
    const filter = this.deltaFilter(dataset, undefined);
    // No `first:` and no cursor — a bulk query must carry neither, and one that
    // does is rejected by Shopify rather than silently paginated.
    const inner = `{ ${field}${filter ? `(query: "${filter.replace(/"/g, '\\"')}")` : ""} { edges { node { ${NODE_SELECTION[dataset]} } } } }`;
    const start = await this.graphql(
      op,
      `mutation DropletBulkExport($query: String!) {
        bulkOperationRunQuery(query: $query) {
          bulkOperation { id status }
          userErrors { field message }
        }
      }`,
      { query: inner },
    );
    const result = start.bulkOperationRunQuery as Record<string, unknown> | undefined;
    const userErrors = Array.isArray(result?.userErrors) ? result.userErrors : [];
    if (userErrors.length > 0) {
      throw new ShopifyBulkOperationError("REJECTED", JSON.stringify(userErrors));
    }
    const started = result?.bulkOperation as Record<string, unknown> | undefined;
    if (!started || typeof started.id !== "string") {
      throw new ShopifyBulkOperationError("REJECTED", "Shopify returned no bulk operation");
    }

    const interval = options.pollIntervalMs ?? 2_000;
    const maxPolls = options.maxPolls ?? 150;
    for (let poll = 0; poll < maxPolls; poll += 1) {
      const data = await this.graphql(
        op,
        `query DropletBulkStatus { currentBulkOperation { id status objectCount url errorCode } }`,
      );
      const current = data.currentBulkOperation as Record<string, unknown> | null;
      const status = typeof current?.status === "string" ? current.status : "UNKNOWN";
      if (status === "COMPLETED") {
        return {
          id: String(current?.id ?? started.id),
          status,
          objectCount:
            current?.objectCount === undefined || current?.objectCount === null
              ? null
              : Number(current.objectCount),
          // Passed through VERBATIM and never fetched. See the type's docstring.
          url: typeof current?.url === "string" ? current.url : null,
        };
      }
      if (status === "FAILED" || status === "CANCELED" || status === "EXPIRED") {
        throw new ShopifyBulkOperationError(status, String(current?.errorCode ?? "no errorCode"));
      }
      await this.sleep(interval);
    }
    throw new ShopifyBulkOperationError(
      "TIMED_OUT",
      `still running after ${maxPolls} polls — reported rather than returned as an empty export`,
    );
  }

  async applyWrite(name: string, _params: Record<string, unknown>): Promise<unknown> {
    // Same validation order as every other track, so a caller bug produces the
    // same typed error here as anywhere else...
    const cmd = getWriteCommand(name);
    assertTargetAllowed(cmd.targetTable);
    // ...and then this track refuses. Cancelling an order, issuing a refund and
    // editing a product are all externally visible to a merchant's customers
    // and most of them are irreversible. None is a later ticket — they are
    // absent by design, and `assertReadOnlyShopifyDocument` fails the build if
    // a mutation surface appears.
    throw this.blocked(
      `applyWrite:${name}`,
      "the Shopify track is read-only — no order, fulfilment, refund or product mutation " +
        "surface exists in this connector at any tier",
    );
  }

  // ── State ─────────────────────────────────────────────────────────────────

  /** A vendor value as lowercased text, or undefined when absent/empty. */
  private static lowerText(value: unknown): string | undefined {
    if (typeof value === "string") {
      const raw = value.trim().toLowerCase();
      return raw === "" ? undefined : raw;
    }
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return undefined;
  }

  /** Half-open `[from, to)` on an ISO column, skipping either bound the caller
   *  omitted. A row with no value in the column is not in a bounded window. */
  private static inWindow(
    rows: readonly CanonicalRow[],
    column: string,
    from: unknown,
    to: unknown,
  ): CanonicalRow[] {
    const lo = canonicalInstant(from);
    const hi = canonicalInstant(to);
    if (lo === undefined && hi === undefined) return [...rows];
    return rows.filter((r) => {
      const v = r[column];
      if (typeof v !== "string") return false;
      if (lo !== undefined && v < lo) return false;
      if (hi !== undefined && v >= hi) return false;
      return true;
    });
  }

  /**
   * The connection's state, explicitly.
   *
   * Order matters: an unusable credential outranks a plan limit, because
   * pasting new credentials is the only action that helps and upgrading a plan
   * would not.
   */
  private state(): ShopifyConnectionState {
    if (!this.credentialsResolved) return "disconnected";
    if (this.token === null && this.grantedScopes.length === 0) return "needs_reconnect";
    if (this.probe.state === "denied") return "capability_limited";
    return "connected";
  }

  async status(): Promise<ShopifyStatus> {
    const state = this.state();
    return {
      state,
      // One source of truth: `ok` is derived from `state`. `capability_limited`
      // is OK — the connection works, it just cannot see one dataset. Reporting
      // it as not-ok would be the "renders as broken" failure in the other
      // direction from a silent blank.
      ok: state === "connected" || state === "capability_limited",
      // Report THAT credentials exist, never the client id, the secret, or the
      // minted access token. Nothing in this object can carry credential
      // material (rule 19).
      hasCredentials: this.credentialsResolved,
      shopDomain: this.shopDomain,
      apiVersion: SHOPIFY_API_VERSION,
      grantedScopes: this.grantedScopes,
      protectedCustomerData: this.probe,
      orderHistory: {
        allOrders: this.grantedScopes.includes(SHOPIFY_ORDER_HISTORY_SCOPE),
        windowDays: SHOPIFY_ORDER_HISTORY_WALL_DAYS,
      },
      requestTimeoutMs: this.timeoutMs,
    };
  }

  /** The connection row's id. Identity only — nothing is persisted here. */
  get connectionId(): string {
    return this.config.connectionId;
  }

  /** The last computed schema fingerprint, or null before `introspect()`. */
  get schemaFingerprint(): string | null {
    return this.fingerprint;
  }
}
