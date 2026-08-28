/**
 * WARP-2379 — `MailchimpConnector`: the audience-and-campaign track.
 *
 * Reads a small business's Mailchimp account — who is on the list, who
 * unsubscribed, what was sent and how it performed — over the Marketing API
 * `/3.0` surface, on an API key the customer creates in their own account.
 * Same {@link Connector} interface, same blocked-error contract, same
 * read-through posture as every other cloud track, so nothing upstream of it
 * changes.
 *
 * ## What makes this track different: the host is ASSEMBLED AT RUNTIME
 *
 * This is the single most important fact in this file, and it inverts where
 * the security burden sits.
 *
 * A Mailchimp key looks like `<secret>-us14`. The trailing token is not
 * decoration — it names the DATACENTER, and the API base is
 * `<dc>` + {@link MAILCHIMP_API_HOST_SUFFIX} + {@link MAILCHIMP_API_BASE_PATH}.
 * There is therefore NO single hostname to write down, and no whole-string
 * URL literal this file could carry.
 *
 * `scripts/check-egress-allowlist.py` is a static text scanner over tracked
 * source. `docs/SECURITY.md:183-185` states the limit plainly: *"the static
 * scan cannot see hostnames assembled at runtime"*. Worse, the scanner's
 * `load_allowlist()` treats a `kind: dynamic` entry as contributing **zero**
 * host patterns (it `continue`s past the `destination.hosts` collection). The
 * consequences are exact and worth stating so nobody "tidies" this later:
 *
 *   1. The `allowed-egress.yaml` entry for this connector is `kind: dynamic`
 *      with a `config_key`, per `docs/SECURITY.md:174-184`. It is DOCUMENTATION
 *      AND REVIEW, not enforcement. Filing it as `kind: egress` with a wildcard
 *      or one sampled datacenter would be worse than useless — it would produce
 *      a green `egress-gate` over a host that nothing actually constrains.
 *   2. **Nothing in CI verifies where this connector dials.** The guard below is
 *      not defence in depth; it is the ENTIRE control. That is why its tests
 *      assert on the injected `fetch` having ZERO calls rather than on a
 *      returned value — a test that inspects the outcome still passes when the
 *      request already went out carrying the customer's key.
 *   3. This file must contain no `https://…mailchimp.com` scheme-URL literal.
 *      One would be extracted by the scanner as an unregistered host and fail
 *      the gate, because the `dynamic` entry registers no hosts. The invariant
 *      SUFFIX is kept as a whole-string literal instead (bare hostnames are
 *      only scanned in config files, never in `.ts`), which is the most the
 *      scanner can be given here. `mailchimp.test.ts` pins that literal so a
 *      refactor into string concatenation cannot pass review unnoticed.
 *
 * ## The ADR-041 conditions, as they land here
 *
 *   1. **Only ever dials out.** The box accepts no inbound connections from the
 *      internet, so Mailchimp webhooks are structurally unavailable and polling
 *      is the only ingestion path. A constraint, not a preference.
 *   2. **Ships off; owner consent is the enabling event.** With no key resolved
 *      the connector blocks honestly rather than half-authenticating.
 *   3. **Every destination registered.** See above — `kind: dynamic`, and
 *      {@link assertSafeMailchimpBaseUrl} is the enforcement.
 *   4. **Persistence: none.** ADR-041 §4 warns that the encryption
 *      `ErpEntityCache` promises is NOT implemented (WARP-2028). This track is
 *      read-through and writes nothing — not `ErpEntityCache`, not
 *      `ErpSyncCursor`, not `secretRef`. Delta watermarks are RETURNED to the
 *      caller, never persisted here, precisely so this connector does not
 *      become the first writer of a model whose promises are not yet kept.
 *   5. **The key is an account-level standing credential** with no expiry.
 *      Never logged, never in a tracked file, never echoed back in an error.
 *
 * ## Rate limits: a semaphore, NOT a rate limiter
 *
 * Mailchimp documents **10 simultaneous connections per API key** and a
 * **120-second request timeout**, and documents **no requests-per-second
 * limit** at all. The widely-repeated third-party "10 requests/second" figure
 * is an UNVERIFIED MISREADING of the concurrency cap; designing against it
 * would be cargo cult and would throttle this connector for no reason. The
 * correct control is {@link MAILCHIMP_MAX_CONCURRENT_CONNECTIONS} in-flight
 * requests, which is what {@link ConnectionSemaphore} enforces.
 *
 * This is also the one vendor in this batch whose limit is **per account and
 * never pooled across our fleet** — one customer's box cannot be throttled by
 * another's, unlike an account-wide search ceiling. That is why this connector
 * needs none of the fleet-governor machinery other tracks do.
 *
 * ## Polling is asymmetric, and e-commerce is the sharp edge
 *
 * Contacts and campaigns are well served by documented delta filters (see
 * {@link MAILCHIMP_MEMBER_DELTA_PARAMS} / {@link MAILCHIMP_CAMPAIGN_DELTA_PARAMS}).
 * `/ecommerce/stores/{id}/orders` has **no date filter of any kind** — the
 * complete documented parameter set is
 * {@link MAILCHIMP_ECOMMERCE_ORDER_PARAMS}. Incremental reads on orders are
 * therefore IMPOSSIBLE, not merely unimplemented, and the dataset is declared
 * {@link MAILCHIMP_SCAN_MODE full-scan-only} so a scheduler can give it a
 * slower cadence. The active hazard is a plausible-looking delta: an invented
 * `since_created_at` would be silently ignored by the API, and the connector
 * would run a full scan while reporting an incremental one.
 *
 * ## Compliance is a build requirement here, not a legal footnote
 *
 * See {@link MAILCHIMP_API_USE_POLICY_OBLIGATIONS}. The deletion obligation is
 * discharged in code by {@link MailchimpConnector.purgeAccount}.
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
import { md5Hex } from "./md5.js";

/** Provider key for this track. */
export const MAILCHIMP_PROVIDER = "mailchimp";

/**
 * The invariant tail of every Mailchimp Marketing API host.
 *
 * A WHOLE-STRING LITERAL on purpose, and deliberately NOT a scheme URL. The
 * datacenter label in front of it is per-connection and unknowable at build
 * time, so this is the most the static egress scanner can ever be given for
 * this vendor (`docs/SECURITY.md:183-185`). Do not "clean this up" into a
 * template, a join, or a config read — and do not add a `https://us1…` example
 * literal anywhere in this directory: the `kind: dynamic` allowlist entry
 * registers no hosts, so the scanner would read one as an unregistered
 * destination and fail `egress-gate`. Examples belong in the tests, which the
 * scanner excludes by construction.
 */
export const MAILCHIMP_API_HOST_SUFFIX = ".api.mailchimp.com";

/** The pinned API surface. Whole-string literal, same reasoning as above. */
export const MAILCHIMP_API_BASE_PATH = "/3.0";

/**
 * The ONLY host shape this connector will ever send an API key to.
 *
 * Two letters and one or two digits — `us14`, `us6`, `eu1` — followed by the
 * invariant suffix, ANCHORED AT BOTH ENDS. The anchoring is the whole point:
 * an unanchored or `endsWith` check accepts `us14.api.mailchimp.com.evil.test`,
 * which is the attack this guard exists to stop.
 *
 * Built from {@link MAILCHIMP_API_HOST_SUFFIX} rather than re-typed so the
 * literal and the guard cannot drift apart.
 */
export const MAILCHIMP_ALLOWED_HOST_PATTERN = new RegExp(
  `^[a-z]{2}\\d{1,2}${MAILCHIMP_API_HOST_SUFFIX.replace(/\./g, "\\.")}$`,
);

/**
 * The datacenter token's shape, on its own.
 *
 * IDENTICAL to the label {@link MAILCHIMP_ALLOWED_HOST_PATTERN} accepts, and
 * that identity is load-bearing: the token parsed out of the key at intake
 * becomes the leftmost label of the host. If intake accepted a token the host
 * guard would not, a customer's valid key would be stored and then refused on
 * every read; if it accepted one LOOSER than the host guard, a crafted key
 * could smuggle a hostname. Keeping one shape for both makes that class of
 * drift unrepresentable.
 */
export const MAILCHIMP_DATACENTER_PATTERN = /^[a-z]{2}\d{1,2}$/;

/**
 * The credential shape accepted at intake.
 *
 * ## Why the secret half is loose and the datacenter half is strict
 *
 * Mailchimp documents the key as "a 32-character string of letters and
 * numbers, followed by a hyphen and a regional data center suffix". But the
 * vendor's OWN documented example is
 * `0123456789abcdef0123456789abcde-us6` (Fundamentals, "Api Structure") — and
 * that prefix is **31** characters, not 32. Pinning the secret half to exactly
 * `{32}` would reject the example Mailchimp itself publishes, and a false
 * rejection here blocks a paying customer's onboarding for no security gain.
 *
 * The asymmetry is deliberate and is the point of this comment: the secret half
 * NEVER becomes part of a hostname — it is presented as a password and nothing
 * else — so its length is not a security property. The datacenter half IS a
 * hostname label, so it is pinned to exactly the shape the host guard accepts.
 * Loosening {@link MAILCHIMP_DATACENTER_PATTERN} is what should be hard; the
 * character budget on an opaque secret is not worth a support ticket.
 *
 * A key with NO suffix is refused outright rather than defaulted — see
 * {@link parseMailchimpApiKey}.
 */
export const MAILCHIMP_API_KEY_PATTERN = /^([0-9A-Za-z]{20,64})-([a-z]{2}\d{1,2})$/;

/**
 * Mailchimp's documented concurrency cap, per API key.
 *
 * A SEMAPHORE, not a rate limiter. See the module docstring: there is no
 * documented requests-per-second limit, and the "10 req/s" figure that
 * circulates in third-party writeups is an unverified misreading of this
 * number. Exceeding this earns a 429; staying under it is free.
 */
export const MAILCHIMP_MAX_CONCURRENT_CONNECTIONS = 10;

/** Mailchimp's documented per-request timeout. Ours matches it exactly: a
 *  client timeout shorter than the server's would abandon work that was about
 *  to succeed, and a longer one would wedge a worker past the point the other
 *  end has already given up. */
export const MAILCHIMP_REQUEST_TIMEOUT_MS = 120_000;

/** Mailchimp's `count` ceiling. Pagination is OFFSET-ONLY — there are no
 *  cursors anywhere in this API — with the linear degradation that implies. */
export const MAILCHIMP_MAX_PAGE_SIZE = 1000;

/** Hard ceiling on pages one read may fetch, so a store that never reports a
 *  short page cannot spin forever against an offset-paginated endpoint. */
export const MAILCHIMP_MAX_PAGES = 500;

/**
 * The datasets this track can serve.
 *
 * Typed `readonly string[]` and NOT `DatasetName[]`, because none of these
 * exist in the closed six-name union at `../export-drop/profiles.ts:37-47` —
 * that vocabulary is dental and accounting, and marketing shapes do not fit
 * it. Widening that union is shared surface owned by WARP-2280; declaring the
 * names here as strings keeps this connector honest today without racing
 * another branch for the same lines.
 */
export const MAILCHIMP_DATASETS: readonly string[] = [
  "contact",
  "campaign",
  "ecommerce_order",
];

/**
 * How each dataset can be read — a DECLARED property, not an accident of the
 * code.
 *
 * `ecommerce_order` is `full_scan_only` because `/ecommerce/stores/{id}/orders`
 * exposes no date filter whatsoever (see
 * {@link MAILCHIMP_ECOMMERCE_ORDER_PARAMS}). Declaring it means a scheduler can
 * give it a much slower cadence than the delta-capable datasets, and means the
 * next engineer does not spend an afternoon hunting for a `since_*` that does
 * not exist.
 */
export const MAILCHIMP_SCAN_MODE: Readonly<Record<string, "delta" | "full_scan_only">> = {
  contact: "delta",
  campaign: "delta",
  ecommerce_order: "full_scan_only",
};

/**
 * The delta filters `/lists/{id}/members` documents.
 *
 * Passing one is what keeps the poll cheap. Omitting one does NOT fail — it
 * silently degrades into a full scan that still returns correct-looking data,
 * which is exactly why the tests assert on the outgoing REQUEST and not on the
 * rows that came back.
 */
export const MAILCHIMP_MEMBER_DELTA_PARAMS: readonly string[] = [
  "since_last_changed",
  "before_last_changed",
  "since_timestamp_opt",
  "unsubscribed_since",
];

/** The delta filters `/campaigns` documents. Same request-not-response rule. */
export const MAILCHIMP_CAMPAIGN_DELTA_PARAMS: readonly string[] = [
  "since_send_time",
  "since_create_time",
];

/**
 * The COMPLETE documented parameter set for `/ecommerce/stores/{id}/orders`.
 *
 * There is no `since_*`, no `before_*`, no modified-at and no sort-by-date in
 * this list, and their absence is the finding: incremental reads on orders are
 * impossible. Enforced at request time by
 * {@link assertEcommerceOrderParams} rather than merely asserted in a test,
 * because the failure mode is silent — Mailchimp ignores an unknown query
 * parameter, so an invented `since_created_at` would produce a full scan
 * mislabelled as a delta, with no error anywhere to notice.
 */
export const MAILCHIMP_ECOMMERCE_ORDER_PARAMS: ReadonlySet<string> = new Set([
  "store_id",
  "fields",
  "exclude_fields",
  "count",
  "offset",
  "customer_id",
  "has_outreach",
  "campaign_id",
  "outreach_id",
]);

/**
 * The complete set of API resources this connector may ever dial.
 *
 * An ALLOWLIST checked at request time by
 * {@link assertReadableMailchimpResource}, never a denylist of forbidden words
 * in source. That distinction is a rule this codebase learned the hard way on
 * the Stripe track: request paths are ASSEMBLED AT RUNTIME, so a denylist only
 * ever catches the literals someone happened to type, and a path built from a
 * route table slips straight past it.
 *
 * Campaign SENDING, audience mutation and member deletion are absent on
 * purpose. Sending a campaign is irreversible and externally visible to
 * thousands of a customer's contacts — the single worst candidate in this batch
 * for an agent-initiated action — so "destructive is blocked" is a property of
 * this set rather than an intention someone held while writing the code.
 */
export const MAILCHIMP_READABLE_RESOURCES: ReadonlySet<string> = new Set([
  "ping",
  "lists",
  "campaigns",
  "reports",
  "ecommerce",
]);

/** What this track is waiting on. Deliberately unlike the other tracks', so an
 *  installer triaging this is not sent looking for a QuickBooks company. */
export const MAILCHIMP_TRACK_REMEDIATION =
  "needs a Mailchimp Marketing API key created by the account owner at " +
  "Profile -> Extras -> API keys and pasted WHOLE, including its trailing -us14 style " +
  "datacenter suffix, stored on the integration row — and the mailchimp-marketing-api " +
  "entry in allowed-egress.yaml, since this connector leaves the customer LAN";

/**
 * The plan prerequisite, in its honest form.
 *
 * Mailchimp cut its free tier hard in June 2025 and the current documentation
 * does not say whether a Free account can still issue API calls. Every other
 * fact this connector is built on is verified; this one is NOT, so it is
 * carried as an explicit unknown rather than an optimistic assumption, and
 * {@link MailchimpConnector.probePlanAccess} turns it into an EMPIRICAL result
 * at connect time. Rewrite this string only when a real Free account has been
 * probed (WARP-2406).
 */
export const MAILCHIMP_PLAN_PREREQUISITE = "paid plan required (unverified on Free)";

/**
 * The obligations Mailchimp's API Use Policy imposes on US, recorded in-repo
 * because two of them are engineering work and one is a commercial exposure.
 *
 * This is not boilerplate we can accept and file:
 *
 *   - **Deletion on request, immediately.** *"You must immediately delete a
 *     user's data if the user requests deletion or terminates their account
 *     with you."* Discharged in code by
 *     {@link MailchimpConnector.purgeAccount} — a callable, tested path, not a
 *     promise made in prose.
 *   - **A published privacy policy** and **incident reporting to Intuit**
 *     (Mailchimp's owner). Process obligations; recorded here so they are not
 *     rediscovered at audit time.
 *   - **Audit rights over our systems and facilities.** FLAGGED FOR ROMAIN and
 *     deliberately not silently accepted. This is an unusual commitment for an
 *     on-prem product whose "systems" are appliances sitting on customers'
 *     premises — granting a vendor audit rights over hardware we do not
 *     operate is a CONTRACTUAL exposure, not a technical one, and it wants a
 *     decision before this ships rather than after.
 *
 * The policy also settles the auth question in our favour: *"You'll only access
 * the API using OAuth or an API key"* — a customer-supplied key is a sanctioned
 * integration mode here, not a workaround, which is why this track has no OAuth.
 */
export const MAILCHIMP_API_USE_POLICY_OBLIGATIONS: readonly string[] = [
  "delete a customer's Mailchimp-derived data immediately on request (purgeAccount)",
  "publish a privacy policy",
  "report security incidents to Intuit",
  "REVIEW NEEDED (Romain): the policy grants Intuit audit rights over our systems and facilities",
];

// ─────────────────────────────────────────────────────────────────────────────
// Errors — distinct classes with distinct codes, so a caller tells them apart
// without string-matching a message.
// ─────────────────────────────────────────────────────────────────────────────

/** Thrown when a connection names a destination this track will not dial. */
export class UnsafeMailchimpBaseUrlError extends Error {
  readonly code = "UNSAFE_BASE_URL";
  constructor(reason: string) {
    super(`refusing to send a Mailchimp API key there: ${reason}`);
    this.name = "UnsafeMailchimpBaseUrlError";
  }
}

/** Why a credential was refused at intake. An explicit enum, never inferred. */
export type MailchimpCredentialRejection =
  | "empty"
  | "missing_datacenter_suffix"
  | "malformed_datacenter_suffix"
  | "unrecognized";

/**
 * Thrown when a credential is not a usable Mailchimp API key.
 *
 * The message NEVER contains the offered value — a validation error that quotes
 * the credential writes it into every log line that renders the error (rule 19,
 * `apps/orchestrator/src/lib/log-redaction.ts`). Only the rejection CLASS is
 * reported, which is what the connect wizard needs to say something useful.
 */
export class InvalidMailchimpCredentialError extends Error {
  readonly code = "INVALID_MAILCHIMP_CREDENTIAL";
  constructor(readonly reason: MailchimpCredentialRejection) {
    super(`Mailchimp credential rejected (${reason}): ${CREDENTIAL_ADVICE[reason]}`);
    this.name = "InvalidMailchimpCredentialError";
  }
}

const CREDENTIAL_ADVICE: Readonly<Record<MailchimpCredentialRejection, string>> = {
  empty: "no value was supplied",
  missing_datacenter_suffix:
    "that key carries no -us14 style datacenter suffix. The suffix is not decoration: it " +
    "selects the datacenter and therefore the hostname, so a key without one is UNROUTABLE. " +
    "Copy the key again from Profile -> Extras -> API keys and paste it whole",
  malformed_datacenter_suffix:
    "the datacenter suffix is not a recognisable region code (two letters then one or two " +
    "digits, like us14 or eu1). Paste the key exactly as Mailchimp shows it",
  unrecognized: "a Mailchimp API key looks like <secret>-us14",
};

/** Thrown when only a person creating a new API key can restore the connection. */
export class MailchimpReauthorizationRequiredError extends Error {
  readonly code = "REAUTHORIZE_REQUIRED";
  constructor(readonly reason: string) {
    super(
      `Mailchimp rejected the API key (${reason}). Retrying cannot fix this — the key was ` +
        `revoked or disabled. Create a new key at Profile -> Extras -> API keys and reconnect. ` +
        `Note the key is a STANDING credential with no expiry, so revoking it in the Mailchimp ` +
        `account is what disconnects the box, immediately and completely.`,
    );
    this.name = "MailchimpReauthorizationRequiredError";
  }
}

/**
 * Thrown when the account's plan or permissions do not grant a resource.
 *
 * Its own class rather than folded into re-authorization, because the key is
 * fine and making a new one would waste the customer's time without fixing
 * anything. This is also the state a Free-plan block would surface as — and
 * surfacing it is mandatory: ADR-041's never-empty contract means a resource
 * the plan withholds must render THIS, never `[]`, which reads as "you have no
 * contacts".
 */
export class MailchimpCapabilityMissingError extends Error {
  readonly code = "CAPABILITY_MISSING";
  constructor(
    readonly resource: string,
    readonly detail: string,
  ) {
    super(
      `Mailchimp refused "${resource}" for this account (${detail}). This is a plan or ` +
        `permission limit, not a broken key — creating a new key will not change it. ` +
        `Prerequisite on record: ${MAILCHIMP_PLAN_PREREQUISITE}.`,
    );
    this.name = "MailchimpCapabilityMissingError";
  }
}

/**
 * Thrown when a request outlived Mailchimp's own 120-second timeout.
 *
 * A NAMED state, and the reason it exists: the ADR-041 contract is that none of
 * the failure states may ever render as an empty result. A timeout that
 * returned `[]` would tell the owner their audience is empty, which is both
 * false and unfalsifiable from the outside.
 */
export class MailchimpTimeoutError extends Error {
  readonly code = "REQUEST_TIMEOUT";
  constructor(
    readonly op: string,
    readonly timeoutMs: number,
  ) {
    super(
      `Mailchimp request "${op}" exceeded the ${timeoutMs}ms timeout and was abandoned. ` +
        `Reported rather than returned empty: an empty result here would read as "nothing ` +
        `to sync" when the truth is that nothing was read. Mailchimp applies the same ` +
        `120-second ceiling server-side; long reads belong on the Batch endpoint.`,
    );
    this.name = "MailchimpTimeoutError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Guards — the real enforcement, because CI cannot see this host
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Split a customer-supplied key into its secret and its datacenter, or throw —
 * before anything is persisted.
 *
 * REFUSES a key with no suffix rather than defaulting the datacenter. A default
 * would send a customer's live credential to a host that is not theirs, which
 * is the single worst outcome available in this file and is precisely what the
 * "no guessing state" rule exists to prevent. The distinction between a missing
 * suffix and a malformed one is kept because they are different paste errors
 * and want different advice.
 *
 * Returns the parts; the CALLER persists them — the datacenter into
 * `providerConfig`, the secret into `providerTokensEnc`. Nothing here writes,
 * logs or renders the key.
 */
export function parseMailchimpApiKey(raw: unknown): { secret: string; datacenter: string } {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new InvalidMailchimpCredentialError("empty");
  }
  const key = raw.trim();
  const match = MAILCHIMP_API_KEY_PATTERN.exec(key);
  if (!match) {
    // Classification is for the MESSAGE only — the pattern above is the gate,
    // so loosening it is what turns the intake test red, not this branch.
    const hyphen = key.lastIndexOf("-");
    if (hyphen === -1 || hyphen === key.length - 1) {
      throw new InvalidMailchimpCredentialError("missing_datacenter_suffix");
    }
    if (!MAILCHIMP_DATACENTER_PATTERN.test(key.slice(hyphen + 1))) {
      throw new InvalidMailchimpCredentialError("malformed_datacenter_suffix");
    }
    throw new InvalidMailchimpCredentialError("unrecognized");
  }
  return { secret: match[1], datacenter: match[2] };
}

/**
 * Assert that a stored datacenter is one this connector will build a host from.
 *
 * `providerConfig` is free-text JSON on the integration row. Nothing but this
 * stands between a tampered row and a key-carrying request to an arbitrary
 * host, so the token is re-validated on the way OUT of storage and not merely
 * on the way in.
 */
export function assertMailchimpDatacenter(raw: unknown): string {
  if (typeof raw !== "string" || !MAILCHIMP_DATACENTER_PATTERN.test(raw)) {
    throw new UnsafeMailchimpBaseUrlError(
      `"${String(raw)}" is not a Mailchimp datacenter token (expected two letters then one ` +
        `or two digits, like us14)`,
    );
  }
  return raw;
}

/**
 * Build this connection's API base, or throw. THE control for this connector.
 *
 * Exact-host equality against `<dc>` + the invariant suffix, for the `<dc>`
 * this connection stores — checked BOTH ways:
 *
 *   - the host must match {@link MAILCHIMP_ALLOWED_HOST_PATTERN}, anchored, so
 *     `us14.api.mailchimp.com.evil.test` is refused. A suffix match, an
 *     `endsWith`, or an unanchored regex would accept it.
 *   - and it must equal THIS connection's datacenter host, so a tampered
 *     `providerConfig` cannot redirect one customer's traffic to another
 *     datacenter, and an operator-supplied `baseUrl` cannot silently disagree
 *     with the key that will be sent to it.
 *
 * HTTPS only — an API key over http is the key given away. Userinfo is rejected
 * because some HTTP clients resolve `https://evil@us14.api.mailchimp.com` to a
 * different authority than a reader expects. Any port but 443 is refused
 * because that is all the egress registry contemplates.
 *
 * Called at CONSTRUCTION and again on every request build, before the request
 * object exists — so a bad destination costs zero fetch calls and never
 * touches the credential.
 */
export function assertSafeMailchimpBaseUrl(raw: string, datacenter: string): string {
  const dc = assertMailchimpDatacenter(datacenter);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeMailchimpBaseUrlError(`"${raw}" is not a URL`);
  }
  if (url.protocol !== "https:") {
    throw new UnsafeMailchimpBaseUrlError(`"${url.protocol}//" is not https`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new UnsafeMailchimpBaseUrlError("the URL carries userinfo");
  }
  const host = url.hostname.toLowerCase();
  if (!MAILCHIMP_ALLOWED_HOST_PATTERN.test(host)) {
    throw new UnsafeMailchimpBaseUrlError(`"${host}" is not a Mailchimp API host`);
  }
  const expected = `${dc}${MAILCHIMP_API_HOST_SUFFIX}`;
  if (host !== expected) {
    throw new UnsafeMailchimpBaseUrlError(
      `"${host}" is not this connection's datacenter host ("${expected}")`,
    );
  }
  // The URL parser drops an explicit :443, so any port left standing is one
  // the egress registry does not declare.
  if (url.port !== "" && url.port !== "443") {
    throw new UnsafeMailchimpBaseUrlError(
      `port ${url.port} — the egress registry allows this host on 443 only`,
    );
  }
  return `${url.protocol}//${url.host}${MAILCHIMP_API_BASE_PATH}`;
}

/**
 * Derive this connection's API base from its datacenter alone.
 *
 * The normal path: there is no operator-supplied base URL to trust, so the host
 * is built from the validated token and then re-checked by the same guard the
 * operator-supplied path uses. Building and then validating (rather than
 * trusting the construction) means one code path is under test, not two.
 */
export function mailchimpBaseUrlFor(datacenter: string): string {
  const dc = assertMailchimpDatacenter(datacenter);
  return assertSafeMailchimpBaseUrl(`https://${dc}${MAILCHIMP_API_HOST_SUFFIX}`, dc);
}

/**
 * The path segment every Mailchimp MUTATION verb lives under.
 *
 * `/campaigns/{id}/actions/send`, `/actions/schedule`, `/actions/pause`,
 * `/actions/cancel-send`, `/actions/replicate`, `/actions/test` — the whole
 * campaign-action surface is `POST` under this one segment, and NOTHING
 * readable lives there. Refusing the segment therefore costs this connector no
 * capability at all while removing the send path outright.
 *
 * This exists because a resource-level allowlist is NOT sufficient on its own:
 * `campaigns` is legitimately readable, so `/campaigns/{id}/actions/send`
 * passes a first-segment check. The repo's own Stripe lesson applies exactly
 * here — request paths are assembled at runtime, so the control has to be a
 * property of the path shape and not of the literals someone happened to type.
 */
export const MAILCHIMP_FORBIDDEN_PATH_SEGMENT = "actions";

/**
 * Refuse a path this connector may not dial.
 *
 * Two independent checks, because either alone leaves a hole:
 *
 *   1. the first segment must be in {@link MAILCHIMP_READABLE_RESOURCES}, and
 *   2. no segment may be {@link MAILCHIMP_FORBIDDEN_PATH_SEGMENT} — which is
 *      where campaign SENDING lives, under an otherwise-readable resource.
 *
 * Called at the top of every request, BEFORE the key is resolved, so an
 * off-allowlist path never reaches the network and never touches the
 * credential. An allowlist at the point of use rather than a denylist in
 * source: a denylist of forbidden words only ever catches the literals someone
 * happened to type, and every id in these paths is interpolated at runtime.
 */
export function assertReadableMailchimpResource(path: string): void {
  const rest = path.startsWith(`${MAILCHIMP_API_BASE_PATH}/`)
    ? path.slice(MAILCHIMP_API_BASE_PATH.length + 1)
    : "";
  const segments = rest.split("/").filter(Boolean);
  const resource = segments[0] ?? "";
  if (!MAILCHIMP_READABLE_RESOURCES.has(resource)) {
    throw new ConnectorBlockedError(
      `refusing to dial the Mailchimp resource "${resource}"`,
      "this connector may only read the resources named in MAILCHIMP_READABLE_RESOURCES. " +
        "Campaign sending, audience mutation and member deletion are absent from that set " +
        "on purpose — adding one is a deliberate, reviewed change, not something a new " +
        "request path can do incidentally.",
    );
  }
  if (segments.some((s) => s.toLowerCase() === MAILCHIMP_FORBIDDEN_PATH_SEGMENT)) {
    throw new ConnectorBlockedError(
      `refusing to dial a Mailchimp "/${MAILCHIMP_FORBIDDEN_PATH_SEGMENT}/" path`,
      "every Mailchimp mutation verb — send, schedule, pause, cancel-send, replicate, " +
        "test — is a POST under that segment, and nothing readable lives there. Sending a " +
        "campaign is irreversible and externally visible to thousands of a customer's " +
        "contacts, so the path is refused by shape rather than left to a resource-level " +
        "allowlist that legitimately admits `campaigns`.",
    );
  }
}

/**
 * Refuse an e-commerce order query carrying a parameter Mailchimp does not
 * document.
 *
 * The hazard is silent, which is why this is a runtime guard and not a comment:
 * Mailchimp ignores unknown query parameters, so an invented `since_created_at`
 * yields a full scan REPORTED AS a delta, with nothing anywhere to notice. A
 * subset check against the documented set turns that into a loud failure at the
 * moment the parameter is added.
 */
export function assertEcommerceOrderParams(params: Record<string, unknown>): void {
  for (const key of Object.keys(params)) {
    if (!MAILCHIMP_ECOMMERCE_ORDER_PARAMS.has(key)) {
      throw new ConnectorBlockedError(
        `"${key}" is not a documented /ecommerce/stores/{id}/orders parameter`,
        "the orders endpoint accepts only " +
          [...MAILCHIMP_ECOMMERCE_ORDER_PARAMS].sort().join(", ") +
          ". It has NO date filter of any kind, so an incremental read is impossible " +
          "rather than unimplemented — Mailchimp would silently ignore an invented " +
          "since_* and the scan would be mislabelled as a delta.",
      );
    }
  }
}

/**
 * The subscriber hash Mailchimp addresses a single member by: the MD5 of the
 * **lowercased** email address.
 *
 * Lowercasing is not a nicety. A mixed-case address hashed as typed produces a
 * 404 against a subscriber who exists — a bug that reads as MISSING DATA rather
 * than as a lookup error, which is the worst way for it to present.
 *
 * MD5 is Mailchimp's choice and is used here purely as an address derivation
 * agreed with the vendor. It authenticates nothing and protects nothing, so its
 * cryptographic weakness is not in scope; there is also no alternative, since
 * the API keys members by this exact digest.
 *
 * The digest comes from {@link md5Hex} — an arithmetic RFC 1321 implementation
 * — and DELIBERATELY NOT from `node:crypto`. MD5 is not a FIPS 140-3 approved
 * algorithm, so on a box running with `DROPLET_FIPS_MODE=1` the OpenSSL FIPS
 * provider refuses to construct it and the `node:crypto` MD5 constructor throws
 * `ERR_OSSL_EVP_UNSUPPORTED` before any request goes out. `erp-connector` ships
 * inside the `orchestrator` image, which is one of the six provider-carrying
 * images that enforce FIPS (`docs/fips.md`, "Scope — which services enforce"),
 * so a `node:crypto` digest here means a FIPS customer's member lookups fail
 * outright while list and campaign reads keep working — the connector
 * half-works, with an error that reads like a crypto bug (WARP-2460).
 */
export function subscriberHash(email: string): string {
  return md5Hex(email.trim().toLowerCase());
}

// ─────────────────────────────────────────────────────────────────────────────
// The concurrency semaphore
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A counting semaphore over in-flight requests.
 *
 * Mailchimp's documented limit is 10 SIMULTANEOUS CONNECTIONS per key, so the
 * control is a concurrency cap and not a rate limiter — see the module
 * docstring for why the circulating "10 req/s" figure must not be designed
 * against. Waiters are released strictly FIFO so a queued read cannot starve
 * behind later arrivals.
 */
export class ConnectionSemaphore {
  private inFlight = 0;
  private readonly waiters: (() => void)[] = [];
  /** The high-water mark, kept so a test can assert the cap on the TIMELINE
   *  rather than on a final count that would look identical either way. */
  private peak = 0;

  constructor(readonly limit: number = MAILCHIMP_MAX_CONCURRENT_CONNECTIONS) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`concurrency limit must be a positive integer, got ${limit}`);
    }
  }

  get peakInFlight(): number {
    return this.peak;
  }

  private async acquire(): Promise<void> {
    if (this.inFlight >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.inFlight += 1;
    if (this.inFlight > this.peak) this.peak = this.inFlight;
  }

  private release(): void {
    this.inFlight -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }

  /** Run `fn` with a slot held. The slot is released on BOTH paths — a throw
   *  that leaked a slot would shrink the effective limit to zero over time and
   *  deadlock the connector rather than fail it. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Wiring types
// ─────────────────────────────────────────────────────────────────────────────

type FetchLike = (input: string, init?: Record<string, unknown>) => Promise<Response>;

/** Resolve the API key (from the orchestrator's encrypted store). Cleartext for
 *  the life of one call only; never cached to disk here. */
export type MailchimpKeyResolver = () => Promise<string>;

/** The default resolver: nothing wired, so the track blocks honestly. */
export const blockedMailchimpKeyResolver: MailchimpKeyResolver = async () => {
  throw new ConnectorBlockedError("resolve the Mailchimp API key", MAILCHIMP_TRACK_REMEDIATION);
};

/**
 * The store the per-account purge clears.
 *
 * INJECTED rather than reached for, because this connector persists nothing
 * itself (ADR-041 §4 / WARP-2028) — whatever holds Mailchimp-derived rows is
 * the caller's, and the purge has to be able to reach caches and indexes as
 * well as tables. `deleteByConnection` is scoped by CONNECTION ID, never by
 * provider: on a box with two Mailchimp connections a provider-scoped delete
 * would destroy the other customer's data.
 */
export interface MailchimpPurgeStore {
  deleteByConnection(connectionId: string, dataset: string): Promise<number>;
}

/** Audit sink, shaped like `activity.service.ts` `record()`. Counts only. */
export type MailchimpAuditRecorder = (entry: {
  action: string;
  scope: Record<string, unknown>;
}) => Promise<void> | void;

export interface MailchimpConnectorConfig {
  /** Pointer into the encrypted secret store — NEVER a key. */
  credentialsSecretRef: string;
  /**
   * The datacenter parsed from the key AT INTAKE and persisted in
   * `providerConfig`. Read from there, never re-derived from the decrypted key
   * per request: re-parsing on every request would mean the credential has to
   * be decrypted to answer "where do we dial", and would let a key swapped
   * out-of-band silently move the destination.
   */
  datacenter: string;
  /** The connection row's id. Scopes the purge; never a provider name. */
  connectionId: string;
  /** Optional operator override. Guarded on construction, and must agree with
   *  {@link datacenter}. */
  baseUrl?: string;
}

export interface MailchimpConnectorDeps {
  fetchImpl?: FetchLike;
  now?: () => number;
  resolveApiKey?: MailchimpKeyResolver;
  timeoutMs?: number;
  semaphore?: ConnectionSemaphore;
  purgeStore?: MailchimpPurgeStore;
  audit?: MailchimpAuditRecorder;
}

/** The ADR-041 §5 connection-state vocabulary. Explicit, never inferred from a
 *  missing key — an absent value defaulted into "connected" is exactly the
 *  looks-connected-syncs-nothing failure that section exists to prevent. */
export type MailchimpConnectionState =
  | "disconnected"
  | "connected"
  | "needs_reconnect"
  | "capability_missing";

/**
 * The empirical answer to "does this account's plan allow API reads?".
 *
 * `unverified` is the SHIPPED default and a first-class value, not a null. The
 * Free-plan question (WARP-2406) is genuinely open, and a probe result that
 * defaulted to "ok" would encode an assumption this connector explicitly
 * refuses to make.
 */
export type MailchimpPlanProbe =
  | { state: "unverified"; prerequisite: string }
  | { state: "ok"; accountName: string | null; probedAt: number }
  | { state: "forbidden"; resource: string; detail: string; probedAt: number };

export interface MailchimpStatus {
  state: MailchimpConnectionState;
  ok: boolean;
  /** Whether a key resolves. NEVER the key, and never its base64 Basic-auth
   *  encoding — the SMTP settings view's `hasPassword` convention. */
  hasApiKey: boolean;
  datacenter: string;
  planProbe: MailchimpPlanProbe;
  maxConcurrentConnections: number;
  requestTimeoutMs: number;
  /** Per dataset, whether a delta read is possible at all. */
  scanModes: Readonly<Record<string, "delta" | "full_scan_only">>;
}

/** One purge run's receipt. Counts only — never a row, never an address. */
export interface MailchimpPurgeResult {
  connectionId: string;
  /** Every dataset the connector DECLARES, so the enumeration cannot drift
   *  away from what the connector actually reads. */
  datasets: readonly string[];
  deleted: Readonly<Record<string, number>>;
  totalDeleted: number;
}

/** A page of members, with the watermark the caller persists. */
export interface MailchimpMemberPage {
  rows: Record<string, unknown>[];
  /** RETURNED, never written here — see ADR-041 §4 in the module docstring. */
  watermark: string | undefined;
}

const MAILCHIMP_DATASET_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  contact: ["contact_id", "email_address", "status", "last_changed", "opt_in_time"],
  campaign: ["campaign_id", "title", "status", "send_time", "emails_sent"],
  ecommerce_order: ["order_id", "store_id", "customer_id", "order_total", "processed_at"],
};

export class MailchimpConnector implements Connector {
  readonly provider = MAILCHIMP_PROVIDER;
  readonly servesDatasets = MAILCHIMP_DATASETS;

  private readonly now: () => number;
  private readonly resolveApiKey: MailchimpKeyResolver;
  private readonly fetchImpl?: FetchLike;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly datacenter: string;
  private readonly semaphore: ConnectionSemaphore;
  private readonly purgeStore?: MailchimpPurgeStore;
  private readonly audit?: MailchimpAuditRecorder;

  private apiKey: string | null = null;
  private fingerprint: string | null = null;
  private probe: MailchimpPlanProbe = {
    state: "unverified",
    prerequisite: MAILCHIMP_PLAN_PREREQUISITE,
  };

  constructor(
    private readonly config: MailchimpConnectorConfig,
    deps: MailchimpConnectorDeps = {},
  ) {
    this.now = deps.now ?? (() => Date.now());
    this.resolveApiKey = deps.resolveApiKey ?? blockedMailchimpKeyResolver;
    this.fetchImpl = deps.fetchImpl;
    this.timeoutMs = deps.timeoutMs ?? MAILCHIMP_REQUEST_TIMEOUT_MS;
    this.semaphore = deps.semaphore ?? new ConnectionSemaphore();
    this.purgeStore = deps.purgeStore;
    this.audit = deps.audit;
    // Validated at CONSTRUCTION: a connection naming a destination we will not
    // dial should fail to build, loudly, rather than look fine until the first
    // read ships a key.
    this.datacenter = assertMailchimpDatacenter(config.datacenter);
    this.baseUrl = config.baseUrl
      ? assertSafeMailchimpBaseUrl(config.baseUrl, this.datacenter)
      : mailchimpBaseUrlFor(this.datacenter);
  }

  private blocked(op: string, detail?: string): ConnectorBlockedError {
    return new ConnectorBlockedError(
      detail ? `${op} (${detail})` : op,
      MAILCHIMP_TRACK_REMEDIATION,
    );
  }

  /** Resolve and validate the key. Validated on every resolve, not only at
   *  intake: a row edited out-of-band must not be able to put a suffix-less
   *  key on the wire. The datacenter it carries must also still agree with the
   *  one stored in `providerConfig` — a key swapped underneath us is a
   *  destination change, and this is where that is caught. */
  private async key(): Promise<string> {
    if (this.apiKey) return this.apiKey;
    const raw = await this.resolveApiKey();
    const { datacenter } = parseMailchimpApiKey(raw);
    if (datacenter !== this.datacenter) {
      throw new UnsafeMailchimpBaseUrlError(
        `the stored key's datacenter ("${datacenter}") disagrees with the connection's ` +
          `("${this.datacenter}") — refusing to dial either`,
      );
    }
    this.apiKey = raw.trim();
    return this.apiKey;
  }

  /**
   * One request.
   *
   * Order is load-bearing. The resource allowlist and the host guard both run
   * BEFORE the key is resolved and before the request object exists, so a
   * refused destination or resource costs zero fetch calls and never touches
   * the credential — which is what the tests assert on.
   */
  private async request(
    op: string,
    path: string,
    search: Record<string, string | number | undefined> = {},
  ): Promise<Record<string, unknown>> {
    assertReadableMailchimpResource(path);
    // Re-checked per request, not only at construction: `providerConfig` is
    // free-text JSON and this is the only thing standing between a tampered row
    // and a key-carrying request to an arbitrary host.
    const base = assertSafeMailchimpBaseUrl(this.baseUrl, this.datacenter);
    const apiKey = await this.key();

    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(search)) {
      if (v !== undefined) qs.set(k, String(v));
    }
    const url = `${base}${path.slice(MAILCHIMP_API_BASE_PATH.length)}${
      qs.toString() ? `?${qs}` : ""
    }`;

    const doFetch = this.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    if (!doFetch) throw this.blocked(op, "no fetch implementation available");

    // The semaphore wraps the NETWORK call only. Holding a slot across the
    // guards above would let a rejected request occupy one of the ten.
    return this.semaphore.run(async () => {
      let res: Response;
      try {
        res = await this.withTimeout(op, (signal) =>
          doFetch(url, {
            method: "GET",
            headers: {
              // HTTP Basic with any username and the key as password
              // (`anystring:apikey`) is Mailchimp's documented scheme. The key
              // is base64'd here and NOWHERE else — a shape that leaks
              // trivially into logs, so it is built inline and never stored on
              // a field (rule 19: never log a captured secret).
              Authorization: `Basic ${Buffer.from(`anystring:${apiKey}`).toString("base64")}`,
              Accept: "application/json",
            },
            // Never follow a 3xx: the fetch spec strips Authorization on
            // cross-origin redirects, but the key's safety must not rest on
            // every runtime implementing that correctly. This API has no
            // legitimate redirect, so one is a fault, not a hop.
            redirect: "error",
            signal,
          }),
        );
      } catch (err) {
        // A timeout is its OWN named state, never folded into "unreachable" and
        // never rendered as an empty result.
        if (err instanceof MailchimpTimeoutError) throw err;
        if (MailchimpConnector.isTimeout(err)) {
          throw new MailchimpTimeoutError(op, this.timeoutMs);
        }
        throw this.blocked(op, `Mailchimp API unreachable: ${(err as Error).message}`);
      }

      if (res.status === 401) {
        throw new MailchimpReauthorizationRequiredError("Mailchimp returned 401");
      }
      if (res.status === 403) {
        throw new MailchimpCapabilityMissingError(
          path,
          await MailchimpConnector.errorMessage(res),
        );
      }
      if (res.status === 429) {
        // With a semaphore of 10 this should be unreachable, so it is reported
        // rather than retried: a 429 here means the documented concurrency cap
        // is not what we think it is, and silently backing off would hide that.
        throw this.blocked(
          op,
          "Mailchimp returned 429 despite the 10-connection semaphore — the documented " +
            "concurrency cap may have changed, or another client is using this key",
        );
      }
      if (!res.ok) {
        throw this.blocked(op, `Mailchimp API returned ${res.status}`);
      }
      try {
        return (await res.json()) as Record<string, unknown>;
      } catch (err) {
        throw this.blocked(op, `unparseable Mailchimp response: ${(err as Error).message}`);
      }
    });
  }

  /**
   * Bound one call at {@link MAILCHIMP_REQUEST_TIMEOUT_MS}, belt AND braces.
   *
   * Two mechanisms, deliberately:
   *
   *   - an `AbortSignal` is passed down so a real `fetch` tears the socket
   *     down rather than leaving it open behind an abandoned promise, and
   *   - the call is RACED against our own timer, so the deadline holds even
   *     when the fetch implementation ignores the signal.
   *
   * The second is not paranoia about hypotheticals: it is what makes the
   * deadline OURS rather than a delegated hope. A connector whose only timeout
   * lives inside `fetch` cannot promise anything about a client that does not
   * honour `signal`, and the ADR-041 contract here is that a stalled request
   * surfaces as {@link MailchimpTimeoutError} — never as an empty result, and
   * never as a promise that simply never settles.
   *
   * The timer is always cleared, so a fast response leaves no handle holding
   * the event loop open.
   */
  private async withTimeout<T>(op: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new MailchimpTimeoutError(op, this.timeoutMs));
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

  private static async errorMessage(res: Response): Promise<string> {
    try {
      const body = (await res.json()) as { detail?: string; title?: string };
      return body?.detail ?? body?.title ?? `HTTP ${res.status}`;
    } catch {
      return `HTTP ${res.status}`;
    }
  }

  /**
   * Page an offset-paginated collection.
   *
   * Mailchimp has NO cursors anywhere — `count` and `offset` are the whole
   * mechanism, and offset paging degrades linearly as the offset grows. That is
   * tolerable for the delta datasets precisely because the filters keep result
   * sets small; it is the standing cost of the e-commerce full scan.
   */
  private async page(
    op: string,
    path: string,
    collection: string,
    search: Record<string, string | number | undefined>,
    pageSize: number,
  ): Promise<Record<string, unknown>[]> {
    const count = Math.min(Math.max(1, Math.trunc(pageSize)), MAILCHIMP_MAX_PAGE_SIZE);
    const rows: Record<string, unknown>[] = [];
    let offset = 0;

    for (let page = 1; ; page += 1) {
      if (page > MAILCHIMP_MAX_PAGES) {
        throw new ConnectorBlockedError(
          `${op} stopped after ${MAILCHIMP_MAX_PAGES} pages`,
          "the endpoint kept returning full pages; aborting rather than paging forever " +
            "against an offset-only API whose cost grows with the offset.",
        );
      }
      const body = await this.request(op, path, { ...search, count, offset });
      const data = body[collection];
      if (data != null && !Array.isArray(data)) {
        throw new ConnectorBlockedError(
          `${op} returned a non-array \`${collection}\` (${typeof data})`,
          "Mailchimp's response did not match the documented list contract. Refusing to " +
            "interpret it rather than guessing at a shape.",
        );
      }
      const list = (data ?? []) as Record<string, unknown>[];
      rows.push(...list);
      // A short page is the ONLY termination signal an offset API offers.
      if (list.length < count) return rows;
      offset += list.length;
    }
  }

  // ── Connector interface ───────────────────────────────────────────────────

  /**
   * Open the connection and PROBE the plan, rather than assume it.
   *
   * `/ping` is the cheapest authenticated read Mailchimp offers and proves
   * three things at once: the key works, egress to this datacenter is
   * permitted, and the account's plan grants API access at all. The last of
   * those is the open question (WARP-2406), so its answer is recorded as an
   * explicit {@link MailchimpPlanProbe} result — never inferred from the
   * absence of an error.
   */
  async connect(): Promise<void> {
    await this.probePlanAccess();
    this.fingerprint = computeSchemaFingerprint(this.tables());
  }

  /**
   * Empirically establish whether this account's plan permits API reads.
   *
   * Partial answers are FIRST CLASS: a key that authenticates but is refused on
   * some resources is a different finding from one that cannot read anything,
   * and both change the customer's setup guide differently. A 403 becomes
   * {@link MailchimpCapabilityMissingError} — never an empty result, which
   * would read as "this account has no data".
   */
  async probePlanAccess(): Promise<MailchimpPlanProbe> {
    try {
      const body = await this.request("probePlanAccess", `${MAILCHIMP_API_BASE_PATH}/ping`);
      const name = body.health_status;
      this.probe = {
        state: "ok",
        accountName: typeof name === "string" ? name : null,
        probedAt: this.now(),
      };
    } catch (err) {
      if (err instanceof MailchimpCapabilityMissingError) {
        this.probe = {
          state: "forbidden",
          resource: err.resource,
          detail: err.detail,
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
    // Derived from the same explicit state `status()` reports, not from
    // whichever fields happen to be populated.
    const state = await this.state();
    if (state === "needs_reconnect") {
      throw new MailchimpReauthorizationRequiredError("the stored API key is not usable");
    }
    if (state === "capability_missing") {
      const p = this.probe as Extract<MailchimpPlanProbe, { state: "forbidden" }>;
      throw new MailchimpCapabilityMissingError(p.resource, p.detail);
    }
    if (state === "disconnected") {
      throw this.blocked("health", "no Mailchimp account is connected");
    }
    return { ok: true };
  }

  /** The canonical shape this track serves. Synthesized rather than
   *  introspected: Mailchimp's schema is Mailchimp's, published and stable, so
   *  there is nothing to discover — but the fingerprint still has to exist so
   *  drift-freeze semantics stay coherent across every track. */
  private tables(): IntrospectedTable[] {
    return MAILCHIMP_DATASETS.map((dataset) => ({
      name: dataset,
      owner: MAILCHIMP_PROVIDER,
      // NOT from `CANONICAL_COLUMNS`: none of these dataset names exist in the
      // closed `DatasetName` union yet (WARP-2280), so indexing it would be a
      // lie the type system cannot catch.
      columns: (MAILCHIMP_DATASET_COLUMNS[dataset] ?? []).map((name) => ({
        name,
        type: "text",
      })),
    }));
  }

  async introspect(): Promise<IntrospectionResult> {
    const tables = this.tables();
    const fingerprint = computeSchemaFingerprint(tables);
    this.fingerprint = fingerprint;
    return { tables, fingerprint };
  }

  /**
   * Named reads route through the shared registry like every other track.
   *
   * No Mailchimp read query is registered yet — tools-core registration is
   * deferred to the provider-descriptor work (WARP-2410), exactly as the Stripe
   * track deferred its own. Until then an unknown name raises
   * `UnknownReadQueryError` and a known name whose dataset this track does not
   * serve raises `DatasetNotServedError`, both of which are honest. The
   * marketing surface is reached through the named methods below.
   */
  async runRead(name: string, _params: Record<string, unknown>): Promise<unknown[]> {
    const query = getReadQuery(name);
    assertDatasetsServed(this.provider, this.servesDatasets, name, query.dependsOnTables);
    throw this.blocked(
      `runRead:${name}`,
      "the Mailchimp track serves its datasets through its named read methods until the " +
        "read registry carries marketing queries (WARP-2410)",
    );
  }

  async applyWrite(name: string, _params: Record<string, unknown>): Promise<unknown> {
    // Same validation order as every other track, so a caller bug produces the
    // same typed error here as anywhere else...
    const cmd = getWriteCommand(name);
    assertTargetAllowed(cmd.targetTable);
    // ...and then this track refuses. Campaign sending is irreversible and
    // externally visible to thousands of a customer's contacts; audience
    // mutation and member deletion are equally one-way. None of them is a later
    // ticket — they are absent by design, and the test suite fails the build if
    // a send or mutate surface appears.
    throw this.blocked(
      `applyWrite:${name}`,
      "the Mailchimp track is read-only — no send-campaign, audience-mutation or " +
        "member-delete surface exists in this connector at any tier",
    );
  }

  // ── Marketing surface ─────────────────────────────────────────────────────

  /**
   * Members of one audience, incrementally.
   *
   * Every documented delta filter is passed through verbatim
   * ({@link MAILCHIMP_MEMBER_DELTA_PARAMS}). Omitting one would not fail — it
   * would silently become a full scan returning correct-looking rows — which is
   * why the tests assert the filter is on the outgoing URL.
   */
  async listMembers(
    listId: string,
    filters: {
      sinceLastChanged?: string;
      beforeLastChanged?: string;
      sinceTimestampOpt?: string;
      unsubscribedSince?: string;
      pageSize?: number;
    } = {},
  ): Promise<MailchimpMemberPage> {
    const rows = await this.page(
      "listMembers",
      `${MAILCHIMP_API_BASE_PATH}/lists/${encodeURIComponent(listId)}/members`,
      "members",
      {
        since_last_changed: filters.sinceLastChanged,
        before_last_changed: filters.beforeLastChanged,
        since_timestamp_opt: filters.sinceTimestampOpt,
        unsubscribed_since: filters.unsubscribedSince,
      },
      filters.pageSize ?? MAILCHIMP_MAX_PAGE_SIZE,
    );
    // The watermark is RETURNED, never persisted here (ADR-041 §4).
    let watermark: string | undefined;
    for (const r of rows) {
      const t = r.last_changed;
      if (typeof t === "string" && (watermark === undefined || t > watermark)) watermark = t;
    }
    return { rows, watermark };
  }

  /**
   * One member, addressed by the MD5 of the LOWERCASED email address.
   *
   * See {@link subscriberHash}: hashing the address as typed 404s against a
   * subscriber who exists, and presents as missing data rather than as a lookup
   * error.
   */
  async getMember(listId: string, email: string): Promise<Record<string, unknown>> {
    return this.request(
      "getMember",
      `${MAILCHIMP_API_BASE_PATH}/lists/${encodeURIComponent(listId)}/members/${subscriberHash(email)}`,
    );
  }

  /** Campaigns, incrementally, on the documented send/create filters. */
  async listCampaigns(
    filters: { sinceSendTime?: string; sinceCreateTime?: string; pageSize?: number } = {},
  ): Promise<Record<string, unknown>[]> {
    return this.page(
      "listCampaigns",
      `${MAILCHIMP_API_BASE_PATH}/campaigns`,
      "campaigns",
      {
        since_send_time: filters.sinceSendTime,
        since_create_time: filters.sinceCreateTime,
      },
      filters.pageSize ?? MAILCHIMP_MAX_PAGE_SIZE,
    );
  }

  /**
   * Every order in a store — a FULL SCAN, always, by necessity.
   *
   * `/ecommerce/stores/{id}/orders` has no date filter of any kind, so this
   * cannot be incremental. The signature deliberately exposes NO `since*`
   * option: an incremental read is impossible here rather than unimplemented,
   * and offering a parameter that the API would silently ignore is how a full
   * scan comes to be reported as a delta.
   *
   * Every scan is idempotent — orders are keyed by their own id and nothing is
   * persisted here — so a re-run costs time, not correctness. The cost is real
   * though: offset paging over a long order history is paid in full every
   * cycle, which is why {@link MAILCHIMP_SCAN_MODE} marks this dataset so a
   * scheduler can slow it down.
   */
  async listEcommerceOrders(
    storeId: string,
    options: { customerId?: string; campaignId?: string; pageSize?: number } = {},
  ): Promise<Record<string, unknown>[]> {
    const search: Record<string, string | undefined> = {
      customer_id: options.customerId,
      campaign_id: options.campaignId,
    };
    // Guard the DECLARED parameters before anything is sent, so an invented
    // date filter is a loud failure and not a silent full scan.
    assertEcommerceOrderParams(
      Object.fromEntries(Object.entries(search).filter(([, v]) => v !== undefined)),
    );
    return this.page(
      "listEcommerceOrders",
      `${MAILCHIMP_API_BASE_PATH}/ecommerce/stores/${encodeURIComponent(storeId)}/orders`,
      "orders",
      search,
      options.pageSize ?? MAILCHIMP_MAX_PAGE_SIZE,
    );
  }

  // ── Compliance ────────────────────────────────────────────────────────────

  /**
   * Delete every locally-persisted Mailchimp record for THIS connection.
   *
   * Mailchimp's API Use Policy: *"You must immediately delete a user's data if
   * the user requests deletion or terminates their account with you."* That is
   * an obligation that has to exist as code, so this is a callable, tested path
   * rather than a promise in prose.
   *
   * Two properties matter and both are tested:
   *
   *   - **Scoped by connection id, never by provider.** On a box with two
   *     Mailchimp connections a provider-scoped delete destroys the other
   *     customer's data. This is the subtle failure the test exists to catch.
   *   - **The enumeration is DERIVED from {@link servesDatasets}**, not a
   *     hand-maintained list. A dataset added to the connector is purged by
   *     construction; a hand-kept list would drift and leave data behind while
   *     still reporting success.
   *
   * The audit row carries COUNTS ONLY. No address, no subscriber content, no
   * campaign text ever reaches the activity trail.
   */
  async purgeAccount(): Promise<MailchimpPurgeResult> {
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
    const result: MailchimpPurgeResult = {
      connectionId: this.config.connectionId,
      datasets: this.servesDatasets,
      deleted,
      totalDeleted,
    };
    await this.audit?.({
      action: "mailchimp.purge_account",
      scope: {
        connectionId: this.config.connectionId,
        provider: MAILCHIMP_PROVIDER,
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
   * Order matters: an unusable key outranks a plan limit, because replacing the
   * key is the only action that helps and upgrading a plan would not.
   */
  private async state(): Promise<MailchimpConnectionState> {
    try {
      await this.key();
    } catch (err) {
      // No key resolvable = the owner has not connected an account. Not an
      // error: it is the shipped-off state ADR-041 §2 requires.
      if (err instanceof InvalidMailchimpCredentialError) return "needs_reconnect";
      if (err instanceof UnsafeMailchimpBaseUrlError) return "needs_reconnect";
      return "disconnected";
    }
    if (this.probe.state === "forbidden") return "capability_missing";
    return "connected";
  }

  async status(): Promise<MailchimpStatus> {
    const state = await this.state();
    return {
      state,
      // One source of truth: `ok` is derived from `state` rather than computed
      // independently, so the two cannot disagree inside one returned object.
      ok: state === "connected",
      // Report THAT a credential exists, never its value and never its base64
      // Basic-auth encoding. Nothing in this object can carry key material.
      hasApiKey: this.apiKey !== null,
      datacenter: this.datacenter,
      planProbe: this.probe,
      maxConcurrentConnections: this.semaphore.limit,
      requestTimeoutMs: this.timeoutMs,
      scanModes: MAILCHIMP_SCAN_MODE,
    };
  }

  /** The last computed schema fingerprint, or null before `introspect()`. */
  get schemaFingerprint(): string | null {
    return this.fingerprint;
  }
}
