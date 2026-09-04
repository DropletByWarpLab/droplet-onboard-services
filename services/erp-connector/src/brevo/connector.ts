/**
 * `BrevoConnector` — the marketing-plus-light-CRM track for Brevo (ex-Sendinblue).
 *
 * Reads a small business's Brevo account — who is on the lists, who changed
 * this week, what was sent and how it landed, which deals are open, which
 * orders came through — over the `/v3` REST surface, on an API key the
 * customer creates in their own Brevo console. Same {@link Connector}
 * interface, same blocked-error contract, same read-through posture as every
 * other cloud track, so nothing upstream of it changes.
 *
 * ## The host is STATIC, and that inverts the Mailchimp discipline
 *
 * Read this before copying anything from `../mailchimp/connector.ts`.
 *
 * Brevo's OpenAPI document declares exactly ONE server —
 * `https://api.brevo.com/v3` — with no datacenter suffix, no per-account
 * subdomain and no data-residency variant. So unlike Mailchimp (whose host is
 * assembled from the key at runtime and therefore CANNOT appear as a literal),
 * this connector MUST carry the whole-string `https://…` base URL as a source
 * literal: `scripts/check-egress-allowlist.py` is a static text scanner, and
 * the literal is exactly what it extracts and matches against the
 * `kind: egress` entry for `api.brevo.com`. Rewriting
 * {@link BREVO_API_BASE_URL} into a template, a join or a config read would
 * leave the allowlist entry unbacked and fail `egress-gate` for the wrong
 * reason — the opposite of the no-scheme-literal rule the Mailchimp and
 * Shopify tracks are built around.
 *
 * `api.sendinblue.com` is the pre-rebrand name. It is not registered, is not
 * a literal here, and is not accepted as an override. One host is the whole of
 * this connector's egress.
 *
 * CI seeing the host does NOT make {@link assertSafeBrevoBaseUrl} redundant:
 * the scanner proves the repo declares its destination, and the guard proves a
 * tampered `baseUrl` on a connection row cannot send the customer's key
 * somewhere else. Its tests assert the injected `fetch` was called ZERO times
 * on refusal, because a test that inspects the returned error still passes
 * when the request already went out carrying the key.
 *
 * ## The ADR-041 conditions, as they land here
 *
 *   1. **Only ever dials out.** The box accepts no inbound connections from
 *      the internet, so Brevo webhooks are structurally unavailable and
 *      polling is the only ingestion path. That is a constraint, not a
 *      preference — and it is the reason the missing deletion feed below is
 *      unfixable rather than merely unimplemented.
 *   2. **Ships off; owner consent is the enabling event.** With no key
 *      resolved every I/O method throws {@link ConnectorBlockedError} rather
 *      than half-authenticating.
 *   3. **Every destination registered.** `kind: egress`, one host, backed by
 *      the literal above and enforced by {@link assertSafeBrevoBaseUrl}.
 *   4. **Persistence: none.** ADR-041 §4 warns the encryption `ErpEntityCache`
 *      promises is NOT implemented (WARP-2028). This track is read-through and
 *      writes nothing — not `ErpEntityCache`, not `ErpSyncCursor`. Delta
 *      watermarks are RETURNED to the caller, never persisted here.
 *   5. **The key is an account-level standing credential.** Never logged,
 *      never in a tracked file, never echoed back in an error or a URL.
 *
 * ## The credential is the whole account, including SEND
 *
 * This is the largest risk on this connector and it is worse than Stripe's,
 * where a restricted `rk_` key exists and the guide's whole first section
 * pushes customers onto one. Brevo's help centre states it plainly: *"API keys
 * give full access to your Brevo account and should be protected in the same
 * way as a password"*, and the documented creation flow — name, expiry,
 * generate, copy — contains no scope or permission picker at all. So the key
 * this connector holds can send email from the customer's domain and delete
 * their contacts. Droplet uses it read-only ({@link BrevoConnector.applyWrite}
 * refuses, and {@link BREVO_READABLE_RESOURCES} is an allowlist rather than a
 * denylist), but the credential itself is not narrowable, and the setup guide
 * says so BEFORE the paste box rather than after it.
 *
 * NO REGEX ON THE KEY. The `xkeysib-` prefix is widely repeated and is
 * probably right, but it appears on no page of Brevo's developer documentation
 * — the api-key-authentication page states no prefix at all. A rejecting
 * pattern anchored on an undocumented prefix is a false rejection that blocks
 * a paying customer's onboarding for zero security gain. Validation is
 * `GET /account`, not a string match. `brevo.test.ts` pins that.
 *
 * ## THREE causes produce ONE indistinguishable 401
 *
 * Brevo answers all of these with the same status, and the box cannot tell
 * them apart from the response alone — so
 * {@link BrevoReauthorizationRequiredError} ENUMERATES them instead of
 * asserting one, and the connect card must render all of them:
 *
 *   a. the key was deleted, or was mistyped;
 *   b. the key EXPIRED — Brevo's creation dialog forces a choice of 7 days to
 *      1 year or no expiration, and separately *"inactive API keys expire
 *      after 90 days"*, so a box paused over a long gap loses the connection
 *      with the warning emails going to the account owner and never to us;
 *   c. the key was DEACTIVATED at Brevo, a real reversible state distinct from
 *      deletion — including the trap where ticking *"Create MCP server API
 *      key"* at creation deactivates the key the customer just copied;
 *   d. the source IP is blocked by Brevo's IP security.
 *
 * (d) gets its own class, {@link BrevoIpBlockedError}, because it is the one
 * an owner would otherwise "fix" by regenerating a key that was never the
 * problem — and because it is not an edge case. Brevo arms it BY ITSELF:
 * *"When you first use an API key, Brevo automatically authorizes the IP
 * addresses that make API calls"*, and *"If no new IPs are detected for 30
 * days, Brevo automatically: Activates the blocking of unknown IP
 * addresses."* Every box on a dynamic WAN address is therefore on a ~30-day
 * fuse by default. The mitigation is that auto-authorized IPs cover a `/24` SUBNET,
 * so an ISP re-lease inside the same /24 survives and only a jump outside it
 * trips the block.
 *
 * Classification uses {@link BREVO_IP_BLOCK_SIGNALS} over the response body.
 * That body is READ TO CLASSIFY and never propagated — see
 * {@link brevoErrorCode}.
 *
 * ## The delta story: five real watermarks, and two endpoints that must not
 *    be given one
 *
 * {@link BREVO_DELTA_PARAM} is the load-bearing table in this file, verified
 * against Brevo's live OpenAPI (`https://api.brevo.com/v3/swagger_definition_v3.yml`):
 *
 *   • `modifiedSince` exists verbatim on `/contacts`,
 *     `/contacts/lists/{listId}/contacts`, `/companies`, `/crm/deals` and
 *     `/orders`. `createdSince` exists on four of those — `/contacts`,
 *     `/companies`, `/crm/deals`, `/orders` — which is worth knowing because a
 *     first backfill can walk creations instead of full-scanning.
 *   • `/contacts/lists` documents ONLY `limit`, `offset` and `sort`. No date
 *     filter of any kind. Full scan only, declared rather than assumed.
 *   • `/emailCampaigns` has NO modification watermark. `startDate`/`endDate`
 *     filter the SENT date, are mutually mandatory, and apply only when
 *     `status` is unset or `sent`. That is a discovery window, not a
 *     watermark, and it is declared as its own scan mode.
 *
 * **The active hazard, and why the tests are shaped the way they are.**
 * ASSUMED, NOT MEASURED: Brevo publishes nothing about how it treats an
 * unknown query parameter, and it cannot be probed without a live key (every
 * unauthenticated call 401s before any parameter is evaluated). Assume the
 * dangerous case — silent ignore — because an invented `since_modified`, a
 * `modifiedSince` bolted onto `/emailCampaigns`, or a `startDate` on
 * `/contacts` would then return 200 with correct-looking rows while performing
 * a FULL SCAN reported as a delta, with no error anywhere. Two consequences,
 * both structural rather than intentional:
 *
 *   1. {@link assertDocumentedBrevoQuery} checks every outgoing query against
 *      the endpoint's documented parameter set, INSIDE the one `request()`
 *      choke point every call goes through, before the key is resolved. It is
 *      deliberately not called from the pagers: a guard that lives on the
 *      callers protects only the callers that exist today, and the next
 *      filtered read added straight onto `request()` would slip past it. The
 *      endpoint is resolved FROM THE PATH ({@link brevoEndpointForPath}), so
 *      no caller has to remember to declare its dataset, and a path this file
 *      cannot resolve may carry no query at all. A wrong delta parameter is a
 *      loud failure at the moment it is added.
 *   2. The tests assert on the OUTGOING REQUEST — the exact query string that
 *      left the box — and never on the rows that came back. A test that
 *      inspects the result still passes when the connector silently degraded.
 *
 * **No deletion feed, anywhere.** The string `deletedSince` occurs zero times
 * in Brevo's entire OpenAPI document. `modifiedSince` surfaces creates and
 * updates only, so a contact, company, deal or order hard-deleted in Brevo
 * simply stops appearing. Brevo's answer is webhooks, which this box cannot
 * receive. Poll-only therefore accumulates rows the customer has since
 * deleted, and reconciliation needs a periodic full sweep with a set
 * difference — not a watermark.
 *
 * ## Rate limits: two meters 360x apart, on one connection
 *
 * Brevo documents *"All endpoints under `/v3/contacts/{…}`"* at 36,000 RPH /
 * 10 RPS and *"All other endpoints"* at **100 RPH**. Campaigns, companies,
 * deals, orders and `/account` all sit in that catch-all, and 100 calls per
 * HOUR is the real throttle on this connector.
 *
 * So the budget is PER ENDPOINT GROUP ({@link BrevoCallBudget}), never per
 * connection: a single connection-wide meter either starves the list and
 * membership endpoints, which Brevo grants 36,000 calls an hour, or lets them
 * consume an allowance the 100/hour endpoints need.
 *
 * **What the two meters do NOT currently protect, stated plainly.** Whether
 * the BARE collection `GET /contacts` sits inside the fast group is NOT stated
 * by the vendor — the fast row is written `/v3/contacts/{…}`, with the braces
 * — so {@link brevoRateGroup} charges it to the SLOW group. That is
 * deliberate caution in the direction that costs latency rather than 429s, and
 * the consequence has to be written down rather than left as a surprise: a
 * 100k-row contacts backfill at `limit=1000` is exactly 100 pages, every one
 * of them charged to the 100/hour meter, so page 101 of an unbounded
 * `find_contact` throws {@link BrevoRateBudgetExhaustedError}. Nothing is lost
 * and nothing is broken when that happens — the read is reported as budgeted
 * out, not as an empty account — but the per-group split does NOT make a large
 * contacts backfill cheap, and a scheduler must page one with `modifiedSince`
 * or `createdSince` rather than assuming the fast meter applies.
 *
 * Resolving the ambiguity needs one successful AUTHENTICATED call against a
 * real account: Brevo's docs claim *"Rate limit headers are included in all
 * responses, not just 429 errors"*, but a live `GET /v3/account` with an
 * invalid key returns 401 carrying no `x-sib-ratelimit-*` header at all, so
 * the ambiguity cannot be resolved from a failed call. Reading
 * `x-sib-ratelimit-limit` on a real 200 is the measurement that would move the
 * bare collection into the fast group; until then this file's caution and its
 * prose agree.
 *
 * The fast group also carries a documented BURST ceiling of 10 requests per
 * second ({@link BREVO_CONTACTS_RATE_LIMIT_PER_SECOND}), which an hourly meter
 * cannot express — 36,000/hour permits a thousand calls in one second. It is
 * enforced by PACING rather than by refusal ({@link BrevoCallBudget.paceMs}):
 * a burst that would exceed it waits, because a membership backfill running as
 * fast as the runtime allows is a legitimate read and refusing it would be a
 * worse answer than delaying it.
 *
 * Backoff reads `x-sib-ratelimit-reset` (seconds). Brevo documents NO
 * `Retry-After`, so a connector looking for one finds nothing and retries
 * straight into another 429.
 *
 * ## Two more places this vendor fails quietly
 *
 *   • **`totalSubscribers` is being retired to a constant 0.** The list
 *     endpoint's own note: *"We're dropping support for the response
 *     attributes totalSubscribers and totalBlacklisted … The default value for
 *     the attributes will be 0."* `member_count` therefore reads
 *     `uniqueSubscribers`. Reading the deprecated field would make every
 *     audience report zero members and say so confidently — the marketing twin
 *     of a bill with no balance.
 *   • **Campaign statistics have a 6-month horizon.** *"This option only
 *     returns data for events that occurred in the last 6 months. For older
 *     campaigns, it is advisable to use the Get Campaign Report endpoint."* So
 *     an older campaign comes back with no `statistics` block, and
 *     `emails_sent` is left ABSENT rather than defaulted to 0 — a zero here
 *     would be a false statement about a send that really happened.
 *
 * ## Pagination disagrees with itself across Brevo's own endpoints
 *
 * `/crm/deals` pages with `offset`; `/companies` pages with `page`, whose
 * description is the identical string used for `offset` elsewhere ("Index of
 * the first document of the page"). Whether it means an offset or a page
 * number is genuinely unresolved in the vendor's documentation, and BOTH
 * wrong readings degrade into wrong-but-plausible result sets rather than
 * errors. {@link BrevoConnector.listCompanies} therefore MEASURES it once per
 * connection instead of guessing ({@link BrevoCompanyPaging}), and every
 * company page is checked against the ids already seen so a parameter that
 * does not advance is a loud failure rather than a silent duplicate.
 *
 * Page-size caps differ per endpoint and the maxima are real:
 * {@link BREVO_MAX_PAGE_SIZE}. A shared helper carrying `limit=1000` from
 * `/contacts` into `/contacts/lists` is 20x over that endpoint's documented
 * cap of 50.
 *
 * There is no cursor anywhere in this API, so a deep offset walk over a
 * collection mutating underneath can skip or repeat rows. Every scan is pinned
 * with `modifiedSince` where one exists, and the response `count` is treated
 * as advisory — never as proof a scan completed.
 *
 * ## Empty is not broken, and broken is not empty
 *
 * `/companies`, `/crm/deals` and `/orders` legitimately return nothing on an
 * account that never used Brevo's Sales Platform or its e-commerce module.
 * Equally, no degraded call may render as an empty dataset — that is the
 * `GET /api/files` 200-`[]`-on-an-outage defect reappearing on a cloud track.
 * Every failure state in this file is a typed throw.
 *
 * The line between the two is drawn at the ENVELOPE KEY, and
 * {@link BrevoConnector.collectionOf} is where it is drawn. A real empty is
 * `{"contacts": []}` — the documented key present, its array empty. A 200
 * whose body does not carry that key AT ALL is not an empty account: it is a
 * renamed array, an error object served with status 200, a proxy-rewritten
 * body, or a response this file does not understand. Returning `[]` for it
 * would make the offset pager see a short page, stop on page one, and report
 * zero rows as a clean result — for orders, "you sold nothing" — with nothing
 * red anywhere. So a missing or null collection key THROWS. Being wrong in
 * that direction costs a loud failure on a response shape nobody has seen;
 * being wrong in the other costs a customer believing a number that was never
 * measured.
 *
 * ## Why plain REST and no SDK
 *
 * `@getbrevo/brevo` declares NO LICENCE. The GitHub API reports `license:
 * null`, there is no LICENSE file at the repo root (though `package.json`'s
 * `files` array lists one), the README carries a hardcoded MIT *badge image*,
 * and npm shows MIT only through 3.0.4 — every 4.x, 5.x and 6.x release,
 * including the current `latest`, has no licence field. Under the repo's
 * permissive-licences-only rule an undeclared licence is not permissive; it is
 * no grant at all, which is a worse position than the copyleft SDKs this
 * codebase excludes outright. Pinning to a three-major-versions-stale release
 * to inherit a licence is not a fix.
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

/** Provider key for this track. */
export const BREVO_PROVIDER = "brevo";

/**
 * The one and only API base this connector will ever dial.
 *
 * A WHOLE-STRING `https://…` LITERAL on purpose — see the module docstring.
 * `scripts/check-egress-allowlist.py` extracts exactly this shape from tracked
 * `.ts` source and matches it against the `kind: egress` entry for
 * `api.brevo.com`. Split it into a template or a join and the allowlist entry
 * becomes unbacked; that is the opposite of the discipline the Mailchimp and
 * Shopify connectors follow, and copying theirs here would fail the gate for
 * the wrong reason.
 *
 * The `/v3` path segment is part of the pinned surface. Brevo's OpenAPI
 * declares this exact string as its single `server`.
 */
export const BREVO_API_BASE_URL = "https://api.brevo.com/v3";

/**
 * The only hosts this connector will send an API key to — EXACTLY these,
 * never a suffix match.
 *
 * DERIVED from {@link BREVO_API_BASE_URL} rather than hand-written, in the
 * `QBO_ALLOWED_API_HOSTS` shape. A hand-written host list drifts in exactly
 * one direction — towards dialling more — and can bless a host the egress
 * registry never screened. Deriving it means a second base URL cannot be added
 * without its host becoming a repo literal the egress gate extracts and
 * checks.
 *
 * Deliberately ABSENT: `api.sendinblue.com`. The pre-rebrand host appears
 * nowhere in current documentation, is not registered, and is not accepted as
 * an override.
 */
export const BREVO_ALLOWED_API_HOSTS: ReadonlySet<string> = new Set(
  [BREVO_API_BASE_URL].map((u) => new URL(u).hostname),
);

/**
 * The authentication header, spelled the way Brevo spells it.
 *
 * Verbatim from `developers.brevo.com/docs/how-it-works`: *"Include your API
 * key in the `api-key` header for every request."* The OpenAPI security scheme
 * agrees: `{name: 'api-key', in: 'header', type: 'apiKey'}`.
 *
 * NOT `Authorization`. NOT `Bearer`. NOT `X-API-Key`. Those are the three
 * shapes a reader coming from the Stripe or QuickBooks track will reach for,
 * and every one of them authenticates nothing here: Brevo answers 401 and the
 * connection looks like a bad credential. `brevo.test.ts` asserts this
 * character for character.
 */
export const BREVO_AUTH_HEADER = "api-key";

/**
 * The constant headers on every request, besides the credential.
 *
 * Small on purpose. Anything added here travels on every call, so this is the
 * wrong place to put anything derived from the account. The test asserts the
 * outgoing header set is EXACTLY the credential plus these — an extra header
 * is a leak surface, and a missing `Accept` lets a proxy negotiate a
 * representation the parser was not written for.
 *
 * (Brevo's OpenAPI also declares an optional `partner-key` scheme. It is not
 * needed on the customer-key path and is deliberately not sent.)
 */
export const BREVO_CONSTANT_HEADERS: Readonly<Record<string, string>> = {
  Accept: "application/json",
};

/** Every request this connector makes is a GET. Asserted in the tests over
 *  the recorded calls, so a mutation verb cannot appear by accident. */
export const BREVO_HTTP_METHOD = "GET";

/**
 * The datasets this track serves.
 *
 * All seven already exist in the shared vocabulary — nothing was invented, and
 * nothing is cast. `satisfies` keeps that honest at compile time while the
 * tuple keeps the per-dataset tables below exhaustive.
 *
 * `contact` rather than `audience_member` for `/contacts`, because Brevo's
 * contact database is the whole address book — a person with a name, an email
 * and creation/modification times — not membership of one list. Membership is
 * `audience_member`, which is a genuinely different row and comes from a
 * different endpoint.
 */
export const BREVO_DATASETS = [
  "contact",
  "audience",
  "audience_member",
  "campaign",
  "company",
  "deal",
  "ecommerce_order",
] as const satisfies readonly DatasetName[];

/** One of the seven datasets this track serves. */
export type BrevoDataset = (typeof BREVO_DATASETS)[number];

/**
 * The endpoint each dataset reads, relative to {@link BREVO_API_BASE_URL}.
 *
 * The `/companies` vs `/crm/deals` asymmetry is BREVO'S, not a typo: companies
 * has no `crm/` segment while deals does, and both resolve in the vendor's own
 * OpenAPI.
 */
export const BREVO_ENDPOINTS: Readonly<Record<BrevoDataset, string>> = {
  contact: "/contacts",
  audience: "/contacts/lists",
  audience_member: "/contacts/lists/{listId}/contacts",
  campaign: "/emailCampaigns",
  company: "/companies",
  deal: "/crm/deals",
  ecommerce_order: "/orders",
};

/** The credential-validation read. Cheapest authenticated call Brevo offers,
 *  takes no parameters, and sits in the 100 RPH bucket like everything else
 *  outside `/contacts/{…}`. */
export const BREVO_ACCOUNT_PATH = "/account";

/**
 * The account's e-commerce display currency.
 *
 * Needed because a Brevo order carries NO per-order currency field — the
 * account has one ISO-4217 display currency and that is the only currency fact
 * the API exposes for orders. Returns `403` when e-commerce is not activated,
 * which is the same account state in which there are no orders to read.
 */
export const BREVO_DISPLAY_CURRENCY_PATH = "/ecommerce/config/displayCurrency";

/**
 * THE load-bearing table: the exact modification-watermark parameter per
 * dataset, or `null` where the vendor documents none.
 *
 * `null` is a FINDING, not a gap. Both nulls were verified against the
 * vendor's live OpenAPI:
 *
 *   • `audience` (`/contacts/lists`) documents only `limit`, `offset`, `sort`.
 *   • `campaign` (`/emailCampaigns`) documents `type`, `status`, `statistics`,
 *     `startDate`, `endDate`, `limit`, `offset`, `sort`, `excludeHtmlContent`
 *     and `excludePdfAttachment` — and no modification filter among them.
 *
 * Giving either of them a `modifiedSince` would, on the assumption this file
 * is built around, return 200 and a full scan wearing a delta's clothes.
 * {@link assertDocumentedBrevoParams} makes that impossible rather than
 * unlikely.
 */
export const BREVO_DELTA_PARAM: Readonly<Record<BrevoDataset, string | null>> = {
  contact: "modifiedSince",
  audience: null,
  audience_member: "modifiedSince",
  campaign: null,
  company: "modifiedSince",
  deal: "modifiedSince",
  ecommerce_order: "modifiedSince",
};

/**
 * The creation filter, where one exists.
 *
 * FOUR endpoints, one of which is `/contacts` — not "the CRM/commerce
 * endpoints". Recorded because a first backfill can walk creations forward
 * instead of full-scanning the address book.
 */
export const BREVO_CREATED_SINCE_PARAM: Readonly<Record<BrevoDataset, string | null>> = {
  contact: "createdSince",
  audience: null,
  audience_member: null,
  campaign: null,
  company: "createdSince",
  deal: "createdSince",
  ecommerce_order: "createdSince",
};

/**
 * How each dataset can be read — DECLARED, so a scheduler can give the
 * expensive ones a slower cadence and so the next engineer does not spend an
 * afternoon hunting for a `modifiedSince` that does not exist.
 *
 * `send_date_window` is its own value rather than being folded into `delta`.
 * A campaign's `startDate`/`endDate` filter WHEN IT WAS SENT: a campaign
 * already inside a consumed window never re-enters it, while its statistics
 * keep accruing for days afterwards. Calling that a delta would be a lie a
 * scheduler acts on.
 */
export const BREVO_SCAN_MODE: Readonly<
  Record<BrevoDataset, "delta" | "full_scan_only" | "send_date_window">
> = {
  contact: "delta",
  audience: "full_scan_only",
  audience_member: "delta",
  campaign: "send_date_window",
  company: "delta",
  deal: "delta",
  ecommerce_order: "delta",
};

/**
 * The COMPLETE documented query-parameter set per endpoint.
 *
 * Enforced at request time by {@link assertDocumentedBrevoParams}, not merely
 * asserted in a test, because the failure mode is silent: an invented
 * parameter is assumed to be ignored, which yields a full scan mislabelled as
 * an incremental read with nothing anywhere to notice.
 *
 * Transcribed from Brevo's live OpenAPI. Parameters this connector never sends
 * are still listed — the set describes the ENDPOINT, so adding a legitimate
 * filter later does not require re-deriving what the vendor accepts.
 */
export const BREVO_DOCUMENTED_PARAMS: Readonly<Record<BrevoDataset, ReadonlySet<string>>> = {
  contact: new Set([
    "limit",
    "offset",
    "modifiedSince",
    "createdSince",
    "sort",
    "ids",
    "segmentId",
    "listIds",
    "filter",
  ]),
  audience: new Set(["limit", "offset", "sort"]),
  audience_member: new Set(["modifiedSince", "limit", "offset", "sort"]),
  campaign: new Set([
    "type",
    "status",
    "statistics",
    "startDate",
    "endDate",
    "limit",
    "offset",
    "sort",
    "excludeHtmlContent",
    "excludePdfAttachment",
  ]),
  company: new Set([
    "filters[attributes.name]",
    "linkedContactsIds",
    "linkedDealsIds",
    "modifiedSince",
    "createdSince",
    "page",
    "limit",
    "sort",
    "sortBy",
  ]),
  deal: new Set([
    "filters[attributes.deal_name]",
    "filters[attributes.deal_owner]",
    "filters[attributes.deal_stage]",
    "filters[attributes.pipeline]",
    "filters[linkedCompaniesIds]",
    "filters[linkedContactsIds]",
    "modifiedSince",
    "createdSince",
    "offset",
    "limit",
    "sort",
    "sortBy",
  ]),
  ecommerce_order: new Set(["limit", "offset", "sort", "modifiedSince", "createdSince"]),
};

/**
 * The documented `limit` ceiling per endpoint.
 *
 * These differ by a factor of twenty across endpoints one connector uses, and
 * an over-large `limit` is assumed to degrade into a wrong-but-plausible
 * result set rather than an error. Verified maxima: `/contacts` 1000,
 * `/contacts/lists/{listId}/contacts` 500, `/contacts/lists` **50**,
 * `/emailCampaigns` 100, `/orders` 100.
 *
 * `/crm/deals` and `/companies` declare NO maximum. They are clamped to the
 * documented DEFAULT of 50 rather than left open: under-consuming costs a page
 * or two, and there is no ceiling to discover safely from outside.
 */
export const BREVO_MAX_PAGE_SIZE: Readonly<Record<BrevoDataset, number>> = {
  contact: 1000,
  audience: 50,
  audience_member: 500,
  campaign: 100,
  company: 50,
  deal: 50,
  ecommerce_order: 100,
};

/** Hard ceiling on pages one read may fetch. An offset-paginated API that
 *  never reports a short page must stop the connector, not spin it. */
export const BREVO_MAX_PAGES = 500;

/**
 * The path segments this connector may dial, as an ALLOWLIST checked at
 * request time.
 *
 * Never a denylist of forbidden words in source: request paths are assembled
 * at runtime, so a denylist only catches the literals somebody happened to
 * type. Transactional send (`/smtp/email`), SMS (`/transactionalSMS`) and
 * WhatsApp are absent from this set, so no request path can reach them however
 * it is built.
 */
export const BREVO_READABLE_RESOURCES: ReadonlySet<string> = new Set([
  "account",
  "contacts",
  "emailCampaigns",
  "companies",
  "crm",
  "orders",
  "ecommerce",
]);

/**
 * Path segments refused by SHAPE, under otherwise-readable resources.
 *
 * A resource allowlist alone is not enough — the same lesson the Mailchimp
 * track records about `/campaigns/{id}/actions/send`. Here:
 *
 *   • `sendNow`, `sendTest`, `sendReport` are the campaign SEND verbs, living
 *     under the readable `emailCampaigns` resource. Sending a campaign is
 *     irreversible and externally visible to thousands of a customer's
 *     contacts.
 *   • `status` is `/orders/status`, the endpoint that CREATES orders, living
 *     under the readable `orders` resource.
 *
 * None of them is reachable by a GET this connector builds; refusing them by
 * shape means that stays true when somebody adds a path.
 */
export const BREVO_FORBIDDEN_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  "sendnow",
  "sendtest",
  "sendreport",
  "status",
]);

/**
 * Brevo's documented rate-limit rows.
 *
 * *"All endpoints under `/v3/contacts/{…}`"* — 36,000 RPH / 10 RPS.
 * *"All other endpoints"* — 100 RPH, which is the real throttle here.
 */
export const BREVO_CONTACTS_RATE_LIMIT_PER_HOUR = 36_000;

/**
 * The fast group's BURST ceiling, and it is enforced rather than recorded.
 *
 * An hourly meter cannot express it: 36,000 calls an hour permits a thousand
 * of them inside one second, which is a hundredfold over this row. So
 * {@link BrevoCallBudget.paceMs} meters the second as well as the hour, and
 * {@link BrevoConnector} waits out the difference before the request goes out.
 *
 * PACED, never refused. A membership backfill running as fast as the runtime
 * allows is a legitimate read; making it fail would be a worse answer than
 * making it wait, and a documented ceiling nothing enforces reads to the next
 * engineer as an enforced ceiling.
 */
export const BREVO_CONTACTS_RATE_LIMIT_PER_SECOND = 10;

/** *"All other endpoints"* — 100 requests per HOUR. Brevo publishes no
 *  per-second row for this group, and one is not invented here: an unstated
 *  burst ceiling paced against a guess is a delay with no vendor fact behind
 *  it. 100/hour is its own throttle. */
export const BREVO_DEFAULT_RATE_LIMIT_PER_HOUR = 100;
export const BREVO_RATE_LIMIT_WINDOW_MS = 3_600_000;

/** The burst window the per-second row is stated over. */
export const BREVO_RATE_LIMIT_BURST_WINDOW_MS = 1_000;

/** The reset header Brevo sends instead of `Retry-After`, which it does not
 *  document at all. Seconds. A connector looking for `Retry-After` finds
 *  nothing and retries straight into another 429. */
export const BREVO_RATE_LIMIT_RESET_HEADER = "x-sib-ratelimit-reset";

/** Retries for a 429 before the read is reported as blocked. */
export const BREVO_MAX_RATE_LIMIT_RETRIES = 3;

/** First backoff step when the reset header is absent; doubles per attempt. */
export const BREVO_BACKOFF_BASE_MS = 1_000;

/** Ceiling on an honoured `x-sib-ratelimit-reset`, so a hostile or garbled
 *  header cannot park a worker for an hour. */
export const BREVO_MAX_BACKOFF_MS = 60_000;

/** Brevo documents no per-request timeout; ours is explicit so a stalled read
 *  surfaces as a named failure instead of a promise that never settles. */
export const BREVO_REQUEST_TIMEOUT_MS = 60_000;

/**
 * The campaign send-date window's documented ceiling.
 *
 * *"The date range between `startDate` and `endDate` must not exceed 2
 * years."* 730 days rather than 731: two calendar years spanning a leap day
 * are 731, and the conservative reading costs one extra window on a backfill
 * while the optimistic one costs a 400 on exactly the accounts with the most
 * history.
 */
export const BREVO_CAMPAIGN_WINDOW_MAX_MS = 730 * 24 * 60 * 60 * 1000;

/**
 * How far back campaign STATISTICS reach.
 *
 * *"This option only returns data for events that occurred in the last 6
 * months. For older campaigns, it is advisable to use the Get Campaign Report
 * endpoint."* A number because it changes what an absent `emails_sent` MEANS:
 * for a campaign older than this it means "Brevo will not tell us from this
 * endpoint", not "nothing was sent".
 *
 * READ, not merely declared: {@link BrevoStatus.campaignStatsHorizonStart}
 * turns it into the instant before which this track cannot answer
 * `emails_sent` at all, so a scheduler pricing a campaign backfill sees the
 * boundary instead of discovering it as a column of absent values.
 */
export const BREVO_CAMPAIGN_STATS_HORIZON_MS = 183 * 24 * 60 * 60 * 1000;

/** The statistics projection this connector asks for. `globalStats` carries
 *  the per-campaign totals the canonical columns need; `linksStats` and
 *  `statsByDomain` are per-URL and per-mailbox-provider breakdowns nothing
 *  upstream asked for, and pulling them would persist far more than the
 *  minimum necessary. */
export const BREVO_CAMPAIGN_STATISTICS = "globalStats";

/**
 * The separator in a composite membership id.
 *
 * A Brevo contact id is ACCOUNT-WIDE, so the same id appears in every list the
 * contact belongs to. `audience_member` is one person's membership of one
 * audience, so keying those rows by the bare contact id would collapse a
 * contact on four lists into one row in any store keyed by (dataset, id) —
 * losing three memberships silently. The id is therefore `<listId>:<contactId>`
 * and `audience_id` carries the list separately, so nothing has to be parsed
 * back out.
 */
export const BREVO_MEMBER_ID_SEPARATOR = ":";

/**
 * Body substrings that mean "Brevo refused the SOURCE IP", not "the key is
 * wrong".
 *
 * Used to CLASSIFY, never to propagate — see {@link brevoErrorCode} for why
 * the vendor's message does not leave this file. Heuristic by necessity:
 * Brevo returns the same 401 status for an unknown IP as for a dead key, and
 * the only distinguishing signal is in the prose. Getting the classification
 * wrong costs a mislabelled connection state; getting it absent costs a
 * customer regenerating a key that was never the problem.
 */
export const BREVO_IP_BLOCK_SIGNALS =
  /\b(?:ip[ _-]?address|unrecogni[sz]ed ip|unknown ip|authorized ips?|whitelist)\b/i;

/** What this track is waiting on. Deliberately unlike the other tracks', so an
 *  installer triaging this is not sent looking for a QuickBooks company. */
export const BREVO_TRACK_REMEDIATION =
  "needs a Brevo API key created by the account owner at Settings -> SMTP & API -> " +
  "API Keys & MCP -> Generate a new API key, stored on the integration row — and the " +
  "brevo-api entry in allowed-egress.yaml, since this connector leaves the customer LAN";

/**
 * The plan prerequisite, and it is the strongest one in this batch.
 *
 * Brevo's own rate-limit page states the General tier is *"Available to all
 * account types (Free, Starter, Standard, Professional, and Enterprise)"*, and
 * the Sales Platform (companies and deals) is advertised as *"Build your
 * custom sales pipeline on the free plan, no credit card required."* So this
 * is a verified fact rather than an optimistic assumption — unlike the
 * Mailchimp track, which carries its plan question as an explicit unknown.
 */
export const BREVO_PLAN_PREREQUISITE = "none — the free plan grants API access";

/**
 * The four causes of a Brevo 401, in the order an owner should check them.
 *
 * Carried as data rather than prose because the connect card has to render all
 * four: the box cannot tell them apart from the response, and asserting one
 * would send the customer to fix something that is not broken.
 */
export const BREVO_UNAUTHORIZED_CAUSES: readonly string[] = [
  "the key was deleted at Brevo, or was pasted incompletely",
  "the key EXPIRED — Brevo's creation dialog forces a choice between 7 days and 1 year " +
    "unless 'no expiration' was picked, and separately inactive keys expire after 90 days",
  "the key was DEACTIVATED at Brevo (a reversible state, distinct from deletion) — " +
    "including by ticking 'Create MCP server API key' at creation, which deactivates the " +
    "key that was just copied",
  "the box's public IP is blocked by Brevo IP security (Settings -> Security -> " +
    "Authorized IPs), which Brevo arms by itself 30 days after the last new IP is seen",
];

// ─────────────────────────────────────────────────────────────────────────────
// Errors — distinct classes with distinct codes, so a caller tells them apart
// without string-matching a message.
// ─────────────────────────────────────────────────────────────────────────────

/** Thrown when a connection names a destination this track will not dial. */
export class UnsafeBrevoBaseUrlError extends Error {
  readonly code = "UNSAFE_BASE_URL";
  constructor(reason: string) {
    super(`refusing to send a Brevo API key there: ${reason}`);
    this.name = "UnsafeBrevoBaseUrlError";
  }
}

/**
 * Thrown when only a person can restore the connection.
 *
 * The message enumerates {@link BREVO_UNAUTHORIZED_CAUSES} rather than naming
 * one, because Brevo answers all of them with the same status and body class.
 * It carries the vendor's error CODE and the HTTP status — never the vendor's
 * message, and never the credential.
 */
export class BrevoReauthorizationRequiredError extends Error {
  readonly code = "REAUTHORIZE_REQUIRED";
  constructor(
    readonly status: number,
    readonly vendorCode: string | undefined,
  ) {
    super(
      `Brevo refused the API key (HTTP ${status}${vendorCode ? `, ${vendorCode}` : ""}). ` +
        `Retrying cannot fix this. One of: ${BREVO_UNAUTHORIZED_CAUSES.join("; ")}.`,
    );
    this.name = "BrevoReauthorizationRequiredError";
  }
}

/**
 * Thrown when Brevo refused the request's SOURCE IP rather than the key.
 *
 * Its own class, and its own connection state, because the remedy is the
 * opposite of the one a 401 usually implies: the key is fine, and regenerating
 * it wastes the customer's time without changing anything. Brevo
 * auto-authorizes on a `/24` SUBNET, so an ISP re-lease inside the same block
 * survives and only a jump outside it trips this.
 */
export class BrevoIpBlockedError extends Error {
  readonly code = "IP_BLOCKED";
  constructor(
    readonly status: number,
    readonly vendorCode: string | undefined,
  ) {
    super(
      `Brevo blocked this box's source IP (HTTP ${status}${vendorCode ? `, ${vendorCode}` : ""}). ` +
        `The API key is NOT the problem and regenerating it will not help. Authorize the ` +
        `office's public IP at Settings -> Security -> Authorized IPs, or deactivate ` +
        `automatic blocking. Brevo arms this by itself 30 days after the last new IP is ` +
        `seen, and auto-authorizes a /24 — so only an address change outside that block ` +
        `trips it.`,
    );
    this.name = "BrevoIpBlockedError";
  }
}

/**
 * Thrown when the account's plan, module or permissions do not grant a
 * resource.
 *
 * Its own class rather than folded into re-authorization: the key is fine and
 * making a new one would not change the answer. This is the state
 * `/ecommerce/config/displayCurrency` returns when e-commerce is not
 * activated, and it must never render as `[]` — an empty order list reads as
 * "you sold nothing".
 */
export class BrevoCapabilityMissingError extends Error {
  readonly code = "CAPABILITY_MISSING";
  constructor(
    readonly resource: string,
    readonly status: number,
    readonly vendorCode: string | undefined,
  ) {
    super(
      `Brevo refused "${resource}" for this account (HTTP ${status}` +
        `${vendorCode ? `, ${vendorCode}` : ""}). This is a plan, module or permission ` +
        `limit, not a broken key — creating a new key will not change it. Plan ` +
        `prerequisite on record: ${BREVO_PLAN_PREREQUISITE}.`,
    );
    this.name = "BrevoCapabilityMissingError";
  }
}

/**
 * Thrown when this connection has spent its hourly allowance for an endpoint
 * group. NOT a fault.
 *
 * Reported rather than silently waited out, because the wait is up to an hour
 * and a caller that thinks it is merely slow will queue more work behind it.
 */
export class BrevoRateBudgetExhaustedError extends Error {
  readonly code = "RATE_BUDGET_EXHAUSTED";
  constructor(
    readonly group: BrevoRateGroup,
    readonly spent: number,
    readonly ceiling: number,
    readonly resetsInMs: number,
  ) {
    super(
      `Brevo hourly budget exhausted for the "${group}" endpoint group: ${spent}/${ceiling} ` +
        `calls used, resets in ${Math.ceil(resetsInMs / 1000)}s. Nothing is broken and no ` +
        `data is lost; the budget is per endpoint group because Brevo's own limits differ ` +
        `360x between them.`,
    );
    this.name = "BrevoRateBudgetExhaustedError";
  }
}

/**
 * Thrown when a paginated walk stopped making progress.
 *
 * Exists because `/companies` pages with a parameter whose documented meaning
 * is ambiguous (see {@link BrevoCompanyPaging}): a page parameter that does
 * not advance produces duplicate rows rather than an error, and a duplicate
 * set is a wrong answer nobody would look at twice.
 */
export class BrevoPaginationContractError extends Error {
  readonly code = "PAGINATION_CONTRACT";
  constructor(
    readonly op: string,
    reason: string,
  ) {
    super(`"${op}" cannot page safely: ${reason}`);
    this.name = "BrevoPaginationContractError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Guards
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate an operator-supplied API base, or throw.
 *
 * HTTPS only — an API key over http is the key given away. Exactly one of the
 * registered hosts ({@link BREVO_ALLOWED_API_HOSTS}), matched on equality and
 * never a suffix, so `api.brevo.com.evil.test` is refused. Userinfo is
 * rejected because some HTTP clients resolve `https://evil@api.brevo.com` to a
 * different authority than a reader expects. Any port but 443 is refused
 * because that is all the egress registry declares.
 *
 * Called at CONSTRUCTION and again on every request build, before the request
 * object exists — so a bad destination costs zero fetch calls and never
 * touches the credential. That is what the tests assert on.
 */
export function assertSafeBrevoBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeBrevoBaseUrlError(`"${raw}" is not a URL`);
  }
  if (url.protocol !== "https:") {
    throw new UnsafeBrevoBaseUrlError(`"${url.protocol}//" is not https`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new UnsafeBrevoBaseUrlError("the URL carries userinfo");
  }
  const host = url.hostname.toLowerCase();
  if (!BREVO_ALLOWED_API_HOSTS.has(host)) {
    throw new UnsafeBrevoBaseUrlError(`"${host}" is not a registered Brevo API host`);
  }
  // The URL parser drops an explicit :443 (the https default), so any port
  // left standing is one the egress registry does not declare.
  if (url.port !== "" && url.port !== "443") {
    throw new UnsafeBrevoBaseUrlError(
      `port ${url.port} — the egress registry allows this host on 443 only`,
    );
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * Refuse a path this connector may not dial.
 *
 * Two independent checks, because either alone leaves a hole: the first
 * segment must be in {@link BREVO_READABLE_RESOURCES}, and no segment may be
 * one of {@link BREVO_FORBIDDEN_PATH_SEGMENTS}, which are the send and
 * order-creation verbs living under otherwise-readable resources.
 *
 * Runs at the top of every request, BEFORE the key is resolved, so an
 * off-allowlist path never reaches the network and never touches the
 * credential.
 */
export function assertReadableBrevoResource(path: string): void {
  const segments = path.split("/").filter(Boolean);
  const resource = segments[0] ?? "";
  if (!BREVO_READABLE_RESOURCES.has(resource)) {
    throw new ConnectorBlockedError(
      `refusing to dial the Brevo resource "${resource}"`,
      "this connector may only read the resources named in BREVO_READABLE_RESOURCES. " +
        "Transactional email, SMS and WhatsApp sending are absent from that set on " +
        "purpose — the customer's key can send mail from their own domain, so the send " +
        "surface is unreachable by construction rather than by intention.",
    );
  }
  const forbidden = segments.find((s) => BREVO_FORBIDDEN_PATH_SEGMENTS.has(s.toLowerCase()));
  if (forbidden !== undefined) {
    throw new ConnectorBlockedError(
      `refusing to dial a Brevo "/${forbidden}/" path`,
      "campaign sending (sendNow, sendTest, sendReport) and order creation " +
        "(/orders/status) live under resources this connector legitimately reads, so " +
        "they are refused by path SHAPE rather than left to a resource-level allowlist.",
    );
  }
}

/**
 * Refuse a query carrying a parameter this endpoint does not document.
 *
 * The whole point of this file's testing posture. Brevo is ASSUMED to ignore
 * an unknown query parameter — the assumption cannot be probed without a live
 * key, and it is the dangerous direction — so an invented `since_modified`, a
 * `modifiedSince` on `/emailCampaigns`, or a `startDate` on `/contacts` would
 * return 200, correct-looking rows, and a full scan mislabelled as a delta,
 * with no error anywhere. A subset check against
 * {@link BREVO_DOCUMENTED_PARAMS} turns that into a loud failure at the moment
 * the parameter is added.
 *
 * Undefined values are skipped: an absent filter is not a parameter.
 */
export function assertDocumentedBrevoParams(
  dataset: BrevoDataset,
  params: Readonly<Record<string, unknown>>,
): void {
  const documented = BREVO_DOCUMENTED_PARAMS[dataset];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (!documented.has(key)) {
      throw new ConnectorBlockedError(
        `"${key}" is not a documented ${BREVO_ENDPOINTS[dataset]} parameter`,
        `that endpoint accepts only ${[...documented].sort().join(", ")}. Brevo is assumed ` +
          `to IGNORE an unknown query parameter rather than reject it, so sending one ` +
          `would produce a full scan reported as an incremental read — which is why this ` +
          `is a runtime guard and not a comment.`,
      );
    }
  }
}

/**
 * Which documented endpoint a request path IS.
 *
 * `dataset` carries a documented parameter set in
 * {@link BREVO_DOCUMENTED_PARAMS}. `parameterless` is an endpoint this
 * connector dials that documents NO query parameter at all — `/account`,
 * `/ecommerce/config/displayCurrency` and the single-object
 * `GET /companies/{id}`. `unknown` is a path this file cannot name, which is
 * not automatically an error (the resource allowlist has already had its say)
 * but which may not carry a query: an unrecognised endpoint's parameters
 * cannot be checked against anything, and Brevo is assumed to IGNORE what it
 * does not recognise.
 */
export type BrevoEndpoint =
  | { kind: "dataset"; dataset: BrevoDataset }
  | { kind: "parameterless"; endpoint: string }
  | { kind: "unknown" };

/**
 * Resolve a request path to the endpoint whose parameters govern it.
 *
 * FROM THE PATH, deliberately, rather than from a dataset argument the caller
 * passes alongside it. A caller-declared dataset is a second thing to keep in
 * step with the path, and the failure when they drift is silent — `/companies`
 * checked against the `deal` parameter set accepts `offset`, which
 * `/companies` does not document. The path is the thing that actually goes on
 * the wire, so the path is what is checked.
 *
 * Matching is on SEGMENT COUNT AND POSITION, never on a prefix: `/contacts`
 * (the collection, 1 segment) and `/contacts/lists/{id}/contacts` (a
 * membership, 4) document different parameters, and `/companies/{id}` — a
 * single object with no query at all — must not inherit the `/companies`
 * collection's filter set.
 */
export function brevoEndpointForPath(path: string): BrevoEndpoint {
  const segments = path.split("/").filter(Boolean);
  const [first, second, third, fourth] = segments;

  if (segments.length === 1) {
    if (first === "account") return { kind: "parameterless", endpoint: BREVO_ACCOUNT_PATH };
    if (first === "contacts") return { kind: "dataset", dataset: "contact" };
    if (first === "emailCampaigns") return { kind: "dataset", dataset: "campaign" };
    if (first === "companies") return { kind: "dataset", dataset: "company" };
    if (first === "orders") return { kind: "dataset", dataset: "ecommerce_order" };
  }

  if (segments.length === 2) {
    if (first === "contacts" && second === "lists") return { kind: "dataset", dataset: "audience" };
    if (first === "crm" && second === "deals") return { kind: "dataset", dataset: "deal" };
    // GET /companies/{id} returns the object UNWRAPPED and documents no query
    // parameter — see BrevoConnector.getCompany.
    if (first === "companies") return { kind: "parameterless", endpoint: "/companies/{id}" };
  }

  if (segments.length === 3 && first === "ecommerce" && second === "config" && third === "displayCurrency") {
    return { kind: "parameterless", endpoint: BREVO_DISPLAY_CURRENCY_PATH };
  }

  if (segments.length === 4 && first === "contacts" && second === "lists" && fourth === "contacts") {
    return { kind: "dataset", dataset: "audience_member" };
  }

  return { kind: "unknown" };
}

/**
 * Refuse a query this PATH does not document. The request-time form of
 * {@link assertDocumentedBrevoParams}, and the one the connector calls.
 *
 * Lives on the path rather than on a dataset so it can sit inside the single
 * `request()` choke point every call in this file goes through. That placement
 * is the whole point: a parameter guard invoked from the pagers protects the
 * pagers, and the next engineer who adds a filtered read straight onto
 * `request()` — a `modifiedSince` on `/emailCampaigns`, say — gets 200, a full
 * scan reported as a delta, and nothing red anywhere.
 *
 * An endpoint that documents no parameters may carry none, and a path this
 * file cannot resolve may carry none either: an unchecked query on an
 * unrecognised endpoint is exactly the silent full scan this connector exists
 * to make impossible.
 */
export function assertDocumentedBrevoQuery(
  path: string,
  params: Readonly<Record<string, unknown>>,
): void {
  const endpoint = brevoEndpointForPath(path);
  if (endpoint.kind === "dataset") {
    assertDocumentedBrevoParams(endpoint.dataset, params);
    return;
  }

  const sent = Object.entries(params)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key)
    .sort();
  if (sent.length === 0) return;

  if (endpoint.kind === "parameterless") {
    throw new ConnectorBlockedError(
      `"${endpoint.endpoint}" documents no query parameters, but ${sent.join(", ")} was sent`,
      "Brevo is assumed to IGNORE an unknown query parameter rather than reject it, so a " +
        "filter on an endpoint that takes none returns 200 and an unfiltered result wearing " +
        "a filter's clothes.",
    );
  }

  throw new ConnectorBlockedError(
    `refusing to send ${sent.join(", ")} to the unrecognised Brevo path "${path}"`,
    "this connector checks every outgoing query against the endpoint's documented " +
      "parameter set, and a path brevoEndpointForPath() cannot name has no set to check " +
      "against. Add the endpoint there — with its parameters in BREVO_DOCUMENTED_PARAMS — " +
      "rather than sending a query nothing has screened.",
  );
}

/**
 * Clamp a requested page size to the endpoint's documented ceiling.
 *
 * The caps differ twentyfold across endpoints this one connector uses
 * ({@link BREVO_MAX_PAGE_SIZE}), and an over-large `limit` is assumed to
 * degrade into a wrong-but-plausible result set rather than an error. A shared
 * pager that carries `/contacts`'s 1000 into `/contacts/lists` is the exact
 * failure this exists to make impossible.
 */
export function clampBrevoPageSize(dataset: BrevoDataset, requested: number): number {
  const max = BREVO_MAX_PAGE_SIZE[dataset];
  if (!Number.isFinite(requested)) return max;
  return Math.min(Math.max(1, Math.trunc(requested)), max);
}

/** Which documented rate-limit meter a path is charged against. */
export type BrevoRateGroup = "contacts" | "other";

/**
 * Charge a path to a rate-limit group.
 *
 * Brevo's fast row is written `/v3/contacts/{…}` — with the braces — so
 * whether the BARE collection `GET /contacts` sits inside that 36,000 RPH
 * group or falls to the 100 RPH catch-all is not stated. It is charged to the
 * SLOW group here: under-consuming costs latency, over-consuming costs 429s,
 * and the ambiguity can only be resolved by reading `x-sib-ratelimit-limit` on
 * a successful authenticated call against a real account.
 *
 * SAY THE CONSEQUENCE OUT LOUD, because the per-group split does not remove
 * it: `/contacts` is the endpoint whose backfill is largest, and charging it
 * here means a 100k-row walk at `limit=1000` — exactly 100 pages — spends the
 * whole 100/hour "other" allowance and throws
 * {@link BrevoRateBudgetExhaustedError} on page 101. That is a reported
 * budget, not a lost read, but a caller must page the address book with
 * `modifiedSince`/`createdSince` rather than assume the fast meter covers it.
 * `brevo.test.ts` pins both halves so the code and the reasoning cannot drift
 * apart again.
 */
export function brevoRateGroup(path: string): BrevoRateGroup {
  return path.startsWith("/contacts/") ? "contacts" : "other";
}

/**
 * Brevo's error CODE, if it is safe to surface.
 *
 * The vendor's `message` NEVER leaves this function. Brevo's own examples
 * quote request state back at the caller (*"email is already associated with
 * another Contact"*), so propagating it writes whatever the request contained
 * into every log line that renders the error.
 *
 * The `code` field is not simply passed through either. Brevo's own enum mixes
 * token-shaped codes (`invalid_parameter`, `permission_denied`) with free-text
 * sentences (*"Returned when query params are invalid"*), and `code` is not
 * even required — only `message` is. So a code is surfaced only when it looks
 * like a code; anything else degrades to the bare HTTP status, which is always
 * safe.
 */
export function brevoErrorCode(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const code = (body as { code?: unknown }).code;
  if (typeof code !== "string") return undefined;
  return /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : undefined;
}

/**
 * A Brevo money value in MAJOR units.
 *
 * IDENTITY, and that is the whole reason this function exists rather than a
 * bare field read. Brevo states amounts in major units already — the vendor's
 * own order example is `amount: 308.42` for a total *"including all shipping
 * expenses, tax and the price of items"*, and a deal's is `amount: 12`. A
 * reader arriving from `../stripe/connector.ts`, where every figure is a
 * minor-unit integer that MUST be divided, would reach for the same conversion
 * here and understate every Brevo figure by 100x — silently, because 20.00 is
 * as plausible a number as 2000.00.
 *
 * So the decision is written down, exported, and tested against the vendor's
 * own documented example. Absent stays absent: a missing amount must not
 * become 0, because absent money and zero money are different facts.
 */
export function brevoMajorUnits(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (raw === "") return undefined;
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

/** An ISO-4217 alphabetic code, or undefined. Shape-checked rather than
 *  trusted: the only currency sources on this track are an account setting and
 *  an account-defined custom attribute, and a money column whose currency is
 *  "dollars" is not a currency column. */
export function brevoCurrencyCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : undefined;
}

/**
 * The composite id for one membership row. See
 * {@link BREVO_MEMBER_ID_SEPARATOR} for why a bare contact id would silently
 * collapse a contact's memberships into one.
 */
export function brevoMemberId(listId: string, contactId: string): string {
  return `${listId}${BREVO_MEMBER_ID_SEPARATOR}${contactId}`;
}

/**
 * Split a requested campaign window into chunks Brevo will accept.
 *
 * Three documented constraints, all of which bite a first backfill:
 * `startDate` and `endDate` are mutually mandatory, the range *"must not
 * exceed 2 years"*, and neither may be in the future. A backfill over a longer
 * history is therefore several calls, not one, and a window whose end is
 * "now + a clock skew" is a 400 on the first run of a new install.
 *
 * Returns oldest-first, in the vendor's own format (`toISOString()` is exactly
 * `YYYY-MM-DDTHH:mm:ss.SSSZ`). An empty array means the requested window lies
 * entirely in the future, which is a legitimate question with no answer rather
 * than an error.
 */
export function brevoCampaignWindows(
  fromMs: number,
  toMs: number,
  nowMs: number,
): { startDate: string; endDate: string }[] {
  const end = Math.min(toMs, nowMs);
  const start = Math.min(fromMs, end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return [];
  const windows: { startDate: string; endDate: string }[] = [];
  // Bounded by construction: each step advances by the maximum window, so the
  // count is (span / 730 days) and cannot exceed it.
  const steps = Math.ceil((end - start) / BREVO_CAMPAIGN_WINDOW_MAX_MS);
  for (let i = 0; i < steps; i += 1) {
    const lo = start + i * BREVO_CAMPAIGN_WINDOW_MAX_MS;
    const hi = Math.min(lo + BREVO_CAMPAIGN_WINDOW_MAX_MS, end);
    windows.push({
      startDate: new Date(lo).toISOString(),
      endDate: new Date(hi).toISOString(),
    });
  }
  return windows;
}

// ─────────────────────────────────────────────────────────────────────────────
// The per-group call budget
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Two hourly meters, one per documented endpoint group.
 *
 * NOT one budget for the connection. Brevo's own limits differ by 360x between
 * the groups, so a single number either starves the contacts endpoints or
 * over-runs everything else: at 100 calls/hour applied connection-wide, one
 * contacts backfill at `limit=1000` is exactly 100 pages and would consume the
 * entire allowance in one run.
 *
 * The window is a simple fixed hour keyed on the injected clock, deliberately
 * not a rolling average: Brevo publishes RPH, the meter has to be explicable
 * to the person reading a connection card, and a conservative reset is the
 * safe direction to be wrong in.
 */
export class BrevoCallBudget {
  private readonly ceilings: Readonly<Record<BrevoRateGroup, number>>;
  private readonly burstCeilings: Readonly<Record<BrevoRateGroup, number>>;
  private readonly spent: Record<BrevoRateGroup, number> = { contacts: 0, other: 0 };
  private readonly windowStart: Record<BrevoRateGroup, number> = { contacts: 0, other: 0 };
  private readonly burstSpent: Record<BrevoRateGroup, number> = { contacts: 0, other: 0 };
  private readonly burstStart: Record<BrevoRateGroup, number> = { contacts: 0, other: 0 };

  constructor(
    private readonly now: () => number,
    ceilings: Partial<Record<BrevoRateGroup, number>> = {},
    burstCeilings: Partial<Record<BrevoRateGroup, number>> = {},
  ) {
    this.ceilings = {
      contacts: ceilings.contacts ?? BREVO_CONTACTS_RATE_LIMIT_PER_HOUR,
      other: ceilings.other ?? BREVO_DEFAULT_RATE_LIMIT_PER_HOUR,
    };
    this.burstCeilings = {
      contacts: burstCeilings.contacts ?? BREVO_CONTACTS_RATE_LIMIT_PER_SECOND,
      // Brevo publishes no per-second row for the catch-all group, and one is
      // not invented: Infinity means "paced by the hourly meter alone".
      other: burstCeilings.other ?? Number.POSITIVE_INFINITY,
    };
    const t = this.now();
    this.windowStart.contacts = t;
    this.windowStart.other = t;
    this.burstStart.contacts = t;
    this.burstStart.other = t;
  }

  /** Charge one call, or throw if this group's hour is spent. Called BEFORE
   *  the request goes out, so an exhausted budget costs zero fetch calls. */
  charge(group: BrevoRateGroup): void {
    const t = this.now();
    if (t - this.windowStart[group] >= BREVO_RATE_LIMIT_WINDOW_MS) {
      this.windowStart[group] = t;
      this.spent[group] = 0;
    }
    const ceiling = this.ceilings[group];
    if (this.spent[group] >= ceiling) {
      throw new BrevoRateBudgetExhaustedError(
        group,
        this.spent[group],
        ceiling,
        BREVO_RATE_LIMIT_WINDOW_MS - (t - this.windowStart[group]),
      );
    }
    this.spent[group] += 1;
  }

  /**
   * How long this call must WAIT to stay inside the group's per-second row,
   * in ms. Zero when the burst has room.
   *
   * Separate from {@link charge} because the two ceilings deserve opposite
   * answers: an exhausted HOUR is reported (the wait is up to an hour and a
   * caller that thinks it is merely slow queues more work behind it), while an
   * exhausted SECOND is simply waited out. A membership backfill hitting the
   * 10 RPS row is a legitimate read going quickly, not a fault.
   *
   * Metered in VIRTUAL time: when the second is full, the window advances by
   * exactly one burst window regardless of what the clock says, and the
   * returned wait is the distance to that new window. So the meter is
   * deterministic, is monotonic under a frozen clock (a test's injected
   * `sleep` does not have to move `now`), and cannot spin — every call either
   * consumes a slot or names a strictly later one.
   */
  paceMs(group: BrevoRateGroup): number {
    const ceiling = this.burstCeilings[group];
    if (!Number.isFinite(ceiling)) return 0;

    const t = this.now();
    if (t >= this.burstStart[group] + BREVO_RATE_LIMIT_BURST_WINDOW_MS) {
      this.burstStart[group] = t;
      this.burstSpent[group] = 0;
    }
    if (this.burstSpent[group] >= ceiling) {
      this.burstStart[group] += BREVO_RATE_LIMIT_BURST_WINDOW_MS;
      this.burstSpent[group] = 0;
    }
    this.burstSpent[group] += 1;
    // The wait is the distance to the window this call was placed in — for
    // EVERY call, not only the one that overflowed. A window already ahead of
    // the clock still lies ahead of it for the nine calls that follow the
    // eleventh, and returning 0 for those would let a burst of twenty leave
    // the box inside one second having waited once.
    return Math.max(0, this.burstStart[group] - t);
  }

  /** Counts only — never a path, never a parameter. Rendered on the
   *  connection card. */
  snapshot(): Readonly<Record<BrevoRateGroup, { spent: number; ceiling: number }>> {
    return {
      contacts: { spent: this.spent.contacts, ceiling: this.ceilings.contacts },
      other: { spent: this.spent.other, ceiling: this.ceilings.other },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Wiring types
// ─────────────────────────────────────────────────────────────────────────────

type FetchLike = (input: string, init?: Record<string, unknown>) => Promise<Response>;

/** Resolve the API key (from the orchestrator's encrypted store). Cleartext
 *  for the life of one call only; never cached to disk here. */
export type BrevoKeyResolver = () => Promise<string>;

/** The default resolver: nothing wired, so the track blocks honestly. */
export const blockedBrevoKeyResolver: BrevoKeyResolver = async () => {
  throw new ConnectorBlockedError("resolve the Brevo API key", BREVO_TRACK_REMEDIATION);
};

export interface BrevoConnectorConfig {
  /** Pointer into the encrypted secret store — NEVER a key. */
  credentialsSecretRef: string;
  /** The connection row's id. Never a provider name. */
  connectionId: string;
  /**
   * Operator override for the API base. Guarded on construction and again per
   * request. Exists only so a test or a proxy deployment can be pointed
   * deliberately; it cannot name a host the registry has not screened.
   */
  baseUrl?: string;
  /**
   * The currency Brevo CRM deal amounts are stated in, if the owner has told
   * us.
   *
   * Brevo publishes NO currency for a deal: the object carries a bare `amount`
   * and there is no CRM equivalent of the e-commerce display-currency
   * endpoint. `profiles.ts` refuses to let money exist without a currency for
   * a reason — *"an amount whose currency must be guessed is not a number"* —
   * so with nothing here, `deal.amount` is WITHHELD rather than emitted
   * beside an empty currency column. Borrowing the e-commerce display currency
   * would be a different subsystem's setting wearing this one's name.
   */
  dealCurrency?: string;
}

export interface BrevoConnectorDeps {
  fetchImpl?: FetchLike;
  now?: () => number;
  resolveApiKey?: BrevoKeyResolver;
  timeoutMs?: number;
  /** Injected so tests exercise the backoff without spending real time. */
  sleep?: (ms: number) => Promise<void>;
  budget?: BrevoCallBudget;
}

/** The ADR-041 §5 connection-state vocabulary. Explicit, never inferred from a
 *  missing key — an absent value defaulted into "connected" is exactly the
 *  looks-connected-syncs-nothing failure that section exists to prevent. */
export type BrevoConnectionState =
  | "disconnected"
  | "connected"
  | "needs_reconnect"
  | "ip_blocked"
  | "capability_missing";

/** What a `/account` probe established. `unverified` is a first-class value,
 *  never a null: "we have not asked" and "we asked and it worked" are
 *  different facts and only one of them is evidence. */
export type BrevoAccountProbe =
  | { state: "unverified" }
  | { state: "ok"; companyName: string | null; probedAt: number }
  | { state: "forbidden"; resource: string; probedAt: number };

export interface BrevoStatus {
  state: BrevoConnectionState;
  ok: boolean;
  /** Whether a key resolves. NEVER the key, and never a prefix of it. */
  hasApiKey: boolean;
  accountProbe: BrevoAccountProbe;
  /** Per dataset, how it can be read at all. */
  scanModes: Readonly<Record<BrevoDataset, "delta" | "full_scan_only" | "send_date_window">>;
  /** Per dataset, the EXACT vendor parameter a delta read uses, or null. */
  deltaParams: Readonly<Record<BrevoDataset, string | null>>;
  budget: Readonly<Record<BrevoRateGroup, { spent: number; ceiling: number }>>;
  /**
   * The instant before which `/emailCampaigns` carries no `statistics` block
   * at all, so `emails_sent` is unanswerable from this track — *"This option
   * only returns data for events that occurred in the last 6 months"*.
   *
   * Declared for the same reason {@link BrevoStatus.scanModes} is: a scheduler
   * pricing a campaign backfill should read the boundary here rather than
   * discover it as a column of absent values, and an operator looking at a
   * connection card should see that the hole is the vendor's rather than ours.
   */
  campaignStatsHorizonStart: string;
  requestTimeoutMs: number;
  /** Resolved once per connection when orders are first read; null until
   *  then. Not a guess and not a default — see {@link BrevoConnectorConfig}. */
  displayCurrency: string | null;
}

/** A page of rows plus the watermark the CALLER persists (ADR-041 §4 — this
 *  connector writes nothing). The watermark stays the vendor's own string,
 *  because it is fed straight back as `modifiedSince`. */
export interface BrevoPage {
  rows: Record<string, unknown>[];
  watermark: string | undefined;
}

/**
 * How `/companies` interprets its `page` parameter.
 *
 * Genuinely unresolved in Brevo's documentation: the parameter is NAMED `page`
 * but described with the identical string used for `offset` on `/crm/deals`
 * ("Index of the first document of the page"). Both wrong readings are silent
 * — an offset sent as a page number skips 49 pages of companies, a page number
 * sent as an offset re-reads the same rows forever — so this is MEASURED once
 * per connection rather than assumed.
 */
export type BrevoCompanyPaging = "offset" | "page_from_zero" | "page_from_one";

// ─────────────────────────────────────────────────────────────────────────────
// Vendor record -> canonical column
// ─────────────────────────────────────────────────────────────────────────────

/** What a mapper needs besides the record itself. Passed explicitly rather
 *  than merged into the vendor payload, so a vendor field can never shadow a
 *  context value (or the other way round). */
interface BrevoLookupContext {
  /** The list a membership read was scoped BY. Authoritative for
   *  `audience_id`: a payload that omitted it would otherwise lose its
   *  audience silently. */
  listId?: string;
  /** The account's e-commerce display currency, resolved from the API. */
  displayCurrency?: string;
  /** The operator-stated CRM currency, if any. */
  dealCurrency?: string;
  // Deliberately NO `nowMs`. It was declared here to decide whether an absent
  // statistics block meant "older than the 6-month horizon" or "genuinely
  // nothing", and no caller ever set it — the distinction is made
  // structurally instead, by `hasGlobalStats`, which leaves `emails_sent`
  // ABSENT in both cases because both cases mean "this endpoint did not tell
  // us". A context field nothing sets reads as a fact the mapper has, and it
  // does not have it; the horizon is published on
  // `BrevoStatus.campaignStatsHorizonStart`, where a scheduler can act on it.
}

/** Read a nested object field without `any` and without asserting a shape the
 *  vendor may not have sent. */
function nested(record: Record<string, unknown>, key: string, field: string): unknown {
  const node = record[key];
  if (node === null || typeof node !== "object" || Array.isArray(node)) return undefined;
  return (node as Record<string, unknown>)[field];
}

/** One field of a campaign's `statistics.globalStats`, or undefined when the
 *  block is absent entirely — which is what Brevo returns for a campaign older
 *  than its 6-month statistics horizon. */
function globalStat(record: Record<string, unknown>, field: string): unknown {
  const stats = record.statistics;
  if (stats === null || typeof stats !== "object" || Array.isArray(stats)) return undefined;
  return nested(stats as Record<string, unknown>, "globalStats", field);
}

/** Whether a campaign carries a statistics block at all. Distinguishes "sent
 *  nothing" from "Brevo will not tell us", which is the difference between a
 *  0 and an absent value in `emails_sent`. */
function hasGlobalStats(record: Record<string, unknown>): boolean {
  const stats = record.statistics;
  if (stats === null || typeof stats !== "object" || Array.isArray(stats)) return false;
  const global = (stats as Record<string, unknown>).globalStats;
  return global !== null && typeof global === "object" && !Array.isArray(global);
}

/** The first attribute spelling the account actually uses.
 *
 *  Brevo's contact `attributes` bag is ACCOUNT-DEFINED, and the vendor's own
 *  examples disagree with each other: the `/contacts` example shows
 *  `FIRST_NAME`/`LAST_NAME` while `/contacts/lists/{id}/contacts` shows
 *  `FIRSTNAME`/`LASTNAME`. Candidates are tried in order and nothing is
 *  guessed by position — an account that renamed the attribute gets an absent
 *  name rather than somebody else's field. */
function attribute(record: Record<string, unknown>, candidates: readonly string[]): unknown {
  for (const candidate of candidates) {
    const value = nested(record, "attributes", candidate);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

/** Exactly one element, or nothing.
 *
 *  Used for `campaign.audience_id` and `deal.company_id`, both of which are
 *  single canonical columns over vendor fields that are ARRAYS. Picking the
 *  first element of a multi-target campaign would report a send to four lists
 *  as a send to one, which is a wrong answer rather than a partial one. */
function onlyElement(value: unknown): unknown {
  return Array.isArray(value) && value.length === 1 ? value[0] : undefined;
}

/**
 * A membership's subscription state, DERIVED — Brevo publishes no per-list
 * status string.
 *
 * The most consequential mapping in this file: *"mailing somebody who
 * unsubscribed is the one unrecoverable mistake this dataset can cause"*
 * (`profiles.ts`). So every branch resolves towards do-not-mail:
 *
 *   • the contact's id appears in `listUnsubscribed` — they opted out of THIS
 *     list;
 *   • `emailBlacklisted` is true — a global opt-out, which Brevo also sets on
 *     a hard bounce. Brevo's blacklist therefore merges what Mailchimp calls
 *     `unsubscribed` and `cleaned`, and the merge is resolved towards the
 *     safer of the two rather than towards the more informative one;
 *   • otherwise `subscribed`, which is a claim the endpoint itself supports:
 *     the row came back FROM this list's membership endpoint.
 *
 * `listUnsubscribed` is *"only available if unsubscription per list is
 * activated for the account"*, so its ABSENCE proves nothing about per-list
 * opt-out and is never read as evidence of subscription.
 */
export function brevoSubscriptionStatus(
  record: Record<string, unknown>,
  listId: string | undefined,
): string {
  const unsubscribed = record.listUnsubscribed;
  if (Array.isArray(unsubscribed) && listId !== undefined) {
    if (unsubscribed.some((id) => String(id) === listId)) return "unsubscribed";
  }
  if (record.emailBlacklisted === true) return "unsubscribed";
  return "subscribed";
}

/**
 * One Brevo record -> canonical-column lookup, per dataset.
 *
 * Returns the RAW vendor value; `projectCanonicalRow` owns the coercion and
 * owns the row's key set, so a mapper can neither leak a vendor field onto a
 * row nor drop a canonical one. That matters here more than most: a Brevo
 * contact arrives with the account's entire custom-attribute bag — dates of
 * birth, postcodes, phone numbers, whatever the business collects — and a
 * mapper written as `{...contact, ...}` would persist all of it on the box.
 *
 * Where a canonical column has NO Brevo source, this returns `undefined` and
 * says why in a comment. An absent column is an honest hole; a plausible
 * substitute is a wrong answer nobody can see.
 */
function brevoLookup(
  dataset: BrevoDataset,
  record: Record<string, unknown>,
  ctx: BrevoLookupContext = {},
): VendorLookup {
  return (column: string): unknown => {
    switch (column) {
      // ── identity ───────────────────────────────────────────────────────
      case "contact_id":
      case "campaign_id":
      case "deal_id":
      case "ecommerce_order_id":
        return record.id;
      case "company_id":
        // A column on THREE datasets, meaning three different things, and the
        // only one that is the record's own id is `company`. On `deal` it is
        // the linked company — and only when there is exactly one, because a
        // deal linked to three companies is not a deal belonging to the first.
        // On `contact` it is NOTHING: Brevo's contact endpoints expose no
        // company link at all (the association lives on the CRM company's
        // `linkedContactsIds`), so returning the contact's own id here would
        // put a contact id in a company column on every row.
        if (dataset === "company") return record.id;
        if (dataset === "deal") return onlyElement(record.linkedCompaniesIds);
        return undefined;
      case "audience_id":
        // On `campaign` this is the targeted list — and ONLY when the campaign
        // targets exactly one, because a canonical column that holds one id
        // cannot honestly describe a send to four. On `audience` it is the
        // list's own id; on `audience_member` it is the list the read was
        // scoped by, never re-derived from the payload.
        if (dataset === "campaign") return onlyElement(nested(record, "recipients", "lists"));
        if (dataset === "audience_member") return ctx.listId;
        return record.id;
      case "audience_member_id":
        return ctx.listId !== undefined && record.id !== undefined
          ? brevoMemberId(ctx.listId, String(record.id))
          : undefined;

      // ── people ─────────────────────────────────────────────────────────
      case "email":
        return record.email;
      case "first_name":
        return attribute(record, ["FIRSTNAME", "FIRST_NAME", "firstname", "first_name"]);
      case "last_name":
        return attribute(record, ["LASTNAME", "LAST_NAME", "lastname", "last_name"]);
      case "lifecycle_stage":
        // Brevo has no lifecycle-stage concept on a contact. Absent, not
        // substituted from a list membership or a blacklist flag, both of
        // which answer different questions.
        return undefined;
      case "subscription_status":
        return brevoSubscriptionStatus(record, ctx.listId);
      case "opted_in_at":
        // Consent evidence. Brevo's contact endpoints expose no double-opt-in
        // timestamp, and `createdAt` is when the ROW was made — which is not
        // when the person agreed to anything. Left absent deliberately: this
        // is the one column in the vocabulary whose wrong value is a legal
        // problem rather than a reporting one.
        return undefined;

      // ── timestamps ─────────────────────────────────────────────────────
      case "created_at":
        // The CRM objects keep their timestamps inside the attribute bag; the
        // contact and order endpoints put them on the record root.
        if (dataset === "company" || dataset === "deal") {
          return attribute(record, ["created_at"]);
        }
        return record.createdAt;
      case "updated_at":
        if (dataset === "company") return attribute(record, ["last_updated_at"]);
        if (dataset === "deal") return attribute(record, ["last_updated_date"]);
        return record.modifiedAt;
      case "closed_at":
        // Brevo's Deal object documents no close date at all — not in the
        // schema and not in the vendor's own example attribute bag. An
        // account may have added a custom attribute for it, but reading an
        // undocumented name would be a guess dressed as a fact.
        return undefined;
      case "processed_at":
        // The store's OWN clock: `createdAt` is documented as *"Event
        // occurrence UTC date-time … when order is actually created"*, while
        // `updatedAt` is when Brevo last touched the row. An order imported a
        // day late still happened when the storefront says it did, and using
        // the ingest time would reorder a revenue report.
        return record.createdAt;
      case "sent_at":
        // ONLY `sentDate`, which Brevo populates *"only available if 'status'
        // of the campaign is 'sent'"*. Deliberately NOT falling back to
        // `scheduledAt`: that would report a send that has not happened yet
        // for every scheduled campaign on the account.
        return record.sentDate;

      // ── campaign ───────────────────────────────────────────────────────
      case "subject":
        // `subject` is *"only available if `abTesting` flag of the campaign is
        // `false`"*; an A/B campaign carries `subjectA`/`subjectB` instead. A
        // and B are two different subject lines for one send, so A is reported
        // as the campaign's subject rather than concatenating them into a
        // string that was never sent to anybody.
        return record.subject ?? record.subjectA;
      case "status":
        return record.status;
      case "emails_sent":
        // From `statistics.globalStats`, which is present only when the
        // `statistics` parameter was passed AND the campaign is inside
        // Brevo's 6-month statistics horizon. ABSENT rather than 0 for older
        // campaigns: a zero here is a false statement about a send that
        // really happened, and `emails_sent` is the column this dataset is
        // required to carry.
        return hasGlobalStats(record) ? globalStat(record, "sent") : undefined;
      case "opens_unique":
        // UNIQUE viewers, not `viewed`: Brevo publishes both, and the raw
        // total counts one recipient opening an email four times as four —
        // which makes an open rate exceed 100% and quietly discredits the row.
        return globalStat(record, "uniqueViews");
      case "clicks_unique":
        return globalStat(record, "uniqueClicks");

      // ── audience ───────────────────────────────────────────────────────
      case "name":
        // Three datasets, two storage shapes: the CRM objects keep everything
        // in the attribute bag, the list keeps its name on the record root.
        if (dataset === "deal") return attribute(record, ["deal_name"]);
        if (dataset === "company") return attribute(record, ["name"]);
        return record.name;
      case "member_count":
        // `uniqueSubscribers`, NOT `totalSubscribers`. The vendor's own note
        // on this endpoint: *"We're dropping support for the response
        // attributes totalSubscribers and totalBlacklisted … The default value
        // for the attributes will be 0."* Reading the deprecated field makes
        // every audience report zero members and say so confidently. The
        // fallback exists for older responses that carry only the retired
        // field.
        return record.uniqueSubscribers ?? record.totalSubscribers;
      case "unsubscribe_count":
        // No source. `totalBlacklisted` is (a) being retired to a constant 0
        // alongside `totalSubscribers` and (b) counts global blacklisting,
        // which is not the same fact as unsubscribing from THIS list.
        return undefined;

      // ── CRM ────────────────────────────────────────────────────────────
      case "domain":
        return attribute(record, ["domain"]);
      case "stage":
        // An opaque stage id (a UUID), not a human-readable stage name.
        // Resolving it to a name needs GET /crm/pipeline/details/{pipelineId},
        // an extra endpoint in the 100 RPH bucket, and the id is what the
        // vendor's own `filters[attributes.deal_stage]` takes — so the id is
        // what round-trips.
        return attribute(record, ["deal_stage"]);

      // ── money ──────────────────────────────────────────────────────────
      case "amount": {
        // Deal amounts are stated in MAJOR units already (the vendor's example
        // is `amount: 12`). Withheld entirely when no currency is known — see
        // `currency` below and `BrevoConnectorConfig.dealCurrency`.
        const currency = brevoDealCurrency(record, ctx.dealCurrency);
        return currency === undefined ? undefined : brevoMajorUnits(attribute(record, ["amount"]));
      }
      case "total_amount":
        // `amount` on an order is *"Total amount of the order, including all
        // shipping expenses, tax and the price of items"* — major units, the
        // vendor's example being 308.42. NOT minor units. Dividing by 100 here
        // (the Stripe reflex) understates every figure by 100x.
        return brevoMajorUnits(record.amount);
      case "currency":
        if (dataset === "deal") return brevoDealCurrency(record, ctx.dealCurrency);
        // Orders carry no per-order currency; the account has exactly one
        // e-commerce display currency and this is it, resolved from
        // `/ecommerce/config/displayCurrency` before any order row is built.
        return ctx.displayCurrency;

      // ── commerce ───────────────────────────────────────────────────────
      case "store_id":
        return record.storeId;
      case "customer_id":
        // Brevo's own field on a fetched order. The `identifiers` bag carries
        // email/phone/ext_id instead, none of which is the contact id and two
        // of which are personal data this row does not need.
        return record.contact_id;

      default:
        return undefined;
    }
  };
}

/**
 * The currency a deal's amount is stated in, or nothing.
 *
 * Brevo publishes no currency for a CRM deal. Two sources are accepted, both
 * shape-validated, in order of specificity: an account-defined `currency`
 * attribute on the deal itself, then the operator-stated
 * {@link BrevoConnectorConfig.dealCurrency}. With neither, the amount is
 * withheld rather than emitted with an empty currency column — `profiles.ts`
 * exists partly to make that combination unrepresentable, and the e-commerce
 * display currency is a different subsystem's setting.
 */
export function brevoDealCurrency(
  record: Record<string, unknown>,
  configured: string | undefined,
): string | undefined {
  return brevoCurrencyCode(attribute(record, ["currency", "CURRENCY"])) ??
    brevoCurrencyCode(configured);
}

// ─────────────────────────────────────────────────────────────────────────────
// The connector
// ─────────────────────────────────────────────────────────────────────────────

export class BrevoConnector implements Connector {
  readonly provider = BREVO_PROVIDER;
  readonly servesDatasets = BREVO_DATASETS;

  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly resolveApiKey: BrevoKeyResolver;
  private readonly fetchImpl?: FetchLike;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly budget: BrevoCallBudget;

  private apiKey: string | null = null;
  private fingerprint: string | null = null;
  private probe: BrevoAccountProbe = { state: "unverified" };
  private displayCurrency: string | null = null;
  private companyPaging: BrevoCompanyPaging | null = null;
  private lastFailure: "ip_blocked" | "capability_missing" | null = null;

  constructor(
    private readonly config: BrevoConnectorConfig,
    deps: BrevoConnectorDeps = {},
  ) {
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.resolveApiKey = deps.resolveApiKey ?? blockedBrevoKeyResolver;
    this.fetchImpl = deps.fetchImpl;
    this.timeoutMs = deps.timeoutMs ?? BREVO_REQUEST_TIMEOUT_MS;
    this.budget = deps.budget ?? new BrevoCallBudget(this.now);
    // Validated at CONSTRUCTION: a connection naming a destination we will not
    // dial should fail to build, loudly, rather than look fine until the first
    // read ships a key.
    this.baseUrl = assertSafeBrevoBaseUrl(config.baseUrl ?? BREVO_API_BASE_URL);
  }

  private blocked(op: string, detail?: string): ConnectorBlockedError {
    return new ConnectorBlockedError(detail ? `${op} (${detail})` : op, BREVO_TRACK_REMEDIATION);
  }

  /**
   * Resolve the key.
   *
   * NO SHAPE VALIDATION, deliberately. The `xkeysib-` prefix everybody repeats
   * appears on no page of Brevo's developer documentation, and a rejecting
   * pattern anchored on an undocumented prefix is a false rejection that
   * blocks a paying customer for zero security gain. Emptiness is the only
   * thing refused here, because an empty header is a request that cannot
   * succeed; everything else is settled by `GET /account`.
   */
  private async key(): Promise<string> {
    if (this.apiKey) return this.apiKey;
    const raw = await this.resolveApiKey();
    if (typeof raw !== "string" || raw.trim() === "") {
      throw this.blocked("resolve the Brevo API key", "the stored credential is empty");
    }
    this.apiKey = raw.trim();
    return this.apiKey;
  }

  /**
   * One request. THE choke point — every call this connector makes goes
   * through here, which is why every guard lives here rather than on the
   * callers.
   *
   * Order is load-bearing and the tests assert on it:
   *
   *   1. the path allowlist ({@link assertReadableBrevoResource}),
   *   2. the parameter allowlist ({@link assertDocumentedBrevoQuery},
   *      resolving the endpoint FROM THE PATH so no caller has to declare it),
   *   3. the host guard ({@link assertSafeBrevoBaseUrl}),
   *
   * all before the key is resolved and before the request object exists — so a
   * refused destination, an invented delta parameter or an unrecognised path
   * costs zero fetch calls and never touches the credential.
   *
   * THEN the key, and only THEN the rate budget. The order of those two is
   * deliberate and it is the opposite of what it once was: charging before the
   * credential resolves means a disconnected connection polled on a schedule
   * burns its own 100/hour allowance on requests that never leave the box, so
   * the meter on the connection card reads high while nothing was spent and
   * the first real call after a reconnect can be refused by a budget nothing
   * actually consumed. The budget still runs BEFORE the fetch, which is the
   * property that matters: an exhausted hour costs zero fetch calls.
   *
   * Last, the per-second pace for the group ({@link BrevoCallBudget.paceMs}) —
   * a wait, never a refusal.
   */
  private async request(
    op: string,
    path: string,
    search: Readonly<Record<string, string | number | undefined>> = {},
  ): Promise<unknown> {
    assertReadableBrevoResource(path);
    assertDocumentedBrevoQuery(path, search);
    // Re-checked per request, not only at construction: `baseUrl` is
    // operator-supplied configuration and this is the only thing standing
    // between a tampered row and a key-carrying request to an arbitrary host.
    const base = assertSafeBrevoBaseUrl(this.baseUrl);
    const apiKey = await this.key();
    const group = brevoRateGroup(path);
    this.budget.charge(group);
    const pace = this.budget.paceMs(group);
    if (pace > 0) await this.sleep(pace);

    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(search)) {
      if (v !== undefined) qs.set(k, String(v));
    }
    const url = `${base}${path}${qs.toString() ? `?${qs}` : ""}`;

    const doFetch = this.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    if (!doFetch) throw this.blocked(op, "no fetch implementation available");

    for (let attempt = 0; attempt <= BREVO_MAX_RATE_LIMIT_RETRIES; attempt += 1) {
      let res: Response;
      try {
        res = await doFetch(url, {
          method: BREVO_HTTP_METHOD,
          headers: {
            // The credential, under Brevo's own header name. Built inline and
            // never stored on a field, so there is one place in this file
            // where the cleartext key exists.
            [BREVO_AUTH_HEADER]: apiKey,
            ...BREVO_CONSTANT_HEADERS,
          },
          // Never follow a 3xx: this API has no legitimate redirect, so one is
          // a fault rather than a hop, and the key's safety must not rest on
          // every runtime stripping credentials across origins correctly.
          redirect: "error",
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        // The message is the RUNTIME's, not the vendor's, and the URL it may
        // quote carries no credential — the key travels in a header.
        throw this.blocked(op, `Brevo API unreachable: ${(err as Error).message}`);
      }

      if (res.status === 429) {
        if (attempt >= BREVO_MAX_RATE_LIMIT_RETRIES) {
          throw this.blocked(
            op,
            `Brevo rate limit (429) persisted across ${attempt + 1} attempts — the ` +
              `100 requests/hour catch-all covers campaigns, companies, deals and orders`,
          );
        }
        await this.sleep(this.backoffMs(res, attempt));
        continue;
      }

      if (res.status === 401 || res.status === 403) {
        // Read to CLASSIFY, never to propagate: the body is inspected for an
        // IP-security signal and then discarded except for its code.
        const body = await BrevoConnector.readBody(res);
        const code = brevoErrorCode(body);
        if (BrevoConnector.looksLikeIpBlock(body)) {
          this.lastFailure = "ip_blocked";
          throw new BrevoIpBlockedError(res.status, code);
        }
        if (res.status === 403) {
          this.lastFailure = "capability_missing";
          throw new BrevoCapabilityMissingError(path, res.status, code);
        }
        throw new BrevoReauthorizationRequiredError(res.status, code);
      }

      if (!res.ok) {
        const code = brevoErrorCode(await BrevoConnector.readBody(res));
        throw this.blocked(
          op,
          `Brevo API returned ${res.status}${code ? ` (${code})` : ""}`,
        );
      }

      this.lastFailure = null;
      const body = await BrevoConnector.readBody(res);
      if (body === undefined) {
        throw this.blocked(op, "unparseable Brevo response");
      }
      return body;
    }
    // Unreachable: the loop either returns, throws, or exhausts its retries
    // into the 429 branch above. Present so the function has no implicit
    // undefined return.
    throw this.blocked(op, "Brevo request loop ended without a response");
  }

  /**
   * How long to wait after a 429.
   *
   * Brevo sends `x-sib-ratelimit-reset` (seconds) and documents NO
   * `Retry-After` — a connector reaching for the standard header finds nothing
   * and retries straight into another 429. The vendor's value is honoured but
   * CAPPED: a garbled or hostile header must not park a worker for an hour.
   * With no usable header, exponential backoff from
   * {@link BREVO_BACKOFF_BASE_MS}.
   */
  private backoffMs(res: Response, attempt: number): number {
    const raw = BrevoConnector.header(res, BREVO_RATE_LIMIT_RESET_HEADER);
    const seconds = raw === undefined ? Number.NaN : Number(raw);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, BREVO_MAX_BACKOFF_MS);
    }
    return Math.min(BREVO_BACKOFF_BASE_MS * 2 ** attempt, BREVO_MAX_BACKOFF_MS);
  }

  /** A response header, tolerating a runtime or a stub that supplies none. */
  private static header(res: Response, name: string): string | undefined {
    const headers = (res as { headers?: { get?: (n: string) => string | null } }).headers;
    const value = headers?.get?.(name);
    return typeof value === "string" && value !== "" ? value : undefined;
  }

  /** The parsed body, or undefined when there is none / it is not JSON. */
  private static async readBody(res: Response): Promise<unknown> {
    try {
      return await res.json();
    } catch {
      return undefined;
    }
  }

  /** Whether an error body reads like Brevo's IP security rather than a bad
   *  key. Inspects the vendor's `message`; nothing read here is propagated. */
  private static looksLikeIpBlock(body: unknown): boolean {
    if (body === null || typeof body !== "object") return false;
    const message = (body as { message?: unknown }).message;
    return typeof message === "string" && BREVO_IP_BLOCK_SIGNALS.test(message);
  }

  /**
   * Page an offset-paginated collection.
   *
   * Termination is the SHORT PAGE and nothing else. Every one of these
   * endpoints reports a `count`, and it is treated as advisory: there is no
   * cursor anywhere in this API, so a walk over a collection mutating
   * underneath cannot use a total as proof it saw everything.
   *
   * The page ceiling is a hard `for` bound rather than a conditional break, so
   * an endpoint that never returns a short page stops the connector instead of
   * spinning it.
   */
  private async pageOffset(
    op: string,
    dataset: BrevoDataset,
    path: string,
    collection: string,
    search: Readonly<Record<string, string | number | undefined>>,
    pageSize: number,
  ): Promise<Record<string, unknown>[]> {
    const limit = clampBrevoPageSize(dataset, pageSize);
    const rows: Record<string, unknown>[] = [];
    let offset = 0;

    for (let page = 0; page < BREVO_MAX_PAGES; page += 1) {
      // No parameter check here: `request()` runs it for every call, resolving
      // the endpoint from the path. Re-checking here would leave the guard
      // looking like a pager concern, which is how it came to be missing from
      // the one direct-read path that had no pager.
      const query = { ...search, limit, offset };
      const body = await this.request(op, path, query);
      const list = BrevoConnector.collectionOf(op, body, collection);
      rows.push(...list);
      if (list.length < limit) return rows;
      offset += list.length;
    }
    throw new BrevoPaginationContractError(
      op,
      `${BREVO_MAX_PAGES} full pages returned without a short one — refusing to walk an ` +
        `offset-only endpoint further`,
    );
  }

  /**
   * Pull the documented array out of a response, or refuse to guess.
   *
   * THREE refusals, and the third is the one with incident history behind it.
   * A non-object body and a non-array value were always faults. A 200 whose
   * envelope simply does not carry the documented key is ALSO a fault, and it
   * used to return `[]`.
   *
   * That degradation is the `GET /api/files` 200-`[]`-on-an-outage defect: an
   * empty list is a claim about the customer's account, and a body this file
   * did not understand is not evidence for it. Concretely — a renamed array,
   * an error object served with status 200, a proxy-rewritten body — the
   * offset pager sees `0 < limit`, terminates on the first page, and reports
   * zero rows as a clean result. For `/orders` that renders as "you sold
   * nothing", confidently, with nothing red anywhere.
   *
   * A genuinely empty collection is `{"contacts": []}` — the key PRESENT, the
   * array empty — and Brevo returns exactly that for an account with no
   * companies, deals or orders. So the distinction costs nothing real and buys
   * the difference between an empty account and an unreadable answer. If a
   * live account is ever observed answering a bare `{}` for an empty
   * collection, that is a measured vendor fact to encode here explicitly, per
   * endpoint — not a reason to go back to guessing at every endpoint at once.
   */
  private static collectionOf(
    op: string,
    body: unknown,
    collection: string,
  ): Record<string, unknown>[] {
    if (body === null || typeof body !== "object") {
      throw new ConnectorBlockedError(
        `${op} returned a non-object body`,
        "Brevo's response did not match the documented list contract. Refusing to " +
          "interpret it rather than guessing at a shape — an unreadable response is not " +
          "an empty dataset.",
      );
    }
    const data = (body as Record<string, unknown>)[collection];
    if (data === undefined || data === null) {
      throw new ConnectorBlockedError(
        `${op} returned a 200 with no \`${collection}\` array`,
        `Brevo's documented list envelope for this endpoint carries \`${collection}\`, and ` +
          `this response does not. An empty collection is \`{"${collection}": []}\` — the ` +
          `key present and the array empty — so a body missing the key entirely is a ` +
          `renamed field, an error served with a 200, or a rewritten response, none of ` +
          `which is evidence that the account has no rows. Returning [] here would stop ` +
          `the pager on its first page and report zero rows as a clean result.`,
      );
    }
    if (!Array.isArray(data)) {
      throw new ConnectorBlockedError(
        `${op} returned a non-array \`${collection}\` (${typeof data})`,
        "Brevo's response did not match the documented list contract. Refusing to " +
          "interpret it rather than guessing at a shape.",
      );
    }
    return data.filter(
      (row): row is Record<string, unknown> =>
        row !== null && typeof row === "object" && !Array.isArray(row),
    );
  }

  /** The highest `modifiedAt` in a page, as the vendor spelled it. RETURNED to
   *  the caller and never persisted here (ADR-041 §4) — it is fed straight
   *  back as `modifiedSince`, so it must stay the vendor's own string. */
  private static watermarkOf(rows: readonly Record<string, unknown>[], field: string): string | undefined {
    let watermark: string | undefined;
    for (const row of rows) {
      const value = row[field];
      if (typeof value === "string" && (watermark === undefined || value > watermark)) {
        watermark = value;
      }
    }
    return watermark;
  }

  // ── Connector interface ───────────────────────────────────────────────────

  /**
   * Open the connection by PROVING the credential works.
   *
   * `GET /account` takes no parameters, is the cheapest authenticated read
   * Brevo offers, and is the whole of credential validation on this track —
   * there is no key pattern to match, by design. A 401 here is one of the four
   * causes in {@link BREVO_UNAUTHORIZED_CAUSES}, not evidence that Brevo is
   * down.
   */
  async connect(): Promise<void> {
    await this.probeAccount();
    this.fingerprint = computeSchemaFingerprint(this.tables());
  }

  /** Empirically establish that the key authenticates. Records the result as
   *  an explicit probe value — never inferred from the absence of an error. */
  async probeAccount(): Promise<BrevoAccountProbe> {
    try {
      const body = await this.request("probeAccount", BREVO_ACCOUNT_PATH);
      const name =
        body !== null && typeof body === "object"
          ? (body as { companyName?: unknown }).companyName
          : undefined;
      this.probe = {
        state: "ok",
        companyName: typeof name === "string" ? name : null,
        probedAt: this.now(),
      };
    } catch (err) {
      if (err instanceof BrevoCapabilityMissingError) {
        this.probe = { state: "forbidden", resource: err.resource, probedAt: this.now() };
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
    if (state === "ip_blocked") {
      throw new BrevoIpBlockedError(401, undefined);
    }
    if (state === "capability_missing") {
      const probe = this.probe;
      throw new BrevoCapabilityMissingError(
        probe.state === "forbidden" ? probe.resource : "unknown",
        403,
        undefined,
      );
    }
    if (state === "disconnected") {
      throw this.blocked("health", "no Brevo account is connected");
    }
    return { ok: true };
  }

  /** The canonical shape this track serves. Synthesized rather than
   *  introspected: Brevo's schema is Brevo's, published and stable, so there
   *  is nothing to discover — but the fingerprint still has to exist so
   *  drift-freeze semantics stay coherent across every track. */
  private tables(): IntrospectedTable[] {
    return BREVO_DATASETS.map((dataset) => ({
      name: dataset,
      owner: BREVO_PROVIDER,
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
   * registry's queries carry mandatory filters written for the SQL track,
   * while the sync runner passes `{}` or `{ since }` and wants the dataset
   * enumerated. A param that is present filters; one that is absent
   * enumerates.
   *
   * `since` reaches the vendor as `modifiedSince` for the five datasets that
   * document one, and is applied to the MAPPED rows for the two that do not —
   * never smuggled into a query string Brevo would silently ignore.
   */
  async runRead(name: string, params: Record<string, unknown>): Promise<unknown[]> {
    const query = getReadQuery(name);
    assertDatasetsServed(this.provider, this.servesDatasets, name, query.dependsOnTables);
    const since = canonicalInstant(params.since);

    switch (name) {
      case "find_contact": {
        // Client-side prefix match, and that is a vendor limit rather than a
        // shortcut: Brevo's `filter` parameter documents the `equals` operator
        // only, so it answers "whose last name IS smith", not "starts with".
        // Pushing an equals filter down would silently answer a different
        // question than the one asked.
        const page = await this.listContacts({ modifiedSince: since });
        const rows = page.rows.map((r) => projectCanonicalRow("contact", brevoLookup("contact", r)));
        const prefix = BrevoConnector.text(params.query)?.toLowerCase();
        const matched =
          prefix === undefined
            ? rows
            : rows.filter((r) => String(r.last_name ?? "").toLowerCase().startsWith(prefix));
        // `ORDER BY last_name, first_name`.
        const byFirst = sortByKey(matched, "first_name");
        return sortByKey(byFirst, "last_name");
      }

      case "get_company": {
        const wanted = BrevoConnector.text(params.companyId);
        const records =
          wanted === undefined
            ? await this.listCompanies({ modifiedSince: since })
            : [await this.getCompany(wanted)];
        const rows = records.map((r) => projectCanonicalRow("company", brevoLookup("company", r)));
        return sortByKey(rows, "company_id");
      }

      case "get_deals_by_stage": {
        const stage = BrevoConnector.text(params.stage);
        const records = await this.listDeals({ modifiedSince: since, stage });
        const rows = records.map((r) =>
          projectCanonicalRow("deal", brevoLookup("deal", r, { dealCurrency: this.config.dealCurrency })),
        );
        // The stage predicate is applied AGAIN, on the projected rows. The
        // vendor filter was pushed down to keep the read cheap, but an unknown
        // query parameter is assumed to be ignored rather than rejected — so
        // if `filters[attributes.deal_stage]` ever stops being the parameter
        // name, this pass is what keeps the answer correct instead of
        // returning every deal labelled as being in the requested stage.
        const matched =
          stage === undefined ? rows : rows.filter((r) => String(r.stage ?? "") === stage);
        // `ORDER BY amount DESC, deal_id` — largest expected value first.
        const byId = sortByKey(matched, "deal_id");
        return [...byId].sort((a, b) => Number(b.amount ?? 0) - Number(a.amount ?? 0));
      }

      case "get_campaign_performance": {
        const from = canonicalInstant(params.from);
        const to = canonicalInstant(params.to);
        const records = await this.listCampaigns({ from, to });
        const rows = records.map((r) => projectCanonicalRow("campaign", brevoLookup("campaign", r)));
        const windowed = BrevoConnector.inWindow(rows, "sent_at", from, to);
        // `ORDER BY sent_at DESC, campaign_id`.
        const byId = sortByKey(windowed, "campaign_id");
        return [...byId].sort((a, b) =>
          String(b.sent_at ?? "").localeCompare(String(a.sent_at ?? "")),
        );
      }

      case "get_audiences": {
        const records = await this.listAudiences();
        const rows = records.map((r) => projectCanonicalRow("audience", brevoLookup("audience", r)));
        // `ORDER BY member_count DESC, audience_id`.
        const byId = sortByKey(rows, "audience_id");
        return [...byId].sort((a, b) => Number(b.member_count ?? 0) - Number(a.member_count ?? 0));
      }

      case "get_audience_members": {
        const wanted = BrevoConnector.text(params.audienceId);
        const listIds = wanted === undefined ? await this.audienceIds() : [wanted];
        const rows: CanonicalRow[] = [];
        for (const listId of listIds) {
          const page = await this.listAudienceMembers(listId, { modifiedSince: since });
          for (const member of page.rows) {
            rows.push(
              projectCanonicalRow("audience_member", brevoLookup("audience_member", member, { listId })),
            );
          }
        }
        // The status filter is client-side because Brevo has no per-list
        // status parameter at all — the state is DERIVED from
        // `listUnsubscribed` and `emailBlacklisted` (see
        // `brevoSubscriptionStatus`), so it cannot be pushed down.
        const status = BrevoConnector.text(params.status)?.toLowerCase();
        const matched =
          status === undefined
            ? rows
            : rows.filter((r) => String(r.subscription_status ?? "").toLowerCase() === status);
        // `ORDER BY updated_at DESC, audience_member_id`.
        const byId = sortByKey(matched, "audience_member_id");
        return [...byId].sort((a, b) =>
          String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")),
        );
      }

      case "get_ecommerce_orders": {
        // Resolved BEFORE any row is built: an order carries no currency of
        // its own, and a money column with no currency is not a number. A 403
        // here means e-commerce is not activated on the account, which is the
        // same state in which there are no orders — reported as a capability,
        // never as an empty list.
        const currency = await this.resolveDisplayCurrency();
        const page = await this.listOrders({ modifiedSince: since });
        const rows = page.rows.map((r) =>
          projectCanonicalRow(
            "ecommerce_order",
            brevoLookup("ecommerce_order", r, { displayCurrency: currency }),
          ),
        );
        const windowed = BrevoConnector.inWindow(rows, "processed_at", params.from, params.to);
        // `ORDER BY processed_at DESC, ecommerce_order_id`.
        const byId = sortByKey(windowed, "ecommerce_order_id");
        return [...byId].sort((a, b) =>
          String(b.processed_at ?? "").localeCompare(String(a.processed_at ?? "")),
        );
      }

      default:
        // Unreachable while every served read is handled above; a new registry
        // entry on a served dataset lands here rather than silently returning
        // nothing, which would read as "this account has no contacts".
        throw this.blocked(`runRead:${name}`, "read is not served by the Brevo track");
    }
  }

  async applyWrite(name: string, _params: Record<string, unknown>): Promise<unknown> {
    // Same validation order as every other track, so a caller bug produces the
    // same typed error here as anywhere else...
    const cmd = getWriteCommand(name);
    assertTargetAllowed(cmd.targetTable);
    // ...and then this track refuses. The customer's key can send email from
    // their own domain and delete their contacts; none of that is a later
    // ticket. The send and order-creation paths are unreachable by shape
    // (BREVO_FORBIDDEN_PATH_SEGMENTS) and every request is a GET, so
    // "read-only" is a property of the code rather than an intention someone
    // held while writing it.
    throw this.blocked(
      `applyWrite:${name}`,
      "the Brevo track is read-only — no send, contact-mutation, deal-mutation or " +
        "order-creation surface exists in this connector at any tier",
    );
  }

  // ── Marketing and CRM surface ─────────────────────────────────────────────

  /**
   * The account's contact database, incrementally.
   *
   * `modifiedSince` and `createdSince` are BOTH documented here — the second
   * is what makes a first backfill a forward walk over creations rather than a
   * full scan of the address book.
   */
  async listContacts(
    filters: { modifiedSince?: string; createdSince?: string; pageSize?: number } = {},
  ): Promise<BrevoPage> {
    const rows = await this.pageOffset(
      "listContacts",
      "contact",
      BREVO_ENDPOINTS.contact,
      "contacts",
      { modifiedSince: filters.modifiedSince, createdSince: filters.createdSince },
      filters.pageSize ?? BREVO_MAX_PAGE_SIZE.contact,
    );
    return { rows, watermark: BrevoConnector.watermarkOf(rows, "modifiedAt") };
  }

  /**
   * Every mailing list. FULL SCAN, always.
   *
   * `/contacts/lists` documents no date filter of any kind, so an incremental
   * read is impossible rather than unimplemented — and the signature exposes
   * no `since` option precisely so nobody offers a parameter the API would
   * ignore. The collection is small, which is why the cost is acceptable; the
   * cap of 50 per page is a fifth of `/contacts`'s and a twentieth of what a
   * shared pager would send.
   */
  async listAudiences(options: { pageSize?: number } = {}): Promise<Record<string, unknown>[]> {
    return this.pageOffset(
      "listAudiences",
      "audience",
      BREVO_ENDPOINTS.audience,
      "lists",
      {},
      options.pageSize ?? BREVO_MAX_PAGE_SIZE.audience,
    );
  }

  /** Every audience id, for the enumerable membership read: there is no
   *  account-wide membership endpoint, so memberships are reached one list at
   *  a time. */
  private async audienceIds(): Promise<string[]> {
    const lists = await this.listAudiences();
    return lists
      .map((l) => BrevoConnector.text(l.id))
      .filter((id): id is string => id !== undefined);
  }

  /** One list's membership, incrementally. Note the page cap is 500 — HALF
   *  `/contacts`'s — which is the easiest place in this connector to hardcode
   *  the wrong size. */
  async listAudienceMembers(
    listId: string,
    filters: { modifiedSince?: string; pageSize?: number } = {},
  ): Promise<BrevoPage> {
    const rows = await this.pageOffset(
      "listAudienceMembers",
      "audience_member",
      BREVO_ENDPOINTS.audience_member.replace("{listId}", encodeURIComponent(listId)),
      "contacts",
      { modifiedSince: filters.modifiedSince },
      filters.pageSize ?? BREVO_MAX_PAGE_SIZE.audience_member,
    );
    return { rows, watermark: BrevoConnector.watermarkOf(rows, "modifiedAt") };
  }

  /**
   * Sent campaigns, over a send-date window.
   *
   * NOT a delta, and the signature says so: the parameters are `from`/`to`,
   * not `since`. `startDate` and `endDate` are mutually mandatory and filter
   * WHEN A CAMPAIGN WAS SENT, so a campaign already inside a consumed window
   * never re-enters it while its statistics keep accruing for days. A poller
   * therefore needs a trailing re-read of recent campaigns, not a watermark —
   * and for campaigns older than six months, not even that: `statistics` stops
   * carrying data and the vendor points at a different endpoint entirely.
   *
   * With only one bound supplied, NEITHER is sent — they are mutually
   * mandatory — and the window is applied to the mapped rows instead.
   * Multi-year requests are chunked ({@link brevoCampaignWindows}).
   *
   * `excludeHtmlContent` is always on: the campaign body is the entire
   * marketing email, which nothing upstream asked for and which would be
   * persisted on the box by a connector that took the default.
   */
  async listCampaigns(
    filters: { from?: string; to?: string; pageSize?: number } = {},
  ): Promise<Record<string, unknown>[]> {
    const fromMs = filters.from === undefined ? Number.NaN : Date.parse(filters.from);
    const toMs = filters.to === undefined ? Number.NaN : Date.parse(filters.to);
    const bounded = Number.isFinite(fromMs) && Number.isFinite(toMs);
    const windows = bounded ? brevoCampaignWindows(fromMs, toMs, this.now()) : [];

    const common = {
      statistics: BREVO_CAMPAIGN_STATISTICS,
      excludeHtmlContent: "true",
    };
    // A bounded request that produced no windows asked only about the future.
    // That is a legitimate question with no answer, and answering it with a
    // full scan of the account's whole campaign history would be a hundred
    // requests against a 100/hour budget to return nothing.
    if (bounded && windows.length === 0) return [];
    if (windows.length === 0) {
      return this.pageOffset(
        "listCampaigns",
        "campaign",
        BREVO_ENDPOINTS.campaign,
        "campaigns",
        common,
        filters.pageSize ?? BREVO_MAX_PAGE_SIZE.campaign,
      );
    }

    const rows: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    for (const window of windows) {
      const page = await this.pageOffset(
        "listCampaigns",
        "campaign",
        BREVO_ENDPOINTS.campaign,
        "campaigns",
        { ...common, startDate: window.startDate, endDate: window.endDate },
        filters.pageSize ?? BREVO_MAX_PAGE_SIZE.campaign,
      );
      // Windows abut rather than overlap, but a campaign sent exactly on a
      // boundary would otherwise appear twice.
      for (const row of page) {
        const id = BrevoConnector.text(row.id);
        if (id !== undefined && seen.has(id)) continue;
        if (id !== undefined) seen.add(id);
        rows.push(row);
      }
    }
    return rows;
  }

  /**
   * Sales Platform deals, incrementally.
   *
   * Pages with `offset` — while {@link listCompanies}, the other CRM endpoint,
   * pages with `page`. That disagreement is Brevo's own and it is exactly the
   * kind of thing a shared pager gets silently wrong.
   *
   * Returns nothing on an account that never used the Sales Platform. That is
   * a real empty, not a failure — and the distinction only holds because every
   * degraded path in this file throws instead of returning `[]`.
   */
  async listDeals(
    filters: { modifiedSince?: string; stage?: string; pageSize?: number } = {},
  ): Promise<Record<string, unknown>[]> {
    return this.pageOffset(
      "listDeals",
      "deal",
      BREVO_ENDPOINTS.deal,
      "items",
      {
        modifiedSince: filters.modifiedSince,
        "filters[attributes.deal_stage]": filters.stage,
      },
      filters.pageSize ?? BREVO_MAX_PAGE_SIZE.deal,
    );
  }

  /** One company by id. `GET /companies/{id}` returns the object UNWRAPPED —
   *  no `items`, no `count` — unlike every collection on this track. */
  async getCompany(companyId: string): Promise<Record<string, unknown>> {
    const body = await this.request(
      "getCompany",
      `${BREVO_ENDPOINTS.company}/${encodeURIComponent(companyId)}`,
    );
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw this.blocked("getCompany", "Brevo returned a non-object company");
    }
    return body as Record<string, unknown>;
  }

  /**
   * Sales Platform companies, incrementally — over a page parameter whose
   * meaning is MEASURED rather than assumed.
   *
   * `/companies` takes `page`, described with the identical wording used for
   * `offset` elsewhere ("Index of the first document of the page"). Three
   * readings are possible and two of them are silently wrong, so the first
   * full page triggers one extra call that distinguishes them:
   *
   *   • `page=1` returns the SAME first row  -> page numbers, 1-based;
   *   • `page=1` returns the SECOND row      -> an offset;
   *   • `page=1` returns something disjoint  -> page numbers, 0-based;
   *   • `page=1` returns nothing at all      -> page numbers, and the account
   *     has exactly one page (an offset of 1 could not be empty when page one
   *     was full).
   *
   * On top of that, every page is checked against the ids already seen: a
   * parameter that does not advance produces duplicates rather than an error,
   * and a duplicate set is a wrong answer nobody looks at twice.
   */
  async listCompanies(
    filters: { modifiedSince?: string; pageSize?: number } = {},
  ): Promise<Record<string, unknown>[]> {
    const limit = clampBrevoPageSize("company", filters.pageSize ?? BREVO_MAX_PAGE_SIZE.company);
    const base = { modifiedSince: filters.modifiedSince, limit };
    const fetchPage = async (page?: number): Promise<Record<string, unknown>[]> => {
      // Parameter-checked inside `request()`, like every other call.
      const query = { ...base, page };
      return BrevoConnector.collectionOf(
        "listCompanies",
        await this.request("listCompanies", BREVO_ENDPOINTS.company, query),
        "items",
      );
    };

    const first = await fetchPage();
    if (first.length < limit) return first;

    const seen = new Set<string>(first.map((r) => String(r.id)));
    const rows = [...first];
    const probe = await fetchPage(1);

    if (probe.length === 0) {
      // An offset of 1 cannot be empty when page one was full, so `page` is a
      // page number and there is exactly one page.
      this.companyPaging = "page_from_zero";
      return rows;
    }
    const probeFirst = String(probe[0]?.id);
    if (probeFirst === String(first[0]?.id)) {
      this.companyPaging = "page_from_one";
    } else if (first.length > 1 && probeFirst === String(first[1]?.id)) {
      this.companyPaging = "offset";
    } else {
      this.companyPaging = "page_from_zero";
    }

    // The probe's ROWS are only data under 0-based page numbering, where
    // `page=1` is genuinely the second page. Under an offset it is the same
    // page shifted by one document — every row of which the `offset=limit`
    // call below returns anyway — and under 1-based numbering it is the first
    // page again. Discarding it in those two cases is what keeps the walk's
    // arithmetic honest: the alternative is a page-length off-by-one that
    // SKIPS a page of companies without erroring.
    if (this.companyPaging === "page_from_zero") {
      BrevoConnector.absorb(rows, seen, probe, "listCompanies");
      if (probe.length < limit) return rows;
    }

    // Under offset semantics the parameter counts DOCUMENTS and the next
    // unread one is at `limit`; under either page numbering it counts PAGES
    // and the next unread page is 2 (0-based has consumed pages 0 and 1;
    // 1-based has consumed page 1).
    const startStep = this.companyPaging === "offset" ? 1 : 2;
    for (let step = startStep; step < BREVO_MAX_PAGES; step += 1) {
      const value = this.companyPaging === "offset" ? step * limit : step;
      const page = await fetchPage(value);
      if (page.length === 0) return rows;
      BrevoConnector.absorb(rows, seen, page, "listCompanies");
      if (page.length < limit) return rows;
    }
    throw new BrevoPaginationContractError(
      "listCompanies",
      `${BREVO_MAX_PAGES} pages returned without a short one`,
    );
  }

  /** Append a page, refusing one that repeats everything already seen — the
   *  signature of a page parameter that did not advance. */
  private static absorb(
    rows: Record<string, unknown>[],
    seen: Set<string>,
    page: readonly Record<string, unknown>[],
    op: string,
  ): void {
    const fresh = page.filter((r) => !seen.has(String(r.id)));
    if (page.length > 0 && fresh.length === 0) {
      throw new BrevoPaginationContractError(
        op,
        "a page repeated every id already read — the page parameter is not advancing, " +
          "which is what an offset sent to a page-numbered endpoint (or the reverse) " +
          "looks like",
      );
    }
    for (const row of fresh) {
      seen.add(String(row.id));
      rows.push(row);
    }
  }

  /** E-commerce orders, incrementally. `modifiedSince` AND `createdSince` are
   *  both documented here — materially better than the Mailchimp equivalent,
   *  which has no date filter at all. */
  async listOrders(
    filters: { modifiedSince?: string; createdSince?: string; pageSize?: number } = {},
  ): Promise<BrevoPage> {
    const rows = await this.pageOffset(
      "listOrders",
      "ecommerce_order",
      BREVO_ENDPOINTS.ecommerce_order,
      "orders",
      { modifiedSince: filters.modifiedSince, createdSince: filters.createdSince },
      filters.pageSize ?? BREVO_MAX_PAGE_SIZE.ecommerce_order,
    );
    return { rows, watermark: BrevoConnector.watermarkOf(rows, "updatedAt") };
  }

  /**
   * The account's e-commerce display currency, resolved once per connection.
   *
   * A Brevo order has no currency field. This endpoint is the only currency
   * fact the API exposes for orders, it returns a bare ISO-4217 code, and it
   * answers **403 when e-commerce is not activated** — which surfaces as a
   * capability, never as an empty order list.
   *
   * Cached for the connection's life: it is an account setting, and paying a
   * call from the 100/hour budget per order page would be a poor trade.
   */
  async resolveDisplayCurrency(): Promise<string> {
    if (this.displayCurrency !== null) return this.displayCurrency;
    const body = await this.request("resolveDisplayCurrency", BREVO_DISPLAY_CURRENCY_PATH);
    const code =
      body !== null && typeof body === "object"
        ? brevoCurrencyCode((body as { code?: unknown }).code)
        : undefined;
    if (code === undefined) {
      throw this.blocked(
        "resolveDisplayCurrency",
        "Brevo returned no ISO-4217 display currency. Refusing to emit order amounts " +
          "with no currency: an amount whose currency must be guessed is not a number",
      );
    }
    this.displayCurrency = code;
    return code;
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

  // ── State ─────────────────────────────────────────────────────────────────

  /**
   * The connection's state, explicitly.
   *
   * Order matters. An IP block outranks everything else because the remedy is
   * the opposite of what a 401 usually implies — the key is fine, and the
   * customer must not be sent to regenerate it.
   */
  private async state(): Promise<BrevoConnectionState> {
    try {
      await this.key();
    } catch {
      // No key resolvable = the owner has not connected an account. Not an
      // error: it is the shipped-off state ADR-041 §2 requires.
      return "disconnected";
    }
    if (this.lastFailure === "ip_blocked") return "ip_blocked";
    if (this.lastFailure === "capability_missing" || this.probe.state === "forbidden") {
      return "capability_missing";
    }
    return "connected";
  }

  async status(): Promise<BrevoStatus> {
    const state = await this.state();
    return {
      state,
      // One source of truth: `ok` is derived from `state` rather than computed
      // independently, so the two cannot disagree inside one returned object.
      ok: state === "connected",
      // Report THAT a credential exists, never its value and never a prefix of
      // it. Nothing in this object can carry key material.
      hasApiKey: this.apiKey !== null,
      accountProbe: this.probe,
      scanModes: BREVO_SCAN_MODE,
      deltaParams: BREVO_DELTA_PARAM,
      budget: this.budget.snapshot(),
      campaignStatsHorizonStart: new Date(
        this.now() - BREVO_CAMPAIGN_STATS_HORIZON_MS,
      ).toISOString(),
      requestTimeoutMs: this.timeoutMs,
      displayCurrency: this.displayCurrency,
    };
  }

  /** How `/companies` was MEASURED to interpret its `page` parameter, or null
   *  before the first multi-page company read. Rendered on the connection card
   *  so an operator can see what the box concluded rather than assuming. */
  get companyPagingSemantics(): BrevoCompanyPaging | null {
    return this.companyPaging;
  }

  /** The connection this connector serves. Never a provider name — on a box
   *  with two Brevo connections, provider scoping is how one customer's data
   *  reaches the other. */
  get connectionId(): string {
    return this.config.connectionId;
  }

  /** The last computed schema fingerprint, or null before `introspect()`. */
  get schemaFingerprint(): string | null {
    return this.fingerprint;
  }
}
