/**
 * WARP-2317 — `HubSpotConnector`: the CRM track.
 *
 * Reads a business's HubSpot portal — contacts, companies, deals, tickets and
 * the engagement objects — over HubSpot's REST API, on a private app access
 * token the customer's own super admin creates. Same `Connector` interface,
 * same blocked-error contract as every other track, so nothing upstream of it
 * changes.
 *
 * ## What makes this track different
 *
 * **It is a CLOUD CONNECTOR under ADR-041**, built to the same five conditions
 * the QuickBooks Online track is (see `../quickbooks/online-connector.ts` for
 * the worked statement of them) and the same standalone, read-through shape as
 * the Stripe track:
 *
 *   1. **Only ever dials out.** The box accepts no inbound connections from
 *      the internet, so HubSpot webhooks are structurally unavailable to us and
 *      the Search delta poller is the ONLY ingestion path for changes. That is
 *      a constraint, not a preference, and it is why the poller carries as much
 *      care as it does.
 *   2. **Ships off; owner consent is the enabling event.** With no token
 *      resolved the connector blocks honestly rather than half-authenticating.
 *   3. **Every destination registered.** `api.hubapi.com` is in
 *      `docs/security/allowed-egress.yaml` as `user-content-on-request`, and
 *      {@link HUBSPOT_ALLOWED_API_HOSTS} accepts exactly that host.
 *   4. **Persistence: none.** ADR-041 §4 warns that the encryption
 *      `ErpEntityCache` promises is NOT implemented (WARP-2028). This track is
 *      therefore read-through and writes nothing — not `ErpEntityCache`, not
 *      `ErpSyncCursor`, not `secretRef`. The delta watermark is RETURNED to the
 *      caller ({@link HubSpotDeltaPollResult.watermark}) rather than persisted
 *      here, precisely so this connector does not become the first writer of a
 *      model whose promises are not yet kept.
 *   5. **The token is a portal-wide credential.** Never logged, never in a
 *      tracked file, never in a URL, and never echoed back in an error — see
 *      {@link assertHubspotPrivateAppToken}.
 *
 * ## Auth is a private app token, and OAuth is disqualified
 *
 * The credential is a private app access token (`pat-…`) that the customer's
 * **super admin** creates inside their own portal by ticking scopes. It never
 * expires, carries a 7-day grace on rotation, and is available on **every tier
 * including Free**.
 *
 * OAuth is out on a hard technical ground rather than a preference: **HubSpot
 * does not support PKCE.** An OAuth integration would therefore mean shipping a
 * `client_secret` onto appliance hardware we do not control and cannot revoke
 * box-by-box — the same reasoning that settled Stripe in WARP-2215. There is
 * also no dynamic client registration of any kind, so onboarding is a
 * documented click-path **by design** and the customer setup guide is the
 * mechanism, not a nicety attached to one.
 *
 * ## The binding constraint is the Search API, and it cannot be bought around
 *
 * The published limits are comfortable and irrelevant: 100 requests per 10
 * seconds per private app, 250,000 per day pooled per account. The ceiling that
 * shapes this connector is the **Search API at 5 requests per second per
 * ACCOUNT**. Three properties make it the thing to design around:
 *
 *   1. **Per account, not per app.** A second private app buys nothing, and
 *      neither does a second `IntegrationConnection` row — which is why
 *      {@link searchGovernorForPortal} is keyed on the portal id.
 *   2. **It cannot be raised.** No tier, no support request, no contract.
 *   3. **Search responses carry no rate-limit headers at all.** There is no
 *      remaining-quota hint to steer by, so backoff is derived from the 429
 *      itself ({@link HubSpotConnector.backoffMs}).
 *
 * ## The 10,000-record cap is answered by RE-ANCHORING, not deeper paging
 *
 * Delta reads are `POST /crm/objects/<version>/{object}/search` filtered on
 * `hs_lastmodifieddate`, 200 records per page, with a **hard cap of 10,000
 * records per query**. Crossing it does not truncate politely — HubSpot answers
 * **HTTP 400**, which reads at a glance like a malformed filter and will cost
 * an hour to diagnose the first time. Deep pagination past 10,000 is not slow;
 * it is unavailable.
 *
 * So the poller advances the filter FLOOR to the newest record it has seen and
 * re-queries from offset zero ({@link HubSpotConnector.pollObjectChanges}).
 * Bulk history goes through the Exports API instead
 * ({@link HubSpotConnector.runBackfill}), which is on Free and has no cap.
 *
 * Search is also **eventually consistent** with no documented bound, so the
 * watermark is held {@link HUBSPOT_SEARCH_CONSISTENCY_OVERLAP_MS} BEHIND the
 * newest record seen, every poll re-reads that overlap, and records are keyed
 * on the HubSpot object id so replaying it is idempotent. The overlap is a
 * chosen margin, not a vendor guarantee.
 *
 * ## Four failure states that must never be confused
 *
 * QuickBooks models three; this deployment shape needs a fourth, and it is the
 * one most likely to be seen in the field. None of them may ever render as an
 * empty result — `[]` from a CRM read reads as "nobody contacted you", which is
 * a confident false statement about the business.
 *
 *   QUOTA_EXHAUSTED               the account's shared 250,000/day pool is
 *                                 spent, quite possibly by another integration
 *                                 the customer runs. Nothing is broken and
 *                                 retrying today cannot help.
 *   REAUTHORIZE_REQUIRED          the token was deleted or is invalid. A person
 *                                 must create a new private app token.
 *   USER_DOES_NOT_HAVE_PERMISSIONS  **the one that will bite.** If the super
 *                                 admin who created the private app is removed
 *                                 from the portal, or merely loses super-admin
 *                                 permission, EVERY call fails. Nothing about
 *                                 the token changed and nothing about our
 *                                 config changed. In an SMB this is the office
 *                                 manager leaving six months after they set the
 *                                 box up, and it must not surface as "the CRM
 *                                 is quiet today".
 *   CONNECTOR_BLOCKED             not configured, or HubSpot is unreachable.
 *
 * A tier boundary is NOT a failure and gets its own class
 * ({@link HubSpotCapabilityUnavailableError}): marketing email reads need
 * Marketing Hub Professional and custom object schemas are Enterprise only, so
 * on a Free portal both 403. Saying "you have no marketing emails" would be the
 * same confident false statement in a different costume.
 *
 * ## Version pinning, and where the date actually goes
 *
 * HubSpot went date-based in March 2026, ships breaking changes twice a year,
 * and commits to an 18-month minimum support window — a standing upgrade
 * obligation that stays legible only if the version is one named constant
 * ({@link HUBSPOT_API_VERSION}) rather than a value scattered through route
 * strings.
 *
 * Date-based versioning (DBV) puts that date **after the product group**, in
 * the slot the semantic version used to occupy: `GET /crm/objects/<version>/
 * contacts`, never `/<version>/crm/objects/contacts`. Getting that backwards
 * 404s every call, and it is not a token swap — the object name moves ahead of
 * the version, and one family changes product group outright. The per-family
 * table on {@link HUBSPOT_API_ROUTES} is the record of what was verified
 * against the published spec, and {@link hubspotPath} is the only place a path
 * is built from it (WARP-2470).
 *
 * There is no default version and no version header: a path without a date is a
 * different, LEGACY endpoint rather than the same one at a defaulted version.
 * Legacy `v3` routes remain valid and unsunset, so this is a correctness fix
 * rather than a deprecation race — but the two are different endpoints and the
 * connector speaks only the documented, dated one.
 *
 * Associations are the one family kept off its own API: HubSpot v4,
 * Associations v4 included, ends support on 2027-03-30 — inside this product's
 * expected support horizon. Association reads therefore go through the object
 * route's `associations` block, and `__tests__/hubspot.test.ts` fails the build
 * if a v4 route literal ever appears in this directory, because those endpoints
 * are the ones a developer reaches for first when wiring contact-to-deal links.
 *
 * ## Reads are wide; writes are two objects and a confirmation
 *
 * Notes and tasks are the only writable objects — the two where an agent adding
 * a record is useful and reversible. Deal-stage changes, contact merges and
 * record deletions are absent by construction, and
 * {@link HUBSPOT_WRITABLE_OBJECTS} is what makes that a property of the code
 * rather than an intention someone held while writing it.
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
import type { DatasetName } from "../export-drop/profiles.js";

/** Provider key for this track. */
export const HUBSPOT_PROVIDER = "hubspot";

/**
 * HubSpot's API base.
 *
 * Kept as a WHOLE-STRING LITERAL on purpose, following the QuickBooks
 * precedent at `../quickbooks/online-connector.ts:100-113`. Do not "clean this
 * up" into a template string, a joined constant, or a config read:
 * `scripts/check-egress-allowlist.py` is a static text scanner over tracked
 * source (`docs/SECURITY.md:183-185`) and can only extract a hostname it can
 * literally see. Assembling the host at runtime silently blinds the egress gate
 * while leaving the code working, which is the worst of both.
 *
 * ONE host covers everything this connector does. There is no token endpoint,
 * because there is no OAuth dance — a private app token is presented directly.
 */
export const HUBSPOT_PRODUCTION_BASE_URL = "https://api.hubapi.com";

/**
 * The only hosts this connector will send a private app token to — EXACTLY
 * these, never a suffix match.
 *
 * `baseUrl` is operator configuration living in `IntegrationConnection.
 * providerConfig`, which is free-text JSON. Nothing but this guard stands
 * between a tampered row and a token-carrying request to an arbitrary host, so
 * the check is an exact-set membership test derived from the published base URL
 * literal above. A suffix match would have accepted `api.hubapi.com.evil.test`.
 */
export const HUBSPOT_ALLOWED_API_HOSTS: ReadonlySet<string> = new Set(
  [HUBSPOT_PRODUCTION_BASE_URL].map((u) => new URL(u).hostname),
);

/**
 * The pinned, date-based API version — the ONLY place this string is written.
 *
 * Every request path is built from it through {@link hubspotPath}, so upgrading
 * the pin is one deliberate edit with its own test run. `hubspot.test.ts`
 * asserts that no second version literal exists anywhere in this directory,
 * because a second one is a version that can drift out of the pin silently.
 */
export const HUBSPOT_API_VERSION = "2026-03";

/**
 * The private app token shape.
 *
 * This single pattern is the ONLY gate — the classification below exists to
 * write a useful message, never to decide the outcome. Keeping one gate means
 * loosening this regex is what turns the intake test red, which is the mutation
 * the ticket names.
 *
 * The regional segment (`na1`, `eu1`, `ap1`, …) is matched as a family rather
 * than enumerated, so a customer in a HubSpot region we have not met is not
 * refused for living in the wrong place.
 */
export const HUBSPOT_PRIVATE_APP_TOKEN_PATTERN = /^pat-[a-z]{2}[0-9]+-/;

/** Records a single Search query may return before HubSpot answers HTTP 400. */
export const HUBSPOT_SEARCH_RESULT_CAP = 10_000;

/** Records per Search page. HubSpot's documented maximum. */
export const HUBSPOT_SEARCH_PAGE_SIZE = 200;

/** The Search ceiling, per ACCOUNT. Cannot be raised at any tier. */
export const HUBSPOT_SEARCH_MAX_REQUESTS_PER_SECOND = 5;

/**
 * How far behind the newest record seen the watermark is held.
 *
 * Search is eventually consistent and HubSpot documents no bound on it, so a
 * watermark set to `max(seen)` permanently drops every record that becomes
 * queryable a moment after the query ran — the next poll starts after them and
 * nothing ever looks again. Two minutes is a CHOSEN margin, not a vendor
 * guarantee: if records are ever observed missing at this overlap the margin
 * moves, and the acceptance criterion moves with it.
 */
export const HUBSPOT_SEARCH_CONSISTENCY_OVERLAP_MS = 120_000;

/** First backoff step; doubles per attempt, then jittered. */
export const HUBSPOT_BACKOFF_BASE_MS = 500;

/** Attempts against a 429 before the read is reported as rate limited. */
export const HUBSPOT_MAX_RATE_LIMIT_RETRIES = 5;

/**
 * Re-anchors one poll may perform before it reports a stall.
 *
 * A bound rather than an open loop: more than the cap's worth of records
 * sharing a single `hs_lastmodifieddate` (a bulk import on the customer's side)
 * makes the floor un-advanceable, and spinning there forever would be a silent
 * hang rather than a reported fault.
 */
export const HUBSPOT_MAX_REANCHORS = 512;

/** Status polls an asynchronous export gets before it is reported still running. */
export const HUBSPOT_BACKFILL_MAX_ATTEMPTS = 6;

/** Request timeout. */
const DEFAULT_TIMEOUT_MS = 15_000;

/** The property every delta query filters and sorts on. */
const LAST_MODIFIED_PROPERTY = "hs_lastmodifieddate";

/**
 * What this track is waiting on. Deliberately unlike the other tracks', so an
 * installer triaging this is not sent looking for a QuickBooks company, a
 * Stripe key, or a folder full of CSVs.
 */
export const HUBSPOT_TRACK_REMEDIATION =
  "needs a HubSpot private app access token (created by the portal's own super admin " +
  "under Settings → Integrations → Private Apps, free on every tier including Free) " +
  "stored on the integration row, and api.hubapi.com allowed in allowed-egress.yaml — " +
  "this connector leaves the customer LAN";

/**
 * The remediation for the super-admin-removal case, rendered verbatim to the
 * customer.
 *
 * It names the actual cause rather than the symptom, because the symptom — every
 * call failing — is indistinguishable from a dozen other things, and the person
 * reading this has no reason to suspect a permissions change made months ago to
 * an account that has nothing obviously to do with the box. The customer setup
 * guide must say the same thing in the same words, so a customer arriving from
 * either direction reaches the same fix.
 */
export const HUBSPOT_SUPER_ADMIN_REMEDIATION =
  "the HubSpot user who created this private app no longer has super admin permission " +
  "in the portal — they were removed, or their role was changed. The token itself is " +
  "fine and nothing on this box needs changing, but HubSpot will refuse every call " +
  "until a CURRENT super admin re-creates the private app and the new token is saved " +
  "here. Create it under an account that will outlive any one individual.";

/**
 * The datasets this track serves.
 *
 * Typed `readonly DatasetName[]` since WARP-2466 (WARP-2306's requirement) and
 * NOT cast — every name below is a member of the closed union in
 * `../export-drop/profiles.ts`, which is what makes the annotation an
 * assertion rather than a formality.
 *
 * These used to be `crm_contact` … `crm_engagement` as bare strings, because
 * the union at the time was six accounting-and-dental names that could not
 * express a CRM object. WARP-2280 widened it to twenty and WARP-2466
 * reconciled these five against it BY COLUMN LIST rather than by name: four of
 * them turned out to BE the canonical shape under HubSpot's own property
 * spellings (`firstname` is `first_name`, `dealstage` is `stage`), and
 * `crm_engagement` had no canonical equivalent and entered the union as
 * `engagement`. The per-name reasoning is the table in `profiles.ts`'s
 * docstring. The `crm_` prefix is gone because a namespace segment is not a
 * type — the vocabulary decision that file already made.
 */
export const HUBSPOT_DATASETS: readonly DatasetName[] = [
  "contact",
  "company",
  "deal",
  "ticket",
  "engagement",
];

/** The canonical columns each served dataset exposes. Synthesized rather than
 *  introspected: HubSpot's schema is HubSpot's, published and versioned. */
const HUBSPOT_DATASET_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  contact: ["id", "email", "firstname", "lastname", "lifecyclestage", LAST_MODIFIED_PROPERTY],
  company: ["id", "name", "domain", "industry", LAST_MODIFIED_PROPERTY],
  deal: ["id", "dealname", "dealstage", "pipeline", "amount", LAST_MODIFIED_PROPERTY],
  ticket: ["id", "subject", "hs_pipeline_stage", "hs_ticket_priority", LAST_MODIFIED_PROPERTY],
  engagement: ["id", "hs_engagement_type", "hs_timestamp", LAST_MODIFIED_PROPERTY],
};

/**
 * Every resource this connector may ever dial.
 *
 * An ALLOWLIST enforced at request time by {@link assertReadableHubspotObject},
 * not a denylist of forbidden words asserted in a test. The Stripe track proved
 * by mutation why that distinction matters: request paths here are assembled at
 * runtime (`/crm/objects/<version>/${objectType}`), so a forbidden literal need never
 * appear in the source at all for the connector to dial a forbidden endpoint.
 *
 * Adding a resource is therefore a deliberate, visible edit to a named constant
 * the suite asserts against, and every path this connector builds is checked
 * against it before a request is constructed.
 *
 * Absent on purpose: workflow/automation routes, settings and user management,
 * and every object outside the CRM read surface the ticket scopes.
 */
export const HUBSPOT_READABLE_RESOURCES: ReadonlySet<string> = new Set([
  "objects/contacts",
  "objects/companies",
  "objects/deals",
  "objects/tickets",
  "objects/calls",
  "objects/emails",
  "objects/meetings",
  "objects/notes",
  "objects/tasks",
  "owners",
  "pipelines",
  "properties",
  // Bulk history. On Free, and with no 10,000-record cap — which is the entire
  // reason backfill does not go through Search.
  "exports",
  // Tier-gated below, but still dialable: the 403 is how the capability state
  // is discovered, and a resource we refuse to dial can only ever be reported
  // as "not built".
  "marketing/emails",
  "schemas",
]);

/**
 * Resources a Free portal cannot read, and the tier that unlocks each.
 *
 * On a Free portal these 403. The named capability state that produces is the
 * ADR-041 never-empty contract applied to a tier boundary rather than to a
 * failure: `[]` here would tell an owner they have no marketing emails, which
 * is a different sentence from "your plan does not include them".
 */
export const HUBSPOT_TIER_GATED_RESOURCES: Readonly<Record<string, string>> = {
  "marketing/emails": "Marketing Hub Professional",
  schemas: "Enterprise",
};

/**
 * The only objects this connector will write, ever.
 *
 * Notes and tasks: the two where an agent adding a record is useful and
 * reversible. Deal-stage changes, contact merges and record deletions are
 * absent by construction — which is what "destructive actions are blocked"
 * means here. "We didn't build it" is not enforceable; this set plus
 * {@link assertWritableHubspotObject} is.
 */
export const HUBSPOT_WRITABLE_OBJECTS: ReadonlySet<string> = new Set(["notes", "tasks"]);

// ─────────────────────────────────────────────────────────────────────────────
// Errors — distinct classes with distinct codes, so a caller can tell them
// apart without string-matching a message.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Thrown when a connection names a destination this track will not dial.
 *
 * Named for the track (rather than a bare `UnsafeBaseUrlError`) because the
 * QuickBooks, Dentrix and Stripe tracks each already export one, and a package
 * with four same-named error classes cannot re-export them all.
 */
export class UnsafeHubspotBaseUrlError extends Error {
  readonly code = "UNSAFE_BASE_URL";
  constructor(reason: string) {
    super(`refusing to send a HubSpot private app token there: ${reason}`);
    this.name = "UnsafeHubspotBaseUrlError";
  }
}

/** Why a credential was refused at intake. An explicit enum, never inferred. */
export type HubspotCredentialRejection =
  | "empty"
  | "legacy_api_key"
  | "oauth_token"
  | "unrecognized";

const CREDENTIAL_ADVICE: Readonly<Record<HubspotCredentialRejection, string>> = {
  empty: "no value was supplied",
  legacy_api_key:
    "that looks like a legacy HubSpot API key (a bare UUID). HubSpot retired those. " +
    "A super admin must create a PRIVATE APP in the portal and use the access token it " +
    "issues",
  oauth_token:
    "that looks like an OAuth access token. This connector does not use OAuth — HubSpot " +
    "has no PKCE support, so an OAuth integration would require shipping a client secret " +
    "onto hardware we cannot revoke. Use a private app access token instead",
  unrecognized: "a HubSpot private app access token starts with pat- and a region, e.g. pat-na1-",
};

/**
 * Thrown when a credential is not a HubSpot private app token.
 *
 * The message NEVER contains the offered value. A validation error that quotes
 * the credential writes it into every log line that renders the error — rule
 * 19. Only the detected CLASS is reported, which is what the connect wizard
 * needs to say something useful.
 */
export class InvalidHubspotCredentialError extends Error {
  readonly code = "INVALID_HUBSPOT_CREDENTIAL";
  constructor(readonly reason: HubspotCredentialRejection) {
    super(`HubSpot credential rejected (${reason}): ${CREDENTIAL_ADVICE[reason]}`);
    this.name = "InvalidHubspotCredentialError";
  }
}

/**
 * Thrown when the account's shared daily request pool is spent. NOT a fault.
 *
 * The 250,000/day pool is per ACCOUNT, so a customer running other HubSpot
 * integrations spends from the same bucket — the box can be limited by a limit
 * it did not cause. Retrying inside the same day cannot help, which is why this
 * is a distinct class from the retryable burst limit.
 */
export class HubSpotQuotaExhaustedError extends Error {
  readonly code = "QUOTA_EXHAUSTED";
  constructor(readonly detail: string) {
    super(
      `HubSpot daily request allocation exhausted (${detail}). This pool is shared across ` +
        `every integration on the portal, so another tool may have spent it. Nothing is ` +
        `broken and no data is lost; reads resume when the daily window rolls.`,
    );
    this.name = "HubSpotQuotaExhaustedError";
  }
}

/** Thrown when only a person creating a new private app token can restore the
 *  connection. Distinct from the super-admin case: there, the token is fine. */
export class HubSpotReauthorizationRequiredError extends Error {
  readonly code = "REAUTHORIZE_REQUIRED";
  constructor(readonly reason: string) {
    super(
      `HubSpot rejected the private app token (${reason}). Retrying cannot fix this — the ` +
        `token was deleted or never carried the required scopes. A super admin must create ` +
        `a new private app token in the portal and save it here.`,
    );
    this.name = "HubSpotReauthorizationRequiredError";
  }
}

/**
 * Thrown when HubSpot answers `USER_DOES_NOT_HAVE_PERMISSIONS`.
 *
 * Deliberately NOT folded into {@link HubSpotReauthorizationRequiredError}, and
 * emphatically not into a not-configured state: the token is valid, the config
 * is correct, and telling the customer to check either would waste their time
 * and not fix it. This follows the `M365ConnectionState` rule
 * (`schema.prisma:4990-5012`) that a needs-reconnect state MUST be
 * distinguishable from a disconnected one.
 */
export class HubSpotSuperAdminRevokedError extends Error {
  readonly code = "USER_DOES_NOT_HAVE_PERMISSIONS";
  readonly remediation = HUBSPOT_SUPER_ADMIN_REMEDIATION;
  constructor(readonly detail: string) {
    super(`HubSpot refused every call for this private app: ${detail}. ${HUBSPOT_SUPER_ADMIN_REMEDIATION}`);
    this.name = "HubSpotSuperAdminRevokedError";
  }
}

/**
 * Thrown when a resource exists but the portal's plan does not include it.
 *
 * A tier boundary is not a failure and not an empty result. Naming the required
 * tier means the owner can decide whether to buy it, rather than filing a bug
 * against a connector that is working exactly as their plan allows.
 */
export class HubSpotCapabilityUnavailableError extends Error {
  readonly code = "CAPABILITY_NOT_AVAILABLE";
  constructor(
    readonly resource: string,
    readonly requiredTier: string,
  ) {
    super(
      `HubSpot "${resource}" needs ${requiredTier}, which this portal's plan does not ` +
        `include. This is a plan boundary, not a fault: nothing is misconfigured and ` +
        `nothing on this box will make the data appear.`,
    );
    this.name = "HubSpotCapabilityUnavailableError";
  }
}

/**
 * Thrown when 429s persist across every retry.
 *
 * Named for Search because Search is the constraint that binds — 5 requests per
 * second per account, unraisable — but thrown for any sustained 429. Reported
 * rather than swallowed: an empty CRM read is a confident false statement about
 * the business.
 */
export class HubSpotSearchRateLimitedError extends Error {
  readonly code = "SEARCH_RATE_LIMITED";
  constructor(
    readonly attempts: number,
    readonly detail: string,
  ) {
    super(
      `HubSpot rate limit (429) persisted across ${attempts} attempts (${detail}). The ` +
        `Search API allows ${HUBSPOT_SEARCH_MAX_REQUESTS_PER_SECOND} requests per second ` +
        `per ACCOUNT and that ceiling cannot be raised, so a portal busy enough to hold ` +
        `this state needs a slower poll cadence or an Exports-based load.`,
    );
    this.name = "HubSpotSearchRateLimitedError";
  }
}

/**
 * Thrown when a re-anchor cannot advance the watermark.
 *
 * More than {@link HUBSPOT_SEARCH_RESULT_CAP} records carrying one identical
 * `hs_lastmodifieddate` — a bulk import on the customer's side — leaves the
 * filter floor with nowhere to move. Reported rather than spun on, because a
 * poller that never returns is indistinguishable from a portal with no changes.
 */
export class HubSpotWatermarkStallError extends Error {
  readonly code = "WATERMARK_STALLED";
  constructor(
    readonly objectType: string,
    readonly floor: number,
    readonly ingested: number,
  ) {
    super(
      `the ${objectType} delta poll cannot advance past ${LAST_MODIFIED_PROPERTY}=${floor}: ` +
        `more than ${HUBSPOT_SEARCH_RESULT_CAP} records share that timestamp, so re-anchoring ` +
        `re-reads the same window forever. ${ingested} records were ingested before the ` +
        `stall. Load this window through the Exports API instead, which has no cap.`,
    );
    this.name = "HubSpotWatermarkStallError";
  }
}

/**
 * Thrown when a delta poll is attempted while a backfill holds the connection.
 *
 * The watermark may only advance once an export is fully ingested. A poll
 * running alongside one would jump the floor past records the export has not
 * delivered yet, and those records are then never looked for again.
 */
export class HubSpotBackfillInProgressError extends Error {
  readonly code = "BACKFILL_IN_PROGRESS";
  constructor(readonly objectType: string) {
    super(
      `a HubSpot ${objectType} backfill is in flight on this connection; the delta poller ` +
        `must not run until it finishes, or the watermark would advance past records the ` +
        `export has not delivered yet.`,
    );
    this.name = "HubSpotBackfillInProgressError";
  }
}

/**
 * Thrown when a write is attempted without an explicit confirmation.
 *
 * "Reads run automatically, writes ask for a thumbs-up" is a product contract,
 * not a setting, and `requiresConfirmation` is enforced by nothing generically
 * today (stated in-tree at `packages/tools-core/src/handlers/memory/forget.ts`).
 * So the gate is local and hard: no write leaves this connector without one.
 * The generic interceptor is WARP-2214's; this is what makes the promise true
 * in the meantime.
 */
export class HubSpotConfirmationRequiredError extends Error {
  readonly code = "CONFIRMATION_REQUIRED";
  constructor(readonly objectType: string) {
    super(
      `writing a HubSpot ${objectType} record needs an explicit confirmation from the ` +
        `person asking. Re-issue with { confirmed: true } once they have agreed.`,
    );
    this.name = "HubSpotConfirmationRequiredError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Guards
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate an operator-supplied API base, or throw.
 *
 * HTTPS only — a bearer token over http is the token given away — exactly one
 * of the registered hosts, on the registered port. Rejects userinfo
 * (`https://evil@api.hubapi.com`), which some HTTP clients resolve to a
 * different authority than a reader expects.
 *
 * Called at CONSTRUCTION, so a connection naming a destination we will not dial
 * fails to build rather than looking fine until the first read ships a token.
 */
export function assertSafeHubspotBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeHubspotBaseUrlError(`"${raw}" is not a URL`);
  }
  if (url.protocol !== "https:") {
    throw new UnsafeHubspotBaseUrlError(`"${url.protocol}//" is not https`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new UnsafeHubspotBaseUrlError("the URL carries userinfo");
  }
  const host = url.hostname.toLowerCase();
  if (!HUBSPOT_ALLOWED_API_HOSTS.has(host)) {
    throw new UnsafeHubspotBaseUrlError(`"${host}" is not a registered HubSpot API host`);
  }
  // The URL parser drops an explicit :443 (the https default), so any port left
  // standing is one the egress registry does not declare.
  if (url.port !== "" && url.port !== "443") {
    throw new UnsafeHubspotBaseUrlError(
      `port ${url.port} — the egress registry allows this host on 443 only`,
    );
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * Validate a customer-supplied credential, or throw — before anything is
 * persisted, and again on every resolve.
 *
 * Re-validating on resolve rather than only at intake matters because the
 * token never expires: there is no natural moment at which a wrong or stale
 * credential announces itself, and a row edited out of band must not be able to
 * put a non-private-app credential on the wire.
 *
 * The returned value is the trimmed token; the caller encrypts it. Nothing here
 * writes, logs or renders it.
 */
export function assertHubspotPrivateAppToken(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new InvalidHubspotCredentialError("empty");
  }
  const token = raw.trim();
  if (!HUBSPOT_PRIVATE_APP_TOKEN_PATTERN.test(token)) {
    // Classification is for the MESSAGE only. The pattern above is the gate, so
    // loosening it is what breaks the intake test — not this expression.
    const reason: HubspotCredentialRejection = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(token)
      ? "legacy_api_key"
      : /^C[A-Za-z0-9]{6,}/.test(token)
        ? "oauth_token"
        : "unrecognized";
    throw new InvalidHubspotCredentialError(reason);
  }
  return token;
}

/**
 * The API-name prefix of every route family this connector may dial.
 *
 * ## Why this is a table and not a string transform (WARP-2470)
 *
 * HubSpot's date-based versioning (DBV) puts the date AFTER the product group,
 * where the semantic version used to sit: the documented pattern is
 * `/api-name/<version>/resource`. Rewriting the legacy `/crm/v3/objects/…`
 * paths this connector was first modelled on is therefore a REORDER, not a
 * token swap — the object name moves ahead of the version — and a naive
 * `v3 → <version>` substitution yields `/crm/<version>/objects/contacts`, which
 * is a third wrong answer.
 *
 * A mechanical reorder is not enough either, because the rule does not hold for
 * every family: custom object schemas move to a DIFFERENT product group
 * entirely (`/crm/v3/schemas` → `/crm-object-schemas/<version>/schemas`), so
 * any general `/A/v3/B/rest → /A/B/<version>/rest` transform would silently
 * produce `/crm/schemas/<version>` and 404. That single exception is the reason
 * this is an explicit, per-family allowlist rather than clever string surgery.
 *
 * ## The endpoint table — every route this connector can build
 *
 * Verified 2026-08-27 against the embedded OpenAPI fragment on each endpoint's
 * own reference page under `developers.hubspot.com/docs/api-reference/latest/`.
 * EVERY one of them declares **zero header parameters**: the version travels in
 * the path and nowhere else, so there is no version header to set and no
 * account-level default to pin. Each family below has a documented 2026-03
 * path, so none of them needs to stay behind on a legacy `v3` route.
 *
 * | Connector call            | Documented 2026-03 path                                   | Legacy form it replaces                              | Spec |
 * |---------------------------|-----------------------------------------------------------|------------------------------------------------------|------|
 * | list / create objects     | `/crm/objects/<version>/{objectType}`                     | `/crm/v3/objects/{objectType}`                       | `crm-contacts-v2026-03.json` |
 * | read one object           | `/crm/objects/<version>/{objectType}/{objectId}`          | `/crm/v3/objects/{objectType}/{objectId}`            | `crm-contacts-v2026-03.json` |
 * | search objects (POST)     | `/crm/objects/<version>/{objectType}/search`              | `/crm/v3/objects/{objectType}/search`                | `crm-contacts-v2026-03.json` |
 * | connect probe / owners    | `/crm/owners/<version>`                                   | `/crm/v3/owners`                                     | `crm-crm-owners-v2026-03.json` |
 * | start an export (POST)    | `/crm/exports/<version>/export/async`                     | `/crm/v3/exports/export/async`                       | `crm-exports-v2026-03.json` |
 * | export task status        | `/crm/exports/<version>/export/async/tasks/{taskId}/status` | `/crm/v3/exports/export/async/tasks/{taskId}/status` | `crm-exports-v2026-03.json` |
 * | list marketing emails     | `/marketing/emails/<version>`                             | `/marketing/v3/emails`                               | `marketing-marketing-emails-v2026-03.json` |
 * | list custom obj. schemas  | `/crm-object-schemas/<version>/schemas`                   | `/crm/v3/schemas`  ← product group renamed           | `crm-schemas-v2026-03.json` |
 * | pipelines †               | `/crm/pipelines/<version>/{objectType}`                   | `/crm/v3/pipelines/{objectType}`                     | `crm-pipelines-v2026-03.json` |
 * | properties †              | `/crm/properties/<version>/{objectType}`                  | `/crm/v3/properties/{objectType}`                    | `crm-properties-v2026-03.json` |
 *
 * † Named in {@link HUBSPOT_READABLE_RESOURCES} and parseable by
 * {@link hubspotResourceOf}, but not dialed by any method today. They are
 * carried here so the allowlist and the resource mapper stay in agreement, and
 * so the first call site that needs one does not have to re-derive its shape.
 *
 * Associations are deliberately absent: the object read answers them as a block
 * (`?associations=deals`), which is what keeps the v4 Associations API — whose
 * support ends 2027-03-30 — out of this connector entirely.
 */
export const HUBSPOT_API_ROUTES = {
  objects: "crm/objects",
  owners: "crm/owners",
  exports: "crm/exports",
  marketingEmails: "marketing/emails",
  objectSchemas: "crm-object-schemas",
  pipelines: "crm/pipelines",
  properties: "crm/properties",
} as const;

/** The families {@link hubspotPath} will build a path for. */
export type HubspotApiName = keyof typeof HUBSPOT_API_ROUTES;

/**
 * Build a request path under the pinned API version.
 *
 * The ONE place a HubSpot path is assembled, so the version pin cannot be
 * skipped by a call site that forgot about it, and so a change in how HubSpot
 * expresses the date-based version is a one-function edit.
 *
 * `api` is a KEY into {@link HUBSPOT_API_ROUTES} rather than a path fragment,
 * which is what makes an undocumented route unrepresentable: a call site cannot
 * hand this function a product group nobody wrote down, because the type has no
 * member for one.
 *
 * @param api      which documented route family to build under.
 * @param resource the path tail BELOW the version, with no leading slash
 *                 (`"contacts/search"`, `"export/async"`). Empty for the
 *                 families whose documented path ends at the version.
 */
export function hubspotPath(api: HubspotApiName, resource = ""): string {
  const apiName = HUBSPOT_API_ROUTES[api];
  // Defence in depth behind the type: a JS caller, or a key deleted from the
  // table while a call site still names it, must not assemble `/undefined/…`
  // and put a token on the wire against it.
  if (!apiName) {
    throw new ConnectorBlockedError(
      `"${String(api)}" is not a documented HubSpot route family`,
      "every request path is built from HUBSPOT_API_ROUTES, which lists the route " +
        "families verified against HubSpot's published 2026-03 OpenAPI. Adding one is a " +
        "deliberate, reviewed change.",
    );
  }
  return `/${apiName}/${HUBSPOT_API_VERSION}${resource === "" ? "" : `/${resource}`}`;
}

/**
 * Map a request path to the resource key it addresses, or `""` for anything
 * this connector does not recognise.
 *
 * DENY BY DEFAULT: an unrecognised shape returns the empty string, which is not
 * in {@link HUBSPOT_READABLE_RESOURCES}, so a path nobody thought about is
 * refused rather than falling through to its first segment. Object routes are
 * additionally constrained to `search` or a numeric object id, so an
 * action-shaped suffix — a merge, an archive, a batch mutation — cannot ride in
 * on an otherwise readable object.
 */
export function hubspotResourceOf(path: string): string {
  const clean = path.split("?")[0];

  for (const [family, apiName] of Object.entries(HUBSPOT_API_ROUTES) as [
    HubspotApiName,
    string,
  ][]) {
    // The version must sit exactly where the spec documents it — immediately
    // after the product group. A path carrying the date anywhere else (the
    // pre-WARP-2470 `/2026-03/crm/v3/…` shape included) matches no family and
    // falls through to the deny-by-default return.
    const prefix = `/${apiName}/${HUBSPOT_API_VERSION}`;
    if (clean !== prefix && !clean.startsWith(`${prefix}/`)) continue;
    const tail = clean.slice(prefix.length).split("/").filter(Boolean);

    switch (family) {
      case "objects": {
        const objectType = tail[0];
        if (!objectType) return "";
        const next = tail[1];
        // Only a read shape: the collection itself, its search endpoint, or one
        // record by its numeric id. Anything else is an action.
        if (next !== undefined && next !== "search" && !/^\d+$/.test(next)) return "";
        if (tail.length > 2) return "";
        return `objects/${objectType}`;
      }
      case "exports":
        return tail[0] === "export" && tail[1] === "async" ? "exports" : "";
      case "owners":
        return tail.length === 0 ? "owners" : "";
      case "marketingEmails":
        return tail.length === 0 ? "marketing/emails" : "";
      case "objectSchemas":
        return tail.length === 1 && tail[0] === "schemas" ? "schemas" : "";
      case "pipelines":
        return "pipelines";
      case "properties":
        return "properties";
    }
  }
  return "";
}

/**
 * Refuse a path whose resource is not in {@link HUBSPOT_READABLE_RESOURCES}.
 *
 * Called at the top of every request, BEFORE the token is resolved, so an
 * off-allowlist path never reaches the network and never even touches the
 * credential. This is what makes the read surface a property of the code rather
 * than a claim about it: a request for a workflow, a settings route or an
 * unlisted object — written literally, or assembled from a variable at runtime
 * — throws here instead of dialing.
 */
export function assertReadableHubspotObject(path: string): void {
  const resource = hubspotResourceOf(path);
  if (!HUBSPOT_READABLE_RESOURCES.has(resource)) {
    throw new ConnectorBlockedError(
      `refusing to dial the HubSpot path "${path}"`,
      "this connector may only reach the resources named in HUBSPOT_READABLE_RESOURCES. " +
        "Workflow, settings and unlisted object routes are absent from that set on " +
        "purpose, and adding one is a deliberate, reviewed change — not something a new " +
        "request path can do incidentally.",
    );
  }
}

/**
 * Refuse a write to any object outside {@link HUBSPOT_WRITABLE_OBJECTS}.
 *
 * The companion to the read allowlist, and the reason deal-stage changes and
 * contact merges cannot appear by accident: a write path built for a new object
 * throws here rather than reaching HubSpot.
 */
export function assertWritableHubspotObject(objectType: string): void {
  if (!HUBSPOT_WRITABLE_OBJECTS.has(objectType)) {
    throw new ConnectorBlockedError(
      `refusing to write HubSpot "${objectType}" records`,
      "this connector writes notes and tasks only. Deal-stage changes, contact merges " +
        "and record deletions are absent by design, which is what \"destructive actions " +
        "are blocked\" means for the CRM track.",
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The account-keyed Search governor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A sliding-window rate governor for one HubSpot ACCOUNT.
 *
 * The ceiling is 5 Search requests per second per account — not per app, not
 * per connection. Two `IntegrationConnection` rows pointed at one portal share
 * it, and so would two private apps, so the governor has to live above the
 * connection and be keyed on the portal id. That is the whole design; keying it
 * anywhere else produces a connector that looks correct and 429s under load.
 *
 * Acquisitions are chained, so two concurrent callers cannot both read the same
 * window and both conclude there is room. The wait loop is BOUNDED rather than
 * open — an unbounded wait inside a governor is a hang wearing a queue's
 * clothes.
 */
export class SearchRateGovernor {
  /** Grant timestamps inside the current window. */
  private readonly recent: number[] = [];
  /** The serialisation chain. Failures are absorbed so one rejected acquire
   *  cannot wedge the queue for every later caller. */
  private chain: Promise<void> = Promise.resolve();

  constructor(
    readonly portalId: string,
    private readonly now: () => number,
    private readonly sleep: (ms: number) => Promise<void>,
    private readonly perSecond = HUBSPOT_SEARCH_MAX_REQUESTS_PER_SECOND,
    private readonly windowMs = 1000,
  ) {}

  acquire(): Promise<void> {
    // Deliberately NOT an `async` method: `async` + `return run` costs the
    // caller two extra microtask hops before it can issue its request, during
    // which the next queued acquisition can already be waiting. Returning the
    // promise directly keeps "slot granted" and "request issued" adjacent.
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
    for (let attempt = 0; attempt <= this.perSecond + 1; attempt += 1) {
      const t = this.now();
      this.prune(t);
      if (this.recent.length < this.perSecond) {
        this.recent.push(t);
        return;
      }
      await this.sleep(this.windowMs - (t - this.recent[0]));
    }
    throw new HubSpotSearchRateLimitedError(
      this.perSecond + 2,
      `the Search governor for portal ${this.portalId} could not find a slot`,
    );
  }
}

/**
 * Governors, one per ACCOUNT, for the life of the process.
 *
 * Module-level on purpose: a governor scoped to a connector instance would
 * reset every time a connection was rebuilt, and two connections on one portal
 * would never see each other — which is precisely the defect this whole
 * mechanism exists to prevent.
 */
const SEARCH_GOVERNORS = new Map<string, SearchRateGovernor>();

/** Get (or create) the governor for one HubSpot account. */
export function searchGovernorForPortal(
  portalId: string,
  deps: { now: () => number; sleep: (ms: number) => Promise<void> },
): SearchRateGovernor {
  const existing = SEARCH_GOVERNORS.get(portalId);
  if (existing) return existing;
  const created = new SearchRateGovernor(portalId, deps.now, deps.sleep);
  SEARCH_GOVERNORS.set(portalId, created);
  return created;
}

/** Drop every governor. A suite hook — production never calls this, because a
 *  forgotten window is a burst against a ceiling that cannot be raised. */
export function resetSearchGovernors(): void {
  SEARCH_GOVERNORS.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// Wiring types
// ─────────────────────────────────────────────────────────────────────────────

type FetchLike = (input: string, init?: Record<string, unknown>) => Promise<Response>;

/** Resolve the private app token (from the orchestrator's encrypted store).
 *  Cleartext for the life of one call only; never cached to disk here. */
export type HubspotTokenResolver = () => Promise<string>;

/** The default resolver: nothing wired, so the track blocks honestly. */
export const blockedHubspotTokenResolver: HubspotTokenResolver = async () => {
  throw new ConnectorBlockedError(
    "resolve the HubSpot private app token",
    HUBSPOT_TRACK_REMEDIATION,
  );
};

export interface HubSpotConnectorConfig {
  /** The HubSpot account (portal) id. The Search governor's key, and the reason
   *  it is required rather than optional: without it two connections on one
   *  account cannot be recognised as sharing a ceiling. */
  portalId: string;
  /** Pointer into the encrypted secret store — NEVER a token. */
  credentialsSecretRef: string;
  /** API base. Operator-configured, and guarded on construction. */
  baseUrl?: string;
}

export interface HubSpotConnectorDeps {
  fetchImpl?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Injected so the backoff jitter is deterministic under test. */
  random?: () => number;
  resolveToken?: HubspotTokenResolver;
  timeoutMs?: number;
  /** Override the account governor. Production never does; the default resolves
   *  through {@link searchGovernorForPortal} so the account keying is real. */
  governor?: SearchRateGovernor;
}

/**
 * The ADR-041 §5 connection-state vocabulary, extended with the two states this
 * vendor forces.
 *
 * Explicit, never inferred from a missing token and never derived from a read
 * that happened to return nothing — an absent value defaulted into "connected"
 * is exactly the looks-connected-syncs-nothing failure that section exists to
 * prevent.
 */
export type HubSpotConnectionState =
  | "disconnected"
  | "connected"
  | "needs_reconnect"
  | "super_admin_revoked"
  | "rate_limited";

const REMEDIATION_BY_STATE: Readonly<Record<HubSpotConnectionState, string | null>> = {
  disconnected: HUBSPOT_TRACK_REMEDIATION,
  connected: null,
  needs_reconnect:
    "HubSpot rejected the stored private app token. A super admin must create a new " +
    "private app token in the portal and save it here.",
  super_admin_revoked: HUBSPOT_SUPER_ADMIN_REMEDIATION,
  rate_limited:
    "HubSpot is rate limiting this portal. The Search ceiling is 5 requests per second " +
    "per account and cannot be raised; reduce the poll cadence or load through Exports.",
};

export interface HubSpotStatus {
  state: HubSpotConnectionState;
  ok: boolean;
  /** Whether a token resolves. NEVER the token — the SMTP settings view's
   *  `hasPassword` convention. */
  hasToken: boolean;
  portalId: string;
  apiVersion: string;
  searchRequestsPerSecond: number;
  remediation: string | null;
}

/** One CRM record as HubSpot returns it, plus the parsed modification stamp. */
export interface HubSpotRecord {
  id: string;
  properties: Record<string, string | undefined>;
  /** Epoch ms parsed from `hs_lastmodifieddate`. */
  updatedAtMs: number;
}

export interface HubSpotDeltaPollResult {
  /** Deduped on OBJECT id: the overlap is deliberately replayed every poll, so
   *  id-keying is what makes the upsert idempotent. Later modifications win. */
  records: HubSpotRecord[];
  /** The watermark to persist, already held behind the newest record seen by
   *  {@link HUBSPOT_SEARCH_CONSISTENCY_OVERLAP_MS}. RETURNED rather than
   *  written: `ErpSyncCursor` has zero writers today and ADR-041 §4 forbids a
   *  cloud connector becoming its first while WARP-2028 is open. */
  watermark: number;
  /** How many times the filter floor was re-anchored. Surfaced because a
   *  steadily rising count is the signal that a portal has outgrown Search. */
  anchors: number;
  objectType: string;
}

/** Backfill is asynchronous on HubSpot's side, so "still running" is a
 *  first-class state and never collapses into "finished, no rows". */
export type HubSpotBackfillResult =
  | { state: "in_progress"; exportId: string; attempts: number; detail: string }
  | { state: "succeeded"; exportId: string; fileRef: string | null; detail: string }
  | { state: "failed"; exportId: string; detail: string };

/** HubSpot's error envelope, as much of it as this connector reads. */
interface HubSpotErrorBody {
  category?: string;
  message?: string;
  policyName?: string;
}

export class HubSpotConnector implements Connector {
  readonly provider = HUBSPOT_PROVIDER;
  readonly servesDatasets = HUBSPOT_DATASETS;

  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly resolveToken: HubspotTokenResolver;
  private readonly fetchImpl?: FetchLike;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly governor: SearchRateGovernor;

  private accessToken: string | null = null;
  private fingerprint: string | null = null;
  /** The last state an actual exchange with HubSpot established. An explicit
   *  value, never derived from a NULL or from a read returning nothing. */
  private observedState: HubSpotConnectionState = "connected";
  /** Held for the duration of a backfill, so the delta poller cannot advance
   *  the watermark past records the export has not delivered. */
  private backfillInFlight = false;

  constructor(
    private readonly config: HubSpotConnectorConfig,
    deps: HubSpotConnectorDeps = {},
  ) {
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = deps.random ?? Math.random;
    this.resolveToken = deps.resolveToken ?? blockedHubspotTokenResolver;
    this.fetchImpl = deps.fetchImpl;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Validated at CONSTRUCTION: a connection naming a destination we will not
    // dial should fail to build, loudly, rather than look fine until the first
    // read ships a token.
    this.baseUrl = assertSafeHubspotBaseUrl(config.baseUrl ?? HUBSPOT_PRODUCTION_BASE_URL);
    this.governor =
      deps.governor ??
      searchGovernorForPortal(config.portalId, { now: this.now, sleep: this.sleep });
  }

  private blocked(op: string, detail?: string): ConnectorBlockedError {
    return new ConnectorBlockedError(detail ? `${op} (${detail})` : op, HUBSPOT_TRACK_REMEDIATION);
  }

  /** Resolve and validate the token. Validated on EVERY resolve, not only at
   *  intake: the token never expires, so nothing else would ever notice a row
   *  edited out of band. */
  private async token(): Promise<string> {
    if (this.accessToken) return this.accessToken;
    const raw = await this.resolveToken();
    this.accessToken = assertHubspotPrivateAppToken(raw);
    return this.accessToken;
  }

  /**
   * Backoff for one 429 attempt: exponential, then jittered downward.
   *
   * Self-derived because Search sends NO rate-limit headers — not `Retry-After`,
   * not a remaining-quota hint. Without this the connector hot-loops against an
   * endpoint that is already telling it to slow down.
   *
   * The jitter is a half-range below the exponential rather than around it, so
   * it can never push a retry LATER than the un-jittered schedule while still
   * breaking the lockstep that has every box retrying on the same tick.
   */
  private backoffMs(attempt: number): number {
    const ceiling = HUBSPOT_BACKOFF_BASE_MS * 2 ** attempt;
    return Math.round(ceiling * (0.5 + 0.5 * this.random()));
  }

  /**
   * One request.
   *
   * `governed` decides whether the call takes a slot from the account's Search
   * ceiling: true for `/search`, false for everything else. Metering the
   * ordinary object reads and the Exports API against a 5 req/s limit that does
   * not apply to them would throttle the connector against a rule HubSpot never
   * made.
   */
  private async request(
    op: string,
    path: string,
    opts: {
      method?: "GET" | "POST";
      search?: Record<string, string | number | undefined>;
      json?: unknown;
      governed?: boolean;
    } = {},
  ): Promise<Record<string, unknown>> {
    assertReadableHubspotObject(path);
    const token = await this.token();

    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.search ?? {})) {
      if (v !== undefined) qs.set(k, String(v));
    }
    const url = `${this.baseUrl}${path}${qs.toString() ? `?${qs}` : ""}`;
    const body = opts.json === undefined ? undefined : JSON.stringify(opts.json);

    const doFetch = this.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    if (!doFetch) throw this.blocked(op, "no fetch implementation available");

    for (let attempt = 0; attempt < HUBSPOT_MAX_RATE_LIMIT_RETRIES; attempt += 1) {
      if (opts.governed) await this.governor.acquire();

      let res: Response;
      try {
        res = await doFetch(url, {
          method: opts.method ?? "GET",
          headers: {
            // The token goes in a header and never in a query string: a
            // credential in a URL is a credential in every proxy log.
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          ...(body ? { body } : {}),
          // Never follow a 3xx: the fetch spec strips Authorization on
          // cross-origin redirects, but the token's safety must not rest on
          // every runtime implementing that correctly. This API has no
          // legitimate redirect, so one is a fault, not a hop.
          redirect: "error",
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        throw this.blocked(op, `HubSpot API unreachable: ${(err as Error).message}`);
      }

      if (res.status === 429) {
        const err = await HubSpotConnector.errorBody(res);
        if (err.policyName === "DAILY") {
          // The account's shared daily pool, not a burst. Retrying inside the
          // same day cannot help, so this does not go round the loop.
          this.observedState = "rate_limited";
          throw new HubSpotQuotaExhaustedError(err.message ?? "HubSpot reported the daily policy");
        }
        if (attempt >= HUBSPOT_MAX_RATE_LIMIT_RETRIES - 1) {
          this.observedState = "rate_limited";
          throw new HubSpotSearchRateLimitedError(
            attempt + 1,
            err.message ?? "no rate-limit headers were returned",
          );
        }
        // Honour Retry-After when HubSpot sends one, and back off anyway when
        // it does not — which, on Search, is always.
        const retryAfter = Number(res.headers.get("Retry-After") ?? "");
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0;
        await this.sleep(Math.max(this.backoffMs(attempt), wait));
        continue;
      }

      if (res.status === 401) {
        this.observedState = "needs_reconnect";
        throw new HubSpotReauthorizationRequiredError("HubSpot returned 401");
      }

      if (res.status === 403) {
        const err = await HubSpotConnector.errorBody(res);
        // ORDER MATTERS. A revoked super admin 403s on everything, gated
        // resources included, so classifying by resource first would tell a
        // customer to buy Marketing Hub when what they actually need is to
        // re-create the private app.
        if (err.category === "USER_DOES_NOT_HAVE_PERMISSIONS") {
          this.observedState = "super_admin_revoked";
          throw new HubSpotSuperAdminRevokedError(err.message ?? "HubSpot returned 403");
        }
        const resource = hubspotResourceOf(path);
        const tier = HUBSPOT_TIER_GATED_RESOURCES[resource];
        if (tier) {
          // A plan boundary is not a connection fault, so `observedState` is
          // left alone: the connection is healthy and reading everything the
          // portal's plan includes.
          throw new HubSpotCapabilityUnavailableError(resource, tier);
        }
        this.observedState = "needs_reconnect";
        throw new HubSpotReauthorizationRequiredError(
          `HubSpot returned 403: ${err.message ?? "forbidden"}`,
        );
      }

      if (res.status === 400) {
        const err = await HubSpotConnector.errorBody(res);
        // Named explicitly because this is the hour it would otherwise cost:
        // the 10,000-record cap surfaces as a 400 that is indistinguishable at
        // a glance from a malformed filter.
        throw this.blocked(
          op,
          `HubSpot rejected the request (400: ${err.message ?? "no message"}). If this is a ` +
            `Search query, check the ${HUBSPOT_SEARCH_RESULT_CAP}-record cap before ` +
            `suspecting the filter — crossing it is answered with exactly this status.`,
        );
      }

      if (!res.ok) {
        throw this.blocked(op, `HubSpot API returned ${res.status}`);
      }

      this.observedState = "connected";
      try {
        return (await res.json()) as Record<string, unknown>;
      } catch (err) {
        throw this.blocked(op, `unparseable HubSpot response: ${(err as Error).message}`);
      }
    }

    // Unreachable: the loop either returns or throws on its final attempt.
    throw this.blocked(op, "request loop exhausted");
  }

  /** Pull what matters out of a HubSpot error envelope. */
  private static async errorBody(res: Response): Promise<HubSpotErrorBody> {
    try {
      return ((await res.json()) ?? {}) as HubSpotErrorBody;
    } catch {
      return {};
    }
  }

  // ── Connector interface ───────────────────────────────────────────────────

  async connect(): Promise<void> {
    // A cheap, real read proves three things at once: the token works, it
    // carries the scopes we need, and egress to HubSpot is permitted. Owners is
    // the cheapest such read and is present on every tier.
    await this.request("connect", hubspotPath("owners"), { search: { limit: 1 } });
    this.fingerprint = computeSchemaFingerprint(this.tables());
  }

  async close(): Promise<void> {
    this.accessToken = null;
  }

  async health(): Promise<{ ok: boolean }> {
    // Derived from the same explicit state `status()` reports, not from
    // whichever fields happen to be populated. Rejecting rather than returning
    // `{ ok: false }` is the blocked-boundary contract: a caller that ignores a
    // return value cannot ignore a rejection.
    const state = await this.currentState();
    if (state === "super_admin_revoked") {
      throw new HubSpotSuperAdminRevokedError("the private app's creator lost super admin");
    }
    if (state === "needs_reconnect") {
      throw new HubSpotReauthorizationRequiredError("the stored token is not usable");
    }
    if (state === "rate_limited") {
      throw new HubSpotSearchRateLimitedError(
        HUBSPOT_MAX_RATE_LIMIT_RETRIES,
        "HubSpot is rate limiting this portal",
      );
    }
    if (state === "disconnected") {
      throw this.blocked("health", "no HubSpot portal is connected");
    }
    return { ok: true };
  }

  /** The canonical shape this track serves. Synthesized rather than
   *  introspected: HubSpot's schema is HubSpot's, published and versioned, so
   *  there is nothing to discover — but the fingerprint still has to exist so
   *  drift-freeze semantics stay coherent across every track. */
  private tables(): IntrospectedTable[] {
    return HUBSPOT_DATASETS.map((dataset) => ({
      name: dataset,
      owner: HUBSPOT_PROVIDER,
      columns: (HUBSPOT_DATASET_COLUMNS[dataset] ?? []).map((name) => ({ name, type: "text" })),
    }));
  }

  async introspect(): Promise<IntrospectionResult> {
    const tables = this.tables();
    // Pin the API version INTO the fingerprint: a HubSpot version bump can
    // change field shapes without changing our column list, and a fingerprint
    // blind to that would report "no drift" across a real one.
    const fingerprint = computeSchemaFingerprint(tables) + `:hsv${HUBSPOT_API_VERSION}`;
    this.fingerprint = fingerprint;
    return { tables, fingerprint };
  }

  async runRead(name: string, _params: Record<string, unknown>): Promise<unknown[]> {
    const query = getReadQuery(name);
    // Every registered read depends on the six canonical datasets, and this
    // track serves none of them, so this refuses — loudly and by type. That is
    // a capability statement: `[]` from `get_open_invoices` reads as "you are
    // owed nothing", which no caller can tell apart from a genuinely empty
    // ledger. HubSpot's own surface is served by the named methods below.
    assertDatasetsServed(this.provider, this.servesDatasets, name, query.dependsOnTables);
    throw this.blocked(
      `runRead:${name}`,
      "the HubSpot track answers CRM reads through its own named methods; the canonical " +
        "read registry is built on accounting and practice-management datasets it does " +
        "not serve",
    );
  }

  async applyWrite(name: string, _params: Record<string, unknown>): Promise<unknown> {
    // Same validation order as every other track, so a caller bug produces the
    // same typed error here as anywhere else...
    const cmd = getWriteCommand(name);
    assertTargetAllowed(cmd.targetTable);
    // ...and then this track refuses. Its two writes are notes and tasks, and
    // they go through the confirmed methods below rather than the named write
    // registry, which is built for the practice-management tracks.
    throw this.blocked(
      `applyWrite:${name}`,
      "the HubSpot track's only writes are notes and tasks, behind an explicit " +
        "confirmation. Deal-stage changes, contact merges and deletions do not exist in " +
        "this connector at any tier",
    );
  }

  // ── CRM-specific surface ──────────────────────────────────────────────────

  /**
   * One page of a `hs_lastmodifieddate` Search query.
   *
   * `after` is an OFFSET into the result set, and the reason it is passed
   * explicitly rather than threaded through a cursor object: the caller has to
   * be able to see how far into the cap it is, because crossing 10,000 is a
   * 400 rather than a truncation.
   */
  private async searchPage(
    objectType: string,
    floor: number,
    after: string | undefined,
    properties: readonly string[],
  ): Promise<Record<string, unknown>> {
    return this.request("pollObjectChanges", hubspotPath("objects", `${objectType}/search`), {
      method: "POST",
      governed: true,
      json: {
        filterGroups: [
          {
            filters: [
              { propertyName: LAST_MODIFIED_PROPERTY, operator: "GTE", value: String(floor) },
            ],
          },
        ],
        // ASCENDING is not cosmetic. Re-anchoring sets the next floor to the
        // newest record seen, and "newest seen" is only the true newest if the
        // feed arrives in order — otherwise the new floor skips rows that were
        // never returned.
        sorts: [{ propertyName: LAST_MODIFIED_PROPERTY, direction: "ASCENDING" }],
        limit: HUBSPOT_SEARCH_PAGE_SIZE,
        properties: [...properties],
        ...(after === undefined ? {} : { after }),
      },
    });
  }

  /**
   * Poll one CRM object type for changes since `watermark`.
   *
   * The two traps this method exists for, and how each is answered:
   *
   *   1. **The 10,000-record cap is an HTTP 400, not a truncation.** So the
   *      floor is RE-ANCHORED to the newest record seen and the query restarts
   *      at offset zero, rather than paging deeper. The offset is checked
   *      before every request, so a request that would cross the cap is never
   *      constructed — which is what makes the 400 unreachable rather than
   *      merely handled.
   *   2. **Search is eventually consistent, with no documented bound.** The
   *      returned watermark is held {@link HUBSPOT_SEARCH_CONSISTENCY_OVERLAP_MS}
   *      behind the newest record, so the next poll re-reads that window.
   *      Records are keyed on object id, so replaying it is idempotent.
   *
   * The watermark is RETURNED, not persisted: `ErpSyncCursor` has zero writers
   * today and ADR-041 §4 forbids a cloud connector becoming its first while
   * WARP-2028 is open.
   */
  async pollObjectChanges(input: {
    objectType: string;
    watermark: number;
    properties?: readonly string[];
  }): Promise<HubSpotDeltaPollResult> {
    const { objectType } = input;
    if (this.backfillInFlight) throw new HubSpotBackfillInProgressError(objectType);

    const properties = input.properties ?? [LAST_MODIFIED_PROPERTY];
    const pagesPerAnchor = HUBSPOT_SEARCH_RESULT_CAP / HUBSPOT_SEARCH_PAGE_SIZE;
    const seen = new Map<string, HubSpotRecord>();

    let floor = input.watermark;
    let newest = input.watermark;
    let anchors = 0;
    let exhausted = false;

    while (!exhausted && anchors < HUBSPOT_MAX_REANCHORS) {
      const anchorFloor = floor;
      const before = seen.size;
      anchors += 1;

      let after: string | undefined;
      for (let page = 0; page < pagesPerAnchor; page += 1) {
        const body = await this.searchPage(objectType, anchorFloor, after, properties);
        const results = Array.isArray(body.results) ? (body.results as unknown[]) : [];
        for (const raw of results) {
          const parsed = HubSpotConnector.toRecord(raw);
          if (!parsed) continue;
          // Keyed on object id, later modification wins: two polls overlapping
          // the same window produce one row to upsert, not two.
          const existing = seen.get(parsed.id);
          if (!existing || parsed.updatedAtMs >= existing.updatedAtMs) seen.set(parsed.id, parsed);
          if (parsed.updatedAtMs > newest) newest = parsed.updatedAtMs;
        }

        const next = HubSpotConnector.nextAfter(body);
        if (next === undefined || results.length === 0) {
          exhausted = true;
          break;
        }
        // The cap check, BEFORE the request that would cross it. HubSpot
        // answers an over-cap offset with a 400, so this is the difference
        // between re-anchoring and failing.
        if (Number(next) >= HUBSPOT_SEARCH_RESULT_CAP) break;
        after = next;
      }

      if (exhausted) break;
      // Re-anchor. If the floor cannot move and nothing new arrived, more than
      // the cap's worth of records share one timestamp and re-querying would
      // return the same window forever.
      if (newest <= anchorFloor || seen.size === before) {
        throw new HubSpotWatermarkStallError(objectType, anchorFloor, seen.size);
      }
      floor = newest;
    }

    return {
      records: [...seen.values()].sort((a, b) => a.id.localeCompare(b.id)),
      // Held BEHIND the newest record seen, and never allowed to move backwards
      // past where the caller already was.
      watermark: Math.max(input.watermark, newest - HUBSPOT_SEARCH_CONSISTENCY_OVERLAP_MS),
      anchors,
      objectType,
    };
  }

  /**
   * Bulk history and oversized-window recovery, through the Exports API.
   *
   * Search is arithmetically disqualified for this rather than merely slow: it
   * caps at 10,000 records per query and is governed at 5 requests per second
   * per account, so seeding a portal's history through it would take hours and
   * starve the delta poller the whole time. Exports has no cap, is available on
   * Free, and does not compete for the Search ceiling.
   *
   * Exports are ASYNCHRONOUS — request, poll, then retrieve — so a run still
   * building is its own returned state and never collapses into "backfill
   * finished, no rows", which would be a confident false statement about the
   * customer's CRM.
   *
   * Retrieving the finished file's CONTENTS is deliberately not done here: it is
   * served from a signed URL on a host that is NOT in
   * `docs/security/allowed-egress.yaml` and would need its own entry and its own
   * security review. This method takes the export to completion and returns the
   * reference; downloading it is a follow-up with an egress decision attached,
   * and refusing to dial an unregistered host is the correct default rather than
   * an oversight.
   */
  async runBackfill(input: {
    objectType: string;
    properties: readonly string[];
  }): Promise<HubSpotBackfillResult> {
    const op = "runBackfill";
    if (this.backfillInFlight) throw new HubSpotBackfillInProgressError(input.objectType);
    // Set BEFORE the first await, so a poll issued on the very next tick sees
    // it. Released in `finally`, because a lock that outlives its holder is a
    // connection that never syncs again.
    this.backfillInFlight = true;
    try {
      const created = await this.request(op, hubspotPath("exports", "export/async"), {
        method: "POST",
        json: {
          exportType: "VIEW",
          format: "CSV",
          objectType: input.objectType,
          exportName: `droplet-${input.objectType}-backfill`,
          objectProperties: [...input.properties],
        },
      });
      const exportId = typeof created.id === "string" ? created.id : String(created.id ?? "");

      for (let attempt = 0; attempt < HUBSPOT_BACKFILL_MAX_ATTEMPTS; attempt += 1) {
        // Backoff between polls: an export over a portal's whole history takes
        // real time, and hammering the status endpoint helps nobody.
        await this.sleep(this.backoffMs(attempt));
        const run = await this.request(
          op,
          hubspotPath("exports", `export/async/tasks/${exportId}/status`),
        );
        const status = typeof run.status === "string" ? run.status : "";
        if (status === "COMPLETE") {
          return {
            state: "succeeded",
            exportId,
            fileRef: typeof run.result === "string" ? run.result : null,
            detail:
              "the export finished; retrieving its file contents needs HubSpot's export " +
              "file host registered in allowed-egress.yaml first",
          };
        }
        if (status === "CANCELED" || status === "FAILED") {
          return { state: "failed", exportId, detail: `HubSpot reported the export as ${status}` };
        }
      }

      // Attempts exhausted. Explicitly STILL RUNNING — the caller polls again
      // later. Reporting this as finished-with-no-rows is the exact silent
      // wrong answer this connector exists not to produce.
      return {
        state: "in_progress",
        exportId,
        attempts: HUBSPOT_BACKFILL_MAX_ATTEMPTS,
        detail:
          `the export was still building after ${HUBSPOT_BACKFILL_MAX_ATTEMPTS} polls. It ` +
          `has NOT failed and no data is missing — poll this export id again shortly.`,
      };
    } finally {
      this.backfillInFlight = false;
    }
  }

  /**
   * The deals associated with one contact.
   *
   * Resolved through the object route's `associations` block rather than the
   * v4 association API, which ends support on 2027-03-30 — inside this
   * product's support horizon.
   */
  async listAssociatedDeals(contactId: string): Promise<string[]> {
    const body = await this.request(
      "listAssociatedDeals",
      hubspotPath("objects", `contacts/${contactId}`),
      { search: { associations: "deals" } },
    );
    const associations = body.associations as
      | { deals?: { results?: { id?: unknown }[] } }
      | undefined;
    return (associations?.deals?.results ?? [])
      .map((r) => (typeof r.id === "string" ? r.id : ""))
      .filter((id) => id !== "");
  }

  /**
   * Marketing emails — Marketing Hub Professional and above.
   *
   * On a Free portal this throws {@link HubSpotCapabilityUnavailableError}
   * naming the tier, rather than returning an empty list. The distinction
   * matters to the owner: "you have no marketing emails" and "your plan does
   * not include them" call for different decisions.
   */
  async listMarketingEmails(): Promise<Record<string, unknown>[]> {
    const body = await this.request("listMarketingEmails", hubspotPath("marketingEmails"));
    return Array.isArray(body.results) ? (body.results as Record<string, unknown>[]) : [];
  }

  /** Custom object schemas — Enterprise only, and gated the same way. Read
   *  only: this connector never mutates a schema. */
  async listCustomObjectSchemas(): Promise<Record<string, unknown>[]> {
    const body = await this.request("listCustomObjectSchemas", hubspotPath("objectSchemas", "schemas"));
    return Array.isArray(body.results) ? (body.results as Record<string, unknown>[]) : [];
  }

  /** Create a note against a contact. Reversible, and one of exactly two
   *  writes this connector has. */
  async createNote(
    input: { body: string; associatedContactId: string },
    opts: { confirmed?: boolean } = {},
  ): Promise<{ id: string }> {
    return this.writeEngagement(
      "notes",
      { hs_note_body: input.body, hs_timestamp: String(this.now()) },
      input.associatedContactId,
      opts,
    );
  }

  /** Create a task against a contact. The other of the two. */
  async createTask(
    input: { subject: string; associatedContactId: string; body?: string },
    opts: { confirmed?: boolean } = {},
  ): Promise<{ id: string }> {
    return this.writeEngagement(
      "tasks",
      {
        hs_task_subject: input.subject,
        hs_task_body: input.body ?? "",
        hs_timestamp: String(this.now()),
      },
      input.associatedContactId,
      opts,
    );
  }

  /**
   * The one write path.
   *
   * Order is the point: confirmation, then the writable-object allowlist, then
   * anything that touches the credential or the network. An unconfirmed write
   * therefore costs zero requests, which is what the suite asserts — a
   * confirmation gate checked after the request has gone out is not a gate.
   */
  private async writeEngagement(
    objectType: string,
    properties: Record<string, string>,
    associatedContactId: string,
    opts: { confirmed?: boolean },
  ): Promise<{ id: string }> {
    if (opts.confirmed !== true) throw new HubSpotConfirmationRequiredError(objectType);
    assertWritableHubspotObject(objectType);
    const body = await this.request(
      `create:${objectType}`,
      hubspotPath("objects", objectType),
      {
        method: "POST",
        json: {
          properties,
          associations: [
            {
              to: { id: associatedContactId },
              // Association TYPES are named, not versioned routes: this is the
              // v3 object-creation payload, so no v4 family is involved.
              types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }],
            },
          ],
        },
      },
    );
    return { id: typeof body.id === "string" ? body.id : String(body.id ?? "") };
  }

  // ── State ─────────────────────────────────────────────────────────────────

  /**
   * Map what we know onto the connection-state vocabulary.
   *
   * RESOLVES the token rather than reading whatever a previous call happened to
   * cache, so a connection that has simply never been read from does not report
   * `disconnected` while being perfectly well configured. Beyond that the state
   * is the EXPLICIT value the last exchange with HubSpot recorded — never
   * inferred from a read that returned nothing.
   */
  private async currentState(): Promise<HubSpotConnectionState> {
    try {
      await this.token();
    } catch (err) {
      // A credential that resolves but is not a private app token is a
      // reconnect, not a disconnect: someone put something there.
      if (err instanceof InvalidHubspotCredentialError) return "needs_reconnect";
      // No token resolvable = the owner has not connected a portal. Not an
      // error: it is the shipped-off state ADR-041 §2 requires.
      return "disconnected";
    }
    return this.observedState;
  }

  async status(): Promise<HubSpotStatus> {
    const state = await this.currentState();
    return {
      state,
      // One source of truth: `ok` is derived from `state` rather than computed
      // independently, so the two cannot disagree inside one returned object.
      ok: state === "connected",
      // The SMTP settings convention: report THAT a credential exists, never
      // its value. Nothing in this object can carry token material.
      hasToken: this.accessToken !== null,
      portalId: this.config.portalId,
      apiVersion: HUBSPOT_API_VERSION,
      searchRequestsPerSecond: HUBSPOT_SEARCH_MAX_REQUESTS_PER_SECOND,
      remediation: REMEDIATION_BY_STATE[state],
    };
  }

  /** The last computed schema fingerprint, or null before `introspect()`. */
  get schemaFingerprint(): string | null {
    return this.fingerprint;
  }

  // ── Value coercion ────────────────────────────────────────────────────────

  /** Parse one Search result. A row without an id or without a parseable
   *  modification stamp is dropped rather than given a default — a record
   *  stamped `0` would re-anchor the floor to the epoch. */
  private static toRecord(raw: unknown): HubSpotRecord | null {
    if (!raw || typeof raw !== "object") return null;
    const row = raw as { id?: unknown; properties?: unknown };
    const id = typeof row.id === "string" ? row.id : "";
    if (id === "") return null;
    const properties = (row.properties ?? {}) as Record<string, string | undefined>;
    const stamp = properties[LAST_MODIFIED_PROPERTY];
    const updatedAtMs =
      stamp === undefined ? NaN : /^\d+$/.test(stamp) ? Number(stamp) : Date.parse(stamp);
    if (!Number.isFinite(updatedAtMs)) return null;
    return { id, properties, updatedAtMs };
  }

  /** The next offset HubSpot offers, or undefined when the window is done. */
  private static nextAfter(body: Record<string, unknown>): string | undefined {
    const paging = body.paging as { next?: { after?: unknown } } | undefined;
    const after = paging?.next?.after;
    if (typeof after === "string" && after !== "") return after;
    if (typeof after === "number") return String(after);
    return undefined;
  }
}
