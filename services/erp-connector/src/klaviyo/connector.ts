/**
 * `KlaviyoConnector`: the marketing-automation track (free-integrations wave 1).
 *
 * Reads a small business's Klaviyo account — who is on their lists, what
 * consent state each person is in, what campaigns went out and how they
 * performed, and what each contact actually did — over Klaviyo's JSON:API
 * surface, on a private API key the customer mints in their own account. Same
 * {@link Connector} interface, same blocked-error contract, same read-through
 * posture as every other cloud track, so nothing upstream of it changes.
 *
 * ## What makes this track different: the host is STATIC, and that is a gift
 *
 * State this first because the neighbouring file argues the exact opposite.
 * `../mailchimp/connector.ts` assembles its host at runtime from the datacenter
 * suffix inside the customer's key, which is why that file deliberately carries
 * NO `https://…` literal and why its `allowed-egress.yaml` entry is
 * `kind: dynamic` — an entry that registers zero host patterns and therefore
 * enforces nothing.
 *
 * Klaviyo has one global endpoint. There are no regional shards and no
 * EU-residency host: Klaviyo stores all customer data in the United States, so
 * a single hostname covers every customer this connector will ever serve. That
 * makes {@link KLAVIYO_API_BASE_URL} a whole-string `https://` literal on
 * purpose — the static egress scanner extracts exactly that shape from tracked
 * source, so the registry entry is `kind: egress` and CI genuinely enforces
 * where this connector dials. DO NOT "harmonise" this file with the Mailchimp
 * one by splitting the URL into parts; the no-scheme-literal rule over there is
 * a workaround for a limitation that does not exist here, and copying it would
 * throw away the only static enforcement available.
 *
 * {@link KLAVIYO_ALLOWED_API_HOSTS} is DERIVED from that literal rather than
 * hand-written, in the shape `../quickbooks/online-connector.ts` uses. A
 * hand-kept host list only ever drifts in one direction — towards dialling
 * more — and a second base URL cannot be added here without its host becoming a
 * repo literal the egress gate extracts and checks.
 *
 * ## Two mandatory headers, and a third that converts a time bomb into an error
 *
 * Every request carries BOTH:
 *
 *   Authorization: Klaviyo-API-Key pk_…      the credential
 *   revision: 2026-07-15                     the API version
 *
 * The revision header is not a default this connector supplies for tidiness. It
 * is listed as a header parameter on every endpoint reference and appears in
 * every documented example. (Honest caveat, and it is a downgrade from what the
 * build spec claimed: no Klaviyo page checked for this build states in words
 * that it is MANDATORY. It is sent unconditionally regardless, and
 * {@link KlaviyoConnector.probePlanAccess} is where the empirical answer would
 * land.)
 *
 * The third header is the interesting one. Klaviyo's versioning policy documents
 * FALL-FORWARD as the default: a retired revision date does not error, Klaviyo
 * *"falls forward and responds to your request with the same behavior as the
 * next oldest revision"*. An appliance sitting in a back office still sending
 * `2026-07-15` after that revision retires (roughly 2028-07-15, on the
 * documented 1-year-stable-plus-1-year-deprecated window) would keep receiving
 * `200`s carrying a DIFFERENT response shape — a silent, two-year-fused change
 * of meaning on hardware nobody is watching.
 *
 * Klaviyo ships a first-class kill switch for precisely that, and this connector
 * uses it: {@link KLAVIYO_FALL_FORWARD_OPT_OUT_HEADER} set to `1` makes a
 * retired revision return `410` instead. That turns the worst failure mode in
 * this vendor from silent drift into {@link KlaviyoRevisionRetiredError} — a
 * named, loud, testable state with an obvious remedy. The `apiRevision` config
 * field is the remediation for that 410 in the field; it is NOT the primary
 * defence, and describing it as such (as the build spec did) understates what
 * the vendor already gives us.
 *
 * ## The delta filters are PER-ENDPOINT and the field is not even spelled alike
 *
 * This is the fact most likely to be broken by a well-meaning refactor, and its
 * failure mode is a full scan REPORTED AS an incremental read:
 *
 *   /api/profiles          greater-than(updated, …)        strict `>` ONLY
 *   /api/lists             greater-than(updated, …)        strict `>` ONLY —
 *                                                          not even less-than
 *   /api/campaigns         greater-or-equal(updated_at, …) all four operators,
 *                                                          and the field really
 *                                                          is `updated_at` here
 *   /api/events            greater-or-equal(datetime, …)   all four operators
 *   /api/lists/{id}/profiles   NOTHING. See below.
 *
 * Klaviyo parses its filter expression, so a malformed one errors rather than
 * being ignored — better than Mailchimp. But the WRONG FIELD on the RIGHT
 * endpoint is still the classic silent full scan, so the parameter set is
 * guarded at request time by {@link assertKlaviyoDeltaClause} and built only by
 * {@link klaviyoDeltaClause}, never typed inline. Every literal is pinned in
 * `__tests__/klaviyo.test.ts` against the vendor reference page that states it.
 *
 * ### List membership cannot be read incrementally AT ALL
 *
 * `/api/lists/{id}/profiles` documents exactly five filters — email,
 * phone_number, push_token, _kx, joined_group_at — and no `updated`. So
 * `audience_member` is {@link KLAVIYO_SCAN_MODE full_scan_only}: not
 * unimplemented, impossible. `joined_group_at` is a JOIN time, so it can find
 * new members but can never see one who LEFT or whose consent changed, which is
 * the half that matters for a dataset whose whole purpose is not mailing
 * somebody who opted out.
 *
 * Nor may the account-level `/api/profiles` delta be substituted for it:
 * whether a list join or leave bumps a profile's `updated` is NOT documented,
 * and covering membership that way would be an assumption presented as a delta.
 * The only stable ordering that endpoint offers is `joined_group_at`, so a
 * resumable scan has exactly one design and it is the one below.
 *
 * ## `audience` costs an N+1 fan-out, and the collection endpoint cannot help
 *
 * `member_count` is REQUIRED for `audience` (`export-drop/profiles.ts`) and the
 * only source for it is `additional-fields[list]=profile_count` — which exists
 * ONLY on the singular `GET /api/lists/{id}`. It is NOT a parameter of the
 * plural `GET /api/lists`, whose complete documented query set is
 * fields[flow], fields[list], fields[tag], filter, include, page[cursor],
 * page[size], sort.
 *
 * That distinction is worth the paragraph because JSON:API endpoints do not
 * reliably reject an unrecognised query parameter: attaching profile_count to
 * the collection would return lists with no counts while the connector believed
 * it had asked for them. {@link assertKlaviyoProfileCountPath} refuses that at
 * request time rather than trusting a comment.
 *
 * So `audience` is a two-stage read: enumerate with `GET /api/lists`
 * (page[size] max 10 — the tightest ceiling in the API), then one
 * `GET /api/lists/{id}?additional-fields[list]=profile_count` per list against
 * a 1/s + 15/m bucket. 200 lists is 20 collection pages PLUS 200 individual
 * reads at 15/m: roughly fourteen minutes of wall clock for the counts alone,
 * drawn from a bucket shared with everything else the account does. That is a
 * cadence decision, not a throughput one — see {@link KLAVIYO_RATE_LIMITS}.
 *
 * ## Rate limits are PER ACCOUNT, not per key
 *
 * Klaviyo documents this explicitly: *"OAuth apps receive their own rate limit
 * quota per installed app instance … while private key integrations share the
 * same rate limit quota per account."* We deliberately took the private-key
 * path (no registered developer app, no partner review, nothing about Warp Lab
 * is reviewed by anybody), so the box draws on the SAME bucket as the
 * customer's Shopify sync and their agency's scripts.
 *
 * Two consequences, both load-bearing: a 429 does not prove our accounting is
 * wrong and must not surface as a Droplet defect, and our polling can degrade
 * the customer's other integrations. So 429 is a named, retried-with-jitter
 * state ({@link KlaviyoRateLimitedError}) rather than an error we treat as a
 * bug, and the setup guide says plainly that we share their allocation.
 *
 * ## Campaign counts cost 225 calls a DAY, total
 *
 * `emails_sent` is REQUIRED for `campaign` and exists nowhere on
 * `/api/campaigns`. It is the Reporting API's `recipients` statistic, reachable
 * only through `POST /api/campaign-values-reports`, which refuses any request
 * lacking `conversion_metric_id` and is capped at 1/s, 2/m and 225/DAY.
 *
 * A daily cap is not a throttle you back off from; it is a hard budget shared
 * with everything else the account does. {@link DailyCallBudget} makes it a
 * first-class typed state rather than a 429 nobody expected. And the report is
 * requested ONCE PER READ, grouped by campaign — never once per campaign, which
 * is what exhausts the budget on an account with a few hundred sends.
 *
 * ## A POST in a read-only connector
 *
 * `campaign-values-reports` is a QUERY that Klaviyo happens to have shaped as a
 * POST: the request body carries statistics, a timeframe and a conversion
 * metric, and the response carries numbers. It creates nothing and changes
 * nothing.
 *
 * That is still the one place a reviewer must be able to satisfy themselves, so
 * the method is not a free parameter: {@link assertKlaviyoMethod} allows `GET`
 * everywhere and `POST` to EXACTLY the paths in
 * {@link KLAVIYO_POST_QUERY_PATHS}, which contains that one report path and
 * nothing else. Every other verb is refused by shape. There is no subscribe, no
 * suppress, no profile-import, no campaign-send surface in this connector at any
 * tier, and {@link KlaviyoConnector.applyWrite} throws.
 *
 * ## The ADR-041 conditions, as they land here
 *
 *   1. **Only ever dials out.** The box accepts no inbound connections, so
 *      Klaviyo's webhook feed is structurally unavailable and polling is the
 *      only ingestion path. A constraint, not a preference.
 *   2. **Ships off; owner consent is the enabling event.** With no key resolved
 *      every I/O method blocks honestly rather than half-authenticating.
 *   3. **Every destination registered.** One static host, `kind: egress`, and
 *      {@link assertSafeKlaviyoBaseUrl} enforces it in code as well.
 *   4. **Persistence: none.** ADR-041 §4 warns the encryption `ErpEntityCache`
 *      promises is NOT implemented (WARP-2028). This track is read-through and
 *      writes nothing. Watermarks are RETURNED to the caller.
 *   5. **The key is an account-level standing credential** with no expiry.
 *      Never logged, never in a tracked file, never echoed back in an error,
 *      and never embedded in a thrown URL.
 *
 * ## Money
 *
 * None of the five datasets this track serves carries a money column — every
 * number in them is a COUNT (see {@link assertKlaviyoDatasetsCarryNoMoney},
 * which fails at module load if that ever stops being true). That is a decision
 * rather than an accident: a Klaviyo "Placed Order" event is an untyped custom
 * property bag with no guaranteed currency, and `ecommerce_order` REQUIRES both
 * `total_amount` and `currency`, so serving it would mean inferring a schema.
 * The `$value` on an event and `conversion_value` on a report are money-shaped
 * and are deliberately never projected onto a canonical row. If a future
 * dataset does carry money here, it converts at THIS boundary into a decimal in
 * MAJOR units with an explicit sibling `currency`, exactly as
 * `../stripe/connector.ts`'s `majorUnits` does — a count must never be filed as
 * money, and money without a currency is not a number.
 *
 * ## Two questions this connector does NOT pretend to have answered
 *
 *   1. **Free-plan API access.** Klaviyo's free tier is real (250 active
 *      profiles, 500 sends/month) and nothing in the API-key documentation
 *      gates key creation by plan — but no Klaviyo page affirmatively states
 *      that a Free account may issue API calls. Carried as an explicit unknown
 *      ({@link KLAVIYO_PLAN_PREREQUISITE}) and turned into an EMPIRICAL result
 *      at connect time by {@link KlaviyoConnector.probePlanAccess}, never
 *      assumed away.
 *   2. **Klaviyo's API terms of use were not read for this build.** Deletion on
 *      request, privacy-policy and audit-rights obligations are therefore
 *      unanswered — see {@link KLAVIYO_UNRESOLVED_OBLIGATIONS}. The deletion
 *      obligation is discharged in code anyway, by
 *      {@link KlaviyoConnector.purgeAccount}, because it is cheaper to have
 *      built it than to discover we owe it.
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
import { sortByKey } from "../api-dto.js";
import { CANONICAL_COLUMNS, COLUMN_KIND, type DatasetName } from "../export-drop/profiles.js";
import {
  canonicalInstant,
  projectCanonicalRow,
  type CanonicalRow,
  type VendorLookup,
} from "../canonical-row.js";

/** Provider key for this track. */
export const KLAVIYO_PROVIDER = "klaviyo";

/**
 * The ONE host this connector will ever send a private API key to.
 *
 * A WHOLE-STRING `https://` LITERAL on purpose. `scripts/check-egress-allowlist.py`
 * is a static text scan that extracts exactly this shape from tracked source,
 * so writing it whole is what makes the registry entry enforceable rather than
 * decorative. Do not split it, template it, or read it from configuration — and
 * do not copy the Mailchimp file's no-scheme-literal rule over here, which
 * exists only because that vendor has no static host to write down.
 *
 * Klaviyo publishes no regional or EU-residency API host: all customer data is
 * stored in the United States, so this single host covers every customer.
 */
export const KLAVIYO_API_BASE_URL = "https://a.klaviyo.com";

/**
 * The exact hosts a base URL may name — DERIVED from the literal above, never
 * hand-written.
 *
 * The same shape `QBO_ALLOWED_API_HOSTS` uses, and for the same reason: a
 * hand-kept list drifts in exactly one direction, towards dialling more. Adding
 * a second destination has to mean adding a second base-URL literal, which the
 * egress gate then extracts and demands a registry entry for.
 */
export const KLAVIYO_ALLOWED_API_HOSTS: ReadonlySet<string> = new Set(
  [KLAVIYO_API_BASE_URL].map((u) => new URL(u).hostname),
);

/** The path every Klaviyo API resource hangs off. */
export const KLAVIYO_API_BASE_PATH = "/api";

/**
 * The pinned API revision.
 *
 * The most recent GA revision in Klaviyo's changelog as of this build
 * (the 2026 GA line is 2026-01-15, 2026-04-15, 2026-07-15). The support window
 * is two years — one stable plus one deprecated — so this pin retires around
 * 2028-07-15, at which point the fall-forward opt-out below turns every request
 * into a `410` and {@link KlaviyoConnectorConfig.apiRevision} is how a box
 * already in the field moves forward without a firmware change.
 */
export const KLAVIYO_API_REVISION = "2026-07-15";

/** The version header's name. Sent on every request, unconditionally. */
export const KLAVIYO_REVISION_HEADER = "revision";

/**
 * The header that converts a retired revision from silent drift into a `410`.
 *
 * Klaviyo's versioning policy makes fall-forward the DEFAULT: a retired
 * revision date is answered *"with the same behavior as the next oldest
 * revision"*, which means `200`s carrying a shape this connector never parsed.
 * Opting out is one header and it is the single highest-value line in this
 * file — see the module docstring.
 */
export const KLAVIYO_FALL_FORWARD_OPT_OUT_HEADER = "X-Klaviyo-Revision-Fall-Forward-Opt-Out";

/** The opt-out header's only meaningful value. */
export const KLAVIYO_FALL_FORWARD_OPT_OUT_VALUE = "1";

/**
 * The authorization scheme token, verbatim.
 *
 * `Authorization: Klaviyo-API-Key <key>` — not `Bearer`, not `Basic`. Kept as
 * its own constant so the exact wire shape is pinned in one place and the test
 * can assert the whole header character for character.
 */
export const KLAVIYO_AUTHORIZATION_SCHEME = "Klaviyo-API-Key";

/** Every private key begins with this. Klaviyo's own documented prefix. */
export const KLAVIYO_PRIVATE_KEY_PREFIX = "pk_";

/**
 * The credential shape accepted at intake.
 *
 * ## Why the character class is strict and the length is loose
 *
 * The key is interpolated into an HTTP header value. A credential carrying CR,
 * LF or a NUL is a header-injection primitive, so the class is pinned to
 * printable non-space ASCII (`!`–`~`) and nothing else — that half is a
 * security property and loosening it should be hard.
 *
 * The LENGTH is deliberately generous. Klaviyo documents the `pk_` prefix and
 * publishes no key-length contract, so pinning an exact digit count would be
 * inventing a rule the vendor never stated and rejecting a paying customer's
 * valid key for no security gain — the same asymmetry
 * `MAILCHIMP_API_KEY_PATTERN` reasons through for the opposite vendor. Nothing
 * about this half ever becomes a hostname; it is presented as a credential and
 * nothing else.
 */
export const KLAVIYO_API_KEY_PATTERN = /^pk_[!-~]{8,512}$/;

/**
 * The datasets this track serves.
 *
 * All five ALREADY EXIST in the canonical vocabulary — none is invented here,
 * and the reuse calls are the interesting part:
 *
 *  • `contact` — a Klaviyo profile genuinely IS a CRM person: it carries
 *    first_name, last_name, email, organization, title, created and updated.
 *    That is exactly the distinction `export-drop/profiles.ts` draws when it
 *    REFUSES `contact` for Mailchimp, whose member is a subscription record
 *    with no name at all. `find_contact` is a LAST-NAME PREFIX search, and here
 *    `last_name` really is on the object. `company_id` and `lifecycle_stage`
 *    have no Klaviyo equivalent and stay undefined; `REQUIRED_CANONICAL` asks
 *    only for `contact_id`.
 *  • `audience` — a Klaviyo list maps one-for-one on id/name/created.
 *  • `audience_member` — one person's membership of one list.
 *  • `campaign` — one send, with its counts from the Reporting API.
 *  • `engagement` — a Klaviyo event is a timestamped interaction attached to a
 *    person, which is structurally what an `engagement` is. FLAGGED AS A
 *    DELIBERATE CALL, not an obvious one: this is by far the highest-volume
 *    dataset (Klaviyo sizes `/api/events` for firehose reads at 1000 rows a
 *    page and 3500 requests a minute), so routing every email open into a CRM
 *    timeline is a decision somebody should have to agree with.
 *
 * `ecommerce_order` was DECLINED — see the money section of the module
 * docstring.
 */
export const KLAVIYO_DATASETS = [
  "contact",
  "audience",
  "audience_member",
  "campaign",
  "engagement",
] as const satisfies readonly DatasetName[];

/** The five names above, as a type, so every per-dataset table is exhaustive. */
export type KlaviyoDataset = (typeof KLAVIYO_DATASETS)[number];

/**
 * How each dataset can be read — DECLARED, not an accident of the code.
 *
 * `audience_member` is `full_scan_only` because `/api/lists/{id}/profiles`
 * exposes no modification filter whatsoever. Declaring it lets a scheduler give
 * that dataset a much slower cadence, and stops the next engineer spending an
 * afternoon hunting for an `updated` filter that does not exist.
 */
export const KLAVIYO_SCAN_MODE: Readonly<Record<KlaviyoDataset, "delta" | "full_scan_only">> = {
  contact: "delta",
  audience: "delta",
  audience_member: "full_scan_only",
  campaign: "delta",
  engagement: "delta",
};

/**
 * One endpoint's verified facts: where it lives, how big a page it will serve,
 * and what it costs against the account's shared bucket.
 *
 * Kept as DATA rather than as numbers sprinkled through the request code,
 * because the ceilings differ sharply per endpoint and the difference is the
 * finding: `/api/lists` serves ten rows a page while `/api/events` serves a
 * thousand.
 */
export interface KlaviyoEndpoint {
  /** Path template. `{id}` is substituted with an encoded identifier. */
  readonly path: string;
  /** Documented `page[size]` ceiling. Zero means the endpoint has no such
   *  parameter at all (metrics: cursor only, max 200 results per page). */
  readonly maxPageSize: number;
  /** Documented burst window, requests per second, per ACCOUNT. */
  readonly burstPerSecond: number;
  /** Documented steady window, requests per minute, per ACCOUNT. */
  readonly steadyPerMinute: number;
}

export type KlaviyoEndpointId =
  | "profiles"
  | "lists"
  | "list"
  | "listProfiles"
  | "campaigns"
  | "events"
  | "metrics"
  | "campaignValuesReport";

/**
 * Every endpoint this connector may dial, with its verified ceilings.
 *
 * The `list` entry (singular) is separate from `lists` (plural) on purpose and
 * that separation is the whole `audience` finding: `additional-fields[list]` is
 * documented ONLY on the singular one, and its presence there drops the bucket
 * from 75/s + 750/m to 1/s + 15/m — a 50x cost for one column.
 */
export const KLAVIYO_ENDPOINTS: Readonly<Record<KlaviyoEndpointId, KlaviyoEndpoint>> = {
  profiles: {
    path: `${KLAVIYO_API_BASE_PATH}/profiles`,
    maxPageSize: 100,
    burstPerSecond: 75,
    steadyPerMinute: 750,
  },
  lists: {
    path: `${KLAVIYO_API_BASE_PATH}/lists`,
    // The tightest page ceiling in the whole API. Default 10, max 10.
    maxPageSize: 10,
    burstPerSecond: 75,
    steadyPerMinute: 750,
  },
  list: {
    path: `${KLAVIYO_API_BASE_PATH}/lists/{id}`,
    // A single resource: no paging at all.
    maxPageSize: 0,
    // WITH additional-fields[list]=profile_count, which is the only reason this
    // connector ever calls it. 50x more expensive than the collection read.
    burstPerSecond: 1,
    steadyPerMinute: 15,
  },
  listProfiles: {
    path: `${KLAVIYO_API_BASE_PATH}/lists/{id}/profiles`,
    maxPageSize: 100,
    burstPerSecond: 75,
    steadyPerMinute: 750,
  },
  campaigns: {
    path: `${KLAVIYO_API_BASE_PATH}/campaigns`,
    maxPageSize: 100,
    burstPerSecond: 10,
    steadyPerMinute: 150,
  },
  events: {
    path: `${KLAVIYO_API_BASE_PATH}/events`,
    maxPageSize: 1000,
    burstPerSecond: 350,
    steadyPerMinute: 3500,
  },
  metrics: {
    path: `${KLAVIYO_API_BASE_PATH}/metrics`,
    // Documented as exposing NO page[size] parameter at all — cursor only,
    // "returns a maximum of 200 results per page". Zero means "do not send it".
    maxPageSize: 0,
    burstPerSecond: 10,
    steadyPerMinute: 150,
  },
  campaignValuesReport: {
    path: `${KLAVIYO_API_BASE_PATH}/campaign-values-reports`,
    maxPageSize: 0,
    burstPerSecond: 1,
    steadyPerMinute: 2,
  },
};

/**
 * The documented rate tiers, restated as a flat table for the setup guide and
 * for anyone sizing a cadence.
 *
 * PER ACCOUNT and PER ENDPOINT, fixed-window, with two windows — burst (1s) and
 * steady (1m). Kept alongside {@link KLAVIYO_ENDPOINTS} rather than derived
 * from it so the daily cap, which no endpoint record has room for, sits with
 * the numbers it belongs with.
 */
export const KLAVIYO_RATE_LIMITS: Readonly<
  Record<KlaviyoEndpointId, { burstPerSecond: number; steadyPerMinute: number; perDay?: number }>
> = {
  profiles: { burstPerSecond: 75, steadyPerMinute: 750 },
  lists: { burstPerSecond: 75, steadyPerMinute: 750 },
  list: { burstPerSecond: 1, steadyPerMinute: 15 },
  listProfiles: { burstPerSecond: 75, steadyPerMinute: 750 },
  campaigns: { burstPerSecond: 10, steadyPerMinute: 150 },
  events: { burstPerSecond: 350, steadyPerMinute: 3500 },
  metrics: { burstPerSecond: 10, steadyPerMinute: 150 },
  campaignValuesReport: { burstPerSecond: 1, steadyPerMinute: 2, perDay: 225 },
};

/**
 * The complete set of API resources this connector may ever dial.
 *
 * An ALLOWLIST checked at request time by {@link assertReadableKlaviyoResource},
 * never a denylist of forbidden words in source. That distinction is a rule
 * this codebase learned on the Stripe track: request paths are ASSEMBLED AT
 * RUNTIME, so a denylist only ever catches the literals somebody happened to
 * type and a path built from a route table walks straight past it.
 *
 * Absent on purpose, and every one of them is a real Klaviyo endpoint: campaign
 * SEND jobs, profile import jobs, subscription and suppression jobs, template
 * mutation, flow control. Sending to a list is irreversible and externally
 * visible to every one of a customer's contacts — the worst possible candidate
 * for an agent-initiated action — so "destructive is blocked" is a property of
 * this set rather than an intention someone held while writing the code.
 */
export const KLAVIYO_READABLE_RESOURCES: ReadonlySet<string> = new Set([
  "profiles",
  "lists",
  "campaigns",
  "events",
  "metrics",
  "campaign-values-reports",
]);

/**
 * The ONLY paths this connector may POST to.
 *
 * Klaviyo shapes its reporting queries as POSTs — the body carries statistics,
 * a timeframe and a conversion metric, and the response carries numbers. That
 * is a read wearing a write's verb, and it is the single reason a POST exists
 * in a read-only connector at all.
 *
 * Because "it's really a read" is a claim and not a control, the verb is
 * checked against this set by {@link assertKlaviyoMethod} before a request is
 * built. Every other path is GET-only and every other verb is refused outright.
 */
export const KLAVIYO_POST_QUERY_PATHS: ReadonlySet<string> = new Set([
  KLAVIYO_ENDPOINTS.campaignValuesReport.path,
]);

/**
 * The mandatory channel predicate on `/api/campaigns`.
 *
 * *"A channel filter is required to list campaigns."* Omitting it is an ERROR,
 * not an unfiltered list — one of the few places this vendor fails loudly — and
 * this connector reads email campaigns only, because `subject` comes from the
 * email message content and an SMS campaign has none.
 */
export const KLAVIYO_CAMPAIGN_CHANNEL_FILTER = 'equals(messages.channel,"email")';

/**
 * The sideload that carries a campaign's SUBJECT.
 *
 * `/api/campaigns` alone yields no subject at all. The line a recipient
 * actually sees lives on the campaign's MESSAGE, at
 * `attributes.definition.content.subject`, and `include=campaign-messages` is
 * the only way to get it in the same read — which is why the include is sent
 * unconditionally rather than only when a delta is in play.
 *
 * Both spellings are pinned because they are NOT the same string and the
 * difference is silent: the relationship key on the campaign resource is the
 * PLURAL `campaign-messages`, while each included resource's `type` is the
 * SINGULAR `campaign-message`. Reading the wrong one of the two leaves every
 * campaign's subject blank while the request still pays for the sideload.
 */
export const KLAVIYO_CAMPAIGN_MESSAGE_INCLUDE = "campaign-messages";
export const KLAVIYO_CAMPAIGN_MESSAGE_TYPE = "campaign-message";

/**
 * The sideload that carries an event's human-readable name.
 *
 * UNVERIFIED against the vendor's `include` enum for this build, and flagged
 * exactly the way {@link KLAVIYO_REPORT_TIMEFRAME_KEY} is: `/api/events`
 * documents a `metric` relationship, but the enum member `include` accepts was
 * not confirmed against a live account. What makes an unverified literal
 * supportable is that it cannot fail SILENTLY — a wrong member here would
 * otherwise leave `engagement.type` undefined on every row of the
 * highest-volume dataset in the track, so
 * {@link KlaviyoConnector.assertSideloadPresent} refuses a 200 that carries
 * rows and no `included` rather than serving blank types — and
 * {@link KlaviyoConnectorConfig.eventMetricInclude} exists so a box in the
 * field can be corrected without a firmware change.
 */
export const KLAVIYO_EVENT_METRIC_INCLUDE = "metric";
export const KLAVIYO_EVENT_METRIC_TYPE = "metric";

/**
 * The delta contract for one dataset.
 *
 * `operators` is the COMPLETE documented operator set for that field on that
 * endpoint, and it is what {@link assertKlaviyoDeltaClause} checks against.
 * Carrying the full set rather than only the one we use is the point: it is the
 * difference between "we happen to send greater-than here" and "greater-or-equal
 * DOES NOT EXIST on this field", and only the second one stops somebody
 * copying the campaigns clause onto profiles.
 */
export interface KlaviyoDeltaFilter {
  /** The filterable field, spelled EXACTLY as this endpoint spells it. */
  readonly field: string;
  /** The operator this connector uses. */
  readonly operator: string;
  /** Every operator the vendor documents for this field on this endpoint. */
  readonly operators: readonly string[];
  /** The ascending sort that must accompany it, so the cursor walk and the
   *  watermark advance in the same direction. */
  readonly sort: string;
}

/**
 * The delta filter per dataset — PER-ENDPOINT, and NOT uniform.
 *
 * Copying one of these onto another endpoint yields a 400 (Klaviyo parses the
 * expression) or, far worse, a syntactically-valid filter on a field that
 * endpoint does not have. Note in particular that campaigns spell the field
 * `updated_at` while profiles and lists spell it `updated`, and that neither
 * profiles nor lists has a `greater-or-equal` at all.
 *
 * `audience_member` is `null` — not "not yet implemented". The endpoint has no
 * modification filter, so the honest declaration is that no delta exists.
 */
export const KLAVIYO_DELTA_FILTERS: Readonly<
  Record<KlaviyoDataset, KlaviyoDeltaFilter | null>
> = {
  // Strict greater-than ONLY. There is no greater-or-equal on this field, which
  // is what makes the boundary rule below load-bearing.
  contact: {
    field: "updated",
    operator: "greater-than",
    operators: ["greater-than", "less-than"],
    sort: "updated",
  },
  // Tighter still: greater-than and nothing else. Not even less-than.
  audience: {
    field: "updated",
    operator: "greater-than",
    operators: ["greater-than"],
    sort: "updated",
  },
  // No modification filter of any kind. The complete documented filter set is
  // email, phone_number, push_token, _kx, joined_group_at.
  audience_member: null,
  // The full operator set, and the field is spelled `updated_at` HERE ONLY.
  campaign: {
    field: "updated_at",
    operator: "greater-or-equal",
    operators: ["greater-or-equal", "greater-than", "less-or-equal", "less-than"],
    sort: "updated_at",
  },
  engagement: {
    field: "datetime",
    operator: "greater-or-equal",
    operators: ["greater-or-equal", "greater-than", "less-or-equal", "less-than"],
    sort: "datetime",
  },
};

/**
 * The complete documented filter set on `/api/lists/{id}/profiles`.
 *
 * Enforced at request time by {@link assertKlaviyoMemberFilterField} rather than
 * merely asserted in a test, because the failure is silent in the direction
 * that matters: an invented `updated` predicate is at best a 400 and at worst a
 * scan somebody labels a delta. There is no `updated` in this list and that
 * absence IS the finding.
 */
export const KLAVIYO_LIST_PROFILES_FILTERS: ReadonlySet<string> = new Set([
  "email",
  "phone_number",
  "push_token",
  "_kx",
  "joined_group_at",
]);

/**
 * The only ordering `/api/lists/{id}/profiles` offers.
 *
 * `updated` is not sortable there, so a full scan of membership has exactly one
 * stable ordering and any resumable design must be built on it plus the opaque
 * cursor. There is no second option to weigh.
 */
export const KLAVIYO_LIST_PROFILES_SORT = "joined_group_at";

/**
 * The `additional-fields` parameter names this connector uses, and where each
 * one is legal.
 *
 * `profile_count` is the expensive one and the one that does not exist on the
 * collection endpoint. `subscriptions` is the cheap one: it is reachable on
 * `/api/lists/{id}/profiles` both as `fields[profile]` and as
 * `additional-fields[profile]`, and — unlike `predictive_analytics` — it
 * carries NO rate-limit penalty. That distinction matters because
 * `audience_member`'s whole reason to exist is the consent state, which lives
 * under `subscriptions`.
 */
export const KLAVIYO_PROFILE_COUNT_FIELD = "additional-fields[list]";
export const KLAVIYO_PROFILE_COUNT_VALUE = "profile_count";
export const KLAVIYO_MEMBER_SUBSCRIPTIONS_FIELD = "additional-fields[profile]";
export const KLAVIYO_MEMBER_SUBSCRIPTIONS_VALUE = "subscriptions";

/** Cursor pagination. The value is taken OPAQUELY from `links.next` and never
 *  constructed — see {@link KlaviyoConnector.cursorFrom}. */
export const KLAVIYO_CURSOR_PARAM = "page[cursor]";
export const KLAVIYO_PAGE_SIZE_PARAM = "page[size]";

/** Hard ceiling on pages one read may fetch, so an endpoint that never stops
 *  offering a `links.next` cannot spin forever. */
export const KLAVIYO_MAX_PAGES = 2000;

/**
 * This connector's request deadline.
 *
 * OURS, not the vendor's: Klaviyo documents no per-request timeout, so this is
 * a number we chose rather than one we matched, and it is stated that way so
 * nobody later "corrects" it to a vendor figure that does not exist.
 */
export const KLAVIYO_REQUEST_TIMEOUT_MS = 60_000;

/** How many times a 429 is retried before it surfaces. */
export const KLAVIYO_MAX_RETRIES = 3;

/** Backoff base when the vendor sends no `Retry-After`. Doubles per attempt. */
export const KLAVIYO_BACKOFF_BASE_MS = 1_000;

/** Cap on an honoured `Retry-After`, so a hostile or mistaken header cannot
 *  wedge a worker for an hour. */
export const KLAVIYO_MAX_RETRY_AFTER_SECONDS = 60;

/** The daily ceiling on `POST /api/campaign-values-reports`. A hard budget
 *  shared with everything else the account does — not a throttle. */
export const KLAVIYO_REPORT_CALLS_PER_DAY = 225;

/**
 * The statistics the campaign report is asked for.
 *
 * `recipients` is the `emails_sent` column `REQUIRED_CANONICAL` demands, and
 * the two engagement figures are the UNIQUE ones — `opens_unique` /
 * `clicks_unique` rather than raw event totals, because one recipient opening
 * four times is one open and the alternative makes an open rate exceed 100%.
 */
export const KLAVIYO_REPORT_STATISTICS: readonly string[] = [
  "recipients",
  "opens_unique",
  "clicks_unique",
];

/**
 * The report timeframe key.
 *
 * UNVERIFIED against the vendor's enum for this build and flagged as such: the
 * required attributes (`statistics`, `timeframe`, `conversion_metric_id`) are
 * confirmed, the enum member spelling is not. A wrong key here fails LOUDLY —
 * Klaviyo validates the report body — so this is a supportable unknown rather
 * than a silent one, and {@link KlaviyoConnectorConfig.reportTimeframeKey}
 * exists so a box in the field can be corrected without a firmware change.
 */
export const KLAVIYO_REPORT_TIMEFRAME_KEY = "last_12_months";

/** What this track is waiting on. Deliberately unlike the other tracks', so an
 *  installer triaging this is not sent looking for a QuickBooks company or a
 *  Mailchimp datacenter suffix. */
export const KLAVIYO_TRACK_REMEDIATION =
  "needs a Klaviyo PRIVATE API key (it begins pk_) created by the account owner at " +
  "Settings -> API keys -> Create Private API Key with a Read-only scope, stored on the " +
  "integration row — and the klaviyo-api entry in allowed-egress.yaml, since this " +
  "connector leaves the customer LAN";

/**
 * The plan prerequisite, in its honest form.
 *
 * Klaviyo's free tier is documented and real, and nothing in the API-key
 * documentation gates key creation by plan — but no Klaviyo page states
 * affirmatively that a Free account may issue API calls, and the pricing page
 * addresses INTEGRATIONS rather than the developer API. Every other fact this
 * connector is built on is verified; this one is not, so it is carried as an
 * explicit unknown and {@link KlaviyoConnector.probePlanAccess} turns it into
 * an empirical result at connect time. Rewrite this string only when a real
 * Free account has been probed.
 */
export const KLAVIYO_PLAN_PREREQUISITE =
  "free plan MAY work (unverified — probed at connect time, never assumed)";

/**
 * Obligations that are OPEN, recorded in-repo so they are not rediscovered at
 * audit time.
 *
 * Klaviyo's developer/API terms were NOT read for this build. The Mailchimp
 * track's equivalent list is not boilerplate — that vendor's API Use Policy
 * granted Intuit audit rights over our systems and facilities, which is an
 * unusual commitment for a product whose "systems" are appliances on customers'
 * premises — and nothing about Klaviyo may be assumed by analogy in either
 * direction.
 */
export const KLAVIYO_UNRESOLVED_OBLIGATIONS: readonly string[] = [
  "UNREAD (Romain): Klaviyo's API terms of use — deletion-on-request, mandatory privacy " +
    "policy, incident reporting, and any audit rights over our systems and facilities",
  "UNVERIFIED: whether a Free-plan Klaviyo account may issue API calls at all " +
    "(probed empirically at connect time; never assumed)",
];

// ─────────────────────────────────────────────────────────────────────────────
// Errors — distinct classes with distinct codes, so a caller tells them apart
// without string-matching a message. None of them may ever render as an empty
// result: "you have no contacts" is a plausible-looking answer for a small
// business and is unfalsifiable from the outside.
// ─────────────────────────────────────────────────────────────────────────────

/** Thrown when a connection names a destination this track will not dial. */
export class UnsafeKlaviyoBaseUrlError extends Error {
  readonly code = "UNSAFE_BASE_URL";
  constructor(reason: string) {
    super(`refusing to send a Klaviyo API key there: ${reason}`);
    this.name = "UnsafeKlaviyoBaseUrlError";
  }
}

/** Why a credential was refused at intake. An explicit enum, never inferred. */
export type KlaviyoCredentialRejection =
  | "empty"
  | "not_a_private_key"
  | "unsafe_characters"
  | "unrecognized";

const CREDENTIAL_ADVICE: Readonly<Record<KlaviyoCredentialRejection, string>> = {
  empty: "no value was supplied",
  not_a_private_key:
    "a Klaviyo PRIVATE key begins pk_. A public key (the six-character site ID used in " +
    "browser tracking snippets) cannot read anything and is not what Droplet needs. " +
    "Create one at Settings -> API keys -> Create Private API Key with a Read-only scope",
  unsafe_characters:
    "that value contains a space, a line break or a control character. It is most likely a " +
    "copy-paste that wrapped across two lines — copy the key again and paste it whole",
  unrecognized: "a Klaviyo private API key looks like pk_ followed by a long random string",
};

/**
 * Thrown when a credential is not a usable Klaviyo private API key.
 *
 * The message NEVER contains the offered value — a validation error that quotes
 * the credential writes it into every log line that renders the error. Only the
 * rejection CLASS is reported, which is what the connect wizard needs in order
 * to say something useful.
 */
export class InvalidKlaviyoCredentialError extends Error {
  readonly code = "INVALID_KLAVIYO_CREDENTIAL";
  constructor(readonly reason: KlaviyoCredentialRejection) {
    super(`Klaviyo credential rejected (${reason}): ${CREDENTIAL_ADVICE[reason]}`);
    this.name = "InvalidKlaviyoCredentialError";
  }
}

/** Thrown when only a person creating a new API key can restore the connection. */
export class KlaviyoReauthorizationRequiredError extends Error {
  readonly code = "REAUTHORIZE_REQUIRED";
  constructor(readonly reason: string) {
    super(
      `Klaviyo rejected the API key (${reason}). Retrying cannot fix this — the key was ` +
        `deleted or is not valid. Create a new one at Settings -> API keys and reconnect. ` +
        `Note a private key is a STANDING credential with no expiry, and Klaviyo will never ` +
        `redisplay it, so deleting it in the Klaviyo account is what disconnects the box — ` +
        `immediately and completely.`,
    );
    this.name = "KlaviyoReauthorizationRequiredError";
  }
}

/**
 * Thrown when the account's plan or the key's scope does not grant a resource.
 *
 * Its own class rather than folded into re-authorization, because the key is
 * fine and making a new one would waste the customer's time — unless the SCOPE
 * is what is wrong, in which case delete-and-recreate is the only route, since
 * Klaviyo cannot edit a key's scope after creation. Surfacing this is
 * mandatory: ADR-041's never-empty contract means a resource the plan or scope
 * withholds must render THIS, never `[]`.
 */
export class KlaviyoCapabilityMissingError extends Error {
  readonly code = "CAPABILITY_MISSING";
  constructor(
    readonly resource: string,
    readonly vendorCode: string,
    readonly status: number,
  ) {
    super(
      `Klaviyo refused "${resource}" for this account (HTTP ${status}, code "${vendorCode}"). ` +
        `This is a plan or key-scope limit, not a broken key — creating a new key with the ` +
        `SAME scope will not change it, and Klaviyo cannot edit a key's scope after creation, ` +
        `so widening access means delete-and-recreate. Plan prerequisite on record: ` +
        `${KLAVIYO_PLAN_PREREQUISITE}.`,
    );
    this.name = "KlaviyoCapabilityMissingError";
  }
}

/**
 * Thrown when the pinned API revision has retired.
 *
 * Only reachable BECAUSE this connector opts out of fall-forward. Without that
 * header Klaviyo answers a retired revision with a `200` carrying the next
 * oldest revision's behaviour, and this failure would instead be a slow drift
 * in the shape of the data — on an appliance in a back office, two years after
 * anybody last looked at it.
 */
export class KlaviyoRevisionRetiredError extends Error {
  readonly code = "REVISION_RETIRED";
  constructor(readonly revision: string) {
    super(
      `Klaviyo revision "${revision}" has retired (HTTP 410). This connector sends ` +
        `${KLAVIYO_FALL_FORWARD_OPT_OUT_HEADER}: ${KLAVIYO_FALL_FORWARD_OPT_OUT_VALUE}, so a ` +
        `retired pin fails loudly here instead of silently returning a different response ` +
        `shape under a 200. Move the box forward by setting the connection's apiRevision to a ` +
        `current revision date, then verify the parsed shape before trusting a sync.`,
    );
    this.name = "KlaviyoRevisionRetiredError";
  }
}

/**
 * Thrown when Klaviyo's shared per-account bucket is empty.
 *
 * NOT a Droplet defect, and that is the whole reason this is its own class.
 * Klaviyo rate-limits per ACCOUNT, not per key, so the customer's Shopify sync
 * and their agency's scripts draw on the same bucket the box does. A 429 here
 * does not prove our accounting is wrong — and our own polling can equally
 * degrade their other integrations, which is why the cadence is conservative
 * and why the setup guide says so out loud.
 */
export class KlaviyoRateLimitedError extends Error {
  readonly code = "RATE_LIMITED";
  constructor(
    readonly op: string,
    readonly retryAfterSeconds: number | undefined,
    readonly attempts: number,
  ) {
    super(
      `Klaviyo rate-limited "${op}" after ${attempts} attempt(s)` +
        (retryAfterSeconds === undefined ? "" : `; it asked for ${retryAfterSeconds}s`) +
        `. Klaviyo meters per ACCOUNT, not per API key, so this bucket is shared with every ` +
        `other integration on the customer's account — it is not necessarily a fault on our ` +
        `side, and it is reported rather than returned as an empty result.`,
    );
    this.name = "KlaviyoRateLimitedError";
  }
}

/**
 * Thrown when this period's campaign-report budget is gone.
 *
 * NOT a fault. `POST /api/campaign-values-reports` is capped at 225 calls a DAY
 * for the whole account, which is a budget rather than a throttle: backing off
 * and retrying cannot produce more of them, so the honest answer is to say the
 * counts are unavailable until the window rolls, never to return campaigns with
 * a zero send count.
 */
export class KlaviyoReportBudgetExhaustedError extends Error {
  readonly code = "REPORT_BUDGET_EXHAUSTED";
  constructor(
    readonly ceiling: number,
    readonly resetsAt: number,
  ) {
    super(
      `Klaviyo's campaign-values report budget (${ceiling} calls/day, per ACCOUNT and shared ` +
        `with the customer's other integrations) is spent. Nothing is broken and retrying ` +
        `cannot help; it refills at ${new Date(resetsAt).toISOString()}. Campaign send, open ` +
        `and click counts are unavailable until then — reported rather than returned as zero, ` +
        `which would read as "this campaign reached nobody".`,
    );
    this.name = "KlaviyoReportBudgetExhaustedError";
  }
}

/**
 * Thrown when a request outlived this connector's own deadline.
 *
 * A NAMED state, and the reason it exists is the ADR-041 contract: none of the
 * failure states may render as an empty result. A timeout that returned `[]`
 * would tell an owner their list is empty, which is both false and
 * unfalsifiable from outside the box.
 */
export class KlaviyoTimeoutError extends Error {
  readonly code = "REQUEST_TIMEOUT";
  constructor(
    readonly op: string,
    readonly timeoutMs: number,
  ) {
    super(
      `Klaviyo request "${op}" exceeded the ${timeoutMs}ms deadline and was abandoned. ` +
        `Reported rather than returned empty: an empty result here would read as "nothing to ` +
        `sync" when the truth is that nothing was read. The deadline is ours — Klaviyo ` +
        `documents no per-request timeout.`,
    );
    this.name = "KlaviyoTimeoutError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Guards
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate an operator-supplied API base, or throw. THE code-side control.
 *
 * HTTPS only — a private API key over http is the key given away. Userinfo is
 * rejected because some HTTP clients resolve `https://evil@a.klaviyo.com` to a
 * different authority than a reader expects. The host must be EXACTLY one of
 * {@link KLAVIYO_ALLOWED_API_HOSTS} — never a suffix match, which would accept
 * `a.klaviyo.com.evil.test`. Port 443 only, because that is all the egress
 * registry declares.
 *
 * A path is refused outright rather than normalised away. Klaviyo's whole API
 * surface is rooted at `/api` on this host, so an operator-supplied prefix
 * could only ever silently re-target every request this connector makes; there
 * is no legitimate reason to accept one.
 *
 * Called at CONSTRUCTION and again on every request build, before the request
 * object exists — so a bad destination costs zero fetch calls and never touches
 * the credential, which is what the tests assert on.
 */
export function assertSafeKlaviyoBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeKlaviyoBaseUrlError(`"${raw}" is not a URL`);
  }
  if (url.protocol !== "https:") {
    throw new UnsafeKlaviyoBaseUrlError(`"${url.protocol}//" is not https`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new UnsafeKlaviyoBaseUrlError("the URL carries userinfo");
  }
  const host = url.hostname.toLowerCase();
  if (!KLAVIYO_ALLOWED_API_HOSTS.has(host)) {
    throw new UnsafeKlaviyoBaseUrlError(`"${host}" is not the registered Klaviyo API host`);
  }
  // The URL parser drops an explicit :443 (the https default), so any port left
  // standing is one the egress registry does not declare.
  if (url.port !== "" && url.port !== "443") {
    throw new UnsafeKlaviyoBaseUrlError(
      `port ${url.port} — the egress registry allows this host on 443 only`,
    );
  }
  if (url.pathname !== "" && url.pathname !== "/") {
    throw new UnsafeKlaviyoBaseUrlError(
      `"${url.pathname}" — a base URL carrying a path would silently re-target every request; ` +
        `Klaviyo's API is rooted at ${KLAVIYO_API_BASE_PATH} on this host`,
    );
  }
  if (url.search !== "" || url.hash !== "") {
    throw new UnsafeKlaviyoBaseUrlError("a base URL may carry no query string and no fragment");
  }
  return `${url.protocol}//${url.host}`;
}

/**
 * Split a customer-supplied key, or throw — before anything is persisted.
 *
 * Returns the trimmed key; the CALLER persists it into the encrypted store.
 * Nothing here writes, logs or renders it.
 */
export function parseKlaviyoApiKey(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new InvalidKlaviyoCredentialError("empty");
  }
  const key = raw.trim();
  if (KLAVIYO_API_KEY_PATTERN.test(key)) return key;
  // Classification is for the MESSAGE only — the pattern above is the gate, so
  // loosening it is what turns the intake test red, not these branches.
  if (!key.startsWith(KLAVIYO_PRIVATE_KEY_PREFIX)) {
    throw new InvalidKlaviyoCredentialError("not_a_private_key");
  }
  // Anything outside printable non-space ASCII. A CR or LF here would be a
  // header-injection primitive, since the key is interpolated into a header.
  if (/[^!-~]/.test(key)) {
    throw new InvalidKlaviyoCredentialError("unsafe_characters");
  }
  throw new InvalidKlaviyoCredentialError("unrecognized");
}

/**
 * Refuse a path this connector may not dial.
 *
 * The first segment under `/api` must be in
 * {@link KLAVIYO_READABLE_RESOURCES}. Called at the top of every request,
 * BEFORE the key is resolved, so an off-allowlist path never reaches the
 * network and never touches the credential.
 *
 * An allowlist at the point of use rather than a denylist in source: every id
 * in these paths is interpolated at runtime, so a denylist of forbidden words
 * only ever catches the literals somebody happened to type.
 */
export function assertReadableKlaviyoResource(path: string): void {
  const rest = path.startsWith(`${KLAVIYO_API_BASE_PATH}/`)
    ? path.slice(KLAVIYO_API_BASE_PATH.length + 1)
    : "";
  const segments = rest.split("/").filter(Boolean);
  const resource = segments[0] ?? "";
  if (!KLAVIYO_READABLE_RESOURCES.has(resource)) {
    throw new ConnectorBlockedError(
      `refusing to dial the Klaviyo resource "${resource}"`,
      "this connector may only read the resources named in KLAVIYO_READABLE_RESOURCES. " +
        "Campaign send jobs, profile-import jobs, subscription and suppression jobs, " +
        "template mutation and flow control are absent from that set on purpose — adding " +
        "one is a deliberate, reviewed change, not something a new request path can do " +
        "incidentally.",
    );
  }
}

/**
 * Refuse a verb this connector may not use on this path.
 *
 * `GET` everywhere; `POST` to exactly {@link KLAVIYO_POST_QUERY_PATHS}, which
 * holds the campaign-values REPORT and nothing else. Everything else — PUT,
 * PATCH, DELETE, and POST to any other path — is refused by shape, so the
 * read-only property survives a future request path being added without anybody
 * re-reading this file.
 */
export function assertKlaviyoMethod(method: string, path: string): void {
  if (method === "GET") return;
  if (method === "POST" && KLAVIYO_POST_QUERY_PATHS.has(path)) return;
  throw new ConnectorBlockedError(
    `refusing to send ${method} to "${path}"`,
    "the Klaviyo track is read-only. GET is allowed everywhere; POST is allowed ONLY to " +
      [...KLAVIYO_POST_QUERY_PATHS].join(", ") +
      ", which is a reporting QUERY that Klaviyo happens to shape as a POST — it creates " +
      "nothing. Every other verb, and a POST anywhere else, is refused by shape rather than " +
      "by an intention someone held while writing the code.",
  );
}

/**
 * Refuse `additional-fields[list]=profile_count` anywhere but a SINGLE list.
 *
 * The hazard is silent, which is why this is a runtime guard and not a comment.
 * That parameter does not exist on the plural `GET /api/lists`, and JSON:API
 * endpoints do not reliably reject an unrecognised query parameter — so
 * attaching it to the collection would return lists with no `profile_count`
 * while this connector believed it had asked for one, leaving the REQUIRED
 * `member_count` column empty with nothing anywhere to notice.
 */
export function assertKlaviyoProfileCountPath(path: string): void {
  const single = KLAVIYO_ENDPOINTS.list.path.replace("{id}", "");
  const tail = path.startsWith(single) ? path.slice(single.length) : "";
  // Non-empty AND with no further segment: `/api/lists/{id}` qualifies,
  // `/api/lists` does not, and neither does `/api/lists/{id}/profiles` — that
  // last one is a different endpoint with a different documented parameter set.
  const isSingleList = tail.length > 0 && !tail.includes("/");
  if (!isSingleList) {
    throw new ConnectorBlockedError(
      `"${KLAVIYO_PROFILE_COUNT_FIELD}" is not a parameter of "${path}"`,
      `${KLAVIYO_PROFILE_COUNT_FIELD}=${KLAVIYO_PROFILE_COUNT_VALUE} is documented ONLY on the ` +
        `singular ${KLAVIYO_ENDPOINTS.list.path}. The plural ${KLAVIYO_ENDPOINTS.lists.path} ` +
        `accepts fields[flow], fields[list], fields[tag], filter, include, page[cursor], ` +
        `page[size] and sort — and would IGNORE this one rather than reject it, leaving the ` +
        `REQUIRED member_count column empty while the read reported success. member_count is ` +
        `therefore an N+1 fan-out, one request per list, against a 1/s + 15/m bucket.`,
    );
  }
}

/**
 * Refuse a filter field `/api/lists/{id}/profiles` does not document.
 *
 * The complete set is {@link KLAVIYO_LIST_PROFILES_FILTERS} and there is no
 * `updated` in it. This exists so that "membership cannot be read
 * incrementally" is enforced rather than remembered: an invented modification
 * predicate is how a full scan comes to be reported as a delta.
 */
export function assertKlaviyoMemberFilterField(field: string): void {
  if (!KLAVIYO_LIST_PROFILES_FILTERS.has(field)) {
    throw new ConnectorBlockedError(
      `"${field}" is not a documented ${KLAVIYO_ENDPOINTS.listProfiles.path} filter`,
      "that endpoint filters on " +
        [...KLAVIYO_LIST_PROFILES_FILTERS].sort().join(", ") +
        " and nothing else. There is NO `updated` filter, so an incremental read of list " +
        "membership is IMPOSSIBLE rather than unimplemented, and joined_group_at is a JOIN " +
        "time — it can find new members but can never see one who left or whose consent " +
        "changed. Do not substitute the account-level /api/profiles `updated` delta either: " +
        "whether a join or leave bumps a profile's `updated` is NOT documented, so covering " +
        "membership that way would be an assumption presented as a delta.",
    );
  }
}

/**
 * A vendor timestamp as a second-precision UTC instant, FLOORED.
 *
 * Klaviyo's documented filter examples are second-precision (`2026-08-01T00:00:00Z`)
 * and this connector matches them rather than sending milliseconds it has never
 * seen the vendor accept. Truncation is a FLOOR — dropping `.750` moves the
 * bound EARLIER — which is the safe direction for both `greater-than` and
 * `greater-or-equal`: it can only re-read rows, never skip them.
 */
export function klaviyoInstant(value: unknown): string | undefined {
  const iso = canonicalInstant(value);
  return iso === undefined ? undefined : iso.replace(/\.\d{3}Z$/, "Z");
}

/**
 * Build the delta clause for one dataset, from the table and never inline.
 *
 * Throws for `audience_member`, whose endpoint has no modification filter at
 * all. That throw is the point: a caller asking for an incremental read of list
 * membership is asking for something the vendor cannot do, and answering with a
 * silent full scan is the failure this whole file is arranged against.
 */
export function klaviyoDeltaClause(dataset: KlaviyoDataset, since: string): string {
  const spec = KLAVIYO_DELTA_FILTERS[dataset];
  if (spec === null) {
    throw new ConnectorBlockedError(
      `"${dataset}" has no Klaviyo delta filter`,
      `${KLAVIYO_ENDPOINTS.listProfiles.path} documents only ` +
        [...KLAVIYO_LIST_PROFILES_FILTERS].sort().join(", ") +
        `, so ${dataset} is full-scan-only (KLAVIYO_SCAN_MODE). An incremental read is ` +
        `impossible here rather than unimplemented.`,
    );
  }
  const instant = klaviyoInstant(since);
  if (instant === undefined) {
    throw new ConnectorBlockedError(
      `"${dataset}" delta needs a parseable instant`,
      "an unparseable watermark must not silently become a full scan reported as a delta.",
    );
  }
  const clause = `${spec.operator}(${spec.field},${instant})`;
  assertKlaviyoDeltaClause(dataset, clause);
  return clause;
}

/**
 * Refuse a delta clause whose operator or field this endpoint does not
 * document.
 *
 * Called on the clause this connector just built, so the guard bites even
 * though the builder is the only producer — the mutation it exists to catch is
 * somebody copying the campaigns clause (`greater-or-equal(updated_at,…)`) onto
 * profiles, where `greater-or-equal` does not exist on that field and
 * `updated_at` is not the field's name.
 *
 * Klaviyo parses filter expressions, so a truly malformed one 400s. What this
 * catches is the case that does NOT 400 loudly enough to notice: a
 * well-formed-looking expression naming a field the endpoint has, with an
 * operator it does not support, or the right operator on a field spelled the
 * way a NEIGHBOURING endpoint spells it.
 */
export function assertKlaviyoDeltaClause(dataset: KlaviyoDataset, clause: string): void {
  const spec = KLAVIYO_DELTA_FILTERS[dataset];
  if (spec === null) {
    throw new ConnectorBlockedError(
      `"${dataset}" accepts no delta clause`,
      `${dataset} is full-scan-only; see KLAVIYO_SCAN_MODE.`,
    );
  }
  const parsed = /^([a-z-]+)\(([A-Za-z0-9_.]+),(.+)\)$/.exec(clause);
  if (!parsed) {
    throw new ConnectorBlockedError(
      `"${clause}" is not a Klaviyo filter expression`,
      "expected operator(field,value) — the shape Klaviyo's filter parser accepts.",
    );
  }
  const [, operator, field] = parsed;
  if (field !== spec.field) {
    throw new ConnectorBlockedError(
      `"${field}" is not the delta field for "${dataset}"`,
      `that endpoint spells it "${spec.field}". The spelling is NOT uniform across Klaviyo: ` +
        `/api/profiles and /api/lists use "updated", /api/campaigns uses "updated_at" and ` +
        `/api/events uses "datetime". The wrong field on the right endpoint is the classic ` +
        `full-scan-reported-as-a-delta.`,
    );
  }
  if (!spec.operators.includes(operator)) {
    throw new ConnectorBlockedError(
      `"${operator}" is not a documented operator for "${spec.field}" on "${dataset}"`,
      `the complete documented set there is ${spec.operators.join(", ")}. Note that ` +
        `/api/profiles offers greater-than and less-than ONLY, and /api/lists offers ` +
        `greater-than ONLY — neither has a greater-or-equal on this field, which is why the ` +
        `watermark may be advanced only after a COMPLETE cursor walk.`,
    );
  }
}

/**
 * The watermark a completed read hands back to the caller.
 *
 * TWO properties, and the second is the one that loses data when it is missing:
 *
 *   - it is RETURNED, never persisted here (ADR-041 §4 / WARP-2028), and
 *   - it is `undefined` unless the cursor walk COMPLETED.
 *
 * Because profiles and lists offer only STRICT greater-than, a watermark
 * advanced from an interrupted walk permanently skips every row sharing that
 * exact `updated` value which had not yet been returned. That is a silent hole,
 * not an error: nothing anywhere reports it, and the rows simply never arrive
 * again. So the rule is enforced by this function's SIGNATURE rather than by a
 * comment somebody has to remember.
 */
export function klaviyoWatermark(
  rows: readonly Record<string, unknown>[],
  field: string,
  complete: boolean,
): string | undefined {
  if (!complete) return undefined;
  let watermark: string | undefined;
  for (const row of rows) {
    const value = row[field];
    if (typeof value === "string" && (watermark === undefined || value > watermark)) {
      watermark = value;
    }
  }
  return watermark;
}

/**
 * Fail at module load if a Klaviyo dataset ever grows a money column.
 *
 * None of the five carries one today: every number in them is a COUNT
 * (`emails_sent`, `opens_unique`, `clicks_unique`, `member_count`,
 * `unsubscribe_count`). Klaviyo's money-shaped values — an event's `$value`,
 * a report's `conversion_value` — are deliberately never projected, because a
 * Klaviyo order event is an untyped property bag with no guaranteed currency
 * and `REQUIRED_CANONICAL` demands `total_amount` AND `currency`.
 *
 * This is a startup assertion rather than a test so the rule travels with the
 * code: the day somebody adds a money-carrying dataset here, the connector
 * refuses to load until they have written the major-units conversion at this
 * boundary and given the amount an explicit sibling `currency`. A count filed
 * as money, or an amount whose currency has to be guessed, is not a number.
 */
export function assertKlaviyoDatasetsCarryNoMoney(): void {
  const money: string[] = [];
  for (const dataset of KLAVIYO_DATASETS) {
    for (const column of CANONICAL_COLUMNS[dataset]) {
      if (COLUMN_KIND[column] === "money") money.push(`${dataset}.${column}`);
    }
  }
  if (money.length > 0) {
    throw new Error(
      `the Klaviyo track now serves money columns (${money.join(", ")}) and has no ` +
        `boundary conversion for them. Money must be a DECIMAL in MAJOR units (12.34, never ` +
        `1234), converted here rather than downstream, and every money column must carry an ` +
        `explicit sibling currency — see ../stripe/connector.ts's majorUnits.`,
    );
  }
}
assertKlaviyoDatasetsCarryNoMoney();

// ─────────────────────────────────────────────────────────────────────────────
// The daily report budget
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A fixed-window daily call budget.
 *
 * For `POST /api/campaign-values-reports` and its 225-calls-a-day ceiling,
 * which is a BUDGET and not a throttle: no amount of backing off produces more
 * of them, and the ceiling is shared with every other integration on the
 * customer's account. Exhausting it is therefore a distinct typed state
 * ({@link KlaviyoReportBudgetExhaustedError}) rather than a 429 nobody expected.
 *
 * The clock is injected so a test can cross a window boundary without waiting a
 * day for one.
 */
export class DailyCallBudget {
  private spent = 0;
  private windowStart: number;

  constructor(
    readonly ceiling: number = KLAVIYO_REPORT_CALLS_PER_DAY,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (!Number.isInteger(ceiling) || ceiling < 1) {
      throw new RangeError(`daily ceiling must be a positive integer, got ${ceiling}`);
    }
    this.windowStart = this.now();
  }

  private static readonly WINDOW_MS = 24 * 60 * 60 * 1000;

  /** When the current window rolls over. */
  get resetsAt(): number {
    return this.windowStart + DailyCallBudget.WINDOW_MS;
  }

  /** Calls left in this window. */
  get remaining(): number {
    this.roll();
    return Math.max(0, this.ceiling - this.spent);
  }

  private roll(): void {
    const now = this.now();
    if (now - this.windowStart >= DailyCallBudget.WINDOW_MS) {
      this.windowStart = now;
      this.spent = 0;
    }
  }

  /** Charge one call, or refuse. Charged BEFORE the attempt loop, so a retried
   *  429 does not draw the budget down twice for one logical read. */
  charge(): void {
    this.roll();
    if (this.spent >= this.ceiling) {
      throw new KlaviyoReportBudgetExhaustedError(this.ceiling, this.resetsAt);
    }
    this.spent += 1;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Wiring types
// ─────────────────────────────────────────────────────────────────────────────

type FetchLike = (input: string, init?: Record<string, unknown>) => Promise<Response>;
type SleepLike = (ms: number) => Promise<void>;

/** Resolve the private API key (from the orchestrator's encrypted store).
 *  Cleartext for the life of one call only; never cached to disk here. */
export type KlaviyoKeyResolver = () => Promise<string>;

/** The default resolver: nothing wired, so the track blocks honestly. */
export const blockedKlaviyoKeyResolver: KlaviyoKeyResolver = async () => {
  throw new ConnectorBlockedError("resolve the Klaviyo API key", KLAVIYO_TRACK_REMEDIATION);
};

/**
 * The store the per-account purge clears.
 *
 * INJECTED rather than reached for, because this connector persists nothing
 * itself — whatever holds Klaviyo-derived rows is the caller's, and the purge
 * has to reach caches and indexes as well as tables. `deleteByConnection` is
 * scoped by CONNECTION ID, never by provider: on a box with two Klaviyo
 * connections a provider-scoped delete destroys the other customer's data.
 */
export interface KlaviyoPurgeStore {
  deleteByConnection(connectionId: string, dataset: string): Promise<number>;
}

/** Audit sink, shaped like `activity.service.ts` `record()`. Counts only. */
export type KlaviyoAuditRecorder = (entry: {
  action: string;
  scope: Record<string, unknown>;
}) => Promise<void> | void;

export interface KlaviyoConnectorConfig {
  /** Pointer into the encrypted secret store — NEVER a key. */
  credentialsSecretRef: string;
  /** The connection row's id. Scopes the purge; never a provider name. */
  connectionId: string;
  /**
   * The conversion metric id the campaign report requires.
   *
   * Optional because lists, contacts and activity all work without it. Absent,
   * the `campaign` dataset is REFUSED rather than served with an empty
   * `emails_sent`: `POST /api/campaign-values-reports` has it in its required
   * attributes, and a campaign row with no send count cannot answer the only
   * question anyone asks of a campaign.
   */
  conversionMetricId?: string;
  /**
   * Move a fielded box past a retired revision without a firmware change.
   *
   * The REMEDIATION for a {@link KlaviyoRevisionRetiredError}, not the primary
   * defence — that is the fall-forward opt-out header, which is what makes the
   * retirement loud enough to act on in the first place.
   */
  apiRevision?: string;
  /** Override the report timeframe key, whose enum member is UNVERIFIED. */
  reportTimeframeKey?: string;
  /** Override the `/api/events` include member, which is UNVERIFIED for the
   *  same reason and gets the same remedy — see
   *  {@link KLAVIYO_EVENT_METRIC_INCLUDE}. */
  eventMetricInclude?: string;
  /** Optional operator override. Guarded on construction and per request. */
  baseUrl?: string;
}

export interface KlaviyoConnectorDeps {
  fetchImpl?: FetchLike;
  now?: () => number;
  sleep?: SleepLike;
  /** Jitter source. Injected so a backoff test is deterministic. */
  random?: () => number;
  resolveApiKey?: KlaviyoKeyResolver;
  timeoutMs?: number;
  reportBudget?: DailyCallBudget;
  purgeStore?: KlaviyoPurgeStore;
  audit?: KlaviyoAuditRecorder;
}

/** The ADR-041 §5 connection-state vocabulary. Explicit, never inferred from a
 *  missing key — an absent value defaulted into "connected" is exactly the
 *  looks-connected-syncs-nothing failure that section exists to prevent. */
export type KlaviyoConnectionState =
  | "disconnected"
  | "connected"
  | "needs_reconnect"
  | "capability_missing";

/**
 * The empirical answer to "does this account's plan allow API reads?".
 *
 * `unverified` is the SHIPPED default and a first-class value, not a null. The
 * Free-plan question is genuinely open, and a probe result that defaulted to
 * "ok" would encode an assumption this connector explicitly refuses to make.
 */
export type KlaviyoPlanProbe =
  | { state: "unverified"; prerequisite: string }
  | { state: "ok"; metricCount: number; probedAt: number }
  | { state: "forbidden"; resource: string; vendorCode: string; status: number; probedAt: number };

export interface KlaviyoStatus {
  state: KlaviyoConnectionState;
  ok: boolean;
  /** Whether a key resolves. NEVER the key, and never a prefix of it. */
  hasApiKey: boolean;
  /** Whether the campaign dataset can be served at all. */
  hasConversionMetricId: boolean;
  apiRevision: string;
  fallForwardOptOut: boolean;
  planProbe: KlaviyoPlanProbe;
  requestTimeoutMs: number;
  reportCallsRemainingToday: number;
  /** Per dataset, whether a delta read is possible at all. */
  scanModes: Readonly<Record<KlaviyoDataset, "delta" | "full_scan_only">>;
}

/** One purge run's receipt. Counts only — never a row, never an address. */
export interface KlaviyoPurgeResult {
  connectionId: string;
  /** Every dataset the connector DECLARES, so the enumeration cannot drift
   *  away from what the connector actually reads. */
  datasets: readonly string[];
  deleted: Readonly<Record<string, number>>;
  totalDeleted: number;
}

/** A completed cursor walk: the rows, and whether it reached the end. */
export interface KlaviyoPage {
  rows: Record<string, unknown>[];
  /** True only when `links.next` was absent. The watermark rule depends on it —
   *  see {@link klaviyoWatermark}. */
  complete: boolean;
}

/** A page of rows plus the watermark the caller persists (never us). */
export interface KlaviyoDeltaPage extends KlaviyoPage {
  watermark: string | undefined;
}

/** One campaign's counts, from the Reporting API. All COUNTS, no money. */
export interface KlaviyoCampaignValues {
  recipients: number | undefined;
  opensUnique: number | undefined;
  clicksUnique: number | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Vendor → canonical mapping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One Klaviyo record -> canonical-column lookup, per dataset.
 *
 * Returns the RAW vendor value; `projectCanonicalRow` owns the coercion and
 * owns the row's key set, so a mapper can neither leak a vendor field onto a
 * row nor drop a canonical one. That matters unusually much here: a Klaviyo
 * profile carries the subscriber's location guess, their IP, their whole
 * custom-property bag and — on the accounts that have it — a predictive
 * lifetime-value model, none of which this product asked for and all of which
 * would be persisted on the box by a mapper written as `{ ...profile, … }`.
 *
 * The record is pre-FLATTENED by the connector into `{ id, ...attributes }`
 * plus whatever the read scoped by (a list id, an included metric's name), so
 * this stays a plain field translation and the JSON:API envelope handling has
 * exactly one home.
 */
export function klaviyoLookup(
  dataset: KlaviyoDataset,
  record: Record<string, unknown>,
): VendorLookup {
  const nested = (key: string, field: string): unknown => {
    const node = record[key];
    return node && typeof node === "object" ? (node as Record<string, unknown>)[field] : undefined;
  };
  return (column: string): unknown => {
    switch (column) {
      // Every dataset's id column is the record's own JSON:API `id`.
      case "contact_id":
        // On `engagement` this is the profile the event is attached to, which
        // the connector resolves from the event's relationships; on `contact`
        // it is the record itself.
        return dataset === "contact" ? record.id : record.profile_id;
      case "audience_id": {
        if (dataset === "audience") return record.id;
        // A CAMPAIGN carries its audiences as an attribute, not as a
        // relationship and not as anything named `list_id`:
        // `attributes.audiences = { included: [listId, …], excluded: […] }`.
        // Only `included` is read — a campaign's EXCLUDED lists are the ones it
        // was deliberately kept away from, and joining a send to one of those
        // would be exactly backwards.
        //
        // Klaviyo allows several included audiences and the canonical column is
        // singular, so the FIRST is taken. That is lossy and it is the right
        // loss: leaving the column undefined whenever a campaign targets two
        // lists is the silent-empty-column failure this file is arranged
        // against, and a campaign that can be joined to one of its lists is
        // strictly more useful than one that can be joined to none.
        if (dataset === "campaign") {
          const included = nested("audiences", "included");
          if (!Array.isArray(included)) return undefined;
          return included.find((v) => typeof v === "string" && v.trim() !== "");
        }
        // Membership rows are scoped BY a list id the connector injects.
        return record.list_id;
      }
      case "audience_member_id":
      case "campaign_id":
      case "engagement_id":
        return record.id;

      case "email":
        return record.email;
      case "first_name":
        return record.first_name;
      case "last_name":
        return record.last_name;
      // Klaviyo has no company OBJECT and no pipeline model. `organization` is
      // free text on the profile, not an id into a company table, so mapping it
      // onto `company_id` would invent a foreign key. Left undefined, which is
      // what `REQUIRED_CANONICAL` allows — it asks only for `contact_id`.
      case "company_id":
      case "lifecycle_stage":
      case "deal_id":
        return undefined;

      case "created_at":
        return record.created;
      case "name":
        return record.name;
      // Counts, never money. `member_count` comes from the N+1 single-list read
      // (`additional-fields[list]=profile_count`); Klaviyo publishes no
      // unsubscribe total on a list, so that column stays honestly absent
      // rather than being reconstructed by subtraction.
      case "member_count":
        return record.profile_count;
      case "unsubscribe_count":
        return undefined;

      // Consent. `subscriptions.email.marketing.consent` is the state the whole
      // `audience_member` row exists for — mailing somebody who opted out is
      // the one unrecoverable mistake this dataset can cause.
      case "subscription_status":
        return klaviyoMarketingConsent(record.subscriptions, "consent");
      case "opted_in_at":
        return klaviyoMarketingConsent(record.subscriptions, "consent_timestamp");

      // NOT a campaign attribute. `/api/campaigns` publishes no subject at all;
      // the line a recipient sees is on the included campaign-MESSAGE, at
      // `definition.content.subject`, and `flattenResources` is what resolves
      // it onto the record — see {@link KLAVIYO_CAMPAIGN_MESSAGE_INCLUDE}.
      case "subject":
        return record.subject;
      case "status":
        return record.status;
      case "sent_at":
        return record.send_time;
      // COUNTS from the Reporting API, and the engagement figures are the
      // UNIQUE ones: one recipient opening four times is one open, and the raw
      // totals make an open rate exceed 100%.
      case "emails_sent":
        return record.recipients;
      case "opens_unique":
        return record.opens_unique;
      case "clicks_unique":
        return record.clicks_unique;

      // The event's metric name — "Opened Email", "Placed Order" — resolved
      // from the included metric resource by the connector.
      case "type":
        return record.metric_name;
      // When it HAPPENED. Klaviyo events are immutable, so there is no
      // modification time to lose and `updated_at` stays absent rather than
      // being backfilled from `occurred_at`, which would make a watermark
      // comparison look meaningful when it is not.
      case "occurred_at":
        return record.datetime;

      case "updated_at":
        // Events have none (immutable); campaigns spell it `updated_at`;
        // profiles and lists spell it `updated`. One translation per track,
        // and this line is where it belongs.
        return dataset === "engagement" ? undefined : (record.updated_at ?? record.updated);

      default:
        return nested("__never", column);
    }
  };
}

/**
 * Read one field out of `subscriptions.email.marketing`.
 *
 * Reachable on `/api/lists/{id}/profiles` as either `fields[profile]` or
 * `additional-fields[profile]`; this connector asks with the latter. Only
 * `predictive_analytics` carries the 10/s + 150/m penalty on that endpoint —
 * `subscriptions` is free, which is the reason `audience_member` can afford to
 * ask for consent on every row.
 */
function klaviyoMarketingConsent(subscriptions: unknown, field: string): unknown {
  if (!subscriptions || typeof subscriptions !== "object") return undefined;
  const email = (subscriptions as Record<string, unknown>).email;
  if (!email || typeof email !== "object") return undefined;
  const marketing = (email as Record<string, unknown>).marketing;
  if (!marketing || typeof marketing !== "object") return undefined;
  return (marketing as Record<string, unknown>)[field];
}

// ─────────────────────────────────────────────────────────────────────────────
// The connector
// ─────────────────────────────────────────────────────────────────────────────

export class KlaviyoConnector implements Connector {
  readonly provider = KLAVIYO_PROVIDER;
  readonly servesDatasets: readonly DatasetName[] = KLAVIYO_DATASETS;

  private readonly now: () => number;
  private readonly sleep: SleepLike;
  private readonly random: () => number;
  private readonly resolveApiKey: KlaviyoKeyResolver;
  private readonly fetchImpl?: FetchLike;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly revision: string;
  private readonly reportTimeframeKey: string;
  private readonly eventMetricInclude: string;
  private readonly reportBudget: DailyCallBudget;
  private readonly purgeStore?: KlaviyoPurgeStore;
  private readonly audit?: KlaviyoAuditRecorder;

  private apiKey: string | null = null;
  private fingerprint: string | null = null;
  private probe: KlaviyoPlanProbe = {
    state: "unverified",
    prerequisite: KLAVIYO_PLAN_PREREQUISITE,
  };

  constructor(
    private readonly config: KlaviyoConnectorConfig,
    deps: KlaviyoConnectorDeps = {},
  ) {
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.random = deps.random ?? Math.random;
    this.resolveApiKey = deps.resolveApiKey ?? blockedKlaviyoKeyResolver;
    this.fetchImpl = deps.fetchImpl;
    this.timeoutMs = deps.timeoutMs ?? KLAVIYO_REQUEST_TIMEOUT_MS;
    this.revision = config.apiRevision ?? KLAVIYO_API_REVISION;
    this.reportTimeframeKey = config.reportTimeframeKey ?? KLAVIYO_REPORT_TIMEFRAME_KEY;
    this.eventMetricInclude = config.eventMetricInclude ?? KLAVIYO_EVENT_METRIC_INCLUDE;
    this.reportBudget = deps.reportBudget ?? new DailyCallBudget(KLAVIYO_REPORT_CALLS_PER_DAY, this.now);
    this.purgeStore = deps.purgeStore;
    this.audit = deps.audit;
    // Validated at CONSTRUCTION: a connection naming a destination we will not
    // dial should fail to build, loudly, rather than look fine until the first
    // read ships a key.
    this.baseUrl = assertSafeKlaviyoBaseUrl(config.baseUrl ?? KLAVIYO_API_BASE_URL);
  }

  private blocked(op: string, detail?: string): ConnectorBlockedError {
    return new ConnectorBlockedError(detail ? `${op} (${detail})` : op, KLAVIYO_TRACK_REMEDIATION);
  }

  /** Resolve and validate the key. Validated on every resolve, not only at
   *  intake: a row edited out-of-band must not be able to put a malformed key —
   *  or one carrying a CR — into an HTTP header. */
  private async key(): Promise<string> {
    if (this.apiKey) return this.apiKey;
    this.apiKey = parseKlaviyoApiKey(await this.resolveApiKey());
    return this.apiKey;
  }

  /**
   * One request.
   *
   * Order is load-bearing. The verb guard, the resource allowlist and the host
   * guard ALL run BEFORE the key is resolved and before the request object
   * exists, so a refused destination, resource or method costs zero fetch calls
   * and never touches the credential — which is exactly what the tests assert.
   */
  private async request(
    op: string,
    method: "GET" | "POST",
    path: string,
    search: Record<string, string | number | undefined> = {},
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    assertKlaviyoMethod(method, path);
    assertReadableKlaviyoResource(path);
    if (search[KLAVIYO_PROFILE_COUNT_FIELD] !== undefined) assertKlaviyoProfileCountPath(path);
    // Re-checked per request, not only at construction: a long-lived instance,
    // a re-read connection row or a future refactor that assigns the base URL
    // per call must not be able to move the destination.
    const base = assertSafeKlaviyoBaseUrl(this.baseUrl);
    const apiKey = await this.key();

    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(search)) {
      if (v !== undefined) qs.set(k, String(v));
    }
    const url = `${base}${path}${qs.toString() ? `?${qs}` : ""}`;

    const doFetch = this.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    if (!doFetch) throw this.blocked(op, "no fetch implementation available");

    // Explicitly bounded rather than `for (;;)`: the 429 branch below is the
    // only thing that continues, and it stops itself at KLAVIYO_MAX_RETRIES —
    // but a loop whose termination lives entirely inside its own body is one
    // edit away from spinning against a rate-limited account forever.
    for (let attempt = 1; attempt <= KLAVIYO_MAX_RETRIES + 1; attempt += 1) {
      let res: Response;
      try {
        res = await this.withTimeout(op, (signal) =>
          doFetch(url, {
            method,
            headers: {
              // The credential. Interpolated inline and NEVER stored on a
              // field or in a template that could be logged — the whole header
              // exists for the length of this object literal.
              Authorization: `${KLAVIYO_AUTHORIZATION_SCHEME} ${apiKey}`,
              // Mandatory in every documented example and listed as a header
              // parameter on every endpoint reference. Sent unconditionally.
              [KLAVIYO_REVISION_HEADER]: this.revision,
              // The one line that turns a retired-revision time bomb into a
              // 410. See the module docstring.
              [KLAVIYO_FALL_FORWARD_OPT_OUT_HEADER]: KLAVIYO_FALL_FORWARD_OPT_OUT_VALUE,
              accept: "application/json",
              ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            // Never follow a 3xx: the fetch spec strips Authorization on
            // cross-origin redirects, but the key's safety must not rest on
            // every runtime implementing that correctly. This API has no
            // legitimate redirect, so one is a fault, not a hop.
            redirect: "error",
            signal,
          }),
        );
      } catch (err) {
        if (err instanceof KlaviyoTimeoutError) throw err;
        if (KlaviyoConnector.isTimeout(err)) throw new KlaviyoTimeoutError(op, this.timeoutMs);
        throw this.blocked(op, `Klaviyo API unreachable: ${(err as Error).message}`);
      }

      if (res.status === 401) {
        throw new KlaviyoReauthorizationRequiredError("Klaviyo returned 401");
      }
      if (res.status === 403) {
        throw new KlaviyoCapabilityMissingError(
          path,
          await KlaviyoConnector.errorCode(res),
          res.status,
        );
      }
      if (res.status === 410) {
        // Only reachable because of the fall-forward opt-out header.
        throw new KlaviyoRevisionRetiredError(this.revision);
      }
      if (res.status === 429) {
        const retryAfter = KlaviyoConnector.retryAfterSeconds(res);
        if (attempt > KLAVIYO_MAX_RETRIES) {
          throw new KlaviyoRateLimitedError(op, retryAfter, attempt);
        }
        // Klaviyo's documented guidance is exponential backoff WITH randomness,
        // to avoid a thundering herd across everything sharing the account's
        // bucket. Jitter is added upward from the vendor's own figure, never
        // subtracted from it: retrying earlier than we were asked to is how a
        // client turns one 429 into several.
        const base429 =
          retryAfter !== undefined
            ? retryAfter * 1000
            : KLAVIYO_BACKOFF_BASE_MS * 2 ** (attempt - 1);
        await this.sleep(Math.round(base429 + this.random() * base429 * 0.5));
        continue;
      }
      if (!res.ok) {
        // The vendor's own message is NOT propagated: Klaviyo's `detail` quotes
        // request state back at you — the filter expression, the field, the
        // value — and that state can contain customer data. The CODE plus the
        // status is what a caller can act on, and it carries nothing.
        throw this.blocked(
          op,
          `Klaviyo API returned ${res.status} (code "${await KlaviyoConnector.errorCode(res)}")`,
        );
      }
      try {
        return (await res.json()) as Record<string, unknown>;
      } catch (err) {
        throw this.blocked(op, `unparseable Klaviyo response: ${(err as Error).message}`);
      }
    }
    // Unreachable: the 429 branch is the loop's only `continue` and it throws
    // at KLAVIYO_MAX_RETRIES + 1. Kept so the bound above is a real bound and
    // not a comment — falling out of the loop can never mean "no result".
    throw new KlaviyoRateLimitedError(op, undefined, KLAVIYO_MAX_RETRIES + 1);
  }

  /**
   * Bound one call at {@link KLAVIYO_REQUEST_TIMEOUT_MS}, belt AND braces.
   *
   * An `AbortSignal` is passed down so a real `fetch` tears the socket down
   * rather than leaving it open behind an abandoned promise, AND the call is
   * raced against our own timer so the deadline holds even when the fetch
   * implementation ignores the signal. The second is what makes the deadline
   * OURS rather than a delegated hope — the contract here is that a stalled
   * request surfaces as {@link KlaviyoTimeoutError}, never as an empty result
   * and never as a promise that simply does not settle.
   */
  private async withTimeout<T>(op: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new KlaviyoTimeoutError(op, this.timeoutMs));
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
   * The vendor's error CODE, never its message.
   *
   * Klaviyo's JSON:API errors are `{ errors: [{ id, code, title, detail, source }] }`
   * and `detail` routinely quotes the request back — the filter expression, the
   * field, the offending value. That is request state, so it is dropped here
   * rather than being carried into an error message that gets logged. The code
   * is a stable enum a caller can branch on and contains nothing.
   */
  private static async errorCode(res: Response): Promise<string> {
    try {
      const body = (await res.json()) as { errors?: { code?: unknown }[] };
      const first = Array.isArray(body?.errors) ? body.errors[0] : undefined;
      const code = first?.code;
      return typeof code === "string" && code !== "" ? code : `http_${res.status}`;
    } catch {
      return `http_${res.status}`;
    }
  }

  /** `Retry-After` in whole seconds, capped so a hostile or mistaken header
   *  cannot wedge a worker for an hour. */
  private static retryAfterSeconds(res: Response): number | undefined {
    const raw = res.headers?.get?.("Retry-After");
    if (typeof raw !== "string" || raw.trim() === "") return undefined;
    const n = Number(raw.trim());
    if (!Number.isFinite(n) || n < 0) return undefined;
    return Math.min(Math.trunc(n), KLAVIYO_MAX_RETRY_AFTER_SECONDS);
  }

  /**
   * The `page[cursor]` value from a response's `links.next`, taken OPAQUELY.
   *
   * Two properties, and both are deliberate:
   *
   *   - the cursor is never CONSTRUCTED. Klaviyo's cursors are opaque, and a
   *     client that builds one is a client that silently reads the wrong page.
   *   - the vendor's URL is never DIALLED. `links.next` is a full URL that
   *     arrives in a response body, and a connector that followed it would have
   *     a destination chosen by whatever answered the last request. So the host
   *     is re-checked against the same guard and only the cursor parameter is
   *     lifted out; the next request is built from OUR base URL.
   */
  private cursorFrom(body: Record<string, unknown>): string | undefined {
    const links = body.links;
    if (!links || typeof links !== "object") return undefined;
    const next = (links as Record<string, unknown>).next;
    if (typeof next !== "string" || next.trim() === "") return undefined;
    let url: URL;
    try {
      url = new URL(next);
    } catch {
      throw this.blocked("pagination", "Klaviyo returned a links.next that is not a URL");
    }
    // Refuses on ZERO further fetch calls if the vendor (or anything that could
    // impersonate it) hands back a link off the registered host.
    assertSafeKlaviyoBaseUrl(`${url.protocol}//${url.host}`);
    const cursor = url.searchParams.get(KLAVIYO_CURSOR_PARAM);
    return cursor === null || cursor === "" ? undefined : cursor;
  }

  /**
   * Walk a cursor-paginated collection to the end.
   *
   * Terminates on `links.next` being absent — the only signal a cursor API
   * offers — and hard-stops at {@link KLAVIYO_MAX_PAGES} so an endpoint that
   * never stops offering one cannot spin. `complete` reports which of those two
   * happened, and {@link klaviyoWatermark} refuses to advance a watermark on
   * the second, because with STRICT greater-than on profiles and lists a
   * watermark advanced from an interrupted walk permanently skips every row
   * sharing that exact `updated` value.
   */
  private async page(
    op: string,
    endpoint: KlaviyoEndpoint,
    path: string,
    search: Record<string, string | number | undefined>,
    /** Checked against EVERY page's envelope, before its rows are flattened.
     *  A read that paid for an `include` uses this to refuse a body that came
     *  back without one — see {@link KlaviyoConnector.assertSideloadPresent}. */
    assertEnvelope?: (body: Record<string, unknown>) => void,
  ): Promise<KlaviyoPage> {
    const rows: Record<string, unknown>[] = [];
    let cursor: string | undefined;

    for (let page = 1; page <= KLAVIYO_MAX_PAGES; page += 1) {
      const body = await this.request(op, "GET", path, {
        ...search,
        // Endpoints with `maxPageSize: 0` expose no such parameter at all
        // (/api/metrics is cursor-only), so it is omitted rather than sent as
        // a value the endpoint would ignore.
        ...(endpoint.maxPageSize > 0 ? { [KLAVIYO_PAGE_SIZE_PARAM]: endpoint.maxPageSize } : {}),
        ...(cursor === undefined ? {} : { [KLAVIYO_CURSOR_PARAM]: cursor }),
      });
      const data = body.data;
      if (!Array.isArray(data)) {
        throw this.blocked(
          op,
          `Klaviyo returned a non-array \`data\` (${typeof data}) — refusing to interpret a ` +
            `response that does not match the documented JSON:API list contract rather than ` +
            `guessing at a shape`,
        );
      }
      assertEnvelope?.(body);
      rows.push(...KlaviyoConnector.flattenResources(data, body.included));
      cursor = this.cursorFrom(body);
      if (cursor === undefined) return { rows, complete: true };
    }
    return { rows, complete: false };
  }

  /**
   * Refuse a 200 that carries rows but NOT the sideload the request paid for.
   *
   * This is the `GET /api/files` lesson, restated for a JSON:API envelope: that
   * endpoint once answered `200 []` through an outage and every consumer read
   * it as "there are no files". A collection key that is ABSENT from an
   * otherwise-successful body is a FAULT, not an empty collection, and the two
   * are indistinguishable downstream — which is precisely why the distinction
   * has to be drawn here, at the only place that still knows an `include` was
   * asked for.
   *
   * Concretely: `include=campaign-messages` is the ONLY source of
   * `campaign.subject` and `include=metric` the only source of
   * `engagement.type`. Without this check a revision that quietly retired an
   * include member, a scope that silently drops sideloads, or a plain typo in
   * the enum member yields a full page of rows with that column blank on every
   * one of them — green, plausible, and wrong for as long as nobody looks.
   *
   * `data.length === 0` is exempt on purpose: a page with no rows has nothing
   * to sideload, and JSON:API does not require an empty `included`.
   */
  private assertSideloadPresent(
    op: string,
    include: string,
    column: string,
    body: Record<string, unknown>,
  ): void {
    const data = body.data;
    if (!Array.isArray(data) || data.length === 0) return;
    if (Array.isArray(body.included)) return;
    throw this.blocked(
      op,
      `Klaviyo answered 200 with ${data.length} row(s) and NO \`included\` array, after this ` +
        `request asked for include=${include} — refusing to serve rows whose \`${column}\` ` +
        `would be blank on every one of them. An absent collection in an otherwise-successful ` +
        `body is a fault, not an empty one: the column has exactly one source and this ` +
        `response did not carry it`,
    );
  }

  /**
   * Flatten JSON:API resources into `{ id, ...attributes }`, resolving the
   * relationships this connector actually uses.
   *
   * Kept in ONE place so the envelope handling does not spread into five
   * mappers. Three sideloads are resolved here and every one of them is a
   * column that does not otherwise exist:
   *
   *   - `metric_name` from an event's included metric (the human-readable
   *     "Opened Email" / "Placed Order" that becomes `engagement.type`),
   *   - `profile_id` from the event's profile relationship,
   *   - `subject` from a campaign's included MESSAGE. `/api/campaigns` carries
   *     no subject on its attributes at all — the recipient-visible line lives
   *     at `campaign-message.attributes.definition.content.subject`, and a
   *     mapper reading `attributes.subject` finds a key the vendor never sends.
   *
   * The `included` array is a FLAT bag of every sideloaded resource, so each
   * kind is indexed by id and then resolved through the owning resource's own
   * relationship — never by position and never by "the first one of that type",
   * which would attach one campaign's subject to another campaign's row.
   */
  private static flattenResources(
    data: readonly unknown[],
    included: unknown,
  ): Record<string, unknown>[] {
    const metrics = new Map<string, string>();
    const subjects = new Map<string, string>();
    if (Array.isArray(included)) {
      for (const item of included) {
        const res = KlaviyoConnector.asRecord(item);
        if (res === undefined) continue;
        const id = KlaviyoConnector.text(res.id);
        if (id === undefined) continue;
        if (res.type === KLAVIYO_EVENT_METRIC_TYPE) {
          const name = KlaviyoConnector.text(KlaviyoConnector.asRecord(res.attributes)?.name);
          if (name !== undefined) metrics.set(id, name);
          continue;
        }
        if (res.type === KLAVIYO_CAMPAIGN_MESSAGE_TYPE) {
          // definition.content.subject — three levels down, and the whole
          // reason `include=campaign-messages` is paid for on every campaigns
          // request.
          const definition = KlaviyoConnector.asRecord(
            KlaviyoConnector.asRecord(res.attributes)?.definition,
          );
          const content = KlaviyoConnector.asRecord(definition?.content);
          const subject = KlaviyoConnector.text(content?.subject);
          if (subject !== undefined) subjects.set(id, subject);
        }
      }
    }
    const rows: Record<string, unknown>[] = [];
    for (const item of data) {
      const res = KlaviyoConnector.asRecord(item);
      if (res === undefined) continue;
      const attributes = KlaviyoConnector.asRecord(res.attributes) ?? {};
      const row: Record<string, unknown> = { ...attributes, id: res.id };
      const relationships = KlaviyoConnector.asRecord(res.relationships);
      if (relationships !== undefined) {
        const profileId = KlaviyoConnector.relationshipId(relationships.profile);
        if (profileId !== undefined) row.profile_id = profileId;
        const metricId = KlaviyoConnector.relationshipId(relationships.metric);
        if (metricId !== undefined) {
          row.metric_id = metricId;
          const name = metrics.get(metricId);
          if (name !== undefined) row.metric_name = name;
        }
        // TO-MANY: a campaign can carry several messages (one per variation).
        // The first whose subject resolved wins, which is the same
        // first-wins rule `audience_id` applies to `audiences.included` — and
        // for the same reason: the canonical column is singular and an absent
        // subject is worse than an A/B test's first variant.
        const messageIds = KlaviyoConnector.relationshipIds(
          relationships[KLAVIYO_CAMPAIGN_MESSAGE_INCLUDE],
        );
        for (const messageId of messageIds) {
          const subject = subjects.get(messageId);
          if (subject !== undefined) {
            row.subject = subject;
            break;
          }
        }
      }
      rows.push(row);
    }
    return rows;
  }

  private static asRecord(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  }

  private static relationshipId(node: unknown): string | undefined {
    const data = KlaviyoConnector.asRecord(KlaviyoConnector.asRecord(node)?.data);
    return KlaviyoConnector.text(data?.id);
  }

  /** The ids of a TO-MANY relationship, in the vendor's order. Empty for a
   *  to-one node or an absent relationship — never a throw, because a campaign
   *  legitimately has no messages until one is drafted. */
  private static relationshipIds(node: unknown): string[] {
    const data = KlaviyoConnector.asRecord(node)?.data;
    if (!Array.isArray(data)) return [];
    return data
      .map((entry) => KlaviyoConnector.text(KlaviyoConnector.asRecord(entry)?.id))
      .filter((id): id is string => id !== undefined);
  }

  /** A vendor value as trimmed text, or undefined when absent/empty. */
  private static text(value: unknown): string | undefined {
    if (typeof value === "string") {
      const raw = value.trim();
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

  /** Newest-first on an ISO column, ties broken by the id column — the same
   *  ordering the SQL track's registered query specifies. */
  private static newestFirst(rows: CanonicalRow[], column: string, idColumn: string): CanonicalRow[] {
    return [...sortByKey(rows, idColumn)].sort((a, b) =>
      String(b[column] ?? "").localeCompare(String(a[column] ?? "")),
    );
  }

  // ── Connector interface ───────────────────────────────────────────────────

  /**
   * Open the connection and PROBE the plan, rather than assume it.
   *
   * `/api/metrics` is the cheapest authenticated read Klaviyo offers and proves
   * four things at once: the key works, egress to this host is permitted, the
   * pinned revision is still live (the fall-forward opt-out makes a retired one
   * a 410 right here), and the account's plan grants API access at all. The
   * last of those is the open question, so its answer is recorded as an
   * explicit {@link KlaviyoPlanProbe} — never inferred from the absence of an
   * error.
   */
  async connect(): Promise<void> {
    await this.probePlanAccess();
    this.fingerprint = computeSchemaFingerprint(this.tables());
  }

  /**
   * Empirically establish whether this account's plan and key scope permit
   * reads.
   *
   * Partial answers are FIRST CLASS: a key that authenticates but is refused on
   * some resources is a different finding from one that cannot read anything,
   * and the two change the customer's remedy completely — a scope problem means
   * delete-and-recreate, because Klaviyo cannot edit a key's scope. A 403
   * becomes {@link KlaviyoCapabilityMissingError}, never an empty result.
   */
  async probePlanAccess(): Promise<KlaviyoPlanProbe> {
    try {
      const body = await this.request(
        "probePlanAccess",
        "GET",
        KLAVIYO_ENDPOINTS.metrics.path,
      );
      const data = body.data;
      if (!Array.isArray(data)) {
        // The same refusal `page()` applies to every list read. Recording `ok`
        // here would assert that API access was exercised when the answer was
        // not even readable - and `connect()` trusts this probe as exactly that
        // evidence. An unreadable response is not a verified, zero-metric account.
        throw this.blocked(
          "probePlanAccess",
          `Klaviyo returned a non-array \`data\` (${typeof data}) from the plan probe - refusing to ` +
            `record a verified account from a response that does not match the documented ` +
            `JSON:API list contract rather than guessing at a shape`,
        );
      }
      this.probe = {
        state: "ok",
        metricCount: data.length,
        probedAt: this.now(),
      };
    } catch (err) {
      if (err instanceof KlaviyoCapabilityMissingError) {
        this.probe = {
          state: "forbidden",
          resource: err.resource,
          vendorCode: err.vendorCode,
          status: err.status,
          probedAt: this.now(),
        };
      }
      throw err;
    }
    return this.probe;
  }

  async close(): Promise<void> {
    this.apiKey = null;
  }

  async health(): Promise<{ ok: boolean }> {
    const state = await this.state();
    if (state === "needs_reconnect") {
      throw new KlaviyoReauthorizationRequiredError("the stored API key is not usable");
    }
    if (state === "capability_missing") {
      const p = this.probe as Extract<KlaviyoPlanProbe, { state: "forbidden" }>;
      throw new KlaviyoCapabilityMissingError(p.resource, p.vendorCode, p.status);
    }
    if (state === "disconnected") {
      throw this.blocked("health", "no Klaviyo account is connected");
    }
    return { ok: true };
  }

  /** The canonical shape this track serves. Synthesized rather than
   *  introspected: Klaviyo's schema is Klaviyo's, published and versioned by
   *  the revision header, so there is nothing to discover — but the fingerprint
   *  still has to exist so drift-freeze semantics stay coherent across tracks. */
  private tables(): IntrospectedTable[] {
    return KLAVIYO_DATASETS.map((dataset) => ({
      name: dataset,
      owner: KLAVIYO_PROVIDER,
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
   * Serve a named read as canonical rows.
   *
   * Filter params are OPTIONAL, as on the HubSpot and Mailchimp tracks: the
   * registry's queries carry mandatory filters written for the SQL track, while
   * a sync runner passes `{}` or `{ since }` and wants the dataset enumerated.
   * A param that is present filters; one that is absent enumerates.
   *
   * Where `since` can be pushed down it is — as the documented per-endpoint
   * delta filter, built by {@link klaviyoDeltaClause} and never typed inline.
   * Where it cannot (`audience_member`) it is applied to the MAPPED rows
   * instead of being smuggled into a query string, which is precisely the
   * full-scan-reported-as-a-delta this file is arranged against.
   */
  async runRead(name: string, params: Record<string, unknown>): Promise<unknown[]> {
    const query = getReadQuery(name);
    assertDatasetsServed(this.provider, this.servesDatasets, name, query.dependsOnTables);
    const dataset = query.dependsOnTables[0] as KlaviyoDataset;
    const op = `runRead:${name}`;
    const since = canonicalInstant(params.since);

    switch (name) {
      case "find_contact": {
        const { rows } = await this.listProfiles({ since });
        const projected = rows.map((r) => projectCanonicalRow(dataset, klaviyoLookup(dataset, r)));
        // The last-name prefix is applied HERE, not pushed down. Klaviyo's
        // documented profile filter set does not include a verified last_name
        // predicate, and inventing one is how a full scan gets labelled a
        // filtered search — the same hazard assertKlaviyoDeltaClause guards.
        const prefix = KlaviyoConnector.text(params.query)?.toLowerCase();
        const matched =
          prefix === undefined
            ? projected
            : projected.filter((r) => String(r.last_name ?? "").toLowerCase().startsWith(prefix));
        // `ORDER BY last_name, first_name`.
        return [...sortByKey(matched, "first_name")].sort((a, b) =>
          String(a.last_name ?? "").localeCompare(String(b.last_name ?? "")),
        );
      }

      case "get_audiences": {
        const rows = await this.listAudiences({ since });
        const projected = rows.map((r) => projectCanonicalRow(dataset, klaviyoLookup(dataset, r)));
        // `ORDER BY member_count DESC, audience_id`.
        return [...sortByKey(projected, "audience_id")].sort(
          (a, b) => Number(b.member_count ?? 0) - Number(a.member_count ?? 0),
        );
      }

      case "get_audience_members": {
        const wanted = KlaviyoConnector.text(params.audienceId);
        const listIds = wanted === undefined ? await this.audienceIds() : [wanted];
        const rows: CanonicalRow[] = [];
        for (const listId of listIds) {
          const page = await this.listMembers(listId);
          for (const member of page.rows) {
            // The list id the read was scoped BY, never one off the payload:
            // `/api/lists/{id}/profiles` returns profiles, and a profile does
            // not know which list it was fetched through.
            rows.push(
              projectCanonicalRow(dataset, klaviyoLookup(dataset, { ...member, list_id: listId })),
            );
          }
        }
        const status = KlaviyoConnector.text(params.status)?.toLowerCase();
        let matched =
          status === undefined
            ? rows
            : rows.filter((r) => String(r.subscription_status ?? "").toLowerCase() === status);
        // `since` is applied AFTER mapping. This dataset is full_scan_only, so
        // there is no query parameter to push it down to and offering one would
        // be inventing a filter the endpoint does not document.
        if (since !== undefined) {
          matched = matched.filter(
            (r) => typeof r.updated_at === "string" && r.updated_at >= since,
          );
        }
        // `ORDER BY updated_at DESC, audience_member_id`.
        return KlaviyoConnector.newestFirst(matched, "updated_at", "audience_member_id");
      }

      case "get_campaign_performance": {
        // NOTE the delta field: campaigns filter on `updated_at`, which is NOT
        // the same axis as the `sent_at` window this query takes. A campaign
        // sent in July and edited in August has an August `updated_at`, so
        // pushing `from` down as an updated_at bound would drop it. Only the
        // watermark goes down the wire; the send window is applied to the
        // mapped rows.
        const raw = await this.listCampaigns({ since });
        const values = await this.campaignValues();
        const rows = raw.map((c) => {
          const counts = values.get(String(c.id ?? "")) ?? {
            recipients: undefined,
            opensUnique: undefined,
            clicksUnique: undefined,
          };
          return projectCanonicalRow(
            dataset,
            klaviyoLookup(dataset, {
              ...c,
              recipients: counts.recipients,
              opens_unique: counts.opensUnique,
              clicks_unique: counts.clicksUnique,
            }),
          );
        });
        const windowed = KlaviyoConnector.inWindow(rows, "sent_at", params.from, params.to);
        // `ORDER BY sent_at DESC, campaign_id`.
        return KlaviyoConnector.newestFirst(windowed, "sent_at", "campaign_id");
      }

      case "get_engagements": {
        // `from` IS on the delta axis here — `/api/events` filters on
        // `datetime`, which is the same instant `occurred_at` maps from — so it
        // is pushed down when no explicit watermark was given.
        const floor = since ?? canonicalInstant(params.from);
        const raw = await this.listEvents({ since: floor });
        const rows = raw.map((e) => projectCanonicalRow(dataset, klaviyoLookup(dataset, e)));
        const windowed = KlaviyoConnector.inWindow(rows, "occurred_at", params.from, params.to);
        // `ORDER BY occurred_at DESC, engagement_id`.
        return KlaviyoConnector.newestFirst(windowed, "occurred_at", "engagement_id");
      }

      default:
        // Unreachable while every served read is handled above; a new registry
        // entry on a served dataset lands here rather than silently returning
        // nothing, which would read as "this account has no contacts".
        throw this.blocked(op, "read is not served by the Klaviyo track");
    }
  }

  async applyWrite(name: string, _params: Record<string, unknown>): Promise<unknown> {
    // Same validation order as every other track, so a caller bug produces the
    // same typed error here as anywhere else...
    const cmd = getWriteCommand(name);
    assertTargetAllowed(cmd.targetTable);
    // ...and then this track refuses. Sending a campaign is irreversible and
    // externally visible to every contact a business has; subscribing,
    // suppressing and profile-import jobs are equally one-way. None of them is
    // a later ticket — they are absent by design, and the test suite fails the
    // build if a send, subscribe or suppress surface ever appears here.
    throw this.blocked(
      `applyWrite:${name}`,
      "the Klaviyo track is read-only — no campaign-send, subscribe, suppress, " +
        "profile-import or list-mutation surface exists in this connector at any tier",
    );
  }

  // ── Marketing surface ─────────────────────────────────────────────────────

  /**
   * Profiles, incrementally.
   *
   * The delta is `greater-than(updated,…)` — STRICT, because
   * `greater-or-equal` does not exist on that field — paired with the ascending
   * `updated` sort so the cursor walk and the watermark advance in the same
   * direction.
   *
   * ## The over-completeness is CORRECT. Do not narrow it.
   *
   * Klaviyo documents `updated` as the last time any profile property changed,
   * *including changes to a profile's timestamps like `last_event_date`*. So
   * every open, click and order bumps that contact's profile, and a delta read
   * against an active account re-surfaces most of its base each cycle with
   * nothing a reader would call a change.
   *
   * That is noisy and it is right. The failure mode of "fixing" it into a
   * narrower filter is that real edits start being missed — silently, because
   * a row that is never returned looks exactly like a row that never changed.
   */
  async listProfiles(filters: { since?: string } = {}): Promise<KlaviyoDeltaPage> {
    const endpoint = KLAVIYO_ENDPOINTS.profiles;
    const spec = KLAVIYO_DELTA_FILTERS.contact;
    const page = await this.page("listProfiles", endpoint, endpoint.path, {
      filter: filters.since === undefined ? undefined : klaviyoDeltaClause("contact", filters.since),
      sort: spec === null ? undefined : spec.sort,
    });
    return {
      ...page,
      // RETURNED, never persisted here — and undefined unless the walk finished.
      watermark: klaviyoWatermark(page.rows, "updated", page.complete),
    };
  }

  /**
   * Lists, with their member counts.
   *
   * TWO STAGES, and the second one is an N+1 by necessity: `profile_count` is
   * documented only on the singular `GET /api/lists/{id}`, so filling the
   * REQUIRED `member_count` column costs one request per list against a
   * 1/s + 15/m bucket — 50x more expensive than the collection read, and
   * against a page ceiling of ten.
   *
   * The count is BEST-EFFORT per list rather than fatal for the whole read: a
   * single list whose detail read is refused leaves that one row's count
   * absent, which `projectCanonicalRow` renders as `undefined` — absent, not
   * zero. Zero would be a confident false statement about the size of somebody's
   * mailing list.
   *
   * That is enforced by the catch below, not merely asserted here. It is the
   * likeliest failure site in the connector: the singular read draws on the
   * 1/s + 15/m bucket the customer's OTHER integrations share, so on an account
   * with a couple of hundred lists one exhausted 429 would otherwise throw away
   * every list — including the ones whose counts had already come back.
   *
   * What the catch does NOT swallow is the point of
   * {@link KlaviyoConnector.isPerListCountFault}: a dead credential or a
   * retired revision is a fact about the CONNECTION, and continuing the loop
   * would issue one more doomed request per remaining list before reporting it.
   */
  async listAudiences(filters: { since?: string } = {}): Promise<Record<string, unknown>[]> {
    const endpoint = KLAVIYO_ENDPOINTS.lists;
    const spec = KLAVIYO_DELTA_FILTERS.audience;
    const page = await this.page("listAudiences", endpoint, endpoint.path, {
      filter:
        filters.since === undefined ? undefined : klaviyoDeltaClause("audience", filters.since),
      sort: spec === null ? undefined : spec.sort,
    });
    const withCounts: Record<string, unknown>[] = [];
    for (const list of page.rows) {
      const id = KlaviyoConnector.text(list.id);
      if (id === undefined) continue;
      let count: number | undefined;
      try {
        count = await this.profileCount(id);
      } catch (err) {
        if (!KlaviyoConnector.isPerListCountFault(err)) throw err;
        // Absent, never zero — and the row itself is still served, because a
        // list the customer can see with no count is a far better answer than
        // no lists at all.
        count = undefined;
      }
      withCounts.push({ ...list, profile_count: count });
    }
    return withCounts;
  }

  /**
   * Is this failure about ONE list, or about the connection?
   *
   * A 403 (this key's scope does not reach that list), an exhausted 429, a
   * timeout and a non-2xx are all facts about a single detail read, and the
   * `member_count` contract already says an unobtainable count is absent.
   *
   * A 401 and a retired revision are NOT: they are true of every remaining
   * request, so swallowing one would fire N-1 more doomed calls and then hand
   * back a full set of lists with every count missing — a degraded read
   * wearing a successful read's shape. {@link UnsafeKlaviyoBaseUrlError} is
   * never swallowed on principle: a security guard that can be caught into
   * "the count is absent" is not a guard.
   */
  private static isPerListCountFault(err: unknown): boolean {
    return (
      err instanceof KlaviyoCapabilityMissingError ||
      err instanceof KlaviyoRateLimitedError ||
      err instanceof KlaviyoTimeoutError ||
      err instanceof ConnectorBlockedError
    );
  }

  /**
   * One list's `profile_count`.
   *
   * The ONLY source for `member_count`, and the only place
   * `additional-fields[list]` is legal — {@link assertKlaviyoProfileCountPath}
   * enforces that at request time, because the plural endpoint would IGNORE the
   * parameter rather than reject it and leave the column silently empty.
   */
  async profileCount(listId: string): Promise<number | undefined> {
    const path = KLAVIYO_ENDPOINTS.list.path.replace("{id}", encodeURIComponent(listId));
    const body = await this.request("profileCount", "GET", path, {
      [KLAVIYO_PROFILE_COUNT_FIELD]: KLAVIYO_PROFILE_COUNT_VALUE,
    });
    const data = KlaviyoConnector.asRecord(body.data);
    const count = KlaviyoConnector.asRecord(data?.attributes)?.profile_count;
    return typeof count === "number" && Number.isFinite(count) ? count : undefined;
  }

  /** Every list id on the account, for the member enumeration below. */
  private async audienceIds(): Promise<string[]> {
    const endpoint = KLAVIYO_ENDPOINTS.lists;
    const page = await this.page("audienceIds", endpoint, endpoint.path, {});
    return page.rows
      .map((l) => KlaviyoConnector.text(l.id))
      .filter((id): id is string => id !== undefined);
  }

  /**
   * Members of one list — a FULL SCAN, always, by necessity.
   *
   * `/api/lists/{id}/profiles` documents exactly five filters and none of them
   * is a modification time, so this cannot be incremental. The signature
   * deliberately exposes NO `since` option: offering one that the endpoint
   * cannot honour is how a full scan comes to be reported as a delta.
   *
   * Sorted by `joined_group_at`, which is the only ordering available there —
   * `updated` is not sortable on this endpoint — so a resumable scan has
   * exactly one design. Consent comes back through
   * `additional-fields[profile]=subscriptions`, which is the free one; only
   * `predictive_analytics` carries a rate penalty on this endpoint.
   */
  async listMembers(listId: string): Promise<KlaviyoPage> {
    // Enforce the documented filter set even though we send no filter: the
    // guard is what stops somebody adding an `updated` predicate here later.
    assertKlaviyoMemberFilterField(KLAVIYO_LIST_PROFILES_SORT);
    const endpoint = KLAVIYO_ENDPOINTS.listProfiles;
    const path = endpoint.path.replace("{id}", encodeURIComponent(listId));
    return this.page("listMembers", endpoint, path, {
      sort: KLAVIYO_LIST_PROFILES_SORT,
      [KLAVIYO_MEMBER_SUBSCRIPTIONS_FIELD]: KLAVIYO_MEMBER_SUBSCRIPTIONS_VALUE,
    });
  }

  /**
   * Email campaigns, incrementally.
   *
   * The channel filter is MANDATORY — *"A channel filter is required to list
   * campaigns"* — so the delta clause is ANDed onto it rather than replacing
   * it. `include=campaign-messages` is what brings back
   * `definition.content.subject`; `/api/campaigns` alone yields no subject and
   * no counts at all.
   */
  async listCampaigns(filters: { since?: string } = {}): Promise<Record<string, unknown>[]> {
    const endpoint = KLAVIYO_ENDPOINTS.campaigns;
    const spec = KLAVIYO_DELTA_FILTERS.campaign;
    const delta =
      filters.since === undefined ? undefined : klaviyoDeltaClause("campaign", filters.since);
    const page = await this.page(
      "listCampaigns",
      endpoint,
      endpoint.path,
      {
        filter:
          delta === undefined
            ? KLAVIYO_CAMPAIGN_CHANNEL_FILTER
            : `and(${KLAVIYO_CAMPAIGN_CHANNEL_FILTER},${delta})`,
        sort: spec === null ? undefined : spec.sort,
        include: KLAVIYO_CAMPAIGN_MESSAGE_INCLUDE,
      },
      (body) =>
        this.assertSideloadPresent(
          "listCampaigns",
          KLAVIYO_CAMPAIGN_MESSAGE_INCLUDE,
          "subject",
          body,
        ),
    );
    return page.rows;
  }

  /**
   * Events, incrementally.
   *
   * The highest-volume endpoint in this connector by an order of magnitude —
   * 1000 rows a page, 3500 requests a minute — which is why `engagement` is
   * flagged as a deliberate reuse call rather than an obvious one. The delta
   * filters on `datetime`, which is the same instant `occurred_at` maps from,
   * so a window bound and a watermark are the same axis here (they are NOT on
   * campaigns — see `runRead`).
   */
  async listEvents(filters: { since?: string } = {}): Promise<Record<string, unknown>[]> {
    const endpoint = KLAVIYO_ENDPOINTS.events;
    const spec = KLAVIYO_DELTA_FILTERS.engagement;
    const page = await this.page(
      "listEvents",
      endpoint,
      endpoint.path,
      {
        filter:
          filters.since === undefined ? undefined : klaviyoDeltaClause("engagement", filters.since),
        sort: spec === null ? undefined : spec.sort,
        include: this.eventMetricInclude,
      },
      (body) => this.assertSideloadPresent("listEvents", this.eventMetricInclude, "type", body),
    );
    return page.rows;
  }

  /**
   * Campaign counts, from the Reporting API. ONE call for every campaign.
   *
   * `emails_sent` is REQUIRED for `campaign` and exists nowhere on
   * `/api/campaigns`; it is this report's `recipients` statistic. The endpoint
   * refuses any request lacking `conversion_metric_id` and is capped at 1/s,
   * 2/m and 225/DAY for the whole account.
   *
   * Grouped, deliberately: the report returns one result per campaign, so this
   * is one request per READ rather than one per campaign. A naive per-campaign
   * loop exhausts a 225-call daily budget on an account with a few hundred
   * sends — and a daily cap is not something you back off from.
   *
   * Absent a conversion metric id the whole dataset is REFUSED rather than
   * served with an empty count. That is the never-empty contract doing its job:
   * `export-drop/profiles.ts` requires `emails_sent` because a campaign with no
   * send count cannot answer the only question anyone asks of it.
   *
   * UNVERIFIED, and flagged so nobody reads past it: the response shape parsed
   * below (`data.attributes.results[].groupings.campaign_id` +
   * `.statistics.<name>`) and the `timeframe.key` enum member were not
   * confirmed against a live account for this build. Both fail LOUDLY — a wrong
   * timeframe key is rejected by the report's own validation, and a shape that
   * does not match throws rather than being coerced into zeros.
   */
  async campaignValues(): Promise<Map<string, KlaviyoCampaignValues>> {
    const metricId = KlaviyoConnector.text(this.config.conversionMetricId);
    if (metricId === undefined) {
      throw this.blocked(
        "campaignValues",
        "the campaign dataset needs a conversion metric id. POST /api/campaign-values-reports " +
          "has conversion_metric_id in its required attributes, and it is the ONLY source of " +
          "emails_sent — which export-drop/profiles.ts requires, because a campaign with no " +
          "send count cannot answer the only question anyone asks of it. Set it on the " +
          "connection (Klaviyo: Analytics -> Metrics -> the metric that represents a sale, " +
          "usually \"Placed Order\"), or read lists, contacts and activity without campaigns",
      );
    }
    // Charged BEFORE the request so a retried 429 cannot draw the daily budget
    // down twice for one logical read.
    this.reportBudget.charge();
    const body = await this.request(
      "campaignValues",
      "POST",
      KLAVIYO_ENDPOINTS.campaignValuesReport.path,
      {},
      {
        data: {
          type: "campaign-values-report",
          attributes: {
            statistics: [...KLAVIYO_REPORT_STATISTICS],
            timeframe: { key: this.reportTimeframeKey },
            conversion_metric_id: metricId,
          },
        },
      },
    );
    const results = KlaviyoConnector.asRecord(
      KlaviyoConnector.asRecord(body.data)?.attributes,
    )?.results;
    if (!Array.isArray(results)) {
      throw this.blocked(
        "campaignValues",
        `the campaign-values report returned no \`results\` array (${typeof results}) — ` +
          `refusing to interpret a response that does not match the documented report ` +
          `contract rather than defaulting every campaign's send count to zero, which would ` +
          `read as "this campaign reached nobody"`,
      );
    }
    const values = new Map<string, KlaviyoCampaignValues>();
    for (const entry of results) {
      const row = KlaviyoConnector.asRecord(entry);
      if (row === undefined) continue;
      const campaignId = KlaviyoConnector.text(
        KlaviyoConnector.asRecord(row.groupings)?.campaign_id,
      );
      if (campaignId === undefined) continue;
      const stats = KlaviyoConnector.asRecord(row.statistics) ?? {};
      values.set(campaignId, {
        recipients: KlaviyoConnector.count(stats.recipients),
        opensUnique: KlaviyoConnector.count(stats.opens_unique),
        clicksUnique: KlaviyoConnector.count(stats.clicks_unique),
      });
    }
    return values;
  }

  /** A report statistic as a count. Absent stays absent — a campaign whose
   *  send count did not come back has an UNKNOWN one, not a zero. */
  private static count(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  }

  // ── Compliance ────────────────────────────────────────────────────────────

  /**
   * Delete every locally-persisted Klaviyo record for THIS connection.
   *
   * Klaviyo's API terms were not read for this build
   * ({@link KLAVIYO_UNRESOLVED_OBLIGATIONS}), so whether a deletion-on-request
   * obligation exists is formally open. It is built anyway, because it is far
   * cheaper to have the path than to discover we owe it — and because every
   * other cloud track here has one, so a customer's "delete my data" cannot
   * mean five different things depending on which vendor they connected.
   *
   * Two properties matter and both are tested:
   *
   *   - **Scoped by connection id, never by provider.** On a box with two
   *     Klaviyo connections a provider-scoped delete destroys the other
   *     customer's data.
   *   - **The enumeration is DERIVED from {@link servesDatasets}**, not a
   *     hand-maintained list, so a dataset added to the connector is purged by
   *     construction rather than left behind under a successful-looking report.
   *
   * The audit row carries COUNTS ONLY. No address, no profile content, no
   * campaign text ever reaches the activity trail.
   */
  async purgeAccount(): Promise<KlaviyoPurgeResult> {
    if (!this.purgeStore) {
      throw this.blocked(
        "purgeAccount",
        "no store is wired, so this connector cannot prove the deletion obligation was " +
          "discharged. Refusing rather than reporting a vacuous success.",
      );
    }
    const deleted: Record<string, number> = {};
    let totalDeleted = 0;
    for (const dataset of this.servesDatasets) {
      const n = await this.purgeStore.deleteByConnection(this.config.connectionId, dataset);
      deleted[dataset] = n;
      totalDeleted += n;
    }
    const result: KlaviyoPurgeResult = {
      connectionId: this.config.connectionId,
      datasets: this.servesDatasets,
      deleted,
      totalDeleted,
    };
    await this.audit?.({
      action: "klaviyo.purge_account",
      scope: {
        connectionId: this.config.connectionId,
        provider: KLAVIYO_PROVIDER,
        datasets: [...this.servesDatasets],
        deleted,
        totalDeleted,
      },
    });
    return result;
  }

  // ── State ─────────────────────────────────────────────────────────────────

  /**
   * The connection's state, explicitly.
   *
   * Order matters: an unusable key outranks a plan or scope limit, because
   * replacing the key is the only action that helps and upgrading a plan would
   * not.
   */
  private async state(): Promise<KlaviyoConnectionState> {
    try {
      await this.key();
    } catch (err) {
      // A malformed stored credential is a reconnect; nothing resolvable at all
      // is the shipped-off state ADR-041 §2 requires, and is not an error.
      if (err instanceof InvalidKlaviyoCredentialError) return "needs_reconnect";
      return "disconnected";
    }
    if (this.probe.state === "forbidden") return "capability_missing";
    return "connected";
  }

  async status(): Promise<KlaviyoStatus> {
    const state = await this.state();
    return {
      state,
      // One source of truth: `ok` is derived from `state` rather than computed
      // independently, so the two cannot disagree inside one returned object.
      ok: state === "connected",
      // Report THAT a credential exists, never its value and never a prefix of
      // it. Nothing in this object can carry key material.
      hasApiKey: this.apiKey !== null,
      hasConversionMetricId: KlaviyoConnector.text(this.config.conversionMetricId) !== undefined,
      apiRevision: this.revision,
      fallForwardOptOut: true,
      planProbe: this.probe,
      requestTimeoutMs: this.timeoutMs,
      reportCallsRemainingToday: this.reportBudget.remaining,
      scanModes: KLAVIYO_SCAN_MODE,
    };
  }

  /** The last computed schema fingerprint, or null before `introspect()`. */
  get schemaFingerprint(): string | null {
    return this.fingerprint;
  }
}
