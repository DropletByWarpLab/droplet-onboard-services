/**
 * `PipedriveConnector`: the sales-pipeline track.
 *
 * Reads a small business's Pipedrive account — who the contacts are (persons),
 * which companies they belong to (organizations), every deal with its stage,
 * value and status, the activity log of calls, meetings and tasks against
 * them, and the product catalog those deals are priced from — over the
 * **API v2** surface, on a personal API token the owner mints in their own
 * Pipedrive settings. Same {@link Connector} interface, same blocked-error
 * contract, same read-through posture as every other cloud track, so nothing
 * upstream of it changes.
 *
 * ## What makes this track different: the host is PER ACCOUNT
 *
 * This is the single most important fact in this file, and it inverts where
 * the security burden sits. It is the Mailchimp situation exactly
 * (`../mailchimp/connector.ts`), reached by a different route.
 *
 * Pipedrive's documented base is `{COMPANYDOMAIN}` +
 * {@link PIPEDRIVE_API_HOST_SUFFIX} + {@link PIPEDRIVE_API_BASE_PATH}, where
 * the company domain is the customer's own subdomain. Pipedrive's stated
 * reason is data-centre routing — it advises the company-domain form because
 * it "helps us to better determine which data center your request should go
 * to". There is therefore NO single hostname to write down and no whole-string
 * URL literal this file could carry.
 *
 * `scripts/check-egress-allowlist.py` is a static text scanner over tracked
 * source, and its `load_allowlist()` treats a `kind: dynamic` entry as
 * contributing **zero** host patterns. The consequences are exact and worth
 * stating so nobody "tidies" this later:
 *
 *   1. The `allowed-egress.yaml` entry for this connector must be
 *      `kind: dynamic` with `config_key: companyDomain`. It is DOCUMENTATION
 *      AND REVIEW, not enforcement. Filing it as `kind: egress` over a sampled
 *      tenant — or over `api.pipedrive.com`, which Pipedrive does still
 *      document as a bootstrap host — would be worse than useless: a green
 *      `egress-gate` over a destination that is genuinely per-customer. A gate
 *      that lies is more dangerous than no gate.
 *   2. **Nothing in CI verifies where this connector dials.**
 *      {@link assertSafePipedriveBaseUrl} is not defence in depth; it is the
 *      ENTIRE control. That is why its tests assert on the injected `fetch`
 *      having ZERO calls rather than on a returned value — a test that inspects
 *      the outcome still passes when the request already went out carrying the
 *      customer's token.
 *   3. This file must contain no `https://…pipedrive.com` scheme-URL literal.
 *      One would be extracted by the scanner as an unregistered host and fail
 *      the gate, because the `dynamic` entry registers no hosts. The invariant
 *      SUFFIX is kept as a bare whole-string literal instead (bare hostnames
 *      are only scanned in config files, never in `.ts`), which is the most the
 *      scanner can ever be given here. `pipedrive.test.ts` pins that literal,
 *      and pins the ABSENCE of a scheme literal across this whole directory, so
 *      a refactor into string concatenation cannot pass review unnoticed.
 *
 * ### On `api.pipedrive.com`, precisely
 *
 * It is NOT a myth and it is NOT absent from Pipedrive's documentation: the
 * "how to get the company domain" page uses `api.pipedrive.com` for exactly one
 * thing — bootstrapping the domain you do not yet know, via `GET /users/me`.
 * This connector deliberately never dials it, for a reason that is about
 * sequencing rather than about the host being wrong: the connect flow collects
 * `companyDomain` from the owner BEFORE any call, so the connector always has a
 * domain in hand by the time it dials, and can make the same call against the
 * customer's own host. One guarded destination, no second registration, and the
 * returned `company_domain` still catches a mistyped or stale value
 * ({@link PipedriveConnector.verifyCompanyDomain}).
 *
 * ## API v2 — with ONE carve-out, and the carve-out is not a fallback
 *
 * Pipedrive's v1 endpoints for Activities, Deals, Persons, Organizations,
 * Products, Pipelines, Stages and itemSearch went OUT OF SUPPORT on
 * 2026-08-01. Every one of the five DATASET paths in this connector is
 * therefore `/api/v2/...` and a v1 dataset fallback would be a build-time bug,
 * not a safety net. Note the prefix rule too: v2 accepts only `/api/v2/...`,
 * where v1 tolerated both `/api/v1/...` and `/v1/...`.
 *
 * **`GET /users/me` is the carve-out and has no v2 form.** Users was never in
 * the deprecated set, and `/api/v2/users/me` does not exist — a connector that
 * applied the v2-only rule absolutely would 404 on every connect attempt. So
 * {@link PIPEDRIVE_USERS_ME_PATH} is `/api/v1/users/me`, it is the ONLY v1 path
 * {@link assertReadablePipedrivePath} admits, and it is correct rather than
 * legacy. (Dating note for a later reader: the v1 out-of-support date rests on
 * Pipedrive's devcommunity reminder, "Effective from: Aug 1st, 2026". The
 * original changelog page still reads December 31, 2025. The August date is the
 * live one; do not "correct" it back to the stale changelog.)
 *
 * ## The ADR-041 conditions, as they land here
 *
 *   1. **Only ever dials out.** The box accepts no inbound connections, so
 *      Pipedrive webhooks are structurally unavailable and polling is the only
 *      ingestion path. A constraint, not a preference — and it is the direct
 *      cause of the deletion gap below.
 *   2. **Ships off; owner consent is the enabling event.** With no token
 *      resolved every I/O method blocks honestly rather than half-authenticating.
 *   3. **Every destination registered.** See above — `kind: dynamic`, and the
 *      code-side guard is the enforcement.
 *   4. **Persistence: none.** ADR-041 §4 warns that the encryption
 *      `ErpEntityCache` promises is NOT implemented (WARP-2028). This track is
 *      read-through and writes nothing. Delta watermarks are RETURNED to the
 *      caller, never persisted here.
 *   5. **The token is an account-level standing credential** with no expiry.
 *      Never logged, never in a tracked file, never echoed back in an error,
 *      never in `status()`, and never in a URL — see below.
 *
 * ## The token is the WHOLE ACCOUNT, and it goes in a header, never a query
 *
 * There is no read-only Pipedrive API token — nothing analogous to a Stripe
 * `rk_` restricted key. Pipedrive's own help text says the key "grants access
 * to your account". Whoever holds it can create, update, delete, merge and
 * export at the owning user's permission level. The only mitigation is
 * organisational (mint it from a dedicated user in a restricted permission
 * set), and that mitigation is PLAN-GATED — custom permission sets are a
 * higher-tier feature, so a customer on an entry plan cannot scope the token at
 * all. `docs/integrations/pipedrive.md` says this plainly rather than as a
 * formality.
 *
 * Two consequences in code:
 *
 *   - The token travels in the {@link PIPEDRIVE_AUTH_HEADER} header ONLY. The
 *     legacy `?api_token=` query parameter is v1-only, and a credential in a
 *     query string is a credential in every proxy log and every browser
 *     history between here and there. {@link PipedriveConnector.request}
 *     cannot express it, and the tests assert no request URL ever contains the
 *     token.
 *   - No error class in this file carries the token, the offered credential, or
 *     a URL built from one. See {@link PipedriveApiError}: it reports the
 *     vendor's error CODE and the HTTP status, never the vendor's message,
 *     because Pipedrive's `error` / `error_info` strings quote request state
 *     back at you and request state is customer data.
 *
 * ## Rate limits: TWO ceilings, and this connector can express one
 *
 * (a) **Burst, per 2 seconds, on API-token auth:** Lite 20, Growth 40,
 * Premium 100, Ultimate 120. {@link PIPEDRIVE_BURST_LIMIT} encodes the LITE
 * FLOOR deliberately — the connector cannot see the customer's plan or seat
 * count, so the conservative ceiling is the only honest default. An operator on
 * a higher plan raises it with {@link PipedriveConnectorConfig.burstCeiling}
 * rather than being throttled to the floor forever.
 *
 * (b) **A daily token budget** — 30,000 base tokens × plan multiplier × seats,
 * resetting at midnight in the SERVER's timezone — shared with every other
 * integration the customer runs against the same account. `ProviderRateLimit`
 * can express one ceiling and this connector models the burst; the daily budget
 * is real, is the one that actually bites a nightly full scan on a single-seat
 * entry-plan account, and needs accounting ABOVE this connector. It is recorded
 * in {@link PIPEDRIVE_DAILY_BUDGET_NOTE} so it cannot be rediscovered the hard
 * way.
 *
 * Search endpoints carry their own, lower ceiling (10 requests / 2 s on every
 * plan). This connector dials no search endpoint at all — the segment is
 * refused by shape in {@link assertReadablePipedrivePath} — so it needs no
 * second budget, and adding a search path is a deliberate, reviewed change
 * rather than something a new request path can do incidentally.
 *
 * ## The delta is complete for EDITS and blind to DELETIONS
 *
 * `updated_since` is documented character-for-character identically on all five
 * v2 endpoints, and the boundary is INCLUSIVE — "later than or equal to". A
 * naive watermark therefore re-reads the boundary row every tick, so
 * {@link PipedrivePage} returns the ids AT the watermark instant alongside it
 * and the caller skips them by id. Adding a millisecond instead would silently
 * skip any row written inside that millisecond.
 *
 * Three ways the watermark is structurally incomplete, all declared rather than
 * discovered:
 *
 *   1. **Deletions, on ALL FIVE datasets.** `deleted` and `merged` exist solely
 *      as webhook event actions, and webhooks need a publicly reachable URL with
 *      a non-self-signed certificate, which a box with no inbound path cannot
 *      provide. Pipedrive does keep a deleted DEAL readable for 30 days behind
 *      `?status=deleted` — but that is a fact about the VENDOR and not a
 *      capability of this connector: `status` is deliberately absent from
 *      {@link PIPEDRIVE_SENDABLE_QUERY_PARAMS}, so this track cannot express the
 *      query and recovers no deleted row on any dataset, deals included. See
 *      {@link PIPEDRIVE_DELETION_VISIBILITY} and
 *      {@link PIPEDRIVE_DELETED_DEAL_WINDOW_NOTE}.
 *   2. **Merges.** Merging two organizations leaves the loser unreachable by
 *      the same route as a delete.
 *   3. **Scope.** `update_time` is the entity's OWN timestamp — logging an
 *      activity against a deal does not bump that deal's `update_time`. Each
 *      dataset therefore needs its own independent watermark, which is why
 *      every list method here returns its own.
 *
 * A read-through connector is largely immune; the moment anything caches, it
 * drifts. The gap is DECLARED so a scheduler cannot infer completeness from a
 * green incremental run.
 *
 * ## The silent-parameter hazard, which is why two guards run before the wire
 *
 * Pipedrive ignores an unknown query parameter. An invented `modified_since`,
 * or a `type=call` filter on activities (which is a request-BODY field on
 * POST/PATCH and NOT a v2 query parameter), returns HTTP 200 and the WHOLE
 * collection — a full scan reported as a filtered delta, with no error anywhere
 * to notice. {@link assertPipedriveSendableParams} and
 * {@link assertPipedriveActivityParams} turn both into loud failures at the
 * moment the parameter is added, and the tests assert on the outgoing REQUEST
 * rather than on the rows that came back.
 *
 * ## What the vocabulary cannot hold, stated as data
 *
 * Pipedrive is not the vendor three of these canonical shapes were designed
 * for, and three canonical columns have no Pipedrive source at all — a catalog
 * product has no inventory concept, an organization has no web-domain field, a
 * person has no lifecycle stage. Those are named in
 * {@link PIPEDRIVE_UNRECONCILED_COLUMNS} and asserted against the mappers, so
 * "this column is always empty on this track" is a declared property a reader
 * can check rather than an absence they have to notice. The sharpest
 * consequence is that `get_low_stock_products` cannot be answered at all here,
 * and is REFUSED rather than answered with a confident, wrong "nothing is low"
 * — see {@link PipedriveColumnNotAvailableError}.
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
// IMPORTED, not re-typed — the same one-way dependency the Shopify track takes
// on it. A second regex-metacharacter escaper is a second thing to get subtly
// wrong, and this one already carries the CodeQL "incomplete string escaping"
// fix from the WARP-2379 review.
import { escapeRegExpLiteral } from "../mailchimp/connector.js";

/** Provider key for this track. */
export const PIPEDRIVE_PROVIDER = "pipedrive";

/**
 * The invariant tail of every Pipedrive API host.
 *
 * A WHOLE-STRING LITERAL on purpose, and deliberately NOT a scheme URL. The
 * company-domain label in front of it is per-customer and unknowable at build
 * time, so this is the most the static egress scanner can ever be given for
 * this vendor. Do not "clean this up" into a template, a join, or a config
 * read — and do not add a scheme-URL example (`https://` + a tenant host) anywhere
 * in this directory: the `kind: dynamic` allowlist entry registers no hosts, so
 * the scanner would read one as an unregistered destination and fail
 * `egress-gate`. Examples belong in the tests, which the scanner excludes by
 * construction.
 */
export const PIPEDRIVE_API_HOST_SUFFIX = ".pipedrive.com";

/**
 * The pinned dataset API surface. Whole-string literal, same reasoning.
 *
 * v2 accepts ONLY this prefix — v1 tolerated both `/api/v1/...` and `/v1/...`,
 * and that leniency is gone.
 */
export const PIPEDRIVE_API_BASE_PATH = "/api/v2";

/**
 * The one v1 path this connector may dial, and the reason it is not a fallback.
 *
 * `GET /users/me` has no v2 equivalent and Users was never in the deprecated
 * set, so this is the supported, current path for the call. It exists here for
 * exactly two jobs: proving at connect time that the token and the company
 * domain agree with each other, and re-deriving the domain after repeated auth
 * failures — the company domain is customer-mutable from Pipedrive's own
 * account settings and nothing notifies an integration when it changes.
 */
export const PIPEDRIVE_USERS_ME_PATH = "/api/v1/users/me";

/**
 * The header the token travels in, exactly.
 *
 * API v2 requires it. The legacy `?api_token=` query parameter is v1-only and
 * is not merely deprecated here but refused by construction: a credential in a
 * query string ends up in proxy logs, referrer headers and browser history.
 */
export const PIPEDRIVE_AUTH_HEADER = "x-api-token";

/** Headers every request carries besides the credential. Constant, so a test
 *  can assert the exact set rather than a sample of it. */
export const PIPEDRIVE_CONSTANT_HEADERS: Readonly<Record<string, string>> = {
  Accept: "application/json",
};

/**
 * The shape a Pipedrive company domain may take.
 *
 * ONE DNS label, anchored: 1–63 characters, lowercase alphanumerics and inner
 * hyphens, never leading or trailing. This is the security-critical half of the
 * credential — whatever lands here becomes the leftmost label of a hostname, so
 * a value carrying a dot, a slash or a colon would make the "host" someone
 * else's domain entirely. Identical to the label
 * {@link PIPEDRIVE_ALLOWED_HOST_PATTERN} accepts, and that identity is
 * load-bearing: if intake accepted a domain the host guard would not, a valid
 * customer would be stored and then refused on every read; if it accepted one
 * LOOSER, a crafted value could smuggle a hostname.
 */
export const PIPEDRIVE_COMPANY_DOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The ONLY host shape this connector will ever send a token to.
 *
 * One DNS label followed by the invariant suffix, ANCHORED AT BOTH ENDS. The
 * anchoring is the whole point: an unanchored check or an `endsWith` accepts
 * `acme.pipedrive.com.evil.test`, which is the attack this guard exists to
 * stop.
 *
 * Built from {@link PIPEDRIVE_API_HOST_SUFFIX} through
 * {@link escapeRegExpLiteral} rather than re-typed, so the literal and the
 * guard cannot drift apart and the suffix is matched as TEXT rather than as a
 * pattern.
 */
export const PIPEDRIVE_ALLOWED_HOST_PATTERN = new RegExp(
  `^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?${escapeRegExpLiteral(PIPEDRIVE_API_HOST_SUFFIX)}$`,
);

/**
 * The character floor a token must clear before it is put in a header.
 *
 * Printable ASCII, no whitespace, no control characters, bounded length. This
 * is deliberately NOT a claimed vendor format: Pipedrive publishes no token
 * shape, so pinning a length or an alphabet would be inventing a fact and would
 * risk refusing a real customer's real token for no security gain.
 *
 * What it IS is a header-safety property. A value carrying a newline or a
 * carriage return is a header-injection primitive, and a value carrying a space
 * produces a malformed header that fails in a way nobody can read. Refusing
 * those is defensible without knowing anything about Pipedrive.
 */
export const PIPEDRIVE_TOKEN_PATTERN = /^[\x21-\x7e]{8,512}$/;

/** The datasets this track serves. Typed `readonly DatasetName[]` and NOT cast
 *  — each name is a member of the closed union in `../export-drop/profiles.ts`,
 *  and every one of the five already existed there. */
export const PIPEDRIVE_DATASETS: readonly DatasetName[] = [
  "contact",
  "company",
  "deal",
  "engagement",
  "product",
];

/**
 * Which v2 collection each canonical dataset reads from.
 *
 * All five are `/api/v2/...`. The vendor's own nouns differ from the canonical
 * ones — a Pipedrive "person" is a `contact`, an "organization" is a `company`,
 * an "activity" is an `engagement` — and this table is the single place that
 * translation lives.
 */
export const PIPEDRIVE_DATASET_ENDPOINTS: Readonly<Record<string, string>> = {
  contact: `${PIPEDRIVE_API_BASE_PATH}/persons`,
  company: `${PIPEDRIVE_API_BASE_PATH}/organizations`,
  deal: `${PIPEDRIVE_API_BASE_PATH}/deals`,
  engagement: `${PIPEDRIVE_API_BASE_PATH}/activities`,
  product: `${PIPEDRIVE_API_BASE_PATH}/products`,
};

/**
 * The delta parameter, verified character-by-character on all five v2
 * endpoints with identical wording: "If set, only <entity> with an
 * `update_time` later than or equal to this time are returned. In RFC3339
 * format, e.g. 2025-01-01T10:20:00Z."
 *
 * ONE constant rather than five copies, because five copies is five chances for
 * one of them to be misspelled — and a misspelled delta parameter does not
 * fail. Pipedrive ignores it and returns everything, so the connector runs a
 * full scan while reporting an incremental read. The tests pin this literal AND
 * assert the outgoing URL of every dataset carries it, which is the half that
 * catches a mapper that simply forgot to pass it.
 */
export const PIPEDRIVE_DELTA_PARAM = "updated_since";

/** The companion upper bound. Present on deals, persons, organizations and
 *  activities; ABSENT on products — see
 *  {@link PIPEDRIVE_DATASETS_WITHOUT_UPPER_BOUND}. */
export const PIPEDRIVE_WINDOW_END_PARAM = "updated_until";

/**
 * The datasets for which a bounded backfill window CANNOT be expressed.
 *
 * `/api/v2/products` documents `updated_since` and no `updated_until`. That is
 * a hard build constraint rather than a footnote: a windowed backfill that
 * silently degrades to open-ended on this one dataset is exactly the scan that
 * exhausts a single-seat entry-plan account's whole daily token budget — and
 * that budget is shared with every other integration the customer runs.
 * {@link assertPipedriveWindow} refuses the parameter here rather than letting
 * Pipedrive ignore it.
 */
export const PIPEDRIVE_DATASETS_WITHOUT_UPPER_BOUND: ReadonlySet<string> = new Set(["product"]);

/**
 * The complete set of query parameters this connector may ever send on a
 * dataset request.
 *
 * An ALLOWLIST checked at request time, not a denylist in source: request query
 * strings are assembled at runtime, so a denylist only ever catches the
 * literals someone happened to type. The failure this closes is silent —
 * Pipedrive ignores an unknown parameter and returns HTTP 200 with the whole
 * collection — so an invented `modified_since` would produce a full scan
 * mislabelled as a delta with no error anywhere.
 */
export const PIPEDRIVE_SENDABLE_QUERY_PARAMS: ReadonlySet<string> = new Set([
  PIPEDRIVE_DELTA_PARAM,
  PIPEDRIVE_WINDOW_END_PARAM,
  "sort_by",
  "sort_direction",
  "limit",
  "cursor",
  "include_fields",
]);

/**
 * The COMPLETE documented v2 query-parameter set for `GET /api/v2/activities`.
 *
 * Recorded in full because of what is NOT in it: `type`. Activity type is a
 * request-BODY field on POST/PATCH and has never been a v2 query parameter, so
 * `?type=call` is not an error — it is ignored, and the connector receives the
 * entire activity stream while believing it asked for calls. That is the
 * highest-damage failure class this vendor offers, which is why this set is
 * enforced by {@link assertPipedriveActivityParams} at request time rather than
 * merely asserted in a test. Filter activity type on the RESPONSE `type` field
 * (which does exist), or server-side through a pre-built `filter_id`.
 */
export const PIPEDRIVE_ACTIVITY_QUERY_PARAMS: ReadonlySet<string> = new Set([
  "filter_id",
  "ids",
  "owner_id",
  "deal_id",
  "lead_id",
  "person_id",
  "org_id",
  "done",
  PIPEDRIVE_DELTA_PARAM,
  PIPEDRIVE_WINDOW_END_PARAM,
  "sort_by",
  "sort_direction",
  "include_fields",
  "limit",
  "cursor",
]);

/** The sort every walk uses, so the watermark advances monotonically across
 *  pages rather than jumping around inside the result set. `update_time` is an
 *  accepted `sort_by` value on all five endpoints. */
export const PIPEDRIVE_SORT_FIELD = "update_time";
/** Ascending, for the same reason: a descending walk cannot produce a watermark
 *  that is safe to persist before the last page has been read. */
export const PIPEDRIVE_SORT_DIRECTION = "asc";

/** Pipedrive's `limit` ceiling on the v2 cursor endpoints. Default is 100. */
export const PIPEDRIVE_MAX_PAGE_SIZE = 500;
/** The vendor's own default, used when a caller names no page size. */
export const PIPEDRIVE_DEFAULT_PAGE_SIZE = 100;

/** Hard ceiling on pages one read may fetch, so a collection that never reports
 *  a null cursor cannot spin forever. No loop in this file is unbounded. */
export const PIPEDRIVE_MAX_PAGES = 1000;

/**
 * The burst ceiling, encoded at the PLAN FLOOR.
 *
 * API-token auth: Lite 20, Growth 40, Premium 100, Ultimate 120, all per 2
 * seconds. The connector cannot see the plan or the seat count, so 20 is the
 * only honest default; an operator who knows better raises it through
 * {@link PipedriveConnectorConfig.burstCeiling}.
 */
export const PIPEDRIVE_BURST_LIMIT = 20;

/** The burst window. Whether Pipedrive's own window is fixed or sliding is NOT
 *  verified, so {@link PipedriveBurstGovernor} implements a SLIDING window —
 *  which never exceeds the ceiling under either model, where a fixed-window
 *  implementation can emit 2× the ceiling across a boundary. */
export const PIPEDRIVE_BURST_WINDOW_MS = 2000;

/** The second ceiling, which this connector cannot enforce and must not
 *  pretend to. Recorded so it is not rediscovered by exhausting a customer's
 *  day of API allowance. */
export const PIPEDRIVE_DAILY_BUDGET_NOTE =
  "Pipedrive also enforces a DAILY token budget — 30,000 base tokens x plan multiplier x " +
  "seats, resetting at midnight in the SERVER's timezone, shared with every other " +
  "integration the customer runs against the same account. This connector models the " +
  "2-second burst only; the daily budget needs accounting above this connector, and a " +
  "nightly full scan of five datasets must be costed against it first.";

/** Pipedrive's documented 429 headers. No `Retry-After` is documented, so
 *  `x-ratelimit-reset` is the authority. */
export const PIPEDRIVE_RATE_LIMIT_RESET_HEADER = "x-ratelimit-reset";

/** Longest this connector will wait on a vendor-supplied reset hint. A
 *  malformed or epoch-shaped value must not wedge a worker for years. */
export const PIPEDRIVE_MAX_BACKOFF_MS = 60_000;

/** How many times one request is retried after a 429 before it is reported. */
export const PIPEDRIVE_MAX_RATE_LIMIT_RETRIES = 3;

/** Our request deadline. Pipedrive documents no server-side timeout, so this is
 *  ours alone and is enforced with both an AbortSignal and a race — see
 *  {@link PipedriveConnector.withTimeout}. */
export const PIPEDRIVE_REQUEST_TIMEOUT_MS = 60_000;

/**
 * The complete set of API resources this connector may ever dial.
 *
 * An ALLOWLIST checked at request time by
 * {@link assertReadablePipedrivePath}, never a denylist of forbidden words in
 * source — request paths are assembled at runtime, so a denylist only catches
 * the literals someone happened to type.
 *
 * Everything Pipedrive mutates is a POST, PUT, PATCH or DELETE on these same
 * nouns, and this connector issues GET exclusively, so read-only here is a
 * property of the method as well as of the path.
 */
export const PIPEDRIVE_READABLE_RESOURCES: ReadonlySet<string> = new Set([
  "persons",
  "organizations",
  "deals",
  "activities",
  "products",
  "users",
]);

/**
 * A path segment this connector refuses by shape.
 *
 * Pipedrive's search endpoints (`/persons/search`, `/deals/search`, and the
 * account-wide item search) are capped at 10 requests / 2 s on EVERY plan and
 * both auth methods — a different, lower budget than the one
 * {@link PipedriveBurstGovernor} models. Refusing the segment costs this
 * connector no capability at all (every dataset is enumerable through its own
 * collection endpoint) while making "we never spend the search budget" a
 * property of the code rather than an intention someone held while writing it.
 */
export const PIPEDRIVE_FORBIDDEN_PATH_SEGMENT = "search";

/**
 * How each dataset can be read — a DECLARED property, not an accident of the
 * code. All five carry `updated_since`, so all five are delta-capable.
 */
export const PIPEDRIVE_SCAN_MODE: Readonly<Record<string, "delta" | "full_scan_only">> = {
  contact: "delta",
  company: "delta",
  deal: "delta",
  engagement: "delta",
  product: "delta",
};

/**
 * What the VENDOR offers for reading a deleted row, per dataset — an ADMITTED
 * GAP, declared so a scheduler cannot infer completeness from a green
 * incremental run.
 *
 * Read the value names carefully, because the distinction is the whole point:
 * `deals` is the only dataset with a documented vendor read for deleted rows
 * (`status=deleted`, "deals that have been deleted up to 30 days ago"), and
 * even that is a 30-day window after which the row is gone for good. The other
 * four have nothing: their deletions and merges are carried ONLY by webhook
 * events, which need a publicly reachable URL with a non-self-signed
 * certificate that a box with no inbound path cannot provide.
 *
 * **THIS CONNECTOR reads none of it, on any dataset.** `status` is not in
 * {@link PIPEDRIVE_SENDABLE_QUERY_PARAMS}, so `?status=deleted` is
 * unrepresentable here and the deal window is a vendor capability this track
 * does not use. The value is therefore `vendor_only_thirty_day_window` rather
 * than `thirty_day_window`: a scheduler reading this map learns what Pipedrive
 * could tell someone, NOT what it will be told, and must run its own
 * reconciliation sweep for deletions on all five datasets. See
 * {@link PIPEDRIVE_DELETED_DEAL_WINDOW_NOTE}, which is reported alongside this
 * map out of `status()` so the caveat cannot travel separately from the fact.
 */
export type PipedriveDeletionVisibility = "none" | "vendor_only_thirty_day_window";

export const PIPEDRIVE_DELETION_VISIBILITY: Readonly<
  Record<string, PipedriveDeletionVisibility>
> = {
  contact: "none",
  company: "none",
  deal: "vendor_only_thirty_day_window",
  engagement: "none",
  product: "none",
};

/**
 * The caveat that has to travel with {@link PIPEDRIVE_DELETION_VISIBILITY},
 * spelled out rather than left to the enum value alone.
 *
 * A scheduler that skipped its own reconciliation sweep because "deals are
 * covered for 30 days" would accumulate deleted deals in its mirror forever,
 * and nothing in a green incremental run would say so.
 */
export const PIPEDRIVE_DELETED_DEAL_WINDOW_NOTE =
  "Pipedrive itself keeps a deleted DEAL readable for 30 days via `?status=deleted`, but " +
  "`status` is deliberately not in PIPEDRIVE_SENDABLE_QUERY_PARAMS, so THIS CONNECTOR never " +
  "sends it and recovers no deleted row on any of the five datasets — deals included. " +
  "`vendor_only_thirty_day_window` is a fact about Pipedrive, not a capability of this track: " +
  "deletion reconciliation has to happen above this connector for every dataset.";

/**
 * Canonical columns this vendor has NO source for, declared per dataset.
 *
 * Three of these five shapes were designed for other vendors, and rather than
 * let a reader discover the holes one confusing empty column at a time, they
 * are named here and asserted against the mappers in `pipedrive.test.ts`:
 *
 *   - `contact.lifecycle_stage` — Pipedrive persons have no lifecycle-stage
 *     concept. A person's position in the funnel is expressed by the DEALS
 *     attached to them, not by a property on the person.
 *   - `company.domain` — a Pipedrive organization carries a name and an
 *     address, not a web domain. Parsing one out of a contact's email address
 *     would be a guess presented as a fact.
 *   - `product.inventory_quantity` — Pipedrive's catalog has no inventory,
 *     variant or fulfilment concept at all; the canonical `product` shape was
 *     minted for a storefront. This is the one that costs a capability:
 *     `get_low_stock_products` cannot be answered on this track, and is
 *     REFUSED rather than answered "nothing is low on stock", which would be a
 *     confident false statement about a business's supply.
 *
 * A column listed here is always `undefined` on this track's rows. That is
 * different from "the customer left it blank", and it is why this is a
 * declaration rather than a comment.
 */
export const PIPEDRIVE_UNRECONCILED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  contact: ["lifecycle_stage"],
  company: ["domain"],
  deal: [],
  engagement: [],
  product: ["inventory_quantity"],
};

/** What this track is waiting on. Deliberately unlike the other tracks', so an
 *  installer triaging this is not sent looking for a QuickBooks company. */
export const PIPEDRIVE_TRACK_REMEDIATION =
  "needs a Pipedrive personal API token created by the account owner at " +
  "Settings -> Personal preferences -> API, plus that account's company domain (the " +
  "subdomain in their Pipedrive web address), both stored on the integration row — and " +
  "the pipedrive-api entry in allowed-egress.yaml, since this connector leaves the " +
  "customer LAN";

/**
 * The plan prerequisite, in its honest form.
 *
 * Pipedrive has no free tier — every plan is paid, with only a 14-day trial —
 * but API access is NOT paywalled to a higher tier: the entry plan carries
 * documented API-token limits, so a customer on the cheapest plan can connect.
 * What the entry plan cannot do is SCOPE the token, because custom permission
 * sets are a higher-tier feature.
 */
export const PIPEDRIVE_PLAN_PREREQUISITE =
  "any paid Pipedrive plan (API access is not tier-gated); there is no free tier, only a " +
  "14-day trial";

// ─────────────────────────────────────────────────────────────────────────────
// Errors — distinct classes with distinct codes, so a caller tells them apart
// without string-matching a message.
// ─────────────────────────────────────────────────────────────────────────────

/** Thrown when a connection names a destination this track will not dial. */
export class UnsafePipedriveBaseUrlError extends Error {
  readonly code = "UNSAFE_BASE_URL";
  constructor(reason: string) {
    super(`refusing to send a Pipedrive API token there: ${reason}`);
    this.name = "UnsafePipedriveBaseUrlError";
  }
}

/** Why a credential was refused at intake. An explicit enum, never inferred. */
export type PipedriveCredentialRejection = "empty" | "whitespace" | "unrecognized";

/**
 * Thrown when a credential is not a usable Pipedrive API token.
 *
 * The message NEVER contains the offered value — a validation error that quotes
 * the credential writes it into every log line that renders the error. Only the
 * rejection CLASS is reported, which is what the connect wizard needs in order
 * to say something useful.
 */
export class InvalidPipedriveCredentialError extends Error {
  readonly code = "INVALID_PIPEDRIVE_CREDENTIAL";
  constructor(readonly reason: PipedriveCredentialRejection) {
    super(`Pipedrive credential rejected (${reason}): ${PIPEDRIVE_CREDENTIAL_ADVICE[reason]}`);
    this.name = "InvalidPipedriveCredentialError";
  }
}

const PIPEDRIVE_CREDENTIAL_ADVICE: Readonly<Record<PipedriveCredentialRejection, string>> = {
  empty: "no value was supplied",
  whitespace:
    "the token carries a space, a tab or a line break. That is almost always a copy-paste " +
    "that wrapped across two lines — copy it again from Settings -> Personal preferences -> API",
  unrecognized:
    "the token carries characters that cannot go in an HTTP header. Paste it exactly as " +
    "Pipedrive shows it, with nothing before or after",
};

/** Thrown when only a person creating a new API token can restore the
 *  connection. */
export class PipedriveReauthorizationRequiredError extends Error {
  readonly code = "REAUTHORIZE_REQUIRED";
  constructor(readonly reason: string) {
    super(
      `Pipedrive rejected the API token (${reason}). Retrying cannot fix this — the token was ` +
        `regenerated, revoked, or belongs to a user who no longer has API access. Note that ` +
        `Pipedrive allows exactly ONE active token per user per company, so anyone generating ` +
        `a new one for another tool has already invalidated this one. The token is a STANDING ` +
        `credential with no expiry, so deleting it in Pipedrive is what disconnects the box, ` +
        `immediately and completely.`,
    );
    this.name = "PipedriveReauthorizationRequiredError";
  }
}

/**
 * Thrown when the account's plan or permission set does not grant something.
 *
 * Its own class rather than folded into re-authorization, because the token is
 * fine and making a new one would waste the customer's time without fixing
 * anything. The characteristic Pipedrive cause is the permission-set toggle:
 * if a user's permission set lacks the API permission, the API settings page
 * simply DOES NOT APPEAR — no error, no explanation — and an administrator has
 * to enable it. Surfacing this is mandatory: ADR-041's never-empty contract
 * means a resource the account withholds must render THIS, never `[]`, which
 * reads as "you have no deals".
 */
export class PipedriveCapabilityMissingError extends Error {
  readonly code = "CAPABILITY_MISSING";
  constructor(
    readonly resource: string,
    readonly status: number,
  ) {
    super(
      `Pipedrive refused "${resource}" for this account (HTTP ${status}). This is a plan or ` +
        `permission-set limit, not a broken token — creating a new token will not change it. ` +
        `The usual cause is that the owning user's permission set does not have API access ` +
        `enabled, which an administrator turns on under Settings -> Manage users -> ` +
        `Permission sets. Prerequisite on record: ${PIPEDRIVE_PLAN_PREREQUISITE}.`,
    );
    this.name = "PipedriveCapabilityMissingError";
  }
}

/**
 * Thrown when Pipedrive refuses a request for a reason that is neither auth nor
 * capability.
 *
 * Carries the vendor's error CODE and the HTTP status and NOT the vendor's
 * message. That is deliberate and is a rule, not a preference: Pipedrive's
 * `error` and `error_info` strings quote request state back — parameter names,
 * offered values, sometimes the offending field — and request state on this
 * track is the customer's own CRM data. A vendor message propagated into an
 * error propagates into every log line that renders it. The code and the status
 * are enough to act on and carry nothing of the customer's.
 */
export class PipedriveApiError extends Error {
  readonly code = "PIPEDRIVE_API_ERROR";
  constructor(
    readonly op: string,
    readonly status: number,
    readonly vendorCode: string,
  ) {
    super(
      `Pipedrive refused "${op}" with vendor code ${vendorCode} (HTTP ${status}). The vendor's ` +
        `own message is deliberately not propagated: Pipedrive quotes request state back in it, ` +
        `and request state here is the customer's CRM data.`,
    );
    this.name = "PipedriveApiError";
  }
}

/** Thrown when the burst ceiling was hit and retries did not clear it. NOT a
 *  fault: the data returns on its own, and on a higher plan the ceiling is
 *  higher. */
export class PipedriveRateLimitedError extends Error {
  readonly code = "RATE_LIMITED";
  constructor(
    readonly op: string,
    readonly attempts: number,
  ) {
    super(
      `Pipedrive rate-limited "${op}" after ${attempts} attempt(s). The connector is pinned to ` +
        `the Lite floor of ${PIPEDRIVE_BURST_LIMIT} requests per ${PIPEDRIVE_BURST_WINDOW_MS}ms; ` +
        `an account on a higher plan can raise burstCeiling. ${PIPEDRIVE_DAILY_BUDGET_NOTE}`,
    );
    this.name = "PipedriveRateLimitedError";
  }
}

/**
 * Thrown when the stored company domain is no longer this account's.
 *
 * The company domain is customer-mutable from Pipedrive's own account settings
 * and nothing notifies an integration when it changes; the documented effect is
 * that "all previous domains and Bcc addresses will no longer be valid and
 * usable". So a stored domain goes stale silently and the connector starts
 * dialling a name that is no longer theirs. This is caught by comparing the
 * `company_domain` that `GET /users/me` returns against the stored one.
 *
 * (What a released domain becomes afterwards — whether another tenant can ever
 * claim it — is NOT documented anywhere we could verify, and this connector
 * makes no claim about it. The documented hazard stands on its own.)
 */
export class PipedriveCompanyDomainChangedError extends Error {
  readonly code = "COMPANY_DOMAIN_CHANGED";
  constructor(
    readonly configured: string,
    readonly reported: string,
  ) {
    super(
      `this connection is configured for the Pipedrive company domain "${configured}", but the ` +
        `account the token belongs to reports "${reported}". A company domain can be changed ` +
        `from Pipedrive's account settings and nothing notifies an integration, so the stored ` +
        `value has to be updated before any read. Refusing rather than dialling a name that is ` +
        `no longer this account's.`,
    );
    this.name = "PipedriveCompanyDomainChangedError";
  }
}

/**
 * Thrown when a read needs a canonical column Pipedrive has no source for.
 *
 * The alternative was returning rows with that column empty, and for
 * `get_low_stock_products` that means answering "nothing is low on stock" —
 * a confident false statement about a business's supply that no caller can tell
 * apart from a genuinely well-stocked catalog. Same reasoning as
 * `DatasetNotServedError`, one level down: the dataset IS served, the column is
 * structurally absent, and the honest answer is to say which.
 */
export class PipedriveColumnNotAvailableError extends Error {
  readonly code = "COLUMN_NOT_AVAILABLE";
  constructor(
    readonly query: string,
    readonly dataset: string,
    readonly column: string,
  ) {
    super(
      `"${query}" is answered from "${dataset}.${column}", which Pipedrive has no source for — ` +
        `its catalog has no inventory, variant or fulfilment concept. Refused rather than ` +
        `answered from an empty column, which would read as a confident fact about stock.`,
    );
    this.name = "PipedriveColumnNotAvailableError";
  }
}

/** Thrown when a request outlived our own deadline. A NAMED state: the ADR-041
 *  contract is that no failure may render as an empty result, and a timeout
 *  that returned `[]` would say the pipeline is empty. */
export class PipedriveTimeoutError extends Error {
  readonly code = "REQUEST_TIMEOUT";
  constructor(
    readonly op: string,
    readonly timeoutMs: number,
  ) {
    super(
      `Pipedrive request "${op}" exceeded the ${timeoutMs}ms timeout and was abandoned. ` +
        `Reported rather than returned empty: an empty result here would read as "nothing to ` +
        `sync" when the truth is that nothing was read.`,
    );
    this.name = "PipedriveTimeoutError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Guards — the real enforcement, because CI cannot see this host
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Assert that a stored company domain is one this connector will build a host
 * from.
 *
 * `providerConfig` is free-text JSON on the integration row. Nothing but this
 * stands between a tampered row and a token-carrying request to an arbitrary
 * host, so the value is re-validated on the way OUT of storage and not merely
 * on the way in. Case is normalised down, because a hostname label is
 * case-insensitive and the exact-equality check below is not.
 */
export function assertPipedriveCompanyDomain(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new UnsafePipedriveBaseUrlError("the company domain is not a string");
  }
  const domain = raw.trim().toLowerCase();
  if (!PIPEDRIVE_COMPANY_DOMAIN_PATTERN.test(domain)) {
    throw new UnsafePipedriveBaseUrlError(
      `"${domain}" is not a Pipedrive company domain (expected the single subdomain label ` +
        `from the account's web address, like acme-sales — not a full URL and not a hostname)`,
    );
  }
  return domain;
}

/**
 * Validate a customer-supplied token, or throw — before anything is persisted
 * and before it can reach a header.
 *
 * Returns the trimmed token; the CALLER persists it into `providerTokensEnc`.
 * Nothing here writes, logs or renders it, and the thrown error names only the
 * rejection class.
 */
export function parsePipedriveApiToken(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new InvalidPipedriveCredentialError("empty");
  }
  const token = raw.trim();
  if (/\s/.test(token)) {
    throw new InvalidPipedriveCredentialError("whitespace");
  }
  if (!PIPEDRIVE_TOKEN_PATTERN.test(token)) {
    throw new InvalidPipedriveCredentialError("unrecognized");
  }
  return token;
}

/**
 * Build this connection's API origin, or throw. THE control for this connector.
 *
 * Exact-host equality against `<companyDomain>` + the invariant suffix, for the
 * domain this connection stores — checked BOTH ways:
 *
 *   - the host must match {@link PIPEDRIVE_ALLOWED_HOST_PATTERN}, anchored, so
 *     `acme.pipedrive.com.evil.test` is refused. A suffix match, an `endsWith`,
 *     or an unanchored regex would accept it.
 *   - and it must equal THIS connection's host, so a tampered `providerConfig`
 *     cannot redirect one customer's traffic to another tenant, and an
 *     operator-supplied `baseUrl` cannot silently disagree with the token that
 *     will be sent to it.
 *
 * HTTPS only — a standing account credential over http is the credential given
 * away. Userinfo is rejected because some HTTP clients resolve
 * a userinfo-bearing URL to a different authority than a reader
 * expects. Any port but 443 is refused because that is all the egress registry
 * contemplates.
 *
 * Returns the ORIGIN with no path, deliberately: this connector dials two path
 * prefixes — `/api/v2` for the five datasets and `/api/v1/users/me` for the
 * domain check — and baking one of them into the base would make the other look
 * like a path-traversal fix rather than the documented carve-out it is.
 *
 * Called at CONSTRUCTION and again on every request build, before the request
 * object exists, so a bad destination costs zero fetch calls and never touches
 * the credential.
 */
export function assertSafePipedriveBaseUrl(raw: string, companyDomain: string): string {
  const domain = assertPipedriveCompanyDomain(companyDomain);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafePipedriveBaseUrlError(`"${raw}" is not a URL`);
  }
  if (url.protocol !== "https:") {
    throw new UnsafePipedriveBaseUrlError(`"${url.protocol}//" is not https`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new UnsafePipedriveBaseUrlError("the URL carries userinfo");
  }
  const host = url.hostname.toLowerCase();
  if (!PIPEDRIVE_ALLOWED_HOST_PATTERN.test(host)) {
    throw new UnsafePipedriveBaseUrlError(`"${host}" is not a Pipedrive API host`);
  }
  const expected = `${domain}${PIPEDRIVE_API_HOST_SUFFIX}`;
  if (host !== expected) {
    throw new UnsafePipedriveBaseUrlError(
      `"${host}" is not this connection's company-domain host ("${expected}")`,
    );
  }
  // The URL parser drops an explicit :443, so any port left standing is one the
  // egress registry does not declare.
  if (url.port !== "" && url.port !== "443") {
    throw new UnsafePipedriveBaseUrlError(
      `port ${url.port} — the egress registry allows this host on 443 only`,
    );
  }
  return `${url.protocol}//${url.host}`;
}

/**
 * Derive this connection's API origin from its company domain alone.
 *
 * The normal path: there is no operator-supplied base URL to trust, so the host
 * is built from the validated label and then re-checked by the same guard the
 * operator-supplied path uses. Building and then validating (rather than
 * trusting the construction) means one code path is under test, not two.
 */
export function pipedriveBaseUrlFor(companyDomain: string): string {
  const domain = assertPipedriveCompanyDomain(companyDomain);
  return assertSafePipedriveBaseUrl(`https://${domain}${PIPEDRIVE_API_HOST_SUFFIX}`, domain);
}

/**
 * Refuse a path this connector may not dial.
 *
 * Three independent checks, because each alone leaves a hole:
 *
 *   1. `/api/v1/users/me` is admitted EXACTLY, and it is the only v1 path. That
 *      is the documented carve-out, not a fallback: Users was never deprecated
 *      and has no v2 form.
 *   2. every other path must sit under {@link PIPEDRIVE_API_BASE_PATH} with a
 *      first segment in {@link PIPEDRIVE_READABLE_RESOURCES}. A `/api/v1/deals`
 *      path is refused here rather than 410'd by the vendor, so a v1 fallback
 *      cannot be reintroduced by accident.
 *   3. no segment may be {@link PIPEDRIVE_FORBIDDEN_PATH_SEGMENT}, which is
 *      where the separately-budgeted search endpoints live under
 *      otherwise-readable nouns.
 *
 * Called at the top of every request, BEFORE the token is resolved, so an
 * off-allowlist path never reaches the network and never touches the
 * credential.
 */
export function assertReadablePipedrivePath(path: string): void {
  if (path === PIPEDRIVE_USERS_ME_PATH) return;
  if (!path.startsWith(`${PIPEDRIVE_API_BASE_PATH}/`)) {
    throw new ConnectorBlockedError(
      `refusing to dial the Pipedrive path "${path}"`,
      `every dataset path must sit under "${PIPEDRIVE_API_BASE_PATH}/". Pipedrive's v1 ` +
        `endpoints for Activities, Deals, Persons, Organizations and Products went out of ` +
        `support on 2026-08-01, so a v1 dataset path is a build-time bug rather than a ` +
        `fallback. The single exception is "${PIPEDRIVE_USERS_ME_PATH}", which has no v2 form ` +
        `and was never deprecated.`,
    );
  }
  const segments = path.slice(PIPEDRIVE_API_BASE_PATH.length + 1).split("/").filter(Boolean);
  const resource = segments[0] ?? "";
  if (!PIPEDRIVE_READABLE_RESOURCES.has(resource)) {
    throw new ConnectorBlockedError(
      `refusing to dial the Pipedrive resource "${resource}"`,
      "this connector may only read the resources named in PIPEDRIVE_READABLE_RESOURCES, and " +
        "only with GET. Adding one is a deliberate, reviewed change, not something a new " +
        "request path can do incidentally.",
    );
  }
  if (segments.some((s) => s.toLowerCase() === PIPEDRIVE_FORBIDDEN_PATH_SEGMENT)) {
    throw new ConnectorBlockedError(
      `refusing to dial a Pipedrive "/${PIPEDRIVE_FORBIDDEN_PATH_SEGMENT}/" path`,
      "Pipedrive's search endpoints carry their own, lower ceiling — 10 requests per 2 " +
        "seconds on every plan and both auth methods — which is a different budget from the " +
        "burst governor this connector runs. Every dataset here is enumerable through its own " +
        "collection endpoint, so the segment is refused by shape rather than left to a " +
        "resource-level allowlist that legitimately admits `deals`.",
    );
  }
}

/**
 * Refuse a dataset query carrying a parameter this connector is not entitled to
 * send.
 *
 * The hazard is silent, which is why this is a runtime guard and not a comment:
 * Pipedrive ignores unknown query parameters, so an invented `modified_since`
 * yields a full scan REPORTED AS a delta, with nothing anywhere to notice.
 */
export function assertPipedriveSendableParams(params: Record<string, unknown>): void {
  for (const key of Object.keys(params)) {
    if (!PIPEDRIVE_SENDABLE_QUERY_PARAMS.has(key)) {
      throw new ConnectorBlockedError(
        `"${key}" is not a query parameter this connector may send`,
        "the sendable set is " +
          [...PIPEDRIVE_SENDABLE_QUERY_PARAMS].sort().join(", ") +
          `. Pipedrive ignores an unknown parameter and returns HTTP 200 with the whole ` +
          `collection, so a misspelt "${PIPEDRIVE_DELTA_PARAM}" is a full scan mislabelled as ` +
          `an incremental read — which is why this is checked before the request rather than ` +
          `asserted in a test.`,
      );
    }
  }
}

/**
 * Refuse an activities query carrying a parameter Pipedrive does not document.
 *
 * Narrower than {@link assertPipedriveSendableParams} and applied on top of it,
 * because `type` is the specific trap: it looks exactly like a filter, it is a
 * request-BODY field on POST/PATCH so it appears in the vendor's own docs, and
 * as a query parameter it is silently ignored — returning the entire activity
 * stream to a caller who believes they asked for calls.
 */
export function assertPipedriveActivityParams(params: Record<string, unknown>): void {
  for (const key of Object.keys(params)) {
    if (!PIPEDRIVE_ACTIVITY_QUERY_PARAMS.has(key)) {
      throw new ConnectorBlockedError(
        `"${key}" is not a documented GET /api/v2/activities query parameter`,
        "the documented set is " +
          [...PIPEDRIVE_ACTIVITY_QUERY_PARAMS].sort().join(", ") +
          ". `type` in particular is a request-BODY field on POST/PATCH and has never been a " +
          "v2 query parameter: Pipedrive would ignore it and return the whole activity " +
          "stream. Filter activity type on the RESPONSE `type` field, or server-side with a " +
          "pre-built filter_id.",
      );
    }
  }
}

/**
 * Refuse a bounded window on a dataset that cannot express one.
 *
 * `/api/v2/products` has `updated_since` and no `updated_until`. Passing one
 * anyway would be ignored and the window would degrade to open-ended — which,
 * against a daily token budget shared with the customer's other integrations,
 * is the difference between a bounded backfill and a scan that spends their
 * whole day of API allowance.
 */
export function assertPipedriveWindow(dataset: string, updatedUntil: string | undefined): void {
  if (updatedUntil === undefined) return;
  if (PIPEDRIVE_DATASETS_WITHOUT_UPPER_BOUND.has(dataset)) {
    throw new ConnectorBlockedError(
      `"${dataset}" cannot express a bounded window`,
      `Pipedrive documents "${PIPEDRIVE_WINDOW_END_PARAM}" on deals, persons, organizations ` +
        `and activities but NOT on products. Sending it anyway would be ignored and the ` +
        `window would silently become open-ended.`,
    );
  }
}

/**
 * A Pipedrive money value, at the connector boundary.
 *
 * **Pipedrive states money in MAJOR UNITS already** — a deal worth twelve
 * dollars and thirty-four cents comes back as `12.34`, not as `1234`. That is
 * the canonical form `profiles.ts` mandates, so unlike the Stripe track (whose
 * integers are minor units and must be divided by the currency's exponent) this
 * conversion is the identity.
 *
 * It exists as a named function anyway, and that is the point of it: it is the
 * ONE place a units decision is made for this vendor. If a future Pipedrive
 * surface turns out to state cents, this is a one-line change with one test
 * to update, rather than a hunt through five mappers. Multiplying or dividing
 * here is a 100× error in a customer's pipeline value, which is the quietly
 * wrong number this product exists not to produce — so `pipedrive.test.ts` pins
 * the identity explicitly rather than leaving it implied.
 *
 * Absent stays absent: a missing value must not become 0. Absent money and zero
 * money are different facts, and a deal with no value yet is what an
 * early-stage deal IS.
 */
export function pipedriveMajorUnits(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (raw === "") return undefined;
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

/**
 * A money amount and its currency, or neither.
 *
 * `REQUIRED_CANONICAL` demands a `currency` beside every money column, and the
 * reason is arithmetic: an amount whose currency has to be guessed is not a
 * number, and summing one into a total is how a revenue figure comes out wrong
 * without anyone being able to see why. So this returns BOTH or NEITHER — a
 * Pipedrive deal with a value and no currency code yields no amount at all,
 * which is honest, rather than an amount in an assumed currency, which is not.
 */
export function pipedriveMoneyPair(
  value: unknown,
  currency: unknown,
): { amount: number | undefined; currency: string | undefined } {
  const code = typeof currency === "string" && currency.trim() !== "" ? currency.trim() : undefined;
  const amount = code === undefined ? undefined : pipedriveMajorUnits(value);
  return { amount, currency: code };
}

// ─────────────────────────────────────────────────────────────────────────────
// The burst governor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A sliding-window burst governor for one Pipedrive ACCOUNT.
 *
 * The ceiling is per token — which is per user, per company — so two
 * `IntegrationConnection` rows pointed at the same tenant share it. The
 * governor therefore lives ABOVE the connection and is keyed on the company
 * domain ({@link pipedriveGovernorFor}); keying it on the connection produces a
 * connector that looks correct and 429s the moment a second connection exists.
 *
 * SLIDING rather than fixed-window, because whether Pipedrive's own window is
 * fixed or sliding is NOT verified. A sliding window never exceeds the ceiling
 * under either model; a fixed-window implementation can emit 2× the ceiling
 * across a boundary and would be wrong exactly when it mattered.
 *
 * Acquisitions are chained, so two concurrent callers cannot both read the same
 * window and both conclude there is room. The wait loop is BOUNDED rather than
 * open — an unbounded wait inside a governor is a hang wearing a queue's
 * clothes — and no loop in this file runs on an unconditional `true`.
 */
export class PipedriveBurstGovernor {
  /** Grant timestamps inside the current window. */
  private readonly recent: number[] = [];
  /** The serialisation chain. Failures are absorbed so one rejected acquire
   *  cannot wedge the queue for every later caller. */
  private chain: Promise<void> = Promise.resolve();

  constructor(
    readonly accountKey: string,
    private readonly now: () => number,
    private readonly sleep: (ms: number) => Promise<void>,
    readonly limit: number = PIPEDRIVE_BURST_LIMIT,
    readonly windowMs: number = PIPEDRIVE_BURST_WINDOW_MS,
  ) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`burst limit must be a positive integer, got ${limit}`);
    }
  }

  acquire(): Promise<void> {
    // Deliberately NOT an `async` method: `async` + `return run` costs the
    // caller two extra microtask hops before it can issue its request, during
    // which the next queued acquisition can already be waiting.
    const run = this.chain.then(() => this.waitForSlot());
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private prune(t: number): void {
    while (this.recent.length > 0 && t - this.recent[0] >= this.windowMs) {
      this.recent.shift();
    }
  }

  private async waitForSlot(): Promise<void> {
    // Bounded: at most one wait per already-granted slot, plus one. A slot
    // always frees within `windowMs`, so this cannot legitimately exhaust.
    for (let attempt = 0; attempt <= this.limit + 1; attempt += 1) {
      const t = this.now();
      this.prune(t);
      if (this.recent.length < this.limit) {
        this.recent.push(t);
        return;
      }
      await this.sleep(this.windowMs - (t - this.recent[0]));
    }
    throw new PipedriveRateLimitedError(
      `burst governor for ${this.accountKey}`,
      this.limit + 2,
    );
  }
}

/**
 * Governors, one per ACCOUNT, for the life of the process.
 *
 * Module-level on purpose: a governor scoped to a connector instance would
 * reset every time a connection was rebuilt, and two connections on one tenant
 * would never see each other — which is precisely the defect this mechanism
 * exists to prevent.
 */
const PIPEDRIVE_GOVERNORS = new Map<string, PipedriveBurstGovernor>();

/** Get (or create) the governor for one Pipedrive account. The ceiling of the
 *  FIRST caller wins, which is the conservative outcome: a second connection
 *  claiming a higher plan cannot raise a ceiling the first one is already
 *  pacing against. */
export function pipedriveGovernorFor(
  accountKey: string,
  deps: { now: () => number; sleep: (ms: number) => Promise<void>; limit?: number },
): PipedriveBurstGovernor {
  const existing = PIPEDRIVE_GOVERNORS.get(accountKey);
  if (existing) return existing;
  const created = new PipedriveBurstGovernor(
    accountKey,
    deps.now,
    deps.sleep,
    deps.limit ?? PIPEDRIVE_BURST_LIMIT,
  );
  PIPEDRIVE_GOVERNORS.set(accountKey, created);
  return created;
}

/** Drop every governor. A suite hook — production never calls this, because a
 *  forgotten window is a burst against a ceiling that cannot be raised. */
export function resetPipedriveGovernors(): void {
  PIPEDRIVE_GOVERNORS.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// Wiring types
// ─────────────────────────────────────────────────────────────────────────────

type FetchLike = (input: string, init?: Record<string, unknown>) => Promise<Response>;

/** Resolve the API token (from the orchestrator's encrypted store). Cleartext
 *  for the life of one call only; never cached to disk here. */
export type PipedriveTokenResolver = () => Promise<string>;

/** The default resolver: nothing wired, so the track blocks honestly. */
export const blockedPipedriveTokenResolver: PipedriveTokenResolver = async () => {
  throw new ConnectorBlockedError("resolve the Pipedrive API token", PIPEDRIVE_TRACK_REMEDIATION);
};

export interface PipedriveConnectorConfig {
  /** Pointer into the encrypted secret store — NEVER a token. */
  credentialsSecretRef: string;
  /**
   * The company domain, collected from the owner at connect time and persisted
   * in `providerConfig`. It is what selects the host, so it is read from there
   * rather than derived per request from the decrypted token: re-deriving would
   * mean decrypting the credential to answer "where do we dial", and would let
   * a token swapped out-of-band silently move the destination.
   */
  companyDomain: string;
  /** The connection row's id. Never a provider name. */
  connectionId: string;
  /** Optional operator override. Guarded on construction, and must agree with
   *  {@link companyDomain}. */
  baseUrl?: string;
  /**
   * Raise the burst ceiling off the Lite floor.
   *
   * The connector cannot see the customer's plan, so it pins the floor of 20
   * per 2 s. An operator who knows the account is on Growth (40), Premium (100)
   * or Ultimate (120) sets it here rather than being throttled forever. It is
   * an operator statement of fact, so it is clamped to the highest documented
   * ceiling and never trusted beyond it.
   */
  burstCeiling?: number;
}

export interface PipedriveConnectorDeps {
  fetchImpl?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  resolveApiToken?: PipedriveTokenResolver;
  timeoutMs?: number;
  governor?: PipedriveBurstGovernor;
}

/** The highest documented API-token burst ceiling (Ultimate). An operator
 *  override above this is a typo, not a plan. */
export const PIPEDRIVE_MAX_BURST_CEILING = 120;

/** The ADR-041 §5 connection-state vocabulary. Explicit, never inferred from a
 *  missing token — an absent value defaulted into "connected" is exactly the
 *  looks-connected-syncs-nothing failure that section exists to prevent. */
export type PipedriveConnectionState =
  | "disconnected"
  | "connected"
  | "needs_reconnect"
  | "capability_missing";

/**
 * The empirical answer to "do this token and this company domain agree?".
 * `unverified` is the SHIPPED default and a first-class value, not a null.
 *
 * `unauthorized` is recorded when the VENDOR rejects the credential with a 401
 * on any call, not only on the domain probe, and it exists because the failure
 * it stands for is otherwise invisible: a 401 that only threw would leave
 * `state()` reporting "connected" and `health()` returning `{ok:true}` for a
 * token Pipedrive refuses on every single request — the looks-connected,
 * syncs-nothing shape ADR-041 §5 exists to prevent. It is cleared by a
 * successful {@link PipedriveConnector.verifyCompanyDomain}, which is what
 * reconnecting runs, so the state is recoverable rather than sticky.
 */
export type PipedriveDomainProbe =
  | { state: "unverified" }
  | { state: "ok"; companyDomain: string; probedAt: number }
  | { state: "changed"; configured: string; reported: string; probedAt: number }
  | { state: "unauthorized"; probedAt: number }
  | { state: "forbidden"; status: number; probedAt: number };

export interface PipedriveStatus {
  state: PipedriveConnectionState;
  ok: boolean;
  /** Whether a token resolves. NEVER the token. */
  hasApiToken: boolean;
  companyDomain: string;
  domainProbe: PipedriveDomainProbe;
  burstLimit: number;
  burstWindowMs: number;
  requestTimeoutMs: number;
  /** Per dataset, whether a delta read is possible at all. */
  scanModes: Readonly<Record<string, "delta" | "full_scan_only">>;
  /**
   * Per dataset, what the VENDOR offers for reading a DELETED row — named
   * `vendor…` because it is not a statement about this connector, which reads
   * none of it on any dataset. An admitted gap, reported rather than left for a
   * scheduler to assume away.
   */
  vendorDeletionVisibility: Readonly<Record<string, PipedriveDeletionVisibility>>;
  /** Why {@link vendorDeletionVisibility} is not a capability of this track.
   *  Reported beside it so the caveat cannot travel separately from the fact. */
  deletedDealWindowNote: string;
  /** The ceiling this connector cannot enforce. */
  dailyBudgetNote: string;
}

/**
 * One page of vendor records, with the watermark the caller persists.
 *
 * `watermarkIds` is not decoration. `updated_since` is INCLUSIVE — "later than
 * or equal to" — so feeding the watermark straight back re-reads every row that
 * shares that instant, every tick, forever. Adding a millisecond instead would
 * silently skip any row written inside that millisecond. Returning the ids AT
 * the watermark lets the caller skip exactly those rows and nothing else, which
 * is the only form of this that is both complete and terminating.
 */
export interface PipedrivePage {
  rows: Record<string, unknown>[];
  /** RETURNED, never written here — ADR-041 §4. The vendor's OWN string, since
   *  it is fed straight back as `updated_since`. */
  watermark: string | undefined;
  /** The vendor ids whose `update_time` equals {@link watermark}. */
  watermarkIds: string[];
}

/**
 * One Pipedrive record -> canonical-column lookup, per dataset.
 *
 * Returns the RAW vendor value; `projectCanonicalRow` owns the coercion and
 * owns the row's key set, so a mapper can neither leak a vendor field onto a
 * row nor drop a canonical one. That matters here as much as on any track: a
 * Pipedrive person carries every custom field the business ever created, keyed
 * by opaque hashes, plus picture URLs and owner records — none of which this
 * product asked for and all of which would be persisted on the box by a mapper
 * written as `{ ...person, ... }`.
 *
 * ## Time
 *
 * Pipedrive emits `add_time` / `update_time` as `YYYY-MM-DD HH:MM:SS` in UTC,
 * with a SPACE rather than a `T` and no zone marker. `canonicalInstant` runs
 * `Date.parse`, whose handling of that form is implementation-defined and can
 * be read as LOCAL time — which would shift every timestamp by the box's UTC
 * offset and, on a watermark, would either re-read hours of rows or skip them.
 * {@link pipedriveInstant} normalises the wire form to RFC 3339 UTC first.
 *
 * ## Money
 *
 * See {@link pipedriveMajorUnits}: Pipedrive states money in major units
 * already. The pairing rule is {@link pipedriveMoneyPair} — an amount is
 * emitted only alongside its currency.
 */
function pipedriveLookup(dataset: DatasetName, record: Record<string, unknown>): VendorLookup {
  const dealMoney = pipedriveMoneyPair(record.value, record.currency);
  const price = selectPipedrivePrice(record);
  return (column: string): unknown => {
    switch (column) {
      // Every dataset's id column is the record's own `id`.
      case "contact_id":
        // On `contact` the record IS the person; on `engagement` it is the
        // person the activity was logged against.
        return dataset === "contact" ? record.id : record.person_id;
      case "company_id":
        // Likewise: on `company` the record is the organization, elsewhere it
        // is the organization the row hangs off.
        return dataset === "company" ? record.id : record.org_id;
      case "deal_id":
        return dataset === "deal" ? record.id : record.deal_id;
      case "engagement_id":
      case "product_id":
        return record.id;

      case "created_at":
        return pipedriveInstant(record.add_time);
      case "updated_at":
        return pipedriveInstant(record.update_time);

      // ── contact ──────────────────────────────────────────────────────────
      case "first_name":
        return record.first_name;
      case "last_name":
        return record.last_name;
      case "email":
        // Pipedrive holds a LIST of addresses per person, one of them flagged
        // primary. The primary is the one the business actually writes to;
        // taking `emails[0]` would silently prefer whichever address happened
        // to be entered first.
        return selectPipedrivePrimaryValue(record.emails);
      // `lifecycle_stage` is declared in PIPEDRIVE_UNRECONCILED_COLUMNS: a
      // Pipedrive person has no funnel-stage property. Their position in the
      // pipeline is expressed by the DEALS attached to them. Returning
      // `undefined` keeps the column present and empty, which is what
      // "this vendor has no source for it" means.

      // ── company ──────────────────────────────────────────────────────────
      // `name` is shared with `deal`, where Pipedrive calls it `title`.
      case "name":
        return dataset === "deal" ? record.title : record.name;
      // `domain` is declared unreconciled: a Pipedrive organization carries a
      // name and an address, not a web domain. Guessing one out of a related
      // contact's email address would be a guess presented as a fact.

      // ── deal ─────────────────────────────────────────────────────────────
      case "stage":
        // The vendor's stage IDENTIFIER, not a label. Pipedrive stage names
        // are per-pipeline and renameable, so the id is the only stable thing
        // to filter on; resolving it to a name would need a second endpoint
        // and would break the moment the customer renamed a stage.
        return record.stage_id;
      case "closed_at":
        // `close_time` is when the deal was ACTUALLY closed, won or lost.
        // Deliberately not `expected_close_date`, which is a salesperson's
        // forecast: putting a forecast in a column named `closed_at` is how a
        // pipeline report starts reporting things that have not happened.
        return pipedriveInstant(record.close_time);
      case "amount":
        return dealMoney.amount;

      // ── engagement ───────────────────────────────────────────────────────
      case "occurred_at":
        return pipedriveActivityInstant(record);
      case "type":
        // The RESPONSE field, which does exist — unlike the `type` QUERY
        // parameter, which does not (see PIPEDRIVE_ACTIVITY_QUERY_PARAMS).
        // This is exactly where that distinction is supposed to live.
        return record.type;

      // ── product ──────────────────────────────────────────────────────────
      case "title":
        return record.name;
      case "sku":
        // Pipedrive's product `code`. It is the customer's own catalog
        // identifier and is what a person would call the SKU.
        return record.code;
      case "price_amount":
        return price?.amount;
      case "status":
        return pipedriveProductStatus(record);
      // `inventory_quantity` is declared unreconciled: Pipedrive's catalog has
      // no inventory, variant or fulfilment concept at all.

      // ── shared ───────────────────────────────────────────────────────────
      case "currency":
        return dataset === "deal" ? dealMoney.currency : price?.currency;

      default:
        return undefined;
    }
  };
}

/**
 * A Pipedrive timestamp as a full UTC ISO instant.
 *
 * Pipedrive's wire form is `2026-09-01 10:20:00` — space-separated, no zone
 * marker — and it is UTC. `Date.parse` on that form is implementation-defined
 * and several engines read it as LOCAL time, which shifts every value by the
 * box's UTC offset. On `updated_at` that is not a cosmetic bug: the watermark
 * comparison either re-reads hours of rows every tick or skips them entirely,
 * and neither announces itself.
 *
 * So the space becomes a `T` and a `Z` is appended before parsing, and anything
 * that already carries a zone marker is passed through to `canonicalInstant`
 * unchanged. Absent stays absent and unparseable stays absent: inventing a
 * value here would put a number in a column a watermark TRUSTS.
 */
export function pipedriveInstant(value: unknown): string | undefined {
  if (typeof value !== "string") return canonicalInstant(value);
  const raw = value.trim();
  if (raw === "") return undefined;
  const spaced = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(raw);
  if (spaced) return canonicalInstant(`${spaced[1]}T${spaced[2]}Z`);
  return canonicalInstant(raw);
}

/**
 * A timestamp in the exact form Pipedrive's own filter documentation shows —
 * `2025-01-01T10:20:00Z`, whole seconds, no fractional part.
 *
 * `canonicalInstant` renders milliseconds (`…T10:20:00.000Z`) because that is
 * the canonical ROW form, and a canonical row is not a wire value. RFC 3339
 * permits the fraction and Pipedrive very probably accepts it, but "probably"
 * is not a property to rest a delta on: this is the one wire value whose silent
 * mishandling is the full-scan-reported-as-a-delta failure this whole file is
 * arranged around, and the vendor's documented example is the only form known
 * to be accepted. Nothing was exercised against a live tenant, so the connector
 * sends the documented form rather than a form that merely ought to work.
 *
 * TRUNCATES, and the direction is load-bearing rather than incidental. The
 * `updated_since` boundary is INCLUSIVE ("later than or equal to"), so dropping
 * a fraction moves the boundary at most one second EARLIER: the read can only
 * re-cover rows it already has — which {@link PipedrivePage.watermarkIds}
 * exists to de-duplicate — and can never step over one. Rounding up would skip
 * whatever was written inside that second, silently and permanently.
 *
 * A value that cannot be rendered at all is REFUSED, never dropped. Pipedrive
 * ignores a parameter it cannot use and answers 200 with the whole collection,
 * so a silently-omitted delta is a full scan wearing an incremental read's
 * clothes.
 */
export function pipedriveWireInstant(param: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const iso = pipedriveInstant(value);
  if (iso === undefined) {
    throw new ConnectorBlockedError(
      `"${param}" was given a timestamp this connector cannot render`,
      `Pipedrive documents "${param}" in RFC3339, e.g. 2025-01-01T10:20:00Z. An unrenderable ` +
        `value is refused rather than dropped from the query: Pipedrive ignores a parameter it ` +
        `cannot use and returns HTTP 200 with the whole collection, so dropping it would turn a ` +
        `bounded incremental read into a silent full scan.`,
    );
  }
  // Whole seconds only. Truncating (never rounding) keeps an inclusive boundary
  // on the safe side — re-read, never skipped.
  return iso.replace(/\.\d+(?=Z$)/, "");
}

/**
 * When an activity HAPPENED, in the canonical sense of `occurred_at`.
 *
 * The rule, in order, and the reasoning for each step:
 *
 *   1. `marked_as_done_time` — a completed activity happened when it was
 *      completed. This is the only field that is the actual event time.
 *   2. otherwise `due_date` (+ `due_time` when present) — a scheduled activity
 *      has not happened yet, and its place on the timeline is when it is due.
 *      A date with no time is placed at the start of that date in UTC, which is
 *      the only instant the vendor supplies for it.
 *
 * Deliberately NOT `update_time` as a last resort. `occurred_at` is when the
 * thing happened, not when the record was written: a meeting logged the next
 * morning happened the day before, and a timeline sorted by write time reorders
 * history. An activity with neither a completion time nor a due date has no
 * honest `occurred_at`, and `REQUIRED_CANONICAL` will reject it — which is the
 * correct outcome, because a row that cannot be placed on the timeline is the
 * one thing this dataset exists to do.
 */
export function pipedriveActivityInstant(record: Record<string, unknown>): string | undefined {
  const done = pipedriveInstant(record.marked_as_done_time);
  if (done !== undefined) return done;
  const date = typeof record.due_date === "string" ? record.due_date.trim() : "";
  if (date === "") return undefined;
  const time = typeof record.due_time === "string" ? record.due_time.trim() : "";
  if (time === "") return canonicalInstant(`${date}T00:00:00Z`);
  // Pipedrive emits `due_time` as HH:MM or HH:MM:SS; normalise to seconds.
  const seconds = /^\d{2}:\d{2}$/.test(time) ? `${time}:00` : time;
  return canonicalInstant(`${date}T${seconds}Z`);
}

/**
 * The primary value out of one of Pipedrive's labelled contact-detail arrays.
 *
 * Persons carry `emails` and `phones` as `[{ value, primary, label }]`. The
 * flagged primary is the address the business actually writes to; `[0]` is
 * whichever one happened to be typed first, which is a different fact and is
 * wrong often enough to matter. Falls back to the first entry that has a value
 * at all, so a person with addresses but no primary flag is not reported as
 * having no email.
 */
export function selectPipedrivePrimaryValue(list: unknown): string | undefined {
  if (!Array.isArray(list)) return undefined;
  const entries = list.filter(
    (e): e is Record<string, unknown> => e !== null && typeof e === "object",
  );
  const value = (e: Record<string, unknown>): string | undefined =>
    typeof e.value === "string" && e.value.trim() !== "" ? e.value.trim() : undefined;
  for (const e of entries) {
    if (e.primary === true) {
      const v = value(e);
      if (v !== undefined) return v;
    }
  }
  for (const e of entries) {
    const v = value(e);
    if (v !== undefined) return v;
  }
  return undefined;
}

/**
 * The price a Pipedrive product row reports, with its currency.
 *
 * Pipedrive lets ONE product carry a price per currency, in a `prices` array,
 * and the product object carries no "default currency" to pick between them.
 * So this takes the first entry that has BOTH a parseable price and a currency
 * code, in the vendor's own order, and does not guess an account default —
 * because an amount in an assumed currency is not a number. A product priced in
 * three currencies reports one of them, deterministically, and that is a stated
 * limitation rather than a hidden one.
 */
export function selectPipedrivePrice(
  record: Record<string, unknown>,
): { amount: number; currency: string } | undefined {
  const list = record.prices;
  if (!Array.isArray(list)) return undefined;
  for (const entry of list) {
    if (entry === null || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const pair = pipedriveMoneyPair(row.price, row.currency);
    if (pair.amount !== undefined && pair.currency !== undefined) {
      return { amount: pair.amount, currency: pair.currency };
    }
  }
  return undefined;
}

/**
 * A product's active flag as a canonical `status`.
 *
 * Read from `active_flag`, which is how v1 spelled it; `is_active` is accepted
 * as well because the v2 spelling was NOT verified against a live tenant and
 * reading a second candidate key invents nothing while an absent flag simply
 * leaves the column empty. Mapped to explicit words rather than passed through
 * as a boolean: `canonicalText` would stringify `false` to `"false"`, and a
 * `status` column reading `"false"` beside four other tracks' `"active"` /
 * `"archived"` is a value nothing downstream can compare.
 */
export function pipedriveProductStatus(record: Record<string, unknown>): string | undefined {
  const flag = typeof record.active_flag === "boolean" ? record.active_flag : record.is_active;
  if (flag === true) return "active";
  if (flag === false) return "inactive";
  return undefined;
}

export class PipedriveConnector implements Connector {
  readonly provider = PIPEDRIVE_PROVIDER;
  readonly servesDatasets = PIPEDRIVE_DATASETS;

  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly resolveApiToken: PipedriveTokenResolver;
  private readonly fetchImpl?: FetchLike;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly companyDomain: string;
  private readonly governor: PipedriveBurstGovernor;

  private apiToken: string | null = null;
  private fingerprint: string | null = null;
  private probe: PipedriveDomainProbe = { state: "unverified" };

  constructor(
    private readonly config: PipedriveConnectorConfig,
    deps: PipedriveConnectorDeps = {},
  ) {
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.resolveApiToken = deps.resolveApiToken ?? blockedPipedriveTokenResolver;
    this.fetchImpl = deps.fetchImpl;
    this.timeoutMs = deps.timeoutMs ?? PIPEDRIVE_REQUEST_TIMEOUT_MS;
    // Validated at CONSTRUCTION: a connection naming a destination we will not
    // dial should fail to build, loudly, rather than look fine until the first
    // read ships a token.
    this.companyDomain = assertPipedriveCompanyDomain(config.companyDomain);
    this.baseUrl = config.baseUrl
      ? assertSafePipedriveBaseUrl(config.baseUrl, this.companyDomain)
      : pipedriveBaseUrlFor(this.companyDomain);
    this.governor =
      deps.governor ??
      pipedriveGovernorFor(this.companyDomain, {
        now: this.now,
        sleep: this.sleep,
        limit: PipedriveConnector.burstCeiling(config.burstCeiling),
      });
  }

  /** Clamp an operator's plan claim to the documented range. A value above the
   *  highest documented ceiling is a typo, and honouring it would burst against
   *  a limit that cannot be raised. */
  private static burstCeiling(requested: number | undefined): number {
    if (requested === undefined) return PIPEDRIVE_BURST_LIMIT;
    if (!Number.isInteger(requested) || requested < 1) return PIPEDRIVE_BURST_LIMIT;
    return Math.min(requested, PIPEDRIVE_MAX_BURST_CEILING);
  }

  private blocked(op: string, detail?: string): ConnectorBlockedError {
    return new ConnectorBlockedError(
      detail ? `${op} (${detail})` : op,
      PIPEDRIVE_TRACK_REMEDIATION,
    );
  }

  /** Resolve and validate the token. Validated on every resolve, not only at
   *  intake: a row edited out-of-band must not be able to put a header-unsafe
   *  value on the wire. */
  private async token(): Promise<string> {
    if (this.apiToken) return this.apiToken;
    const raw = await this.resolveApiToken();
    this.apiToken = parsePipedriveApiToken(raw);
    return this.apiToken;
  }

  /**
   * One request.
   *
   * Order is load-bearing. The path allowlist and the host guard both run
   * BEFORE the token is resolved and before the request object exists, so a
   * refused destination or resource costs zero fetch calls and never touches
   * the credential — which is what the tests assert on.
   */
  private async request(
    op: string,
    path: string,
    search: Record<string, string | number | undefined> = {},
  ): Promise<Record<string, unknown>> {
    assertReadablePipedrivePath(path);
    // Re-checked per request, not only at construction: `providerConfig` is
    // free-text JSON and this is the only thing standing between a tampered row
    // and a token-carrying request to an arbitrary host.
    const base = assertSafePipedriveBaseUrl(this.baseUrl, this.companyDomain);

    const present: Record<string, string> = {};
    for (const [k, v] of Object.entries(search)) {
      if (v !== undefined) present[k] = String(v);
    }
    // Both parameter guards, before the token is resolved. An invented delta
    // parameter must never cost a request, because a request that went out is a
    // full scan that already happened.
    //
    // The ACTIVITIES guard runs FIRST, and the order is deliberate rather than
    // incidental: every parameter in the sendable set is also a documented
    // activities parameter, so a sendable-first order would make the activities
    // guard unreachable — a guard that cannot fire, which is worse than no
    // guard because it reads as coverage. Running it first means `type` on
    // activities produces the message that explains why (a POST/PATCH body
    // field, silently ignored as a query parameter) rather than the generic
    // not-in-the-sendable-set one.
    if (path === PIPEDRIVE_DATASET_ENDPOINTS.engagement) {
      assertPipedriveActivityParams(present);
    }
    assertPipedriveSendableParams(present);

    const apiToken = await this.token();
    const qs = new URLSearchParams(present);
    const url = `${base}${path}${qs.toString() ? `?${qs}` : ""}`;

    const doFetch = this.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    if (!doFetch) throw this.blocked(op, "no fetch implementation available");

    for (let attempt = 0; attempt <= PIPEDRIVE_MAX_RATE_LIMIT_RETRIES; attempt += 1) {
      // The governor wraps the NETWORK call only. Holding a slot across the
      // guards above would spend burst budget on a request that never went out.
      await this.governor.acquire();
      let res: Response;
      try {
        res = await this.withTimeout(op, (signal) =>
          doFetch(url, {
            method: "GET",
            headers: {
              // The token travels HERE and nowhere else. It is never a query
              // parameter (the `?api_token=` form is v1-only and would put a
              // standing account credential in every proxy log between here
              // and Pipedrive), and it is built inline rather than stored on a
              // field so it cannot be reached by anything that renders this
              // object.
              [PIPEDRIVE_AUTH_HEADER]: apiToken,
              ...PIPEDRIVE_CONSTANT_HEADERS,
            },
            // Never follow a 3xx. The fetch spec strips credential headers on
            // cross-origin redirects, but the token's safety must not rest on
            // every runtime implementing that correctly — and a 30x off the
            // configured host is exactly the stale-company-domain failure this
            // connector is supposed to catch, so it is a refusal, not a hop.
            redirect: "error",
            signal,
          }),
        );
      } catch (err) {
        if (err instanceof PipedriveTimeoutError) throw err;
        if (PipedriveConnector.isTimeout(err)) {
          throw new PipedriveTimeoutError(op, this.timeoutMs);
        }
        throw this.blocked(op, `Pipedrive API unreachable: ${(err as Error).message}`);
      }

      if (res.status === 429) {
        if (attempt === PIPEDRIVE_MAX_RATE_LIMIT_RETRIES) {
          throw new PipedriveRateLimitedError(op, attempt + 1);
        }
        // `x-ratelimit-reset` is the authority — no `Retry-After` is
        // documented — and a local model of the budget cannot be trusted,
        // because the plan multiplier and seat count are facts this connector
        // cannot see.
        await this.sleep(PipedriveConnector.resetDelayMs(res));
        continue;
      }
      if (res.status === 401) {
        // RECORDED, not merely thrown. A 401 that only threw would leave
        // `state()` reporting "connected", `status().ok` true and `health()`
        // returning `{ok:true}` for a token Pipedrive is refusing on every
        // call — looks-connected, syncs-nothing, which is exactly what ADR-041
        // §5 forbids and what an operator triaging a silent sync would be
        // misled by. The cached token is dropped at the same time: the vendor
        // has just said this value does not work, so holding it would answer
        // "yes, a credential resolves" with a credential that does not.
        this.apiToken = null;
        this.probe = { state: "unauthorized", probedAt: this.now() };
        throw new PipedriveReauthorizationRequiredError("Pipedrive returned 401");
      }
      if (res.status === 403) {
        throw new PipedriveCapabilityMissingError(path, res.status);
      }
      if (!res.ok) {
        throw new PipedriveApiError(op, res.status, await PipedriveConnector.vendorCode(res));
      }
      try {
        return (await res.json()) as Record<string, unknown>;
      } catch (err) {
        throw this.blocked(op, `unparseable Pipedrive response: ${(err as Error).message}`);
      }
    }
    // Unreachable: the loop either returns, throws, or exhausts its retries
    // into the 429 branch above. Present so the function has no implicit
    // undefined return path.
    throw new PipedriveRateLimitedError(op, PIPEDRIVE_MAX_RATE_LIMIT_RETRIES + 1);
  }

  /**
   * How long to wait after a 429.
   *
   * `x-ratelimit-reset` is documented as the seconds remaining before the limit
   * resets. It is CLAMPED at both ends: a missing or unparseable value falls
   * back to one whole burst window, and anything longer than
   * {@link PIPEDRIVE_MAX_BACKOFF_MS} is capped — a header that turned out to
   * carry an absolute epoch rather than a duration would otherwise wedge a
   * worker for decades, which is a worse failure than retrying slightly early.
   */
  private static resetDelayMs(res: Response): number {
    const raw = res.headers?.get?.(PIPEDRIVE_RATE_LIMIT_RESET_HEADER);
    const seconds = raw === null || raw === undefined ? Number.NaN : Number(raw);
    if (!Number.isFinite(seconds) || seconds <= 0) return PIPEDRIVE_BURST_WINDOW_MS;
    return Math.min(seconds * 1000, PIPEDRIVE_MAX_BACKOFF_MS);
  }

  /**
   * The vendor's error CODE, and never its message.
   *
   * Pipedrive's `error` and `error_info` strings quote request state back —
   * parameter names, offered values, the offending field — and on this track
   * request state is the customer's CRM data. Propagating one writes it into
   * every log line that renders the error. So this reads a code if the body
   * carries one in a recognisable field and otherwise synthesises `http_<n>`,
   * which is the honest floor: the status is a fact about the exchange, not
   * about the customer.
   */
  private static async vendorCode(res: Response): Promise<string> {
    try {
      const body = (await res.json()) as Record<string, unknown>;
      for (const key of ["errorCode", "error_code"]) {
        const value = body[key];
        if (typeof value === "string" && value.trim() !== "") return value.trim();
        if (typeof value === "number" && Number.isFinite(value)) return String(value);
      }
    } catch {
      // A body that is not JSON tells us nothing beyond the status, which the
      // fallback already carries.
    }
    return `http_${res.status}`;
  }

  /**
   * Bound one call at {@link PIPEDRIVE_REQUEST_TIMEOUT_MS}, belt AND braces.
   *
   * An `AbortSignal` is passed down so a real `fetch` tears the socket down
   * rather than leaving it open behind an abandoned promise, AND the call is
   * raced against our own timer so the deadline holds even when the fetch
   * implementation ignores the signal. The second is what makes the deadline
   * OURS rather than a delegated hope: the ADR-041 contract is that a stalled
   * request surfaces as {@link PipedriveTimeoutError}, never as an empty result
   * and never as a promise that simply does not settle.
   */
  private async withTimeout<T>(op: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new PipedriveTimeoutError(op, this.timeoutMs));
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

  /**
   * Walk one v2 collection by cursor.
   *
   * Offset pagination (`start` / `limit`) was REMOVED in v2 and exists only on
   * v1, so there is no offset anywhere here — which is a property worth having:
   * a cursor walk does not degrade as the offset grows, and it does not skip or
   * duplicate rows when the collection is written to mid-walk.
   *
   * Termination is `additional_data.next_cursor` being null, which is
   * Pipedrive's documented end-of-dataset signal. Two additional guards, both
   * for loops that would otherwise never end:
   *
   *   - a page count ceiling ({@link PIPEDRIVE_MAX_PAGES}), and
   *   - a NON-ADVANCING cursor check. A vendor that echoed the same cursor back
   *     would otherwise be an infinite loop that looks like a slow sync, and
   *     each turn of it spends the customer's daily token budget.
   */
  private async walk(
    op: string,
    path: string,
    search: Record<string, string | number | undefined>,
    pageSize: number,
  ): Promise<Record<string, unknown>[]> {
    const limit = Math.min(Math.max(1, Math.trunc(pageSize)), PIPEDRIVE_MAX_PAGE_SIZE);
    const rows: Record<string, unknown>[] = [];
    let cursor: string | undefined;

    for (let page = 1; page <= PIPEDRIVE_MAX_PAGES; page += 1) {
      const body = await this.request(op, path, { ...search, limit, cursor });
      if (!("data" in body)) {
        // `data: null` is the empty page — the key present. A body without the
        // key at all is a renamed field, an error served with a 200, or a
        // rewritten response, none of which is evidence that the account has
        // no rows. Coercing it to [] would end the walk on this page and report
        // the dataset as fully synced with nothing in it and nothing red
        // anywhere — the same defect Brevo's collectionOf() refuses.
        throw new ConnectorBlockedError(
          `${op} returned a 200 with no \`data\` key`,
          "Pipedrive's documented v2 list envelope carries `data` on every page (null for an " +
            "empty one), and this response does not. Refusing to interpret it rather than " +
            "reporting zero rows as a clean result.",
        );
      }
      const data = body.data;
      if (data != null && !Array.isArray(data)) {
        throw new ConnectorBlockedError(
          `${op} returned a non-array \`data\` (${typeof data})`,
          "Pipedrive's response did not match the documented v2 list contract. Refusing to " +
            "interpret it rather than guessing at a shape.",
        );
      }
      for (const row of (data ?? []) as unknown[]) {
        if (row !== null && typeof row === "object") rows.push(row as Record<string, unknown>);
      }
      const next = PipedriveConnector.nextCursor(body);
      if (next === undefined) return rows;
      if (next === cursor) {
        throw new ConnectorBlockedError(
          `${op} received the same cursor twice`,
          "Pipedrive returned a next_cursor identical to the one just used, which cannot " +
            "terminate. Refusing rather than walking forever — each turn spends the " +
            "customer's daily token budget, which is shared with their other integrations.",
        );
      }
      cursor = next;
    }
    throw new ConnectorBlockedError(
      `${op} stopped after ${PIPEDRIVE_MAX_PAGES} pages`,
      "the collection never reported a null next_cursor; aborting rather than paging forever.",
    );
  }

  /** The documented next-page marker, or undefined when the dataset is
   *  exhausted. Pipedrive: "The value of the next_cursor field will be null if
   *  you have reached the end of the dataset". An absent `additional_data` is
   *  read the same way as a null cursor — both mean there is no next page, and
   *  treating a missing envelope as "keep going" would be a loop. */
  private static nextCursor(body: Record<string, unknown>): string | undefined {
    const extra = body.additional_data;
    if (extra === null || typeof extra !== "object") return undefined;
    const next = (extra as Record<string, unknown>).next_cursor;
    return typeof next === "string" && next !== "" ? next : undefined;
  }

  // ── Connector interface ───────────────────────────────────────────────────

  /**
   * Open the connection and VERIFY the company domain, rather than assume it.
   *
   * `GET /api/v1/users/me` is the cheapest authenticated read Pipedrive offers
   * and proves three things at once: the token works, egress to this tenant's
   * host is permitted, and the token belongs to the company this connection
   * says it does. The third is the one that rots silently, because a customer
   * can rename their company domain from Pipedrive's own settings and nothing
   * notifies an integration.
   */
  async connect(): Promise<void> {
    await this.verifyCompanyDomain();
    this.fingerprint = computeSchemaFingerprint(this.tables());
  }

  /**
   * Confirm that the token's account still uses the stored company domain.
   *
   * The one call in this connector that goes to `/api/v1/...`, and it is the
   * documented path rather than a fallback — see
   * {@link PIPEDRIVE_USERS_ME_PATH}. It dials the customer's OWN host, not
   * `api.pipedrive.com`: the connect flow has already collected the domain, so
   * there is no bootstrap problem to solve and no second destination to
   * register.
   */
  async verifyCompanyDomain(): Promise<PipedriveDomainProbe> {
    let body: Record<string, unknown>;
    try {
      body = await this.request("verifyCompanyDomain", PIPEDRIVE_USERS_ME_PATH);
    } catch (err) {
      if (err instanceof PipedriveCapabilityMissingError) {
        this.probe = { state: "forbidden", status: err.status, probedAt: this.now() };
      }
      throw err;
    }
    const data = body.data;
    const reported =
      data !== null && typeof data === "object"
        ? (data as Record<string, unknown>).company_domain
        : undefined;
    // A response with no `company_domain` proves the token works but says
    // nothing about the domain, so the probe stays honest about which of the
    // two it verified rather than reporting a match it did not see.
    if (typeof reported !== "string" || reported.trim() === "") {
      this.probe = { state: "ok", companyDomain: this.companyDomain, probedAt: this.now() };
      return this.probe;
    }
    const normalised = reported.trim().toLowerCase();
    if (normalised !== this.companyDomain) {
      this.probe = {
        state: "changed",
        configured: this.companyDomain,
        reported: normalised,
        probedAt: this.now(),
      };
      throw new PipedriveCompanyDomainChangedError(this.companyDomain, normalised);
    }
    this.probe = { state: "ok", companyDomain: normalised, probedAt: this.now() };
    return this.probe;
  }

  async close(): Promise<void> {
    this.apiToken = null;
  }

  async health(): Promise<{ ok: boolean }> {
    // Derived from the same explicit state `status()` reports, not from
    // whichever fields happen to be populated.
    const state = await this.state();
    if (state === "needs_reconnect") {
      throw new PipedriveReauthorizationRequiredError("the stored API token is not usable");
    }
    if (state === "capability_missing") {
      throw new PipedriveCapabilityMissingError(
        PIPEDRIVE_USERS_ME_PATH,
        this.probe.state === "forbidden" ? this.probe.status : 403,
      );
    }
    if (state === "disconnected") {
      throw this.blocked("health", "no Pipedrive account is connected");
    }
    return { ok: true };
  }

  /** The canonical shape this track serves. Synthesized rather than
   *  introspected: Pipedrive's schema is Pipedrive's, published and stable, so
   *  there is nothing to discover — but the fingerprint still has to exist so
   *  drift-freeze semantics stay coherent across every track. */
  private tables(): IntrospectedTable[] {
    return PIPEDRIVE_DATASETS.map((dataset) => ({
      name: dataset,
      owner: PIPEDRIVE_PROVIDER,
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
   * Serve a named CRM read as canonical rows.
   *
   * Filter params are OPTIONAL, as on the HubSpot and Mailchimp tracks: the
   * registry's queries carry mandatory filters written for the SQL track, while
   * the sync runner passes `{}` or `{ since }` and wants the dataset
   * enumerated. A param that is present filters; one that is absent enumerates.
   *
   * `since` reaches the vendor as `updated_since` — the documented delta filter
   * on every one of these five endpoints — rather than being applied to the
   * mapped rows, because pushing it down is the whole point of having it.
   */
  async runRead(name: string, params: Record<string, unknown>): Promise<unknown[]> {
    const query = getReadQuery(name);
    // Still the capability statement it always was: `[]` from a read this track
    // cannot serve reads as "you have none of those", which no caller can tell
    // apart from a genuinely empty pipeline.
    assertDatasetsServed(this.provider, this.servesDatasets, name, query.dependsOnTables);
    const dataset = query.dependsOnTables[0];
    const op = `runRead:${name}`;
    const since = canonicalInstant(params.since);

    // Refused BEFORE any I/O: this read is answered from a column Pipedrive has
    // no source for, and an empty-columned answer would read as a fact about
    // stock. See PipedriveColumnNotAvailableError.
    if (name === "get_low_stock_products") {
      throw new PipedriveColumnNotAvailableError(name, "product", "inventory_quantity");
    }

    const rows = await this.enumerate(dataset, since);

    switch (name) {
      case "find_contact": {
        const prefix = PipedriveConnector.lowerText(params.query);
        const matched =
          prefix === undefined
            ? rows
            : rows.filter((r) => PipedriveConnector.lowerText(r.last_name)?.startsWith(prefix));
        // `ORDER BY last_name, first_name`.
        return sortByKey(sortByKey(matched, "first_name"), "last_name");
      }
      case "get_company": {
        const wanted = PipedriveConnector.lowerText(params.companyId);
        return wanted === undefined
          ? rows
          : rows.filter((r) => PipedriveConnector.lowerText(r.company_id) === wanted);
      }
      case "get_deals_by_stage": {
        // The caller names a Pipedrive STAGE ID, because stage names are
        // per-pipeline and renameable — see the `stage` case in
        // `pipedriveLookup`.
        const stage = PipedriveConnector.lowerText(params.stage);
        const matched =
          stage === undefined
            ? rows
            : rows.filter((r) => PipedriveConnector.lowerText(r.stage) === stage);
        // `ORDER BY amount DESC, deal_id`. Sorted ascending then reversed would
        // also reverse the id tiebreak, so the descending leg is its own pass.
        const byId = sortByKey(matched, "deal_id");
        return [...byId].sort((a, b) => Number(b.amount ?? 0) - Number(a.amount ?? 0));
      }
      case "get_engagements": {
        const windowed = PipedriveConnector.inWindow(rows, "occurred_at", params.from, params.to);
        // `ORDER BY occurred_at DESC, engagement_id`.
        const byId = sortByKey(windowed, "engagement_id");
        return [...byId].sort((a, b) =>
          String(b.occurred_at ?? "").localeCompare(String(a.occurred_at ?? "")),
        );
      }
      default:
        // Unreachable while every served read is handled above; a new registry
        // entry on a served dataset lands here rather than silently returning
        // nothing, which would read as "your pipeline is empty".
        throw this.blocked(op, "read is not served by the Pipedrive track");
    }
  }

  /**
   * Enumerate one canonical dataset as canonical rows.
   *
   * One walk of the dataset's own v2 collection, projected through
   * `projectCanonicalRow`, so the row's key set is `CANONICAL_COLUMNS[dataset]`
   * by construction rather than by convention.
   */
  private async enumerate(dataset: DatasetName, since: string | undefined): Promise<CanonicalRow[]> {
    const page = await this.listDataset(dataset, { updatedSince: since });
    return page.rows.map((record) => projectCanonicalRow(dataset, pipedriveLookup(dataset, record)));
  }

  async applyWrite(name: string, _params: Record<string, unknown>): Promise<unknown> {
    // Same validation order as every other track, so a caller bug produces the
    // same typed error here as anywhere else...
    const cmd = getWriteCommand(name);
    assertTargetAllowed(cmd.targetTable);
    // ...and then this track refuses. A Pipedrive API token carries the full
    // permissions of the user who owns it, with no read-only variant available
    // at any plan tier, so the only boundary on what this connector could do to
    // a customer's CRM is this one. Deal-stage changes, contact merges, record
    // deletion and export are not later tickets — there is no write surface in
    // this connector at any tier, and the test suite fails the build if one
    // appears.
    throw this.blocked(
      `applyWrite:${name}`,
      "the Pipedrive track is read-only — no create, update, delete or merge surface exists " +
        "in this connector at any tier. That matters more here than on most tracks: the API " +
        "token is full account access at its owning user's permission level, so this refusal " +
        "is the only thing standing between an agent and a customer's sales system of record",
    );
  }

  // ── The pipeline surface ──────────────────────────────────────────────────

  /**
   * One dataset, incrementally, by cursor.
   *
   * The delta filter is passed through verbatim as
   * {@link PIPEDRIVE_DELTA_PARAM}. Omitting it would NOT fail — it would
   * silently become a full scan returning correct-looking rows — which is why
   * the tests assert the filter is on the outgoing URL rather than on the rows
   * that came back.
   *
   * The walk is sorted by `update_time` ascending so the watermark advances
   * monotonically across pages: a descending or unsorted walk cannot produce a
   * watermark that is safe to persist before the last page has been read.
   */
  async listDataset(
    dataset: DatasetName,
    filters: {
      updatedSince?: string;
      updatedUntil?: string;
      pageSize?: number;
    } = {},
  ): Promise<PipedrivePage> {
    const path = PIPEDRIVE_DATASET_ENDPOINTS[dataset];
    if (path === undefined) {
      throw this.blocked(
        `listDataset:${dataset}`,
        "the Pipedrive track has no endpoint for that dataset",
      );
    }
    // Products document `updated_since` and no `updated_until`. Refused here
    // rather than sent and silently ignored.
    assertPipedriveWindow(dataset, filters.updatedUntil);
    // Rendered in the vendor's documented second-precision form at the ONE
    // place the wire query is assembled, so every caller — `runRead`, the sync
    // runner, a direct `listDataset` — sends the same shape. See
    // {@link pipedriveWireInstant} for why the millisecond form is not sent and
    // why truncation is the only safe direction on an inclusive boundary.
    const rows = await this.walk(
      `listDataset:${dataset}`,
      path,
      {
        [PIPEDRIVE_DELTA_PARAM]: pipedriveWireInstant(PIPEDRIVE_DELTA_PARAM, filters.updatedSince),
        [PIPEDRIVE_WINDOW_END_PARAM]: pipedriveWireInstant(
          PIPEDRIVE_WINDOW_END_PARAM,
          filters.updatedUntil,
        ),
        sort_by: PIPEDRIVE_SORT_FIELD,
        sort_direction: PIPEDRIVE_SORT_DIRECTION,
      },
      filters.pageSize ?? PIPEDRIVE_DEFAULT_PAGE_SIZE,
    );
    return PipedriveConnector.pageOf(rows);
  }

  /**
   * Compute the watermark and the ids that sit exactly on it.
   *
   * The watermark stays the VENDOR's own string, because it is fed straight
   * back as `updated_since`; re-formatting it would be one more place for the
   * two to disagree. `watermarkIds` exists because the boundary is inclusive —
   * see {@link PipedrivePage}.
   */
  private static pageOf(rows: Record<string, unknown>[]): PipedrivePage {
    let watermark: string | undefined;
    for (const r of rows) {
      const t = r.update_time;
      if (typeof t === "string" && (watermark === undefined || t > watermark)) watermark = t;
    }
    const watermarkIds =
      watermark === undefined
        ? []
        : rows
            .filter((r) => r.update_time === watermark)
            .map((r) => PipedriveConnector.text(r.id))
            .filter((id): id is string => id !== undefined);
    return { rows, watermark, watermarkIds };
  }

  /** A vendor value as trimmed text, or undefined when absent/empty. Pipedrive
   *  ids arrive as JSON numbers for what is semantically an opaque
   *  identifier. */
  private static text(value: unknown): string | undefined {
    if (typeof value === "string") {
      const raw = value.trim();
      return raw === "" ? undefined : raw;
    }
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return undefined;
  }

  /** Case-folded text for a comparison, or undefined for an absent value.
   *  Stage ids and names are vendor-supplied strings whose casing a caller has
   *  no way to know. */
  private static lowerText(value: unknown): string | undefined {
    const raw = PipedriveConnector.text(value);
    return raw === undefined ? undefined : raw.toLowerCase();
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

  // ── State ─────────────────────────────────────────────────────────────────

  /**
   * The connection's state, explicitly.
   *
   * Order matters: an unusable token outranks a capability limit, because
   * replacing the token is the only action that helps and enabling a permission
   * set would not. A token the VENDOR rejected outranks both — a resolvable,
   * well-shaped token that Pipedrive answers 401 to is not a connected account,
   * and reporting it as one is the failure this ordering exists to prevent.
   */
  private async state(): Promise<PipedriveConnectionState> {
    try {
      await this.token();
    } catch (err) {
      // No token resolvable = the owner has not connected an account. Not an
      // error: it is the shipped-off state ADR-041 §2 requires.
      if (err instanceof InvalidPipedriveCredentialError) return "needs_reconnect";
      return "disconnected";
    }
    // The vendor's own verdict on the credential, recorded by the 401 branch of
    // `request()`. Checked BEFORE the capability probe: only a new token helps.
    if (this.probe.state === "unauthorized") return "needs_reconnect";
    if (this.probe.state === "forbidden") return "capability_missing";
    if (this.probe.state === "changed") return "needs_reconnect";
    return "connected";
  }

  async status(): Promise<PipedriveStatus> {
    const state = await this.state();
    return {
      state,
      // One source of truth: `ok` is derived from `state` rather than computed
      // independently, so the two cannot disagree inside one returned object.
      ok: state === "connected",
      // Report THAT a credential exists, never its value. Nothing in this
      // object can carry token material.
      hasApiToken: this.apiToken !== null,
      companyDomain: this.companyDomain,
      domainProbe: this.probe,
      burstLimit: this.governor.limit,
      burstWindowMs: this.governor.windowMs,
      requestTimeoutMs: this.timeoutMs,
      scanModes: PIPEDRIVE_SCAN_MODE,
      // Named for what it is — the VENDOR's capability, which this connector
      // does not use — and reported with the note that says so, because the
      // enum value alone was read as "deleted deals are covered".
      vendorDeletionVisibility: PIPEDRIVE_DELETION_VISIBILITY,
      deletedDealWindowNote: PIPEDRIVE_DELETED_DEAL_WINDOW_NOTE,
      dailyBudgetNote: PIPEDRIVE_DAILY_BUDGET_NOTE,
    };
  }

  /** The connection row's id, for callers that scope by connection rather than
   *  by provider. */
  get connectionId(): string {
    return this.config.connectionId;
  }

  /** The last computed schema fingerprint, or null before `introspect()`. */
  get schemaFingerprint(): string | null {
    return this.fingerprint;
  }
}
