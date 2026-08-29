/**
 * WARP-2215 — `StripeConnector`: the payments track.
 *
 * Reads a merchant's Stripe account over Stripe's REST API on a restricted key
 * the merchant creates themselves. Same `Connector` interface, same read
 * registry, same blocked-error contract as every other track, so nothing
 * upstream of it changes.
 *
 * ## What makes this track different
 *
 * **It is a CLOUD CONNECTOR under ADR-041**, and it is built to the same five
 * conditions the QuickBooks Online track is (see
 * `../quickbooks/online-connector.ts` for the worked statement of them):
 *
 *   1. **Only ever dials out.** Webhooks are structurally unavailable to us —
 *      the box accepts no inbound connections from the internet — so the
 *      `/v1/events` cursor poller is the ONLY ingestion path. That is a
 *      constraint, not a preference, and it is why the poller carries as much
 *      care as it does.
 *   2. **Ships off; owner consent is the enabling event.** With no key
 *      resolved the connector blocks honestly rather than half-authenticating.
 *   3. **Every destination registered.** This track dials TWO hosts, each with
 *      its own `docs/security/allowed-egress.yaml` entry and its own security
 *      review: `api.stripe.com` (`stripe-api`, WARP-2215) for the ordinary and
 *      Reporting APIs, and `files.stripe.com` (`stripe-report-files`,
 *      WARP-2450) for a finished report run's CSV. They are guarded by two
 *      SEPARATE exact-match sets — {@link STRIPE_ALLOWED_API_HOSTS} and
 *      {@link STRIPE_ALLOWED_FILE_HOSTS} — rather than one merged set, so the
 *      file host can never be used as an API base or the reverse, and nothing
 *      the registry has not screened is dialable either way.
 *   4. **Persistence: none.** ADR-041 §4 warns that the encryption
 *      `ErpEntityCache` promises is NOT implemented (WARP-2028). This track is
 *      therefore read-through and writes nothing — not `ErpEntityCache`, not
 *      `ErpSyncCursor`, not `secretRef`. The event cursor is RETURNED to the
 *      caller ({@link StripeEventPollResult.cursor}) rather than persisted
 *      here, precisely so this connector does not become the first writer of a
 *      model whose promises are not yet kept.
 *   5. **The key is an account-level credential.** Never logged, never in a
 *      tracked file, and never echoed back in an error — see
 *      {@link assertStripeRestrictedKey}.
 *
 * ## Auth is a restricted key, and that is contractual
 *
 * Not OAuth. Stripe's OAuth has no PKCE, and Connect's `read_only` scope is
 * Extensions-only. What Stripe documents for exactly our shape is the
 * restricted API key: *"If customers self-host your integration, Stripe Apps
 * using the restricted API key authentication method is likely the best fit.
 * It doesn't require you to store your secret key on untrusted servers."*
 *
 * Stripe's September 2024 plugin-security rule is that businesses give you
 * restricted keys prefixed `rk_`, **not** `sk_`. So a secret key is REFUSED at
 * intake rather than accepted and hoped about — {@link assertStripeRestrictedKey}.
 *
 * ## The binding constraint is the read ALLOCATION, not the request rate
 *
 * Global rate is 100 req/s and irrelevant to us. The account rule is what
 * shapes this connector: read API requests must average under 500 per
 * transaction over a rolling 30 days, and *"every account, regardless of
 * transaction count, has a minimum allocation of 10,000 read requests per
 * month."*
 *
 * The arithmetic decides the design:
 *
 *   |  poll  | requests/month on ONE endpoint | share of the 10,000 floor |
 *   |--------|--------------------------------|---------------------------|
 *   |   60 s | ~43,200                        | **432%** — 4x over        |
 *   |  300 s | ~8,640                         | 86%                       |
 *   |  900 s | ~2,880                         | 29%                       |
 *
 * 900 s is therefore the design FLOOR and it is enforced in code
 * ({@link assertStripePollIntervalSeconds}), not documented as a convention.
 * The interval is only a default, though; {@link ReadAllocationMeter} is the
 * authority, because a busy merchant's 500-per-transaction average gives far
 * more headroom than the floor and a quiet one gets exactly the floor.
 *
 * Bulk history does NOT come out of that allocation: Stripe excludes the
 * Reporting API from it, so backfill routes through report runs
 * ({@link StripeConnector.runBackfill}).
 *
 * ## Four failure states that must never be confused
 *
 * QBO has three; this deployment shape needs a fourth. None of them may ever
 * render as an empty result — `[]` from a payments read is a confident false
 * statement about money.
 *
 *   QUOTA_EXHAUSTED       out of read allocation this period. Nothing is
 *                         broken; reads resume next period.
 *   REAUTHORIZE_REQUIRED  the key was revoked or is invalid. A person must
 *                         create a new restricted key. Retrying cannot help.
 *   STRIPE_ACCESS_POLICY  the key carries an IP/ASN access policy that no
 *                         longer matches this appliance. Stripe RECOMMENDS
 *                         merchants set these, and the box sits behind an
 *                         SMB's dynamic WAN IP — so the day the ISP re-leases
 *                         that address, every call 403s. Expected, not exotic,
 *                         and it gets its own class because the remedy is a
 *                         specific Workbench screen rather than a new key.
 *   CONNECTOR_BLOCKED     not configured, or Stripe is unreachable.
 *
 * ## No money movement, at any tier
 *
 * No refunds, no transfers, no payouts. Not "later" — not in this connector.
 * Reading a charge is enough to SEE a refund; issuing one is deliberately
 * absent, and `__tests__/stripe.test.ts` fails the build if a path or a method
 * matching those ever appears in this directory. "We didn't build it" is not
 * enforceable; a red build is.
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
import { CANONICAL_COLUMNS, type DatasetName } from "../export-drop/profiles.js";

/** Provider key for this track. */
export const STRIPE_PROVIDER = "stripe";

/**
 * Stripe's API base.
 *
 * Kept as a WHOLE-STRING LITERAL on purpose, following the QuickBooks
 * precedent at `../quickbooks/online-connector.ts:100-113`. Do not "clean this
 * up" into a template string, a joined constant, or a config read:
 * `scripts/check-egress-allowlist.py` is a static text scanner over tracked
 * source (`docs/SECURITY.md:183-185`) and can only extract a hostname it can
 * literally see. Assembling the host at runtime silently blinds the egress
 * gate while leaving the code working, which is the worst of both.
 *
 * This host covers every API call the connector makes: the ordinary API and
 * the Reporting API both live here, and there is no token endpoint because
 * there is no OAuth dance — a restricted key is presented directly. It does
 * NOT cover a finished report run's FILE, which Stripe serves from
 * {@link STRIPE_FILES_BASE_URL}.
 */
export const STRIPE_PRODUCTION_BASE_URL = "https://api.stripe.com";

/**
 * Where Stripe serves a finished report run's contents.
 *
 * A genuinely different host from the API, and the reason WARP-2215 shipped
 * `runBackfill` stopping at the file reference: `docs/security/
 * allowed-egress.yaml` is `policy.default: deny`, WARP-2216's acceptance
 * criterion pins the `stripe-api` entry to exactly `[api.stripe.com]`, and
 * dialing an unregistered host is not something a connector may do quietly.
 * It now has its OWN registry entry (`stripe-report-files`, WARP-2450) with
 * its own security review, which is the correct way to add a destination.
 *
 * A WHOLE-STRING LITERAL for the same reason the API base is one:
 * `scripts/check-egress-allowlist.py` is a static text scanner over tracked
 * source and can only bind a hostname it literally sees. Do not compose this
 * from parts.
 */
export const STRIPE_FILES_BASE_URL = "https://files.stripe.com";

/**
 * The pinned API version, sent on EVERY request.
 *
 * A restricted key carries no API version of its own. A request without an
 * explicit `Stripe-Version` header is served at the MERCHANT's account default
 * version — a value they can change at any time from the Stripe Workbench,
 * without telling us. That is a silent, remote, third-party-controlled schema
 * change applied to every response this box parses. One header per request is
 * the entire mitigation.
 *
 * This is the ONLY place the version string is written. Upgrading the pin is a
 * deliberate PR with its own test run — never a runtime read, and never an
 * implicit follow of whatever the merchant last clicked. `stripe.test.ts`
 * asserts that no second version literal exists anywhere in this directory.
 */
export const STRIPE_API_VERSION = "2026-08-26.dahlia";

/**
 * The only hosts this connector will send a restricted key to — EXACTLY these,
 * never a suffix match.
 *
 * `baseUrl` is operator configuration living in `IntegrationConnection.
 * providerConfig`, which is free-text JSON. Nothing but this guard stands
 * between a tampered row and a key-carrying request to an arbitrary host, so
 * the check is an exact-set membership test derived from the published base
 * URL literal above. A suffix match would have accepted `api.stripe.evil.com`.
 */
export const STRIPE_ALLOWED_API_HOSTS: ReadonlySet<string> = new Set(
  [STRIPE_PRODUCTION_BASE_URL].map((u) => new URL(u).hostname),
);

/**
 * The only hosts a report FILE will be downloaded from — a SIBLING set, not a
 * widening of the API set.
 *
 * Two sets rather than one merged set is deliberate. Merging them would let an
 * operator point `baseUrl` at the report-file host and have the ordinary
 * API guard wave it through, or the reverse; each guard should admit exactly
 * the host its registry entry screened and nothing else. It also keeps
 * WARP-2216's acceptance criterion — `stripe-api` pinned to exactly
 * `api.stripe.com` — visibly true in code as well as in the yaml.
 */
export const STRIPE_ALLOWED_FILE_HOSTS: ReadonlySet<string> = new Set(
  [STRIPE_FILES_BASE_URL].map((u) => new URL(u).hostname),
);

/**
 * The restricted-key shape Stripe's plugin-security rule mandates.
 *
 * This single pattern is the ONLY gate — the `sk_`/`pk_` classification below
 * exists to write a useful message, never to decide the outcome. Keeping one
 * gate means loosening this regex is what turns the intake test red, which is
 * the mutation the ticket names.
 */
export const STRIPE_RESTRICTED_KEY_PATTERN = /^rk_(live|test)_/;

/** The read-allocation floor Stripe guarantees every account, per month. */
export const STRIPE_DEFAULT_MONTHLY_READ_ALLOCATION = 10_000;

/** The enforced minimum scheduled poll interval. See the module docstring's table. */
export const STRIPE_MIN_POLL_INTERVAL_SECONDS = 900;

/**
 * How far behind wall clock the event cursor is held.
 *
 * Same-second events on `/v1/events` are eventually consistent: a cursor set
 * to `now` misses records that materialise microseconds later, and they are
 * never seen again because the next poll starts after them. Lagging the window
 * absorbs that at the cost of re-reading a few seconds, which the idempotent
 * object-id keying makes free.
 */
export const STRIPE_EVENT_CURSOR_LAG_MS = 5_000;

/**
 * The `/v1/events` type filter used to recover an invoice's modification time
 * (WARP-2494). Stripe documents `type` as "a specific event name, or group of
 * events using * as a wildcard", so this is one server-side filter rather than
 * an enumeration this file would have to keep in step with Stripe's event
 * catalogue - a missed member of such a list reads as "that invoice never
 * changed", which is the failure `updated_at` exists to prevent.
 */
export const STRIPE_INVOICE_EVENT_TYPE = "invoice.*";

/** `/v1/events` retention. A gap wider than this cannot be closed by any cursor. */
export const STRIPE_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Hard ceiling on pages one list read may fetch. Each page is one metered read. */
export const STRIPE_MAX_PAGES = 50;

/** Attempts a report run is polled for before the caller is told it is still running. */
export const STRIPE_BACKFILL_MAX_ATTEMPTS = 6;

/** First backoff step; doubles per attempt. Stripe documents no `Retry-After`. */
export const STRIPE_BACKOFF_BASE_MS = 500;

/** Retries for a 429 before the read is reported as blocked. */
export const STRIPE_MAX_RATE_LIMIT_RETRIES = 3;

/**
 * The datasets a Stripe account can serve.
 *
 * `invoice` only, and the absence of the rest is a capability statement rather
 * than a gap: Stripe has no bills (it is not an accounts-payable system) and
 * no appointments or patients. Balance transactions are richer than any
 * existing canonical dataset and are served through
 * {@link StripeConnector.listBalanceTransactions} rather than shoehorned into
 * one; giving them their own `DatasetName` means widening the closed union in
 * `../export-drop/profiles.ts`, which is shared surface and belongs with the
 * tool-registration ticket (WARP-2293), not here.
 *
 * WARP-2280 typed this `readonly DatasetName[]` rather than `readonly
 * string[]`. The looser type was only ever a workaround for a six-name union
 * that could not express what this track serves; `invoice` is in the twenty,
 * so the annotation now costs nothing and buys the guarantee
 * `vocabulary-contract.ts` asserts — a connector cannot declare a dataset
 * outside the vocabulary. Note this does NOT widen what Stripe serves: the
 * balance-transaction case above is unchanged and still waits on WARP-2293.
 */
/**
 * WARP-2497 — `charge` joins `invoice`.
 *
 * The docstring above was written when the vocabulary held six names and the
 * payments datasets did not exist; WARP-2280 has since added them, and
 * `get_recent_charges` has been a registered read query with canonical columns
 * ever since. What was still missing was this declaration, and its absence was
 * load-bearing in the worst way: `assertDatasetsServed` refused the read before
 * a request was built, so a merchant with a CONNECTED account and a full charge
 * history got "the stripe track does not serve charge" for "what did we bill
 * last week". The dataset was reachable everywhere except here.
 *
 * ONLY `charge` is added. `refund` and `payout` also have read queries and
 * vocabulary entries, but neither `refunds` nor `payouts` is an ordinary
 * readable collection on this track (`STRIPE_READABLE_COLLECTIONS` —
 * `payouts` appears solely as a REPORT family), and `balance_transaction` and
 * `subscription` need projection decisions of their own. Widening those is a
 * capability change with its own tests, not a side effect of registering a
 * tool, so they still refuse — asserted in stripe.test.ts.
 */
export const STRIPE_DATASETS: readonly DatasetName[] = ["invoice", "charge"];

/**
 * What this track is waiting on. Deliberately unlike the other tracks', so an
 * installer triaging this is not sent looking for a QuickBooks company or a
 * folder full of CSVs.
 */
export const STRIPE_TRACK_REMEDIATION =
  "needs a Stripe restricted API key (rk_live_… or rk_test_…, created by the merchant in " +
  "their own Stripe Workbench with the required resources set to Read) stored on the " +
  "integration row, and both api.stripe.com and files.stripe.com allowed in " +
  "allowed-egress.yaml — this connector leaves the customer LAN";

/**
 * The remediation for a key whose IP/ASN access policy no longer matches this
 * box. Rendered verbatim to the merchant, so it names the screen rather than
 * the symptom.
 */
export const STRIPE_IP_POLICY_REMEDIATION =
  "this Stripe restricted key has an IP access policy that no longer matches this " +
  "appliance's public address — your ISP most likely re-leased it. Update the key's IP " +
  "access policy in the Stripe Workbench (Developers → API keys → the key → IP " +
  "restrictions), or remove the restriction. Nothing on the box needs changing and no " +
  "new key is required.";

// ─────────────────────────────────────────────────────────────────────────────
// Errors — four distinct classes with four distinct codes, so a caller can
// tell them apart without string-matching a message.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Thrown when a connection names a destination this track will not dial.
 *
 * Named for the track (rather than a bare `UnsafeBaseUrlError`) because the
 * QuickBooks and Dentrix tracks each already export one, and a package with
 * three same-named error classes cannot re-export them all — see
 * `UnsafeAscendBaseUrlError` for the same precedent.
 */
export class UnsafeStripeBaseUrlError extends Error {
  readonly code = "UNSAFE_BASE_URL";
  constructor(reason: string) {
    super(`refusing to send a Stripe restricted key there: ${reason}`);
    this.name = "UnsafeStripeBaseUrlError";
  }
}

/** Why a credential was refused at intake. An explicit enum, never inferred. */
export type StripeCredentialRejection =
  | "empty"
  | "secret_key"
  | "publishable_key"
  | "unrecognized";

/**
 * Thrown when a credential is not a Stripe restricted key.
 *
 * The message NEVER contains the offered value. A validation error that quotes
 * the credential writes it into every log line that renders the error — rule
 * 19. Only the detected prefix CLASS is reported, which is what the wizard
 * needs to say something useful.
 */
export class InvalidStripeCredentialError extends Error {
  readonly code = "INVALID_STRIPE_CREDENTIAL";
  constructor(readonly reason: StripeCredentialRejection) {
    super(`Stripe credential rejected (${reason}): ${CREDENTIAL_ADVICE[reason]}`);
    this.name = "InvalidStripeCredentialError";
  }
}

const CREDENTIAL_ADVICE: Readonly<Record<StripeCredentialRejection, string>> = {
  empty: "no value was supplied",
  secret_key:
    "that looks like a SECRET key. Stripe requires integrations to be given a " +
    "RESTRICTED key instead — create one in the Workbench and set only the resources " +
    "this connector reads to Read",
  publishable_key:
    "that looks like a PUBLISHABLE key, which cannot read account data. Create a " +
    "restricted key in the Workbench instead",
  unrecognized: "a Stripe restricted key starts with rk_live_ or rk_test_",
};

/** Thrown when this period's read allocation is gone. NOT a fault. */
export class StripeQuotaExhaustedError extends Error {
  readonly code = "QUOTA_EXHAUSTED";
  constructor(
    readonly spent: number,
    readonly ceiling: number,
  ) {
    super(
      `Stripe read allocation exhausted: ${spent}/${ceiling} reads used this period. ` +
        `Reads resume next period; nothing is broken and no data is lost. Bulk history ` +
        `does not come out of this allocation — use the Reporting API backfill.`,
    );
    this.name = "StripeQuotaExhaustedError";
  }
}

/** Thrown when only a person creating a new restricted key can restore the connection. */
export class StripeReauthorizationRequiredError extends Error {
  readonly code = "REAUTHORIZE_REQUIRED";
  constructor(readonly reason: string) {
    super(
      `Stripe rejected the restricted key (${reason}). Retrying cannot fix this — the ` +
        `key was revoked, expired or never had the required Read permissions. Create a ` +
        `new restricted key in the Stripe Workbench and reconnect. Note that a LIVE key's ` +
        `value is shown exactly once, so a lost key is a re-create, never a re-read.`,
    );
    this.name = "StripeReauthorizationRequiredError";
  }
}

/**
 * Thrown when Stripe refuses the call in a way consistent with the key's
 * IP/ASN access policy.
 *
 * Deliberately NOT folded into {@link StripeReauthorizationRequiredError}: the
 * key is fine, the permissions are fine, and telling the merchant to make a
 * new key would waste their time and not fix it.
 */
export class StripeAccessPolicyError extends Error {
  readonly code = "STRIPE_ACCESS_POLICY";
  readonly remediation = STRIPE_IP_POLICY_REMEDIATION;
  constructor(readonly detail: string) {
    super(`Stripe refused this appliance's address: ${detail}. ${STRIPE_IP_POLICY_REMEDIATION}`);
    this.name = "StripeAccessPolicyError";
  }
}

/** Thrown when a configured poll interval is below the enforced floor. */
export class StripePollIntervalError extends Error {
  readonly code = "POLL_INTERVAL_TOO_SHORT";
  constructor(readonly requestedSeconds: number) {
    super(
      `a Stripe poll interval of ${requestedSeconds}s is below the ${STRIPE_MIN_POLL_INTERVAL_SECONDS}s ` +
        `floor. At 60s one endpoint alone spends ~43,200 reads/month against an account ` +
        `allocation whose guaranteed floor is ${STRIPE_DEFAULT_MONTHLY_READ_ALLOCATION}. ` +
        `Refused rather than clamped: a clamp would hide that you asked for something else.`,
    );
    this.name = "StripePollIntervalError";
  }
}

/** Thrown when the cursor is older than `/v1/events` retention. */
export class StripeEventGapError extends Error {
  readonly code = "EVENT_RETENTION_GAP";
  constructor(
    readonly cursorSeconds: number,
    readonly retentionDays: number,
  ) {
    super(
      `the Stripe event cursor is older than the ${retentionDays}-day /v1/events retention ` +
        `window, so the missed changes are gone from the feed and no cursor can recover ` +
        `them. Run a Reporting API backfill to close the gap. Reported rather than polled ` +
        `because a poll from here would succeed and return nothing, which reads as ` +
        `"nothing changed".`,
    );
    this.name = "StripeEventGapError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Guards
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate an operator-supplied API base, or throw.
 *
 * HTTPS only — a restricted key over http is the key given away — exactly one
 * of the registered hosts, on the registered port. Rejects userinfo
 * (`https://evil@api.stripe.com`), which some HTTP clients resolve to a
 * different authority than a reader expects.
 *
 * Called at CONSTRUCTION, so a connection naming a destination we will not
 * dial fails to build rather than looking fine until the first read ships a
 * key.
 */
export function assertSafeStripeBaseUrl(raw: string): string {
  return assertSafeStripeUrl(raw, STRIPE_ALLOWED_API_HOSTS, "Stripe API");
}

/**
 * The same guard, applied to the report-FILE host.
 *
 * Identical strictness by construction — it is the same function body, given a
 * different registered set — so the download host can never end up screened
 * more loosely than the API host. Passing the API host here fails, and passing
 * the file host to {@link assertSafeStripeBaseUrl} fails, because the two sets
 * are siblings rather than one merged set.
 */
export function assertSafeStripeFileBaseUrl(raw: string): string {
  return assertSafeStripeUrl(raw, STRIPE_ALLOWED_FILE_HOSTS, "Stripe report-file");
}

function assertSafeStripeUrl(
  raw: string,
  allowed: ReadonlySet<string>,
  what: string,
): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeStripeBaseUrlError(`"${raw}" is not a URL`);
  }
  if (url.protocol !== "https:") {
    throw new UnsafeStripeBaseUrlError(`"${url.protocol}//" is not https`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new UnsafeStripeBaseUrlError("the URL carries userinfo");
  }
  const host = url.hostname.toLowerCase();
  if (!allowed.has(host)) {
    throw new UnsafeStripeBaseUrlError(`"${host}" is not a registered ${what} host`);
  }
  // The URL parser drops an explicit :443 (the https default), so any port
  // left standing is one the egress registry does not declare.
  if (url.port !== "" && url.port !== "443") {
    throw new UnsafeStripeBaseUrlError(
      `port ${url.port} — the egress registry allows this host on 443 only`,
    );
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * Validate a merchant-supplied credential, or throw — before anything is
 * persisted.
 *
 * The returned value is the trimmed key; the caller encrypts it. Nothing here
 * writes, logs or renders it.
 */
export function assertStripeRestrictedKey(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new InvalidStripeCredentialError("empty");
  }
  const key = raw.trim();
  if (!STRIPE_RESTRICTED_KEY_PATTERN.test(key)) {
    // Classification is for the MESSAGE only. The pattern above is the gate,
    // so loosening it is what breaks the test — not this switch.
    const reason: StripeCredentialRejection = /^sk_/.test(key)
      ? "secret_key"
      : /^pk_/.test(key)
        ? "publishable_key"
        : "unrecognized";
    throw new InvalidStripeCredentialError(reason);
  }
  return key;
}

/**
 * Validate a configured scheduled-poll interval, or throw.
 *
 * REFUSES rather than clamps. A clamp would silently give an operator who
 * asked for 60-second freshness a 15-minute one while leaving them believing
 * otherwise, and the whole point of the floor is that the operator understands
 * the trade they are making.
 */
export function assertStripePollIntervalSeconds(seconds: number): number {
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new StripePollIntervalError(seconds);
  }
  if (seconds < STRIPE_MIN_POLL_INTERVAL_SECONDS) {
    throw new StripePollIntervalError(seconds);
  }
  return seconds;
}

// ─────────────────────────────────────────────────────────────────────────────
// The read-allocation meter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The read meter.
 *
 * Counts only requests Stripe itself counts against the account's read
 * allocation: successful (2xx) reads of the ordinary `/v1/*` API. A 401, a 429
 * or a network failure costs nothing on Stripe's side and must not cost
 * anything here either — a counter that charged for failures would exhaust the
 * allowance fastest exactly when the integration is already struggling.
 *
 * Reporting API calls are NOT metered here, because Stripe excludes the
 * Reporting API (along with the Data and Tax products) from the allocation.
 * That exclusion is the entire reason backfill routes through report runs.
 *
 * Structurally identical to the QuickBooks `CallBudget` on purpose — same
 * assert-before/record-after discipline — but a separate class because the
 * quantity metered and the vendor rule behind it are different, and one shared
 * "budget" abstraction would blur which vendor's constraint is being enforced.
 * Wiring this into the orchestrator's per-connection `CallBudget` map belongs
 * with the provider-descriptor work (WARP-2217 / WARP-2282).
 */
export class ReadAllocationMeter {
  private spent = 0;
  private periodStart: number;

  constructor(
    readonly ceiling: number,
    private readonly now: () => number,
    /** Stripe's rule is a ROLLING 30 days, not a calendar month — and a
     *  calendar month would need a timezone this class has no business having
     *  an opinion about. */
    private readonly periodMs = 30 * 24 * 60 * 60 * 1000,
  ) {
    this.periodStart = now();
  }

  private roll(): void {
    const t = this.now();
    if (t - this.periodStart >= this.periodMs) {
      this.periodStart = t;
      this.spent = 0;
    }
  }

  /** Throw if the next read would exceed the allocation. Call BEFORE the
   *  request is constructed, so an exhausted allocation costs no network. */
  assertHeadroom(): void {
    this.roll();
    if (this.spent >= this.ceiling) {
      throw new StripeQuotaExhaustedError(this.spent, this.ceiling);
    }
  }

  /** Record one allocation-counted read. Only ever called for a 2xx. */
  record(): void {
    this.roll();
    this.spent += 1;
  }

  snapshot(): { spent: number; ceiling: number; remaining: number; periodStart: number } {
    this.roll();
    return {
      spent: this.spent,
      ceiling: this.ceiling,
      remaining: Math.max(0, this.ceiling - this.spent),
      periodStart: this.periodStart,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Wiring types
// ─────────────────────────────────────────────────────────────────────────────

type FetchLike = (input: string, init?: Record<string, unknown>) => Promise<Response>;

/** Resolve the restricted key (from the orchestrator's encrypted store).
 *  Cleartext for the life of one call only; never cached to disk here. */
export type StripeKeyResolver = () => Promise<string>;

/** The default resolver: nothing wired, so the track blocks honestly. */
export const blockedStripeKeyResolver: StripeKeyResolver = async () => {
  throw new ConnectorBlockedError("resolve the Stripe restricted key", STRIPE_TRACK_REMEDIATION);
};

export interface StripeConnectorConfig {
  /** Pointer into the encrypted secret store — NEVER a key. */
  credentialsSecretRef: string;
  /** API base. Operator-configured, and guarded on construction. */
  baseUrl?: string;
  /** Report-file base. Operator-configured, guarded on construction against
   *  its OWN registered set — never against the API set. */
  filesBaseUrl?: string;
  /** Per-connection monthly read allocation. Defaults to Stripe's floor. */
  monthlyReadAllocation?: number;
}

export interface StripeConnectorDeps {
  fetchImpl?: FetchLike;
  now?: () => number;
  resolveApiKey?: StripeKeyResolver;
  timeoutMs?: number;
  meter?: ReadAllocationMeter;
  /** Injected so tests exercise the backoff without spending real time. */
  sleep?: (ms: number) => Promise<void>;
}

/** The ADR-041 §5 connection-state vocabulary. Explicit, never inferred from a
 *  missing key — an absent value defaulted into "connected" is exactly the
 *  looks-connected-syncs-nothing failure that section exists to prevent. */
export type StripeConnectionState =
  | "disconnected"
  | "connected"
  | "needs_reconnect"
  | "blocked_by_access_policy"
  | "error";

export interface StripeStatus {
  state: StripeConnectionState;
  ok: boolean;
  /** Whether a key resolves. NEVER the key — the SMTP settings view's
   *  `hasPassword` convention. */
  hasApiKey: boolean;
  apiVersion: string;
  allocation: { spent: number; ceiling: number; remaining: number };
  minPollIntervalSeconds: number;
}

/** One canonical balance-transaction row: every inflow and outflow with its
 *  fee and its net. Amounts are in MAJOR units — see {@link majorUnits}. */
export interface StripeBalanceTransactionRow {
  transaction_id: string;
  created_at: string | undefined;
  type: string | undefined;
  currency: string | undefined;
  amount: number | undefined;
  fee: number | undefined;
  net: number | undefined;
  status: string | undefined;
}

/** One change observed on the event feed, carrying the RE-FETCHED object. */
export interface StripeChangeRecord {
  objectId: string;
  objectType: string;
  eventType: string;
  eventCreated: number;
  /** Fetched fresh under {@link STRIPE_API_VERSION} — never the event's own
   *  embedded payload, which renders at its creation-time version. */
  object: Record<string, unknown>;
}

export interface StripeEventPollResult {
  /** Deduped on OBJECT id: two events touching one object are one row to
   *  upsert, which is what makes replaying a window idempotent. */
  records: StripeChangeRecord[];
  /** The cursor to persist — max(created) observed, never the last element. */
  cursor: number;
  /** The lagged end of the window this poll covered (epoch seconds). */
  windowEnd: number;
  /** Events whose type this connector deliberately does not map, reported
   *  rather than silently dropped. Money-movement types live here. */
  unmapped: { id: string; type: string; created: number }[];
}

/** Backfill is asynchronous on Stripe's side, so "still running" is a first
 *  class state and never collapses into "finished, no rows". */
export type StripeBackfillResult =
  | { state: "in_progress"; reportRunId: string; attempts: number; detail: string }
  | {
      state: "succeeded";
      reportRunId: string;
      fileId: string;
      /** The report's contents, in the SAME shape `listBalanceTransactions()`
       *  yields, so a caller cannot tell which path a row arrived by. */
      rows: StripeBalanceTransactionRow[];
      detail: string;
    }
  | { state: "failed"; reportRunId: string; detail: string };

const DEFAULT_TIMEOUT_MS = 15_000;

/** What one outbound Stripe call needs to know about itself. */
interface StripeRequestOptions {
  /** Whether Stripe counts this against the account's read allocation. */
  metered: boolean;
  /** Which registered host to dial. Defaults to the API base; the only other
   *  value is the report-file base. Both are validated at construction. */
  origin?: string;
  search?: Record<string, string | number | undefined>;
  method?: "GET" | "POST";
  form?: Record<string, string | number>;
  /** Defaults to JSON. A report file is CSV, and asking for JSON there would
   *  be a request we do not mean. */
  accept?: string;
}

/**
 * An ISO-8601 instant as Stripe's Unix seconds, or `undefined` when the caller
 * did not supply one (WARP-2497).
 *
 * `undefined` rather than a default window on purpose: `send()` drops
 * undefined search entries, so an absent bound becomes an absent filter —
 * Stripe's own "no lower bound" — instead of a boundary this module invented.
 * A NON-date string is also `undefined` rather than `NaN`: `String(NaN)` would
 * put the literal text "NaN" on the wire as a filter value, which Stripe
 * rejects with a 400 that reads like an auth problem.
 */
export function epochSeconds(value: unknown): number | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

/**
 * Currencies Stripe holds with no minor unit (a JPY "amount" of 5000 is ¥5000,
 * not ¥50) and with three (a BHD amount of 5000 is 5.000 BHD).
 *
 * Dividing everything by 100 misstates a JPY ledger by 100x, which is the kind
 * of quietly-wrong number this product exists not to produce.
 */
const ZERO_DECIMAL_CURRENCIES = new Set([
  "bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga",
  "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf",
]);
const THREE_DECIMAL_CURRENCIES = new Set(["bhd", "jod", "kwd", "omr", "tnd"]);

/**
 * Convert a Stripe minor-unit integer to major units for the currency.
 *
 * Absent stays absent: a missing amount must not become 0, for the same reason
 * every other track keeps an unparseable balance — absent money and zero money
 * are different facts.
 */
export function majorUnits(amount: unknown, currency: unknown): number | undefined {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return undefined;
  const code = typeof currency === "string" ? currency.toLowerCase() : "";
  const exponent = ZERO_DECIMAL_CURRENCIES.has(code)
    ? 0
    : THREE_DECIMAL_CURRENCIES.has(code)
      ? 3
      : 2;
  if (exponent === 0) return amount;
  // Round to the currency's precision so binary floating point cannot leave
  // 96.80000000000001 in a money field.
  return Number((amount / 10 ** exponent).toFixed(exponent));
}

/**
 * The complete set of Stripe collections this connector may ever dial.
 *
 * An ALLOWLIST rather than a denylist, and enforced at request time by
 * {@link StripeConnector.assertReadableCollection} — not merely asserted in a
 * test. "Destructive actions are blocked" has to be a property of the code, not
 * an intention someone held while writing it, and a denylist of forbidden words
 * is only ever as good as the list: the first review of this file had one, and
 * it did not catch a `payouts` collection added to the event-route table
 * because the request path is assembled at runtime and the forbidden literal
 * never appeared in the source at all.
 *
 * Adding a money-movement collection here is therefore a deliberate, visible
 * edit to a named constant that `__tests__/stripe.test.ts` asserts against —
 * and every path the connector builds is checked against it before a request
 * is constructed, so a hardcoded money-movement path written anywhere else in
 * this file throws rather than dials.
 *
 * `refunds`, `payouts`, `transfers` and `topups` are absent on purpose. Reading
 * a charge is enough to SEE that it was refunded; issuing one is not this
 * product's business.
 */
export const STRIPE_READABLE_COLLECTIONS: ReadonlySet<string> = new Set([
  "balance_transactions",
  "charges",
  "customers",
  "events",
  "invoices",
  "payment_intents",
  "subscriptions",
  // The Reporting API — excluded from the read allocation, and how bulk
  // history is loaded. Two segments, so it is matched as a whole.
  "reporting/report_runs",
  // The Files API on files.stripe.com, from which a finished report run's CSV
  // is downloaded (WARP-2450). Present so the download path is subject to this
  // allowlist like every other path, NOT as a general file surface: the only
  // URL the connector ever builds here is /v1/files/<id>/contents for a file
  // id a report run of an ALLOWED subject collection produced.
  "files",
]);

/**
 * Report-type family → the collection whose rows that family reports on.
 *
 * The family is the segment before the first dot of a Stripe report type:
 * `balance_change_from_activity.itemized.3` is the `balance_change_from_activity`
 * family. Mapping the family to a collection is what lets
 * {@link assertReadableStripeCollection} decide a report run the same way it
 * decides an ordinary request path — otherwise "no money movement" would hold
 * for the REST surface and quietly not hold for the Reporting one, since a
 * payout-reconciliation CSV is a payouts read wearing a different URL.
 *
 * The money-movement families are listed HERE, mapped to the collection they
 * actually read, rather than omitted. Omitting them would make the refusal
 * indistinguishable from "unknown report type"; naming them states plainly
 * that they exist, that this connector knows what they read, and that the
 * allowlist — not this table — is what refuses them. Adding `payouts` to
 * {@link STRIPE_READABLE_COLLECTIONS} is the single edit that would let one
 * through, and it turns three tests red.
 */
export const STRIPE_REPORT_FAMILY_COLLECTIONS: ReadonlyMap<string, string> = new Map([
  ["balance", "balance_transactions"],
  ["balance_change_from_activity", "balance_transactions"],
  ["ending_balance_reconciliation", "balance_transactions"],
  ["payout_reconciliation", "payouts"],
  ["connected_account_balance_change_from_activity", "balance_transactions"],
]);

/**
 * The collection a report type reads, or a refusal.
 *
 * An UNKNOWN family is refused rather than assumed harmless. A report type
 * this connector has never heard of could read anything, and "we did not
 * recognise it so we let it through" is the shape of every allowlist that
 * turned out not to be one.
 */
export function collectionForStripeReportType(reportType: string): string {
  const family = reportType.split(".")[0] ?? "";
  const collection = STRIPE_REPORT_FAMILY_COLLECTIONS.get(family);
  if (collection === undefined) {
    throw new ConnectorBlockedError(
      `refusing the Stripe report type "${reportType}"`,
      "its family is not in STRIPE_REPORT_FAMILY_COLLECTIONS, so this connector cannot " +
        "say which collection the report would read. An unrecognised report type is " +
        "refused rather than assumed harmless — add the family to that map, with the " +
        "collection it reads, in a reviewed change.",
    );
  }
  return collection;
}

/**
 * Event-type prefix → the REST collection the object is re-fetched from.
 *
 * Ordered longest-prefix-first, because `customer.subscription.*` must not be
 * matched by the `customer.` arm. Money-movement object types have no entry,
 * so `payout.*`, `transfer.*` and `refund.*` land in
 * {@link StripeEventPollResult.unmapped} and no URL is ever built for them.
 * Every `collection` here must be in {@link STRIPE_READABLE_COLLECTIONS}.
 */
export const EVENT_OBJECT_ROUTES: readonly {
  prefix: string;
  collection: string;
  objectType: string;
}[] = [
  { prefix: "customer.subscription.", collection: "subscriptions", objectType: "subscription" },
  { prefix: "payment_intent.", collection: "payment_intents", objectType: "payment_intent" },
  { prefix: "invoice.", collection: "invoices", objectType: "invoice" },
  { prefix: "charge.", collection: "charges", objectType: "charge" },
  { prefix: "customer.", collection: "customers", objectType: "customer" },
];

/**
 * Refuse a path whose collection is not in {@link STRIPE_READABLE_COLLECTIONS}.
 *
 * Called at the top of every request, BEFORE the allocation check and before
 * the key is resolved, so an off-allowlist path never reaches the network and
 * never even touches the credential. This is what makes "no money movement" a
 * property of the code rather than a claim about it: a request for a payouts,
 * refunds or transfers collection added anywhere in this file — literally, or
 * assembled from a route table at runtime — throws here instead of dialing.
 *
 * Defence in depth rather than the only line: {@link EVENT_OBJECT_ROUTES}
 * already has no money-movement entry, so this guard exists for the case where
 * someone adds a new request path and does not think about the allowlist.
 */
export function assertReadableStripeCollection(path: string): void {
  const rest = path.startsWith("/v1/") ? path.slice(4) : "";
  const segments = rest.split("/").filter(Boolean);
  // `reporting/report_runs` is a two-segment collection; everything else is one
  // segment followed by an optional object id.
  const collection =
    segments[0] === "reporting" ? segments.slice(0, 2).join("/") : (segments[0] ?? "");
  if (!STRIPE_READABLE_COLLECTIONS.has(collection)) {
    throw new ConnectorBlockedError(
      `refusing to dial the Stripe collection "${collection}"`,
      "this connector may only read the collections named in " +
        "STRIPE_READABLE_COLLECTIONS. Money-movement collections are absent from that " +
        "set on purpose and adding one is a deliberate, reviewed change — not something " +
        "a new request path can do incidentally.",
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Report files (WARP-2450)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a Stripe report CSV into records keyed by header name.
 *
 * RFC 4180 rather than `split(",")`: report rows carry merchant-authored text
 * (a customer name, a statement descriptor, an invoice memo) which routinely
 * contains commas and quotes, and a naive split silently shifts every column
 * after the first offending field — producing a ledger that is wrong rather
 * than a parse that fails. Handles quoted fields, doubled quotes inside them,
 * embedded newlines, CRLF and a UTF-8 BOM.
 *
 * Rows with a different field count from the header are a contract violation,
 * not something to pad or truncate: a short row means a column was lost and
 * every value after it is attributed to the wrong name.
 */
export function parseStripeReportCsv(text: string): Record<string, string>[] {
  const rows = splitCsvRows(text.replace(/^\uFEFF/, ""));
  const header = rows.shift();
  if (!header || header.length === 0 || (header.length === 1 && header[0] === "")) return [];
  return rows.map((cells, i) => {
    if (cells.length !== header.length) {
      throw new ConnectorBlockedError(
        `Stripe report row ${i + 1} has ${cells.length} fields, header has ${header.length}`,
        "the CSV does not match its own header. Refusing to interpret it rather than " +
          "padding or truncating — a misaligned row attributes every value after the gap " +
          "to the wrong column, which is a wrong ledger rather than a failed read.",
      );
    }
    const rec: Record<string, string> = {};
    header.forEach((name, j) => {
      rec[name] = cells[j];
    });
    return rec;
  });
}

/** One pass over the text, tracking whether we are inside a quoted field. */
function splitCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') {
        field += ch;
      } else if (text[i + 1] === '"') {
        // A doubled quote inside a quoted field is one literal quote.
        field += '"';
        i += 1;
      } else {
        quoted = false;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  // A file that does not end in a newline still has a final row.
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Column aliases, because the balance report families do not agree on names.
 *
 * Longest-lived first in each list; the first present column wins. Listing the
 * alternatives explicitly beats guessing at a prefix, which would happily bind
 * `net` to `net_available_on`.
 */
const REPORT_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  id: ["balance_transaction_id", "id"],
  created: ["created", "created_utc"],
  type: ["reporting_category", "type", "balance_transaction_type"],
  currency: ["currency"],
  gross: ["gross", "amount"],
  fee: ["fee"],
  net: ["net"],
  status: ["status", "balance_transaction_status"],
};

function column(rec: Record<string, string>, field: keyof typeof REPORT_COLUMNS): string | undefined {
  for (const name of REPORT_COLUMNS[field]) {
    const v = rec[name];
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
}

/**
 * A report CSV's timestamp as an ISO instant.
 *
 * Two shapes appear: an epoch-seconds integer (`created`) and a UTC wall-clock
 * string (`created_utc`, `2026-05-01 12:00:00`). The second one is a trap —
 * `new Date("2026-05-01 12:00:00")` is parsed in the RUNNING PROCESS's local
 * zone, so the same report read on a box in Los Angeles and a box in Berlin
 * would date the same transaction seven hours apart. Stripe documents these
 * columns as UTC, so they are assembled with `Date.UTC` from the parts rather
 * than handed to the permissive parser.
 */
function reportInstant(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (/^\d+$/.test(raw)) {
    return new Date(Number(raw) * 1000).toISOString();
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(raw);
  if (!m) return undefined;
  const ms = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
  );
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/**
 * A report CSV amount.
 *
 * Report files carry amounts in MAJOR units already — `10.00` is ten dollars,
 * where the REST API's `1000` for the same charge is a thousand cents. Running
 * these through {@link majorUnits} would divide a second time and understate
 * the whole ledger by 100x, so this is deliberately NOT that function. The
 * asymmetry between the two ingestion paths is the reason both get their own
 * conversion rather than sharing one.
 */
function reportAmount(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Map report records onto the SAME row shape the incremental path yields.
 *
 * `listBalanceTransactions()` and a backfill must produce interchangeable
 * rows, or a caller has to know which path a row came from to read it — and
 * the whole point of backfill is to seed the same ledger the poller then keeps
 * current. Rows with no transaction id are dropped: a ledger row that cannot
 * be keyed cannot be deduplicated against the poller's output.
 */
export function balanceTransactionRowsFromReport(
  records: readonly Record<string, string>[],
): StripeBalanceTransactionRow[] {
  const rows: StripeBalanceTransactionRow[] = [];
  for (const rec of records) {
    const id = column(rec, "id");
    if (id === undefined) continue;
    rows.push({
      transaction_id: id,
      created_at: reportInstant(column(rec, "created")),
      type: column(rec, "type"),
      currency: column(rec, "currency"),
      amount: reportAmount(column(rec, "gross")),
      fee: reportAmount(column(rec, "fee")),
      net: reportAmount(column(rec, "net")),
      status: column(rec, "status"),
    });
  }
  return rows;
}

export class StripeConnector implements Connector {
  readonly provider = STRIPE_PROVIDER;
  readonly servesDatasets = STRIPE_DATASETS;

  private readonly now: () => number;
  private readonly resolveApiKey: StripeKeyResolver;
  private readonly fetchImpl?: FetchLike;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly filesBaseUrl: string;
  private readonly meter: ReadAllocationMeter;
  private readonly sleep: (ms: number) => Promise<void>;

  private apiKey: string | null = null;
  private fingerprint: string | null = null;

  constructor(
    private readonly config: StripeConnectorConfig,
    deps: StripeConnectorDeps = {},
  ) {
    this.now = deps.now ?? (() => Date.now());
    this.resolveApiKey = deps.resolveApiKey ?? blockedStripeKeyResolver;
    this.fetchImpl = deps.fetchImpl;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    // Validated at CONSTRUCTION: a connection naming a destination we will not
    // dial should fail to build, loudly, rather than look fine until the first
    // read ships a key.
    this.baseUrl = assertSafeStripeBaseUrl(config.baseUrl ?? STRIPE_PRODUCTION_BASE_URL);
    // Guarded at construction too, and against its own set: a connection that
    // names an unregistered download host must fail to build rather than look
    // fine until a backfill finishes and ships the key to it.
    this.filesBaseUrl = assertSafeStripeFileBaseUrl(
      config.filesBaseUrl ?? STRIPE_FILES_BASE_URL,
    );
    this.meter =
      deps.meter ??
      new ReadAllocationMeter(
        config.monthlyReadAllocation ?? STRIPE_DEFAULT_MONTHLY_READ_ALLOCATION,
        this.now,
      );
  }

  private blocked(op: string, detail?: string): ConnectorBlockedError {
    return new ConnectorBlockedError(detail ? `${op} (${detail})` : op, STRIPE_TRACK_REMEDIATION);
  }

  /** Resolve and validate the key. Validated on every resolve, not only at
   *  intake: a row edited out-of-band must not be able to put an `sk_` key on
   *  the wire. */
  private async key(): Promise<string> {
    if (this.apiKey) return this.apiKey;
    const raw = await this.resolveApiKey();
    this.apiKey = assertStripeRestrictedKey(raw);
    return this.apiKey;
  }

  /**
   * One request whose response is JSON.
   *
   * `metered` decides whether it counts against the account's read allocation:
   * true for ordinary `/v1/*` reads, FALSE for the Reporting API and its
   * files, which Stripe excludes. The headroom check happens before the URL is
   * even built, so an exhausted allocation costs no network at all — the test
   * asserts on the injected fetch having zero calls, not on the return value.
   */
  private async request(
    op: string,
    path: string,
    opts: StripeRequestOptions,
  ): Promise<Record<string, unknown>> {
    const res = await this.send(op, path, opts);
    try {
      return (await res.json()) as Record<string, unknown>;
    } catch (err) {
      throw this.blocked(op, `unparseable Stripe response: ${(err as Error).message}`);
    }
  }

  /**
   * One request whose body is not JSON — a report file's CSV.
   *
   * Shares {@link StripeConnector.send} with every other call, so the
   * collection allowlist, the `Stripe-Version` pin, the no-redirect rule, the
   * 429 backoff and the 401/403 classification are the same machinery rather
   * than a second implementation that drifts.
   */
  private async requestText(
    op: string,
    path: string,
    opts: StripeRequestOptions,
  ): Promise<string> {
    const res = await this.send(op, path, opts);
    try {
      return await res.text();
    } catch (err) {
      throw this.blocked(op, `unreadable Stripe response body: ${(err as Error).message}`);
    }
  }

  /** Everything both request kinds share, up to and including the status
   *  classification and the allocation record. */
  private async send(
    op: string,
    path: string,
    opts: StripeRequestOptions,
  ): Promise<Response> {
    assertReadableStripeCollection(path);
    if (opts.metered) this.meter.assertHeadroom();
    const apiKey = await this.key();

    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.search ?? {})) {
      if (v !== undefined) qs.set(k, String(v));
    }
    // `origin` defaults to the API base. The ONLY other value it ever takes is
    // the report-file base, and both were validated at construction against
    // their own registered host set — so no request can reach an origin the
    // egress registry has not screened.
    const url = `${opts.origin ?? this.baseUrl}${path}${qs.toString() ? `?${qs}` : ""}`;

    const doFetch = this.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    if (!doFetch) throw this.blocked(op, "no fetch implementation available");

    const body = opts.form
      ? new URLSearchParams(
          Object.entries(opts.form).map(([k, v]) => [k, String(v)]),
        ).toString()
      : undefined;

    for (let attempt = 0; ; attempt += 1) {
      let res: Response;
      try {
        res = await doFetch(url, {
          method: opts.method ?? "GET",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            // NON-NEGOTIABLE, on every request kind. Without it the response is
            // served at the merchant's Workbench-changeable account default.
            "Stripe-Version": STRIPE_API_VERSION,
            Accept: opts.accept ?? "application/json",
            ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
          },
          ...(body ? { body } : {}),
          // Never follow a 3xx: the fetch spec strips Authorization on
          // cross-origin redirects, but the key's safety must not rest on every
          // runtime implementing that correctly. This API has no legitimate
          // redirect, so one is a fault, not a hop.
          redirect: "error",
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        throw this.blocked(op, `Stripe API unreachable: ${(err as Error).message}`);
      }

      if (res.status === 429) {
        // Stripe sends `Stripe-Rate-Limited-Reason` but documents NO
        // `Retry-After`, so the backoff is self-derived. Without it this is a
        // hot loop against an endpoint already telling us to slow down.
        if (attempt >= STRIPE_MAX_RATE_LIMIT_RETRIES - 1) {
          throw this.blocked(
            op,
            `Stripe rate limit (429) persisted across ${attempt + 1} attempts — back off and retry later`,
          );
        }
        await this.sleep(STRIPE_BACKOFF_BASE_MS * 2 ** attempt);
        continue;
      }

      if (res.status === 401) {
        throw new StripeReauthorizationRequiredError("Stripe returned 401");
      }
      if (res.status === 403) {
        // A 403 here is far more often the key's IP/ASN access policy than a
        // permissions problem, because Stripe RECOMMENDS merchants set one and
        // this box's WAN address is not stable. Classified from the response
        // body so a genuine permissions 403 still routes to re-authorization.
        const detail = await StripeConnector.errorMessage(res);
        if (STRIPE_IP_POLICY_SIGNALS.test(detail)) {
          throw new StripeAccessPolicyError(detail);
        }
        throw new StripeReauthorizationRequiredError(`Stripe returned 403: ${detail}`);
      }
      if (!res.ok) {
        throw this.blocked(op, `Stripe API returned ${res.status}`);
      }

      // Recorded only on a 2xx, and only for allocation-counted paths.
      if (opts.metered) this.meter.record();
      return res;
    }
  }

  /** Pull the human-readable message out of a Stripe error envelope. */
  private static async errorMessage(res: Response): Promise<string> {
    try {
      const body = (await res.json()) as { error?: { message?: string; code?: string } };
      return body?.error?.message ?? body?.error?.code ?? `HTTP ${res.status}`;
    } catch {
      return `HTTP ${res.status}`;
    }
  }

  /**
   * Page a `/v1` list endpoint.
   *
   * Every page is one allocation-counted read, which is why the page ceiling
   * exists: without it one endpoint that never returns `has_more: false` burns
   * the merchant's entire monthly allocation inside a single call, and the
   * ongoing poll then has nothing left to spend. That aborts as a
   * `ConnectorBlockedError` — a fault to report — never as QuotaExhausted,
   * which would tell the owner nothing is broken and to wait a month.
   */
  private async list(
    op: string,
    path: string,
    search: Record<string, string | number | undefined> = {},
  ): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    let startingAfter: string | undefined;

    for (let page = 1; ; page += 1) {
      if (page > STRIPE_MAX_PAGES) {
        throw new ConnectorBlockedError(
          `${op} stopped after ${STRIPE_MAX_PAGES} pages`,
          "the endpoint kept reporting more results; aborting rather than spending the " +
            "merchant's whole monthly read allocation on one read. Bulk history belongs " +
            "on the Reporting API backfill, which is excluded from that allocation.",
        );
      }
      const body = await this.request(op, path, {
        metered: true,
        search: { limit: 100, starting_after: startingAfter, ...search },
      });
      const data = body.data;
      if (data != null && !Array.isArray(data)) {
        throw new ConnectorBlockedError(
          `${op} returned a non-array \`data\` (${typeof data})`,
          "Stripe's response did not match the documented list contract. Refusing to " +
            "interpret it rather than guessing at a shape — report this if it persists.",
        );
      }
      const list = (data ?? []) as Record<string, unknown>[];
      rows.push(...list);
      if (body.has_more !== true || list.length === 0) return rows;
      const last = list[list.length - 1];
      const id = typeof last.id === "string" ? last.id : undefined;
      if (!id) {
        throw new ConnectorBlockedError(
          `${op} cannot page: the last row carries no id`,
          "Stripe's cursor pagination needs the previous page's last id; without it the " +
            "next request would re-read the same window forever.",
        );
      }
      startingAfter = id;
    }
  }

  // ── Connector interface ───────────────────────────────────────────────────

  async connect(): Promise<void> {
    // A cheap, real read proves three things at once: the key works, it has
    // the Read permissions we need, and egress to Stripe is permitted. It
    // costs one allocation-counted read, which is the correct price for
    // knowing the connection is real rather than assuming it.
    await this.request("connect", "/v1/balance_transactions", {
      metered: true,
      search: { limit: 1 },
    });
    this.fingerprint = computeSchemaFingerprint(this.tables());
  }

  async close(): Promise<void> {
    this.apiKey = null;
  }

  async health(): Promise<{ ok: boolean }> {
    // Derived from the same explicit state `status()` reports, not from
    // whichever fields happen to be populated.
    const state = await this.state();
    if (state === "needs_reconnect") {
      throw new StripeReauthorizationRequiredError("the stored restricted key is not usable");
    }
    if (state === "blocked_by_access_policy") {
      throw new StripeAccessPolicyError("the key's IP access policy rejected this appliance");
    }
    if (state === "error") {
      const a = this.meter.snapshot();
      throw new StripeQuotaExhaustedError(a.spent, a.ceiling);
    }
    if (state === "disconnected") {
      throw this.blocked("health", "no Stripe account is connected");
    }
    return { ok: true };
  }

  /** The canonical shape this track serves. Synthesized rather than
   *  introspected: Stripe's schema is Stripe's, published and versioned, so
   *  there is nothing to discover — but the fingerprint still has to exist so
   *  drift-freeze semantics stay coherent across every track. */
  private tables(): IntrospectedTable[] {
    return STRIPE_DATASETS.map((dataset) => ({
      name: dataset,
      owner: "stripe",
      columns: CANONICAL_COLUMNS[dataset as DatasetName].map((name) => ({ name, type: "text" })),
    }));
  }

  async introspect(): Promise<IntrospectionResult> {
    const tables = this.tables();
    // Pin the API version INTO the fingerprint: a Stripe version bump can
    // change field shapes without changing our canonical column list, and a
    // fingerprint blind to that would report "no drift" across a real one.
    const fingerprint = computeSchemaFingerprint(tables) + `:sv${STRIPE_API_VERSION}`;
    this.fingerprint = fingerprint;
    return { tables, fingerprint };
  }

  async runRead(name: string, params: Record<string, unknown>): Promise<unknown[]> {
    const query = getReadQuery(name);
    assertDatasetsServed(this.provider, this.servesDatasets, name, query.dependsOnTables);
    const op = `runRead:${name}`;

    switch (name) {
      case "get_open_invoices": {
        // `status=open` is Stripe's own explicit enum, not a balance heuristic
        // — the one place in this package where the vendor already models the
        // state we would otherwise have to derive.
        const raw = await this.list(op, "/v1/invoices", { status: "open" });
        // WARP-2494 — the modification time is a SECOND read, because Stripe
        // does not put one on the object. See {@link invoiceModifiedAt}.
        const modifiedAt = await this.invoiceModifiedAt(op, raw);
        const rows = raw.map((r) => ({
          invoice_id: typeof r.number === "string" ? r.number : String(r.id ?? ""),
          issued_at: StripeConnector.instant(r.created),
          due_at: StripeConnector.instant(r.due_date),
          customer_id: StripeConnector.idOf(r.customer),
          amount: majorUnits(r.total, r.currency),
          balance: majorUnits(r.amount_remaining, r.currency),
          status: typeof r.status === "string" ? r.status : undefined,
          // Keyed on the OBJECT id, never on `invoice_id` - that column is the
          // merchant-facing `number`, which the event feed never mentions.
          updated_at: StripeConnector.instant(modifiedAt.get(String(r.id ?? ""))),
        }));
        return sortByKey(sortByKey(rows, "invoice_id"), "due_at");
      }
      case "get_recent_charges": {
        // WARP-2497. The [from, to) window is pushed to Stripe as its own
        // half-open `created` filter rather than applied after paging: this
        // endpoint is metered, and a read that pulls the whole history to
        // filter locally spends a merchant's monthly allocation on one
        // question. `gte`/`lt` — inclusive start, exclusive end — so adjacent
        // windows neither double-count a charge nor drop one.
        const raw = await this.list(op, "/v1/charges", {
          "created[gte]": epochSeconds(params.from),
          "created[lt]": epochSeconds(params.to),
        });
        const rows = raw.map((r) => ({
          charge_id: String(r.id ?? ""),
          created_at: StripeConnector.instant(r.created),
          customer_id: StripeConnector.idOf(r.customer),
          // `amount_refunded` travels WITH the charge and is never netted off
          // — gross takings and what was kept are different numbers, and only
          // one of them can be the `amount` column (profiles.ts states this
          // convention once for every payments dataset).
          amount: majorUnits(r.amount, r.currency),
          amount_refunded: majorUnits(r.amount_refunded ?? 0, r.currency),
          currency: typeof r.currency === "string" ? r.currency : undefined,
          status: typeof r.status === "string" ? r.status : undefined,
        }));
        // `created_at DESC, charge_id` — the ORDER BY `get_recent_charges`
        // declares. Stripe's own list order is not contractual, so the sort is
        // ours. sortByKey is ascending and Array.sort is stable, so sorting by
        // id first and then DESCENDING by timestamp leaves charge_id ascending
        // within a shared timestamp, which a bare `.reverse()` would not.
        const byId = sortByKey(rows, "charge_id");
        return [...byId].sort((a, b) =>
          String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")),
        );
      }
      default:
        // Unreachable while every served read is handled above; a new registry
        // entry lands here rather than silently returning nothing.
        throw this.blocked(op, "read is not served by the Stripe track");
    }
  }

  async applyWrite(name: string, _params: Record<string, unknown>): Promise<unknown> {
    // Same validation order as every other track, so a caller bug produces the
    // same typed error here as anywhere else...
    const cmd = getWriteCommand(name);
    assertTargetAllowed(cmd.targetTable);
    // ...and then this track refuses. Non-monetary writes (customer metadata,
    // invoice draft fields) are a separate ticket behind `confirmationRequired()`
    // in packages/tools-core (WARP-2293). Money movement is not a later ticket:
    // it is absent by design and the test suite fails the build if it appears.
    throw this.blocked(
      `applyWrite:${name}`,
      "the Stripe track is read-only — no refund, transfer or payout surface exists in " +
        "this connector at any tier, and non-monetary writes land with their own " +
        "confirmation gate (WARP-2293)",
    );
  }

  // ── Payments-specific surface ─────────────────────────────────────────────

  /**
   * Every inflow and outflow with its fee and its net.
   *
   * The single best read Stripe exposes and the closest thing to a general
   * ledger any of these vendors offers — which is why it is the first one this
   * connector serves.
   */
  async listBalanceTransactions(
    params: { createdGte?: number; createdLte?: number } = {},
  ): Promise<StripeBalanceTransactionRow[]> {
    const raw = await this.list("listBalanceTransactions", "/v1/balance_transactions", {
      "created[gte]": params.createdGte,
      "created[lte]": params.createdLte,
    });
    return raw.map((r) => ({
      transaction_id: String(r.id ?? ""),
      created_at: StripeConnector.instant(r.created),
      type: typeof r.type === "string" ? r.type : undefined,
      currency: typeof r.currency === "string" ? r.currency : undefined,
      amount: majorUnits(r.amount, r.currency),
      fee: majorUnits(r.fee, r.currency),
      net: majorUnits(r.net, r.currency),
      status: typeof r.status === "string" ? r.status : undefined,
    }));
  }

  /**
   * The last time each of `invoices` CHANGED, keyed on the Stripe object id.
   *
   * Stripe puts no modification timestamp on an invoice - the object carries
   * `created` and nothing else - so re-listing invoices can never reveal that
   * one of them moved. The only source is the `/v1/events` feed, whose own
   * `created` is when the change happened; this is the same feed
   * {@link pollEvents} already consumes, read here for its timestamps rather
   * than for its objects, so nothing is re-fetched.
   *
   * Emitting the object's `created` as `updated_at` instead would be strictly
   * worse than emitting nothing: a watermark TRUSTS this column, so a row that
   * has never changed would advance it and the edits that follow would stop
   * being seen with nothing reporting a fault. An invoice whose last change
   * predates {@link STRIPE_EVENT_RETENTION_MS} therefore gets `undefined`, and
   * WARP-2218's sweep is what catches it.
   *
   * Two bounds keep this from spending the merchant's read allocation:
   *
   *  1. `type=invoice.*` - the documented single-type wildcard, so the feed is
   *     filtered server-side rather than paged through and discarded here.
   *  2. `created[gte]` never reaches further back than the OLDEST invoice in
   *     hand, because no `invoice.*` event can predate the invoice it is
   *     about (`invoice.created` is the first one). Retention is the other
   *     bound; the later of the two wins.
   *
   * An empty invoice list short-circuits to zero requests: there is nothing to
   * stamp, and the call is metered.
   */
  private async invoiceModifiedAt(
    op: string,
    invoices: readonly Record<string, unknown>[],
  ): Promise<Map<string, number>> {
    const byObject = new Map<string, number>();
    if (invoices.length === 0) return byObject;

    const retentionFloor = Math.floor((this.now() - STRIPE_EVENT_RETENTION_MS) / 1000);
    let oldest = Number.POSITIVE_INFINITY;
    for (const inv of invoices) {
      if (typeof inv.created === "number" && Number.isFinite(inv.created)) {
        oldest = Math.min(oldest, inv.created);
      }
    }
    const floor = Number.isFinite(oldest) ? Math.max(retentionFloor, oldest) : retentionFloor;

    const events = await this.list(op, "/v1/events", {
      type: STRIPE_INVOICE_EVENT_TYPE,
      "created[gte]": floor,
    });

    for (const ev of events) {
      const created =
        typeof ev.created === "number" && Number.isFinite(ev.created) ? ev.created : undefined;
      const objectId = StripeConnector.idOf(
        (ev.data as { object?: unknown } | undefined)?.object,
      );
      if (created === undefined || !objectId) continue;
      // MAXIMUM, not last-seen: ordering on /v1/events is explicitly not
      // guaranteed, so "the last one on the page" is a stale change time.
      const prev = byObject.get(objectId);
      if (prev === undefined || created > prev) byObject.set(objectId, created);
    }
    return byObject;
  }

  /**
   * Poll `/v1/events` for changes since `cursor`.
   *
   * Three traps live in this feed and each one silently corrupts a naive
   * `created > cursor` loop:
   *
   *   1. **Ordering is explicitly not guaranteed.** Advancing the cursor to
   *      the last element of a page drops everything that sorted after it, so
   *      the cursor advances to the MAXIMUM `created` observed.
   *   2. **Same-second events are eventually consistent.** The window ends
   *      {@link STRIPE_EVENT_CURSOR_LAG_MS} behind wall clock, and the
   *      resulting overlap is absorbed by keying on object id.
   *   3. **The embedded object renders at the event's CREATION-TIME API
   *      version** and ignores the `Stripe-Version` header entirely. Only
   *      `id`, `type` and `created` are read off the event — plus the object's
   *      `id`, which is the pointer and is stable across every version — and
   *      the object itself is re-fetched under the pin. Every FIELD comes from
   *      the re-fetch; none comes from the payload.
   *
   * The cursor is RETURNED, not persisted: `ErpSyncCursor` has zero writers
   * today and ADR-041 §4 forbids a cloud connector becoming its first while
   * WARP-2028 is open.
   */
  async pollEvents(input: { cursor: number | null }): Promise<StripeEventPollResult> {
    const op = "pollEvents";
    const nowMs = this.now();
    const windowEnd = Math.floor((nowMs - STRIPE_EVENT_CURSOR_LAG_MS) / 1000);
    const retentionSeconds = Math.floor(STRIPE_EVENT_RETENTION_MS / 1000);
    const cursor = input.cursor ?? windowEnd - retentionSeconds + 3600;

    if (Math.floor(nowMs / 1000) - cursor > retentionSeconds) {
      // Checked BEFORE any request: polling from here would succeed and return
      // nothing, which reads as "nothing changed in 40 days".
      throw new StripeEventGapError(cursor, Math.floor(retentionSeconds / 86400));
    }

    const events = await this.list(op, "/v1/events", {
      "created[gt]": cursor,
      "created[lte]": windowEnd,
    });

    const unmapped: { id: string; type: string; created: number }[] = [];
    // Keyed on OBJECT id, not event id: two events touching one object are one
    // row to upsert, which is what makes replaying a window produce no
    // duplicates. Later events win, so the freshest re-fetch is kept.
    const byObject = new Map<string, StripeChangeRecord>();
    let maxCreated = cursor;

    for (const ev of events) {
      const id = typeof ev.id === "string" ? ev.id : "";
      const type = typeof ev.type === "string" ? ev.type : "";
      const created = typeof ev.created === "number" ? ev.created : 0;
      if (created > maxCreated) maxCreated = created;

      const route = EVENT_OBJECT_ROUTES.find((r) => type.startsWith(r.prefix));
      const objectId = StripeConnector.idOf(
        (ev.data as { object?: unknown } | undefined)?.object,
      );
      if (!route || !objectId) {
        unmapped.push({ id, type, created });
        continue;
      }

      // The re-fetch. Nothing but the id was taken from the event payload.
      const object = await this.request(op, `/v1/${route.collection}/${objectId}`, {
        metered: true,
      });
      const existing = byObject.get(objectId);
      if (!existing || created >= existing.eventCreated) {
        byObject.set(objectId, {
          objectId,
          objectType: route.objectType,
          eventType: type,
          eventCreated: created,
          object,
        });
      }
    }

    return {
      records: [...byObject.values()].sort((a, b) => a.objectId.localeCompare(b.objectId)),
      // Never past the lagged window end, or the next poll would start inside
      // the eventually-consistent zone this lag exists to avoid.
      cursor: Math.min(maxCreated, windowEnd),
      windowEnd,
      unmapped,
    };
  }

  /**
   * Bulk history and >30-day gap recovery, through the Reporting API.
   *
   * Stripe EXCLUDES the Reporting API from the read allocation and charges
   * nothing for it on a standard account, which makes it the only correct path
   * for these two jobs. The alternative is arithmetically disqualified rather
   * than merely slow: paginating `/v1/balance_transactions` far enough back to
   * seed a ledger burns a quiet merchant's entire monthly allocation in one
   * sitting, and the ongoing poll then has nothing left to spend.
   *
   * Report runs are ASYNCHRONOUS — request, poll, then retrieve — so a run
   * still in progress is its own returned state and never collapses into
   * "backfill finished, no rows", which would be a confident false statement
   * about money.
   *
   * The finished file's CONTENTS come from `files.stripe.com` (WARP-2450),
   * which is a second host with its own `docs/security/allowed-egress.yaml`
   * entry and its own security review. WARP-2215 shipped this method stopping
   * at the file reference because that host was unregistered at the time and
   * neither dialing it quietly nor widening WARP-2216's pinned `stripe-api`
   * entry was acceptable; registering it separately is what unblocked the
   * download, and the URL is built from a whole-string literal here rather
   * than followed from the file object's own `url` field, so a Stripe-supplied
   * value cannot point this request anywhere.
   *
   * The report TYPE is checked against the same collection allowlist every
   * request path is checked against, BEFORE the run is created. A
   * payout-reconciliation report is a payouts read wearing a different URL,
   * and "no money movement" has to hold on the Reporting surface too.
   */
  async runBackfill(input: {
    reportType: string;
    intervalStart: number;
    intervalEnd: number;
  }): Promise<StripeBackfillResult> {
    const op = "runBackfill";
    // Refused before the run is created, so a report this connector may not
    // read costs no network at all — the test asserts zero fetch calls.
    assertReadableStripeCollection(`/v1/${collectionForStripeReportType(input.reportType)}`);
    // `metered: false` throughout — this is the exclusion the whole design
    // rests on, and the test asserts the meter snapshot is byte-identical
    // across a full backfill.
    const created = await this.request(op, "/v1/reporting/report_runs", {
      metered: false,
      method: "POST",
      form: {
        report_type: input.reportType,
        "parameters[interval_start]": input.intervalStart,
        "parameters[interval_end]": input.intervalEnd,
      },
    });

    const runId = typeof created.id === "string" ? created.id : "";
    let run = created;

    for (let attempt = 0; attempt < STRIPE_BACKFILL_MAX_ATTEMPTS; attempt += 1) {
      const status = typeof run.status === "string" ? run.status : "";
      if (status === "succeeded") {
        const fileId = StripeConnector.idOf(run.result);
        if (fileId === null) {
          // A succeeded run with no file reference is a broken contract, and
          // the one thing that must NOT happen here is returning it as
          // succeeded-with-no-rows. That reads as "your history is empty".
          throw new ConnectorBlockedError(
            `${op}: Stripe reported report run ${runId} succeeded but returned no file`,
            "the run cannot be retrieved without a file reference. Refusing to report " +
              "this as a finished backfill — a backfill that loaded nothing is not the " +
              "same fact as an account with no history.",
          );
        }
        const rows = await this.retrieveReportRows(op, input.reportType, fileId);
        return {
          state: "succeeded",
          reportRunId: runId,
          fileId,
          rows,
          detail: `the report run finished and its file yielded ${rows.length} rows`,
        };
      }
      if (status === "failed") {
        return {
          state: "failed",
          reportRunId: runId,
          detail: "Stripe reported the report run as failed",
        };
      }
      // Backoff between polls: a report run over 90 days of history takes real
      // time, and hammering the status endpoint helps nobody.
      await this.sleep(STRIPE_BACKOFF_BASE_MS * 2 ** attempt);
      run = await this.request(op, `/v1/reporting/report_runs/${runId}`, { metered: false });
    }

    // Attempts exhausted. Explicitly STILL RUNNING — the caller polls again
    // later. Reporting this as succeeded-with-no-rows is the exact silent
    // wrong answer this connector exists not to produce.
    return {
      state: "in_progress",
      reportRunId: runId,
      attempts: STRIPE_BACKFILL_MAX_ATTEMPTS,
      detail:
        `the report run was still building after ${STRIPE_BACKFILL_MAX_ATTEMPTS} polls. ` +
        `It has NOT failed and no data is missing — poll this run id again shortly.`,
    };
  }

  /**
   * Download a finished report run's CSV and map it onto ledger rows.
   *
   * Three properties this method has to hold, in order:
   *
   *   1. **The collection allowlist gates it, again.** `runBackfill` already
   *      checked the report type before creating the run; this re-checks it
   *      here so the guard travels with the DOWNLOAD rather than living only
   *      at one call site, and then the `/v1/files/...` path goes through the
   *      same guard as every other request path.
   *   2. **The URL is built, never followed.** The file object carries its own
   *      `url` field. Using it would let a Stripe-side value — or anything
   *      that ever impersonated one — choose where a request carrying the
   *      merchant's restricted key goes. The base is a literal validated at
   *      construction against {@link STRIPE_ALLOWED_FILE_HOSTS}.
   *   3. **Nothing here is allocation-metered.** Stripe excludes the Reporting
   *      API and its files, which is the whole reason bulk history takes this
   *      route; `metered: false` is what makes that true in code.
   */
  private async retrieveReportRows(
    op: string,
    reportType: string,
    fileId: string,
  ): Promise<StripeBalanceTransactionRow[]> {
    assertReadableStripeCollection(`/v1/${collectionForStripeReportType(reportType)}`);
    const csv = await this.requestText(op, `/v1/files/${fileId}/contents`, {
      metered: false,
      origin: this.filesBaseUrl,
      accept: "text/csv",
    });
    return balanceTransactionRowsFromReport(parseStripeReportCsv(csv));
  }

  // ── State ─────────────────────────────────────────────────────────────────

  /**
   * Map what we know onto ADR-041's vocabulary.
   *
   * RESOLVES the key rather than reading whatever a previous call happened to
   * cache, so a connection whose allocation is exhausted (or which has simply
   * never been read from) does not report `disconnected` while being perfectly
   * well configured.
   *
   * Order matters: an unusable key outranks an exhausted allocation, because
   * replacing the key is the only action that helps and waiting for the period
   * to roll would not.
   */
  private async state(): Promise<StripeConnectionState> {
    try {
      await this.key();
    } catch (err) {
      // No key resolvable = the owner has not connected an account. Not an
      // error: it is the shipped-off state ADR-041 §2 requires.
      if (err instanceof InvalidStripeCredentialError) return "needs_reconnect";
      return "disconnected";
    }
    if (this.meter.snapshot().remaining <= 0) return "error";
    return "connected";
  }

  async status(): Promise<StripeStatus> {
    const state = await this.state();
    const a = this.meter.snapshot();
    return {
      state,
      // One source of truth: `ok` is derived from `state` rather than computed
      // independently, so the two cannot disagree inside one returned object.
      ok: state === "connected",
      // The SMTP settings convention: report THAT a credential exists, never
      // its value. Nothing in this object can carry key material.
      hasApiKey: this.apiKey !== null,
      apiVersion: STRIPE_API_VERSION,
      allocation: { spent: a.spent, ceiling: a.ceiling, remaining: a.remaining },
      minPollIntervalSeconds: STRIPE_MIN_POLL_INTERVAL_SECONDS,
    };
  }

  /** The last computed schema fingerprint, or null before `introspect()`. */
  get schemaFingerprint(): string | null {
    return this.fingerprint;
  }

  // ── Value coercion ────────────────────────────────────────────────────────

  /** Stripe timestamps are epoch SECONDS; the canonical form is a full ISO
   *  instant, matching every other track. */
  private static instant(v: unknown): string | undefined {
    if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
    return new Date(v * 1000).toISOString();
  }

  /** A Stripe reference is either a bare id string or an expanded object. */
  private static idOf(v: unknown): string | null {
    if (typeof v === "string" && v !== "") return v;
    if (v && typeof v === "object") {
      const id = (v as { id?: unknown }).id;
      if (typeof id === "string" && id !== "") return id;
    }
    return null;
  }
}

/**
 * What a 403 body has to say for it to be read as the key's IP/ASN access
 * policy rather than a permissions problem.
 *
 * Deliberately narrow. Classifying every 403 as an access policy would send a
 * merchant whose key simply lacks a Read permission to the wrong screen, so a
 * body that does not name an address restriction still routes to
 * re-authorization.
 */
const STRIPE_IP_POLICY_SIGNALS = /ip\s*address|ip[_-]?restriction|access\s*policy|\basn\b/i;
