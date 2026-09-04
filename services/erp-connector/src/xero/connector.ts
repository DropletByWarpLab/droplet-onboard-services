/**
 * WARP-2383 — `XeroConnector`: the second accounting cloud track.
 *
 * Reads ONE Xero organisation — customer invoices, supplier bills and the
 * contacts both hang off — over Xero's Accounting API, on a **Custom
 * Connection** the customer creates and pays for in Xero's own developer
 * portal. Same `Connector` interface and the same blocked-error contract as
 * every other track, so nothing upstream of it changes.
 *
 * ## What makes this track different
 *
 * **It is a CLOUD CONNECTOR under ADR-041**, built to the same five conditions
 * the QuickBooks Online track states in full (`../quickbooks/online-connector.ts`),
 * and a **customer-supplied credential** under ADR-042:
 *
 *   1. **Only ever dials out.** Xero offers webhooks; the box has no inbound
 *      path, so they are structurally unavailable and polling is the only
 *      ingestion mechanism. That is a fit, not a compromise (ADR-041 §1).
 *   2. **Ships off; owner consent is the enabling event.** With no credential
 *      resolved the connector blocks honestly rather than half-authenticating.
 *   3. **Every destination registered.** `api.xero.com` and
 *      `identity.xero.com` are in `docs/security/allowed-egress.yaml`
 *      (`xero-api` as `user-content-on-request`, `xero-identity` as `none`),
 *      and {@link XERO_ALLOWED_API_HOSTS} accepts exactly those two.
 *   4. **Persistence: none.** ADR-041 §4 warns that the encryption
 *      `ErpEntityCache` promises is NOT implemented (WARP-2028). This track is
 *      therefore read-through: it writes no cache, no cursor and no
 *      `secretRef`. See {@link XeroConnector} and WARP-2425's firewall note
 *      below.
 *   5. **The credential is the whole organisation's books.** Never logged,
 *      never in a URL, never echoed back in an error.
 *
 * ## Two authentication paths, and only one of them exists (WARP-2394)
 *
 * ADR-042 §2 records both, and they are **disjoint variants, not optional
 * fields**:
 *
 *   `custom-connection`  client id + client secret, a **modified**
 *                        client-credentials grant, one organisation per
 *                        connection, 30-minute access tokens and **no refresh
 *                        token**. Implemented here.
 *   `pkce-app`           a customer-registered app with *"no option to
 *                        generate a client secret"*, reached through an
 *                        authorization-code redirect. **Declared and refused**
 *                        — see {@link XeroVariantNotImplementedError}. The
 *                        appliance has no inbound path for a redirect URI
 *                        (WARP-2388), so this is a missing SUBSYSTEM rather
 *                        than a missing branch.
 *
 * The refusal is a parse-then-reject, not an absence: a row that names
 * `pkce-app` is a row somebody deliberately configured, and answering it with
 * "unknown provider" or an empty read would hide a decision the owner made.
 *
 * **Do not "fix" the modified grant into the standard one.** Xero's own
 * documentation says a Custom Connection *"uses a modified version of client
 * credentials which is not described on this page"*, and that the ordinary
 * grant *"cannot"* reach an organisation's data — plain `client_credentials`
 * against a normal Xero app authenticates fine and reads NON-TENANTED app
 * data, i.e. nothing the customer has. A useful consequence of the modified
 * variant: a Custom Connection *"can only make calls against one organisation
 * so only the access token is required"*, which is why no `xero-tenant-id`
 * header is set anywhere in this file.
 *
 * ## The token is re-minted, never refreshed, and never persisted (WARP-2408)
 *
 * Xero issues **no refresh token** for this connection type and the access
 * token lasts 30 minutes (ADR-042 §6). So {@link XeroConnector} holds no
 * refresh path at all: it mints from the stored client credential, caches the
 * result in {@link xeroTokenCache} for the process lifetime, and mints again
 * when the cached one is inside {@link XERO_TOKEN_EARLY_MINT_MS} of expiry.
 *
 * Two deliberate deviations from WARP-2408's wording, recorded rather than
 * quietly made:
 *
 *   - **The ticket says `deriveXeroTokenKey()`. That predates ADR-042.** §5 of
 *     that ADR settled the storage: the pasted client id and secret go in
 *     `IntegrationConnection.providerTokensEnc` under the SHARED
 *     `deriveSaasCredentialKey()` with the `saas-credential:<rowId>` AAD, which
 *     the descriptor-driven `saas-credential.service.ts` already writes for
 *     every WARP-2214 vendor. A per-vendor derivation would have been a second
 *     credential store for this one connector.
 *   - **The MINTED token is not stored at all, and there is no proactive cron
 *     refresh.** A 30-minute token against a 4-hour poll cadence
 *     ({@link XERO_POLL_INTERVAL_FLOOR_MS}) is expired at every tick by
 *     construction, so "refresh it before it lapses" would mean minting ~57
 *     tokens a day to use 6 of them — spending the metered daily allowance the
 *     rest of this file exists to protect. What IS scheduled on
 *     `cron-runtime.service.ts` is {@link pruneExpiredXeroTokens}, so dead
 *     credential material does not sit in process memory and the cache cannot
 *     grow without bound. There is no `while (true)` anywhere in this track.
 *
 * ## The egress bill is bounded three ways (WARP-2417)
 *
 *   1. **`If-Modified-Since` on every list read.** Xero applies it as a
 *      server-side filter on `UpdatedDateUTC`, so an unchanged ledger costs one
 *      call and returns an empty page instead of paging the whole book.
 *   2. **`summaryOnly=true` where Xero documents it** — Invoices and Contacts.
 *      It drops line items, addresses and contact persons, none of which any
 *      canonical column needs, and Xero's own guidance is that it is the
 *      faster, lighter response. It is NOT sent to ManualJournals, where Xero
 *      documents no such parameter and where the journal LINES are the record.
 *   3. **A 4-hour cadence, jittered per box.** Xero's per-tenant limits are 60
 *      calls/minute and 5,000/day, but the one that actually binds is
 *      **app-wide and pooled at 10,000 calls/minute across every box we ship**
 *      — see `apps/orchestrator/src/services/erp-sync/schedule-jitter.ts`,
 *      which names that number and derives each box's offset from its device
 *      identity so the fleet spreads and stays spread.
 *
 * ## `UpdatedDateUTC` is the canonical `updated_at`, and it is INCOMPLETE
 *
 * `export-drop/profiles.ts` already records the limit against the `invoice`
 * and `bill` columns and it is repeated here because it decides how this track
 * is OPERATED: Xero's `UpdatedDateUTC` does not fire on a DueDate edit, on
 * `SentToContact`, or on a contact-balance change. An incremental pass keyed on
 * it therefore misses real edits **in silence**, which is why WARP-2218's full
 * reconciliation sweep is mandatory for Xero rather than a safety net.
 *
 * ## Four failure states that must never be confused
 *
 * None of them may render as an empty result. `[]` from `get_open_bills` reads
 * as "you owe nobody anything", which is a confident false statement about
 * money — `../quickbooks/online-connector.ts:60-68` states the rule and it is
 * not negotiable.
 *
 *   REAUTHORIZE_REQUIRED    Xero rejected the client credential. Editing a live
 *                           Custom Connection DEACTIVATES it until it is
 *                           re-authorised, so this is a routine state reached
 *                           by a customer changing scopes, not only by a
 *                           revocation.
 *   XERO_SCOPE_MISSING      the connection authenticates and this endpoint is
 *                           outside the scopes the owner ticked. A capability
 *                           boundary, not a fault — and re-ticking it is
 *                           partly IRREVERSIBLE at Xero (removing a broad scope
 *                           permanently replaces it with granular ones), so the
 *                           message says what to grant rather than "retry".
 *   XERO_RATE_LIMITED       Xero's own 429, with its `Retry-After`. Transient.
 *   CONNECTOR_BLOCKED       not configured, or Xero is unreachable.
 *
 * ## WARP-2425 — the firewall between this data and every weight-updating path
 *
 * Nothing in this connector persists a row, and the sync runner that calls it
 * (`erp-sync.service.ts` `runOneCursor`) reads rows, extracts a POSITION from
 * them and discards them — `ErpEntityCache` still has zero writers in the tree.
 * So no Xero record reaches the file indexer's embedding path, which reads
 * Nextcloud files and nothing else.
 *
 * The path that DID reach a weight-updating corpus was the LoRA export
 * (`apps/orchestrator/src/services/finetune-dataset.service.ts`): a
 * `cloud_query_dataset` tool result carries connector rows into `curateTurn`,
 * and its scrubs match secret SHAPES and key NAMES — ADR-039 §3 is explicit
 * that neither anonymises a customer name or an amount. That boundary is now
 * an explicit exclusion with a test; see `CONNECTOR_RECORD_TOOLS` there.
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
import { projectCanonicalRow, type CanonicalRow, type VendorLookup } from "../canonical-row.js";
import { sortByKey } from "../api-dto.js";

/** Provider key for this track. */
export const XERO_PROVIDER = "xero";

/**
 * Xero's Accounting API base.
 *
 * Kept as a WHOLE-STRING LITERAL on purpose, following the QuickBooks and
 * HubSpot precedent. Do not "clean this up" into a template string, a joined
 * constant, or a config read: `scripts/check-egress-allowlist.py` is a static
 * text scanner over tracked source (`docs/SECURITY.md:183-185`) and can only
 * extract a hostname it can literally see. Assembling the host at runtime
 * silently blinds the egress gate while leaving the code working, which is the
 * worst of both.
 */
export const XERO_API_BASE_URL = "https://api.xero.com";

/**
 * Xero's identity host — where an access token is minted, and the ONLY other
 * host this track dials.
 *
 * A separate registry entry (`xero-identity`, `data_class: none`) because it
 * carries OAuth protocol traffic and no ledger content, exactly as the
 * `m365-graph-api` / `m365-entra-login` pair does. Same whole-string-literal
 * rule as above.
 */
export const XERO_IDENTITY_BASE_URL = "https://identity.xero.com";

/**
 * WARP-2399 — the only hosts this connector will send Xero credential material
 * to. EXACTLY these, never a suffix match.
 *
 * A suffix match would have accepted `api.xero.com.evil.test`. The set is
 * DERIVED from the two published base-URL literals above, so a third
 * destination cannot be added without its host becoming a repo literal the
 * egress gate extracts and checks — which is the mirror ADR-041 §3 requires
 * between the registry and the code.
 *
 * Both hosts are in one set rather than two because both requests carry
 * credential material: the identity host receives the client id and secret,
 * and the API host receives the bearer token minted from them. A guard that
 * covered only one of them would leave the other unconstrained.
 */
export const XERO_ALLOWED_API_HOSTS: ReadonlySet<string> = new Set(
  [XERO_API_BASE_URL, XERO_IDENTITY_BASE_URL].map((u) => new URL(u).hostname),
);

/** Thrown when a connection names a destination this track will not dial. */
export class UnsafeXeroBaseUrlError extends Error {
  readonly code = "UNSAFE_BASE_URL";
  constructor(reason: string) {
    super(`refusing to send a Xero credential there: ${reason}`);
    this.name = "UnsafeXeroBaseUrlError";
  }
}

/**
 * Validate an operator-supplied Xero base, or throw.
 *
 * HTTPS only — a bearer token over http is the token given away — exactly one
 * of the registered hosts ({@link XERO_ALLOWED_API_HOSTS}), on the registered
 * port. Rejects userinfo (`https://evil@api.xero.com`), which some HTTP clients
 * resolve to a different authority than a reader expects.
 *
 * Called at CONSTRUCTION, so a connection naming a destination we will not dial
 * fails to build rather than looking fine until the first read ships a token.
 */
export function assertSafeXeroBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeXeroBaseUrlError(`"${raw}" is not a URL`);
  }
  if (url.protocol !== "https:") {
    throw new UnsafeXeroBaseUrlError(`"${url.protocol}//" is not https`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new UnsafeXeroBaseUrlError("the URL carries userinfo");
  }
  const host = url.hostname.toLowerCase();
  if (!XERO_ALLOWED_API_HOSTS.has(host)) {
    throw new UnsafeXeroBaseUrlError(`"${host}" is not a registered Xero host`);
  }
  // The URL parser drops an explicit :443 (the https default), so any port left
  // standing is one the egress registry does not declare.
  if (url.port !== "" && url.port !== "443") {
    throw new UnsafeXeroBaseUrlError(
      `port ${url.port} — the egress registry allows these hosts on 443 only`,
    );
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The two credential variants (WARP-2394)
// ─────────────────────────────────────────────────────────────────────────────

/** The authentication paths Xero offers, in the descriptor's own ids. */
export const XERO_CREDENTIAL_VARIANTS = ["custom-connection", "pkce-app"] as const;
export type XeroCredentialVariant = (typeof XERO_CREDENTIAL_VARIANTS)[number];

/** The one this build implements. */
export const XERO_IMPLEMENTED_VARIANT: XeroCredentialVariant = "custom-connection";

/**
 * What the owner is told when a row names the unimplemented path.
 *
 * Names the actual obstacle rather than "not supported yet": the missing piece
 * is an authorization-code redirect an appliance with no inbound path cannot
 * receive (ADR-009), which is why WARP-2388 recorded the spike's answer as
 * "not needed for a Custom Connection" rather than as a portal question still
 * open. A reader who is told "coming soon" will wait; one who is told this can
 * go and create the connection that works.
 */
export const XERO_PKCE_NOT_IMPLEMENTED_REMEDIATION =
  "this connection is configured for Xero's customer-owned PKCE app, which Droplet does " +
  "not implement: that path is an OAuth authorization-code flow and needs a redirect URI " +
  "the vendor can reach, which this appliance deliberately does not have (it accepts no " +
  "inbound connections). Create a Custom Connection in Xero's developer portal instead " +
  "and re-connect with its client id and client secret — see the Xero setup guide";

/** Thrown when a row names a Xero authentication path this build cannot run. */
export class XeroVariantNotImplementedError extends Error {
  readonly code = "XERO_VARIANT_NOT_IMPLEMENTED";
  readonly remediation = XERO_PKCE_NOT_IMPLEMENTED_REMEDIATION;
  constructor(readonly variant: string) {
    super(`the Xero "${variant}" path is not implemented: ${XERO_PKCE_NOT_IMPLEMENTED_REMEDIATION}`);
    this.name = "XeroVariantNotImplementedError";
  }
}

/** Thrown when a row names no Xero authentication path at all. */
export class UnknownXeroVariantError extends Error {
  readonly code = "UNKNOWN_XERO_VARIANT";
  constructor(readonly variant: unknown) {
    // The VALUE is not interpolated. It arrives from a persisted row and a
    // mis-pasted secret has landed in a discriminator field before; rule 19
    // says the rejection path is itself a secret-handling path.
    super(
      `this Xero connection does not say which authentication path it is on. ` +
        `Expected one of: ${XERO_CREDENTIAL_VARIANTS.join(", ")}. Re-connect it from the ` +
        `Integrations page so the choice is recorded.`,
    );
    this.name = "UnknownXeroVariantError";
  }
}

/**
 * Narrow a persisted variant discriminator, or throw.
 *
 * PARSE THEN REJECT, in that order, and both halves matter. An unrecognised
 * value is not the same fact as a recognised-but-unbuilt one: the first is a
 * row nobody wrote correctly, the second is a deliberate choice this build
 * cannot honour, and collapsing them would tell a customer who chose the PKCE
 * app that their connection is corrupt.
 */
export function assertXeroVariantImplemented(raw: unknown): XeroCredentialVariant {
  if (typeof raw !== "string" || !(XERO_CREDENTIAL_VARIANTS as readonly string[]).includes(raw)) {
    throw new UnknownXeroVariantError(raw);
  }
  const variant = raw as XeroCredentialVariant;
  if (variant !== XERO_IMPLEMENTED_VARIANT) throw new XeroVariantNotImplementedError(variant);
  return variant;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The scopes a Custom Connection needs for what this track reads.
 *
 * `accounting.journals.read` is ABSENT and that is the point: Xero's
 * general-ledger `/Journals` feed sits behind it, the scope stopped being
 * available to NEW Custom Connections on 2026-04-29, and the ledger question it
 * answers is served here from `/ManualJournals` instead. Asking for a scope we
 * cannot be granted would fail every new connection at authorisation.
 *
 * `accounting.reports.read` is absent for a simpler reason: no read on this
 * track calls a report endpoint, and requesting a scope we do not use is the
 * opposite of minimum-necessary — the setup guide lists it as optional, which
 * is a customer's choice to make and not one we make for them.
 */
const SCOPE_TRANSACTIONS = "accounting.transactions.read";
const SCOPE_CONTACTS = "accounting.contacts.read";
const SCOPE_SETTINGS = "accounting.settings.read";

export const XERO_SCOPES: readonly string[] = [
  SCOPE_TRANSACTIONS,
  SCOPE_CONTACTS,
  SCOPE_SETTINGS,
];

/**
 * Which scope a 403 on a resource is asking for.
 *
 * A table, not a guess: the message tells the owner what to tick in Xero's
 * portal, and a wrong scope name sends them to re-authorise for nothing —
 * which at this vendor costs an outage and, if they trim the wrong one, is
 * irreversible. Anything not listed is a transactions read.
 *
 * Built from the same three constants {@link XERO_SCOPES} is, so the set the
 * token request asks for and the set the error messages name cannot drift.
 */
const SCOPE_BY_RESOURCE: Readonly<Record<string, string>> = {
  Contacts: SCOPE_CONTACTS,
  Organisation: SCOPE_SETTINGS,
};

/**
 * Documented life of a Custom Connection access token (ADR-042 §2).
 *
 * Two jobs, both bounds on what a token response is allowed to claim:
 *
 *  • the FALLBACK when the response omits `expires_in`, states it as something
 *    other than a number, or states a value that is not positive; and
 *  • the CEILING on a stated value, since a response claiming more than the
 *    documented life is not a life Xero will honour.
 *
 * It is not a floor. A SHORTER `expires_in` still wins — a vendor that
 * shortens its tokens must not find this constant asserting they are good for
 * half an hour regardless. See `mint()` for why both bounds are load-bearing.
 */
export const XERO_ACCESS_TOKEN_TTL_MS = 30 * 60_000;

/**
 * How far ahead of expiry a cached token is re-minted.
 *
 * A token that expires mid-flight surfaces as a 401, which this connector
 * reports as REAUTHORIZE_REQUIRED — an ask the owner cannot act on, because
 * nothing is actually wrong with their credential. Two minutes is comfortably
 * more than a slow page plus its retries and comfortably less than the token's
 * life.
 */
export const XERO_TOKEN_EARLY_MINT_MS = 2 * 60_000;

/** Records per page. Xero's documented maximum for these endpoints. */
export const XERO_PAGE_SIZE = 100;

/**
 * Hard ceiling on pages one read may fetch: 200 pages × 100 records.
 *
 * Same reasoning as the QuickBooks track's, with a lower page size and so a
 * higher page count for the same row ceiling. The loop's only natural exit is a
 * short page, and the backstop behind it is a metered daily allowance shared
 * with every other read on the connection — without a bound, one endpoint that
 * never returns a short page burns the whole day inside a single call.
 */
export const XERO_MAX_PAGES = 200;

/**
 * Wall-clock budget for one whole read (all pages).
 *
 * The page ceiling bounds CALLS, not TIME: an endpoint dripping distinct pages
 * just inside the per-request timeout could otherwise hold a read — and the
 * credential behind it — open for the best part of an hour.
 */
export const XERO_MAX_READ_WALL_MS = 5 * 60_000;

/**
 * WARP-2417 — the minimum interval between scheduled reads of a Xero
 * connection, mirrored by the descriptor's `pollIntervalFloorMs`.
 *
 * Declared here as well so the connector's own documentation of the token
 * lifecycle can reason about it, and asserted equal to the descriptor by
 * `erp-provider.descriptor.test.ts`'s registry table.
 */
export const XERO_POLL_INTERVAL_FLOOR_MS = 4 * 60 * 60 * 1000;

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * What this track is waiting on. Deliberately unlike the other tracks', so an
 * installer triaging this is not sent looking for a QuickBooks company, a
 * HubSpot portal, or a folder full of CSVs.
 */
export const XERO_TRACK_REMEDIATION =
  "needs a Xero Custom Connection (created by the customer in Xero's developer portal, " +
  "AU/NZ/UK/US only, billed by Xero per organisation) with its client id and client " +
  "secret stored on the integration row, and api.xero.com + identity.xero.com allowed " +
  "in allowed-egress.yaml — this connector leaves the customer LAN";

/**
 * The datasets this track serves.
 *
 * Reconciled BY COLUMN LIST against `../export-drop/profiles.ts`, per that
 * file's rule that a vendor shape takes an existing canonical name only when
 * the columns match:
 *
 *   ACCREC invoice → `invoice`   InvoiceNumber/Date/DueDate/Contact/Total/
 *                                AmountDue/Status/UpdatedDateUTC is exactly
 *                                [invoice_id, issued_at, due_at, customer_id,
 *                                amount, balance, status, updated_at].
 *   ACCPAY invoice → `bill`      the same shape with the counterparty read as
 *                                `vendor_id`. Xero holds bills and invoices in
 *                                ONE resource discriminated by `Type`, which is
 *                                why one endpoint serves two datasets here.
 *   Contact        → `contact`   a party that may have bought nothing and
 *                                carries no money of its own, which is
 *                                `contact`'s docstring almost word for word.
 *                                NOT the commerce `customer`: that dataset
 *                                requires `orders_count`, `total_spent_amount`
 *                                and `currency`, none of which a Xero contact
 *                                has any source for, and serving it as
 *                                `customer` would let a lifetime-spend
 *                                calculation run on three columns that are not
 *                                there.
 *
 * ManualJournals is deliberately ABSENT from this list even though
 * {@link XeroConnector.listManualJournals} reads it — no member of the closed
 * 23-name union matches a journal's column list (a journal LINE is an account
 * code plus a signed amount, which nothing in the vocabulary holds), and
 * widening the vocabulary is a decision with every track's blast radius rather
 * than this ticket's to take. See that method.
 */
export const XERO_DATASETS: readonly DatasetName[] = ["invoice", "bill", "contact"];

/**
 * The Xero endpoints this connector may dial, and whether Xero documents
 * `summaryOnly` for each.
 *
 * An ALLOWLIST enforced at request time by {@link assertReadableXeroResource},
 * not a denylist asserted in a test. Request paths are assembled from a
 * variable (`/api.xro/2.0/${resource}`), so a forbidden literal need never
 * appear in the source for the connector to dial a forbidden endpoint — the
 * Stripe track proved that by mutation.
 *
 * Absent on purpose: every write endpoint, `/Journals` (the Advanced-tier
 * general ledger, whose scope new Custom Connections can no longer be granted),
 * payroll, files, assets and the practice-manager APIs.
 */
export const XERO_READABLE_RESOURCES: Readonly<Record<string, { summaryOnly: boolean }>> = {
  // Invoices and Bills are ONE Xero resource discriminated by `Type`.
  Invoices: { summaryOnly: true },
  Contacts: { summaryOnly: true },
  // Xero documents no `summaryOnly` here, and it would be wrong if it did: the
  // journal LINES are the record, not a detail to omit.
  ManualJournals: { summaryOnly: false },
  // The organisation probe `connect()` uses. Cheapest authenticated read on the
  // API and present under every scope set this track asks for.
  Organisation: { summaryOnly: false },
};

/** Refuse a resource outside {@link XERO_READABLE_RESOURCES}. */
export function assertReadableXeroResource(resource: string): void {
  if (!Object.prototype.hasOwnProperty.call(XERO_READABLE_RESOURCES, resource)) {
    throw new ConnectorBlockedError(
      `refusing to dial the Xero resource "${resource}"`,
      "this connector may only reach the resources named in XERO_READABLE_RESOURCES. " +
        "Write endpoints, payroll, files and the Advanced-tier /Journals ledger are " +
        "absent from that set on purpose, and adding one is a deliberate, reviewed " +
        "change — not something a new request path can do incidentally.",
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

/** Thrown when only a person can restore the connection. */
export class XeroReauthorizationRequiredError extends Error {
  readonly code = "REAUTHORIZE_REQUIRED";
  constructor(readonly reason: string) {
    super(
      `Xero rejected this connection's credential (${reason}). Retrying cannot fix it. ` +
        `The usual causes are all at the customer's end: the Custom Connection was EDITED ` +
        `(which deactivates it until it is re-authorised in Xero's developer portal), the ` +
        `client secret was rotated, the Xero subscription lapsed, or the connection was ` +
        `deleted. Re-authorise it in Xero and paste the current credential here.`,
    );
    this.name = "XeroReauthorizationRequiredError";
  }
}

/**
 * Thrown when the credential works and the SCOPE does not cover the read.
 *
 * Deliberately NOT folded into the reauthorization error: the credential is
 * fine, and telling the owner to re-paste it would waste their time and not fix
 * it. Naming the scope matters more here than at any other vendor, because
 * changing scopes at Xero is a re-consent event and one direction of it is
 * PERMANENT — removing a broad scope replaces it irreversibly with granular
 * ones — so "just tick everything and see" is advice that cannot be taken back.
 */
export class XeroScopeMissingError extends Error {
  readonly code = "XERO_SCOPE_MISSING";
  constructor(
    readonly resource: string,
    readonly requiredScope: string,
  ) {
    super(
      `this Xero connection is not authorised to read ${resource}: it needs the ` +
        `"${requiredScope}" scope. That is a permission the owner ticks in Xero's ` +
        `developer portal, not a fault on this box — and editing a live Custom Connection ` +
        `deactivates it until it is re-authorised, so it costs a short outage. Removing a ` +
        `broad scope at Xero cannot be undone, so change scopes deliberately.`,
    );
    this.name = "XeroScopeMissingError";
  }
}

/** Thrown when Xero throttles this tenant. Transient, and carries its own wait. */
export class XeroRateLimitedError extends Error {
  readonly code = "XERO_RATE_LIMITED";
  constructor(
    readonly limitName: string,
    readonly retryAfter: string | null,
  ) {
    super(
      `Xero rate limit reached (${limitName}). Nothing is broken and no data is lost: ` +
        `Xero allows 60 calls a minute and 5,000 a day per organisation, and the box backs ` +
        `off and resumes.` + (retryAfter ? ` Xero asked for ${retryAfter}s.` : ""),
    );
    this.name = "XeroRateLimitedError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The minted access token, and its process-lifetime cache
// ─────────────────────────────────────────────────────────────────────────────

/** A minted Custom Connection access token. Never persisted — see the header. */
export interface XeroAccessToken {
  accessToken: string;
  /** Epoch ms at which Xero stops accepting it. */
  expiresAt: number;
}

/**
 * Minted tokens by CONNECTION id, for the life of the process.
 *
 * Module-level for the same reason `erp-provider.ts`'s call budgets are:
 * `erp.service` builds and closes a connector per read, so a cache held on the
 * instance would be born empty every time and this track would mint a token per
 * read — one extra call against `identity.xero.com` for every call against
 * `api.xero.com`, doubling the connection's metered spend to no purpose.
 *
 * Keyed on the connection id rather than on the client id so two organisations
 * connected with credentials that happen to share an id cannot see each other's
 * token, and so {@link forgetXeroToken} has a key the disconnect path already
 * holds — and, since the review on #1946, actually uses.
 */
const xeroTokenCache = new Map<string, XeroAccessToken>();

/**
 * Drop one connection's minted token.
 *
 * Three callers, and the third was missing until #1946's review found it: the
 * two 401 paths (a token Xero has stopped accepting is worse than no token,
 * because it costs a call to learn that again), `decommission()`, and
 * `integrations.service.disconnect()`. Without that last one the DB row was
 * purged while a live bearer token for the account sat in this map for up to
 * {@link XERO_ACCESS_TOKEN_TTL_MS} plus the prune cron's lag.
 */
export function forgetXeroToken(connectionId: string): void {
  xeroTokenCache.delete(connectionId);
}

/**
 * Drop every minted token that has expired.
 *
 * WARP-2408's cron leg, scheduled on `cron-runtime.service.ts` — NOT a
 * `while (true)`, and not a proactive re-mint (the header says why re-minting
 * on a timer would spend the daily allowance to no purpose). What it buys is
 * real: a token is credential material, and one belonging to a connection
 * nobody has read from since this morning should not still be sitting in
 * process memory this evening. It also bounds the map on a box whose
 * connections come and go.
 *
 * Returns the number dropped, so the caller can log a count without a second
 * pass.
 */
export function pruneExpiredXeroTokens(now: number = Date.now()): number {
  let dropped = 0;
  for (const [connectionId, token] of xeroTokenCache) {
    if (token.expiresAt <= now) {
      xeroTokenCache.delete(connectionId);
      dropped += 1;
    }
  }
  return dropped;
}

/** Test seam: clear every cached token between cases. */
export function __resetXeroTokenCacheForTest(): void {
  xeroTokenCache.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// Value coercion
// ─────────────────────────────────────────────────────────────────────────────

/** `/Date(1518685950940+0000)/` — Xero's JSON date form. */
const XERO_DOTNET_DATE = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/;

/**
 * A Xero timestamp as a full UTC ISO instant.
 *
 * Xero's Accounting API JSON serialises every date in the .NET
 * `/Date(<epoch-ms>+<offset>)/` form, which `Date.parse` does not understand at
 * all — it returns `NaN`, so a naive `canonicalInstant` would silently drop
 * EVERY timestamp on this track, including the `updated_at` the watermark rides
 * on. That is the failure this function exists to prevent, and it is invisible
 * without a fixture: the rows still arrive, they just have no dates.
 *
 * The leading integer is already UTC epoch milliseconds; the trailing offset is
 * Xero's display hint and is deliberately IGNORED rather than added, because
 * adding it would shift every instant by the organisation's timezone.
 *
 * ISO strings are accepted too — a few Xero surfaces emit them — and anything
 * else stays `undefined`. Absent stays absent: defaulting to the epoch or to
 * `now` would put a value in the column the watermark TRUSTS.
 */
export function xeroInstant(value: unknown): string | undefined {
  if (typeof value === "number") return isoFromEpochMs(value);
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (raw === "") return undefined;
  const dotnet = XERO_DOTNET_DATE.exec(raw);
  if (dotnet) return isoFromEpochMs(Number(dotnet[1]));
  return isoFromEpochMs(Date.parse(raw));
}

/**
 * The largest epoch-ms magnitude `Date` can represent — ECMA-262's Time Range,
 * ±100,000,000 days around the epoch. Beyond it a `Date` is Invalid and
 * `toISOString()` THROWS `RangeError` rather than returning a value.
 *
 * The clause is named by TITLE and never by its dotted number: a four-part
 * dotted numeric in a comment is read by `scripts/check-egress-allowlist.py`
 * as a registrable domain and denied — the same class
 * `ref-dotted-identifier-keys` describes for `.chat` / `.zip`. Citing the
 * title costs nothing and keeps the gate honest.
 */
const MAX_EPOCH_MS = 8.64e15;

/**
 * One epoch-ms → ISO conversion for all three of {@link xeroInstant}'s
 * branches, because `Number.isFinite` is not the same predicate as "a `Date`
 * can hold this".
 *
 * `/Date(99999999999999999999)/` is finite, matches the .NET form, and made
 * `toISOString()` throw — an uncaught `RangeError` on a *value coercion* that
 * the docstring above promises will only ever return `undefined` for input it
 * cannot read. One malformed field in one row would have taken down the whole
 * page's mapping rather than leaving that field absent, which is the exact
 * failure the "absent stays absent" rule exists to avoid.
 *
 * `Date.parse` already answers NaN for an out-of-range literal, so that branch
 * was never the reachable one; it shares this helper so a fourth branch cannot
 * be added without the bound.
 */
function isoFromEpochMs(ms: number): string | undefined {
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_EPOCH_MS) return undefined;
  return new Date(ms).toISOString();
}

/**
 * An RFC 1123 date for the `If-Modified-Since` header (WARP-2417).
 *
 * Xero requires this exact shape and treats the value as UTC. `toUTCString()`
 * produces it; building it by hand from locale parts is how a header ends up
 * meaning a different instant on a box in another timezone.
 *
 * Returns undefined for anything unparseable, and the caller then sends NO
 * header — a full enumeration, which is the correct fallback. Sending a header
 * derived from a value we could not read would silently skip the window we
 * failed to parse.
 */
export function xeroIfModifiedSince(since: unknown): string | undefined {
  if (since === undefined || since === null) return undefined;
  const iso = xeroInstant(since);
  if (iso === undefined) return undefined;
  return new Date(iso).toUTCString();
}

/** Read a nested value without asserting the shape of what is in between. */
function field(record: unknown, name: string): unknown {
  if (!record || typeof record !== "object") return undefined;
  return (record as Record<string, unknown>)[name];
}

/**
 * The counterparty on an invoice or bill.
 *
 * Prefers the human-readable `Name` over the opaque `ContactID`, matching the
 * QuickBooks track's `ref()`: the id is useless in a chat answer, and "who do
 * we owe" is the question this column exists for.
 */
function xeroContactRef(contact: unknown): unknown {
  return field(contact, "Name") ?? field(contact, "ContactID");
}

// ─────────────────────────────────────────────────────────────────────────────
// Row mappers (WARP-2414)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One Xero invoice/bill → a canonical `invoice` or `bill` lookup.
 *
 * `idColumn` and `partyColumn` are the only difference between the two
 * datasets, because Xero holds both in ONE `Invoices` resource discriminated by
 * `Type` — `ACCREC` is money owed to the business, `ACCPAY` money owed by it.
 * Two mappers would be two places to fix the .NET date parsing.
 *
 * The document id follows the QuickBooks precedent (`DocNumber ?? Id`):
 * `InvoiceNumber` when the organisation sets one, `InvoiceID` otherwise. Worth
 * knowing rather than discovering: `InvoiceNumber` is editable in Xero, so
 * renumbering a document makes the sync see a new record. That is the same
 * hazard the QuickBooks track already carries, and keeping the two tracks
 * identical matters more than either one being individually clever — a row this
 * dataset serves must be indistinguishable across tracks.
 */
function xeroDocumentLookup(
  record: unknown,
  idColumn: "invoice_id" | "bill_id",
  partyColumn: "customer_id" | "vendor_id",
): VendorLookup {
  return (column: string): unknown => {
    switch (column) {
      case idColumn:
        return field(record, "InvoiceNumber") || field(record, "InvoiceID");
      case "issued_at":
        return xeroInstant(field(record, "Date"));
      case "due_at":
        return xeroInstant(field(record, "DueDate"));
      case partyColumn:
        return xeroContactRef(field(record, "Contact"));
      // `Total` is the document's face value; `AmountDue` is what remains
      // unpaid. Summing `Total` instead of `AmountDue` overstates receivables
      // by every part-payment ever taken — `profiles.ts` states the rule and
      // this is the track it was written against.
      case "amount":
        return field(record, "Total");
      case "balance":
        return field(record, "AmountDue");
      case "status":
        return field(record, "Status");
      case "updated_at":
        return xeroInstant(field(record, "UpdatedDateUTC"));
      default:
        return undefined;
    }
  };
}

/**
 * One Xero contact → a canonical `contact` lookup.
 *
 * Two columns are left undefined on purpose, and both are statements rather
 * than oversights:
 *
 *   `created_at`       Xero publishes no creation time on the contact
 *                      resource. It stays present-and-undefined exactly as
 *                      `profiles.ts` specifies for a column a track has no
 *                      source for; dropping the key would make a contact
 *                      missing a date indistinguishable from one whose date is
 *                      absent.
 *   `lifecycle_stage`  Xero's `ContactStatus` is ACTIVE / ARCHIVED /
 *                      GDPRREQUEST — a RECORD state, not a position in a sales
 *                      pipeline. Mapping it here would put a filing status
 *                      under a column every other track fills with a
 *                      pipeline stage, and a caller comparing the two would be
 *                      comparing different facts that happen to share a name.
 *
 * `last_name` falls back to `Name` and that fallback is load-bearing. A Xero
 * contact is a PARTY, not a person: an organisation — which most suppliers are
 * — carries a `Name` and no `LastName` at all. `find_contact` searches by
 * last-name prefix, so leaving it undefined for organisations would make every
 * supplier on the ledger unfindable by the one read the dataset has.
 */
function xeroContactLookup(record: unknown): VendorLookup {
  return (column: string): unknown => {
    switch (column) {
      case "contact_id":
        return field(record, "ContactID");
      case "first_name":
        return field(record, "FirstName");
      case "last_name":
        return field(record, "LastName") || field(record, "Name");
      case "email":
        return field(record, "EmailAddress");
      case "updated_at":
        return xeroInstant(field(record, "UpdatedDateUTC"));
      // `created_at`, `company_id` and `lifecycle_stage` — see the docstring.
      default:
        return undefined;
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Wiring types
// ─────────────────────────────────────────────────────────────────────────────

type FetchLike = (input: string, init?: Record<string, unknown>) => Promise<Response>;

/** Resolve one field of the sealed customer-credential bundle. */
export type XeroSecretResolver = (field: string) => Promise<string>;

/** The default resolver: nothing wired, so the track blocks honestly. */
export const blockedXeroSecretResolver: XeroSecretResolver = async () => {
  throw new ConnectorBlockedError("resolve the Xero client secret", XERO_TRACK_REMEDIATION);
};

export interface XeroConnectorConfig {
  /**
   * The connection row's id — the token cache's key.
   *
   * Required rather than optional: without it two connections would share a
   * cache slot and one organisation's token would be presented to the other's
   * books. An empty string is refused at construction.
   */
  connectionId: string;
  /** The Custom Connection's client id. A public identifier, from
   *  `providerConfig` — never decrypted, never a secret. */
  clientId: string;
  /** Which authentication path this row is on. Parsed, then refused when it is
   *  the path this build does not implement. */
  credentialVariant: string;
  /** Pointer into the encrypted secret store — NEVER a credential. */
  credentialsSecretRef: string;
  /** API base. Operator-configured, and guarded on construction. */
  baseUrl?: string;
  /** Identity base. Same guard, same reason. */
  identityBaseUrl?: string;
}

export interface XeroConnectorDeps {
  fetchImpl?: FetchLike;
  now?: () => number;
  /** Resolve the client secret from the sealed bundle. Absent → the track
   *  keeps its own blocked resolver and degrades honestly. */
  resolveSecret?: XeroSecretResolver;
  timeoutMs?: number;
}

/**
 * The ADR-041 §5 connection-state vocabulary, extended with the two states this
 * vendor forces.
 *
 * Explicit, never inferred from a missing credential and never derived from a
 * read that happened to return nothing — an absent value defaulted into
 * "connected" is exactly the looks-connected-syncs-nothing failure that section
 * exists to prevent.
 *
 * `not_implemented` is a state and not an error-only condition because a row
 * on the PKCE path is a configured row: the hub has to be able to render "this
 * connection names a path Droplet does not run" rather than showing it as
 * merely disconnected, which would invite the owner to try connecting again.
 */
export type XeroConnectionState =
  | "disconnected"
  | "connected"
  | "needs_reconnect"
  | "scope_missing"
  | "rate_limited"
  | "not_implemented";

const REMEDIATION_BY_STATE: Readonly<Record<XeroConnectionState, string | null>> = {
  disconnected: XERO_TRACK_REMEDIATION,
  connected: null,
  needs_reconnect:
    "Xero rejected the stored client credential. Re-authorise the Custom Connection in " +
    "Xero's developer portal and paste its current client id and secret here.",
  scope_missing:
    "the Custom Connection authenticates but is missing a read scope. Add it in Xero's " +
    "developer portal — note that editing a live connection deactivates it until it is " +
    "re-authorised, and that removing a broad scope there cannot be undone.",
  rate_limited:
    "Xero is throttling this organisation (60 calls a minute, 5,000 a day). The box backs " +
    "off and resumes on its own; nothing is lost.",
  not_implemented: XERO_PKCE_NOT_IMPLEMENTED_REMEDIATION,
};

export interface XeroStatus {
  state: XeroConnectionState;
  ok: boolean;
  /** Whether a client secret resolves. NEVER the secret — the SMTP settings
   *  view's `hasPassword` convention (ADR-042 §4). */
  hasCredential: boolean;
  /** Whether a minted access token is currently held in memory. A liveness
   *  fact, not a credential; the token itself never leaves this module. */
  hasAccessToken: boolean;
  credentialVariant: string;
  /** The client id — a public identifier, and the only way an owner can tell
   *  two Xero connections apart on the hub. */
  clientId: string;
  pollIntervalFloorMs: number;
  remediation: string | null;
}

/** One organisation this credential can reach, as `/connections` returns it. */
export interface XeroTenantConnection {
  /** The CONNECTION id — what `DELETE /connections/{id}` takes. Not the tenant
   *  id, and mixing the two deletes nothing while reporting success. */
  id: string;
  tenantId: string;
  tenantName: string | null;
}

/** The outcome of a vendor-side decommission (WARP-2408). */
export type XeroDecommissionResult =
  | { state: "revoked"; connections: number }
  | { state: "nothing_to_revoke" };

export class XeroConnector implements Connector {
  readonly provider = XERO_PROVIDER;
  readonly servesDatasets = XERO_DATASETS;

  private readonly now: () => number;
  private readonly resolveSecret: XeroSecretResolver;
  private readonly fetchImpl?: FetchLike;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly identityBaseUrl: string;
  private readonly variant: XeroCredentialVariant;

  private fingerprint: string | null = null;
  /** The last state an actual exchange with Xero established. An explicit
   *  value, never derived from a NULL or from a read returning nothing. */
  private observedState: XeroConnectionState = "connected";
  /** Whether a credential has ever resolved on this instance. Reported as a
   *  boolean and never as a value (rule 19). */
  private credentialResolved = false;

  constructor(
    private readonly config: XeroConnectorConfig,
    deps: XeroConnectorDeps = {},
  ) {
    this.now = deps.now ?? (() => Date.now());
    this.resolveSecret = deps.resolveSecret ?? blockedXeroSecretResolver;
    this.fetchImpl = deps.fetchImpl;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Refused at CONSTRUCTION, all three of them, so a row that cannot work
    // fails to build loudly rather than looking fine until the first read ships
    // a credential.
    if (config.connectionId.trim() === "") {
      throw new ConnectorBlockedError(
        "construct (the Xero connection has no row id)",
        XERO_TRACK_REMEDIATION,
      );
    }
    this.variant = assertXeroVariantImplemented(config.credentialVariant);
    this.baseUrl = assertSafeXeroBaseUrl(config.baseUrl ?? XERO_API_BASE_URL);
    this.identityBaseUrl = assertSafeXeroBaseUrl(
      config.identityBaseUrl ?? XERO_IDENTITY_BASE_URL,
    );
  }

  private blocked(op: string, detail?: string): ConnectorBlockedError {
    return new ConnectorBlockedError(detail ? `${op} (${detail})` : op, XERO_TRACK_REMEDIATION);
  }

  // ── Token ─────────────────────────────────────────────────────────────────

  /**
   * A usable access token, minted if the cached one is gone or nearly gone.
   *
   * There is no refresh path in this file and there must not be one: a Custom
   * Connection issues NO refresh token (ADR-042 §6), so "refresh" would be a
   * method that could only ever throw. Re-minting from the stored client
   * credential is the whole mechanism.
   */
  private async token(op: string): Promise<string> {
    const cached = xeroTokenCache.get(this.config.connectionId);
    if (cached && cached.expiresAt - this.now() > XERO_TOKEN_EARLY_MINT_MS) {
      this.credentialResolved = true;
      return cached.accessToken;
    }
    const minted = await this.mint(op);
    xeroTokenCache.set(this.config.connectionId, minted);
    return minted.accessToken;
  }

  /**
   * Exchange the client credential for an access token.
   *
   * The secret travels in an HTTP Basic header rather than in the form body:
   * both are permitted by RFC 6749 and Xero accepts either, but a body is what
   * gets logged when somebody adds a request-body log line during an incident.
   * Neither the id nor the secret is ever interpolated into a URL.
   */
  private async mint(op: string): Promise<XeroAccessToken> {
    const secret = await this.resolveSecret("clientSecret");
    this.credentialResolved = true;
    const basic = Buffer.from(`${this.config.clientId}:${secret}`, "utf8").toString("base64");
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      scope: XERO_SCOPES.join(" "),
    }).toString();

    const doFetch = this.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    if (!doFetch) throw this.blocked(op, "no fetch implementation available");

    let res: Response;
    try {
      res = await doFetch(`${this.identityBaseUrl}/connect/token`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body,
        // Never follow a 3xx: the fetch spec strips Authorization on
        // cross-origin redirects, but the credential's safety must not rest on
        // every runtime implementing that correctly. This endpoint has no
        // legitimate redirect, so one is a fault, not a hop.
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw this.blocked(op, `Xero identity unreachable: ${(err as Error).message}`);
    }

    if (res.status === 400 || res.status === 401) {
      // Xero answers a deactivated, deleted or wrong-secret Custom Connection
      // with `invalid_client` / `invalid_grant` here. The response BODY is not
      // read into the message: it echoes request parameters, and a mis-pasted
      // secret in a client id field would land in the log line (rule 19).
      this.observedState = "needs_reconnect";
      throw new XeroReauthorizationRequiredError(`Xero identity returned ${res.status}`);
    }
    if (res.status === 429) {
      this.observedState = "rate_limited";
      throw new XeroRateLimitedError("token endpoint", res.headers.get("Retry-After"));
    }
    if (!res.ok) throw this.blocked(op, `Xero identity returned ${res.status}`);

    let parsed: Record<string, unknown>;
    try {
      parsed = (await res.json()) as Record<string, unknown>;
    } catch (err) {
      throw this.blocked(op, `unparseable Xero token response: ${(err as Error).message}`);
    }
    const accessToken = parsed.access_token;
    if (typeof accessToken !== "string" || accessToken === "") {
      // A 200 with no token is a contract break, not a token we should guess
      // at. Reported as blocked rather than as a reauthorization ask, because
      // there is nothing the owner can do about Xero's response shape.
      throw this.blocked(op, "Xero returned a token response with no access_token");
    }
    // Xero's own `expires_in` wins, BOUNDED ON BOTH SIDES — the documented 30
    // minutes is the fallback and the ceiling, not a second opinion.
    //
    // The lower bound is the finding on #1946. `Number.isFinite` admits `0`
    // and negatives, and either one lands `expiresAt` at or before `now`, so
    // the early-mint check in `token()` can never be satisfied: the cache
    // holds an entry that is never served, and EVERY read mints a fresh token
    // first. That is one identity call per API call against a ceiling of sixty
    // calls a minute per organisation and — the limit allowed-egress.yaml
    // names as the binding one — ten thousand a minute for the whole app
    // across every box in the fleet. One customer's malformed token response
    // would spend a budget shared with every other customer.
    //
    // The upper bound is the same argument in the other direction. Cached past
    // the real expiry, a token Xero has already stopped accepting is presented
    // on read after read, and each 401 is reported as REAUTHORIZE_REQUIRED —
    // asking an owner to fix a credential that was never broken.
    //
    // A SHORTER value is still followed: this is a ceiling, not a floor, so a
    // vendor that shortens its tokens is obeyed. `> 0` also rejects `NaN`,
    // which is why the guard is written as a positive test rather than as a
    // negated `<= 0`.
    const stated = parsed.expires_in;
    const expiresIn =
      typeof stated === "number" && stated > 0
        ? Math.min(stated * 1000, XERO_ACCESS_TOKEN_TTL_MS)
        : XERO_ACCESS_TOKEN_TTL_MS;
    this.observedState = "connected";
    return { accessToken, expiresAt: this.now() + expiresIn };
  }

  // ── Requests ──────────────────────────────────────────────────────────────

  /**
   * One Accounting API request.
   *
   * `ifModifiedSince` is the WARP-2417 bound and is passed on EVERY list read
   * the caller has a watermark for: Xero applies it server-side against
   * `UpdatedDateUTC`, so an unchanged ledger costs one call rather than a full
   * enumeration.
   */
  private async get(
    op: string,
    resource: string,
    opts: {
      search?: Record<string, string | number | undefined>;
      ifModifiedSince?: string;
    } = {},
  ): Promise<Record<string, unknown>> {
    // Checked BEFORE the credential is resolved, so an off-allowlist resource
    // never reaches the network and never even touches the secret.
    assertReadableXeroResource(resource);
    const token = await this.token(op);

    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.search ?? {})) {
      if (v !== undefined) qs.set(k, String(v));
    }
    const url = `${this.baseUrl}/api.xro/2.0/${resource}${qs.toString() ? `?${qs}` : ""}`;

    const doFetch = this.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    if (!doFetch) throw this.blocked(op, "no fetch implementation available");

    let res: Response;
    try {
      res = await doFetch(url, {
        method: "GET",
        headers: {
          // The token goes in a header and never in a query string: a
          // credential in a URL is a credential in every proxy log.
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(opts.ifModifiedSince ? { "If-Modified-Since": opts.ifModifiedSince } : {}),
        },
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw this.blocked(op, `Xero API unreachable: ${(err as Error).message}`);
    }

    // A conditional GET Xero chose to answer literally. Not an error and not a
    // fault: it means nothing changed, which is a legitimate empty page.
    if (res.status === 304) return {};

    if (res.status === 401) {
      // The cached token is dead — drop it so the next call mints rather than
      // replaying a rejected one. This is the ONE place a 401 is not
      // immediately terminal: an expired token that raced the early-mint
      // window looks identical to a revoked credential from here, and the
      // distinction is made by the retry, not by guessing.
      forgetXeroToken(this.config.connectionId);
      this.observedState = "needs_reconnect";
      throw new XeroReauthorizationRequiredError("Xero returned 401");
    }
    if (res.status === 403) {
      this.observedState = "scope_missing";
      throw new XeroScopeMissingError(resource, XeroConnector.scopeFor(resource));
    }
    if (res.status === 429) {
      this.observedState = "rate_limited";
      throw new XeroRateLimitedError(
        // Xero names which ceiling was hit in this header, which is the whole
        // difference between "wait a minute" and "wait until tomorrow".
        res.headers.get("X-Rate-Limit-Problem") ?? "unspecified limit",
        res.headers.get("Retry-After"),
      );
    }
    if (!res.ok) throw this.blocked(op, `Xero API returned ${res.status}`);

    this.observedState = "connected";
    try {
      return (await res.json()) as Record<string, unknown>;
    } catch (err) {
      throw this.blocked(op, `unparseable Xero response: ${(err as Error).message}`);
    }
  }

  /** Which scope a 403 on a resource is asking for. See
   *  {@link SCOPE_BY_RESOURCE}. */
  private static scopeFor(resource: string): string {
    return SCOPE_BY_RESOURCE[resource] ?? SCOPE_TRANSACTIONS;
  }

  /**
   * Every page of a Xero list resource.
   *
   * Bounded three ways, because the loop's only natural exit is a short page:
   * a page ceiling ({@link XERO_MAX_PAGES}), a no-progress guard (an endpoint
   * that ignores `page` serves the identical window forever, so the short-page
   * exit can never fire), and a whole-read wall-clock deadline
   * ({@link XERO_MAX_READ_WALL_MS}). Each aborts as a
   * {@link ConnectorBlockedError} — a fault to report, never an empty success.
   */
  private async pull(
    op: string,
    resource: string,
    collection: string,
    opts: { where?: string; ifModifiedSince?: string } = {},
  ): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    const startedAt = this.now();
    let lastFullPageFingerprint: string | null = null;

    for (let page = 1; ; page += 1) {
      // Both bounds are checked BEFORE the next request, so a read that is
      // already over costs no further network and no further metered calls.
      if (page > XERO_MAX_PAGES) {
        throw new ConnectorBlockedError(
          `${op} stopped after ${XERO_MAX_PAGES} pages (${XERO_MAX_PAGES * XERO_PAGE_SIZE} records)`,
          "the endpoint kept returning full pages; aborting rather than spending the " +
            "organisation's whole daily Xero allowance on one read. If a real " +
            "organisation holds more records than this, raise XERO_MAX_PAGES " +
            "deliberately (WARP-2383) — do not let a single read run open-ended.",
        );
      }
      if (this.now() - startedAt > XERO_MAX_READ_WALL_MS) {
        throw new ConnectorBlockedError(
          `${op} exceeded its ${XERO_MAX_READ_WALL_MS / 60_000}-minute wall-clock budget`,
          "no healthy organisation reads for this long; aborting rather than pinning the " +
            "connection and its daily allowance open. Retry later — an endpoint that is " +
            "persistently this slow is a Xero-side fault to report, not one more page " +
            "away from finishing.",
        );
      }

      const body = await this.get(op, resource, {
        search: {
          page,
          // WARP-2417 — only where Xero documents it. Sending it to an endpoint
          // that does not support it is an unknown parameter, and Xero's
          // handling of one is not something this code should bet a read on.
          ...(XERO_READABLE_RESOURCES[resource]?.summaryOnly ? { summaryOnly: "true" } : {}),
          ...(opts.where ? { where: opts.where } : {}),
        },
        ifModifiedSince: opts.ifModifiedSince,
      });

      const raw = body[collection];
      // Absent stays absent — a 304, or a page past the end, carries no
      // collection key at all and that is a legitimate "no rows". Only a
      // present, non-nullish, non-array value is a contract break.
      if (raw != null && !Array.isArray(raw)) {
        throw new ConnectorBlockedError(
          `${op} returned a non-array ${collection} (${typeof raw})`,
          "Xero's response did not match the documented Accounting API contract, which " +
            "returns the collection as an array. Refusing to interpret it rather than " +
            "guessing at a shape — report the response if this persists.",
        );
      }
      const items = (raw ?? []) as Record<string, unknown>[];
      if (items.length < XERO_PAGE_SIZE) {
        rows.push(...items);
        return rows;
      }

      // A full page must prove the window MOVED before the loop is trusted with
      // another call. Two byte-identical full pages in a row means `page` is
      // being ignored and every further page would be the same one.
      const fingerprint = JSON.stringify(items);
      if (fingerprint === lastFullPageFingerprint) {
        throw new ConnectorBlockedError(
          `${op} aborted: pagination is not advancing`,
          "Xero returned the identical full page twice in a row, so the page parameter is " +
            "being ignored and the read can never complete. Looping would spend the whole " +
            "daily allowance on one read — retry later, and report the endpoint if this " +
            "persists.",
        );
      }
      lastFullPageFingerprint = fingerprint;
      rows.push(...items);
    }
  }

  // ── Connector interface ───────────────────────────────────────────────────

  async connect(): Promise<void> {
    // A cheap, real read proves three things at once: the credential mints a
    // token, the token reaches the organisation, and egress to Xero is
    // permitted. `Organisation` is the cheapest such read and returns exactly
    // one record.
    await this.get("connect", "Organisation");
    this.fingerprint = computeSchemaFingerprint(this.tables());
  }

  async close(): Promise<void> {
    // The MINTED token deliberately survives: it is cached per CONNECTION, not
    // per connector instance, and `erp.service` builds and closes a connector
    // per read. Dropping it here would mint a token for every read, which is
    // the defect the module-level cache exists to prevent. It is dropped by
    // `forgetXeroToken` on disconnect and by `pruneExpiredXeroTokens` on
    // expiry — both of which are events, not the end of one read.
    this.credentialResolved = false;
  }

  async health(): Promise<{ ok: boolean }> {
    // Derived from the same explicit state `status()` reports, not from
    // whichever fields happen to be populated. Rejecting rather than returning
    // `{ ok: false }` is the blocked-boundary contract: a caller that ignores a
    // return value cannot ignore a rejection.
    const state = await this.currentState();
    if (state === "needs_reconnect") {
      throw new XeroReauthorizationRequiredError("the stored client credential is not usable");
    }
    if (state === "scope_missing") {
      throw new XeroScopeMissingError("this organisation", "accounting.transactions.read");
    }
    if (state === "rate_limited") {
      throw new XeroRateLimitedError("this organisation", null);
    }
    if (state === "disconnected") {
      throw this.blocked("health", "no Xero organisation is connected");
    }
    return { ok: true };
  }

  /** The canonical shape this track serves. Synthesized rather than
   *  introspected: Xero's schema is Xero's, published and versioned, so there
   *  is nothing to discover — but the fingerprint still has to exist so
   *  drift-freeze semantics stay coherent across every track. */
  private tables(): IntrospectedTable[] {
    return XERO_DATASETS.map((dataset) => ({
      name: dataset,
      owner: XERO_PROVIDER,
      columns: CANONICAL_COLUMNS[dataset].map((name) => ({ name, type: "text" })),
    }));
  }

  async introspect(): Promise<IntrospectionResult> {
    const tables = this.tables();
    // Pin the API version INTO the fingerprint: Xero can change field shapes
    // within `2.0` without changing our column list, and a fingerprint blind to
    // that would report "no drift" across a real one.
    const fingerprint = computeSchemaFingerprint(tables) + ":xro2.0";
    this.fingerprint = fingerprint;
    return { tables, fingerprint };
  }

  /**
   * Serve a named read as canonical rows.
   *
   * The filter params are OPTIONAL, matching the HubSpot and Mailchimp tracks:
   * the registry's queries were written for the SQL track where every one
   * carries a mandatory filter, while the sync runner passes `{}` or
   * `{ since }` and expects the dataset ENUMERATED. A filter that is present
   * filters and one that is absent enumerates, so the same named read backs the
   * assistant's lookup and the poller's sweep without a second query name
   * meaning almost the same thing.
   *
   * `since` becomes the `If-Modified-Since` header rather than a client-side
   * filter — that is the WARP-2417 bound, and applying it after paging would
   * spend the whole enumeration to throw most of it away.
   */
  async runRead(name: string, params: Record<string, unknown>): Promise<unknown[]> {
    const query = getReadQuery(name);
    assertDatasetsServed(this.provider, this.servesDatasets, name, query.dependsOnTables);
    const op = `runRead:${name}`;
    const ifModifiedSince = xeroIfModifiedSince(params.since);

    switch (name) {
      case "get_open_invoices": {
        const rows = await this.documents(op, "ACCREC", "invoice", ifModifiedSince);
        return sortByKey(sortByKey(rows, "invoice_id"), "due_at");
      }
      case "get_open_bills": {
        const rows = await this.documents(op, "ACCPAY", "bill", ifModifiedSince);
        return sortByKey(sortByKey(rows, "bill_id"), "due_at");
      }
      case "find_contact": {
        const raw = await this.pull(op, "Contacts", "Contacts", { ifModifiedSince });
        const rows = raw.map((r) => projectCanonicalRow("contact", xeroContactLookup(r)));
        const prefix = XeroConnector.lowerText(params.query);
        const matched =
          prefix === undefined
            ? rows
            : rows.filter((r) => XeroConnector.lowerText(r.last_name)?.startsWith(prefix));
        return sortByKey(sortByKey(matched, "first_name"), "last_name");
      }
      default:
        // Unreachable while every served read is handled above; a new registry
        // entry on a served dataset lands here rather than silently returning
        // nothing, which would read as "your books are empty".
        throw this.blocked(op, "read is not served by the Xero track");
    }
  }

  /**
   * Invoices or bills, filtered to the OPEN ones.
   *
   * The `Type` predicate is pushed down to Xero (it is the only thing
   * distinguishing the two datasets in one resource) while the open predicate
   * is applied client-side, byte-identically to the QuickBooks and export-drop
   * tracks: a part-paid document is still money, status vocabularies differ,
   * and a balance we could not read is money we cannot account for and must
   * stay visible rather than be quietly dropped.
   */
  private async documents(
    op: string,
    type: "ACCREC" | "ACCPAY",
    dataset: "invoice" | "bill",
    ifModifiedSince: string | undefined,
  ): Promise<CanonicalRow[]> {
    const raw = await this.pull(op, "Invoices", "Invoices", {
      where: `Type=="${type}"`,
      ifModifiedSince,
    });
    const idColumn = dataset === "invoice" ? "invoice_id" : "bill_id";
    const partyColumn = dataset === "invoice" ? "customer_id" : "vendor_id";
    return raw
      .map((r) => projectCanonicalRow(dataset, xeroDocumentLookup(r, idColumn, partyColumn)))
      .filter((row) => typeof row.balance !== "number" || row.balance !== 0);
  }

  async applyWrite(name: string, _params: Record<string, unknown>): Promise<unknown> {
    // Same validation order as every other track, so a caller bug produces the
    // same typed error here as anywhere else...
    const cmd = getWriteCommand(name);
    assertTargetAllowed(cmd.targetTable);
    // ...and then this track refuses. The scopes it asks Xero for are read-only
    // (`XERO_SCOPES`), so a write would fail at the vendor even if this method
    // tried — but "we didn't build it" is not enforceable and this is.
    throw this.blocked(
      `applyWrite:${name}`,
      "the Xero track is read-only: it requests read scopes only, and writing to a " +
        "customer's books needs its own ticket, an outbox and a human confirmation step",
    );
  }

  // ── Xero-specific surface ─────────────────────────────────────────────────

  /**
   * The general-ledger journals a Custom Connection can actually read.
   *
   * **`/Journals` is not this**, and reaching for it is the mistake this method
   * exists to prevent: that endpoint is the full general ledger, it sits behind
   * `accounting.journals.read`, and Xero stopped granting that scope to NEW
   * Custom Connections on 2026-04-29. A connection created today cannot read it
   * at all, so a connector written against it would authenticate, 403, and look
   * broken. `/ManualJournals` is the adjustments feed a Custom Connection can
   * be granted under `accounting.transactions.read`, and it is what answers
   * "what did the bookkeeper post by hand".
   *
   * Returns Xero's records as they arrive rather than canonical rows, because
   * there is **no canonical dataset for a journal**: no member of the closed
   * 23-name union in `../export-drop/profiles.ts` has a journal's column list
   * (an entry is a set of LINES, each an account code and a signed amount, and
   * nothing in the vocabulary holds a line at all). Inventing a name is a
   * vocabulary decision with every track's blast radius — the rule that file
   * states is to compare column lists and take an existing name only when they
   * match, and here they do not. Recorded as a gap on WARP-2414 rather than
   * resolved by forcing it into `account` or `balance_transaction`, either of
   * which would let an arithmetic run on columns that mean something else.
   */
  async listManualJournals(since?: unknown): Promise<Record<string, unknown>[]> {
    return this.pull("listManualJournals", "ManualJournals", "ManualJournals", {
      ifModifiedSince: xeroIfModifiedSince(since),
    });
  }

  /**
   * The organisations this credential can reach.
   *
   * A Custom Connection reaches exactly one, so this returns a single-element
   * list in normal operation — but it is read rather than assumed, because the
   * `id` it carries is what {@link decommission} deletes and guessing an
   * identifier that deletes something is not a risk worth taking.
   *
   * NOTE the two ids. `id` is the CONNECTION id and is what
   * `DELETE /connections/{id}` takes; `tenantId` identifies the organisation.
   * Passing the tenant id to the delete succeeds at the HTTP level and revokes
   * nothing, which is the worst possible outcome for a revocation call.
   */
  async listTenantConnections(): Promise<XeroTenantConnection[]> {
    const op = "listTenantConnections";
    const token = await this.token(op);
    const doFetch = this.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    if (!doFetch) throw this.blocked(op, "no fetch implementation available");

    let res: Response;
    try {
      res = await doFetch(`${this.baseUrl}/connections`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw this.blocked(op, `Xero API unreachable: ${(err as Error).message}`);
    }
    if (res.status === 401) {
      forgetXeroToken(this.config.connectionId);
      this.observedState = "needs_reconnect";
      throw new XeroReauthorizationRequiredError("Xero returned 401");
    }
    if (!res.ok) throw this.blocked(op, `Xero /connections returned ${res.status}`);

    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      throw this.blocked(op, `unparseable Xero /connections response: ${(err as Error).message}`);
    }
    if (!Array.isArray(body)) {
      throw this.blocked(op, "Xero /connections did not return an array");
    }
    return body
      .map((row) => ({
        id: String(field(row, "id") ?? ""),
        tenantId: String(field(row, "tenantId") ?? ""),
        tenantName: typeof field(row, "tenantName") === "string"
          ? (field(row, "tenantName") as string)
          : null,
      }))
      .filter((c) => c.id !== "");
  }

  /**
   * WARP-2408 — sever the connection AT XERO.
   *
   * `GET /connections` then `DELETE /connections/{id}` for each. This is the
   * one thing ADR-042 §6 says we generally cannot do — *"we cannot rotate what
   * we did not mint"* — and Xero is the exception worth taking: the customer's
   * Custom Connection is BILLED MONTHLY, per organisation, so one left behind
   * on a decommissioned box keeps charging them. `docs/integrations/xero.md`
   * says exactly that under Revocation.
   *
   * Deliberately NOT wired into the generic `disconnect()` route, and that is a
   * decision rather than an omission. That route's purge is a SERIALIZABLE
   * transaction whose whole guarantee is that the credential and the sync
   * cursors go together; a network call to a vendor that can hang, 429 or fail
   * has no business inside it, and a vendor-side revoke that fails must never
   * block the box-side purge. Wiring it needs a generic
   * `Connector.decommission?()` seam plus a decision about ordering and
   * failure, which is its own ticket. Recorded as a gap on WARP-2408.
   *
   * Xero also publishes a token-revocation endpoint, and it is deliberately NOT
   * called: it revokes a REFRESH token, and a Custom Connection has none.
   */
  async decommission(): Promise<XeroDecommissionResult> {
    const op = "decommission";
    const connections = await this.listTenantConnections();
    if (connections.length === 0) return { state: "nothing_to_revoke" };

    const token = await this.token(op);
    const doFetch = this.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    if (!doFetch) throw this.blocked(op, "no fetch implementation available");

    let revoked = 0;
    for (const conn of connections) {
      let res: Response;
      try {
        res = await doFetch(`${this.baseUrl}/connections/${encodeURIComponent(conn.id)}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          redirect: "error",
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        throw this.blocked(op, `Xero API unreachable: ${(err as Error).message}`);
      }
      // 404 counts as revoked: the connection is gone, which is the outcome
      // asked for. Treating it as a failure would make a second decommission
      // of an already-severed connection look like an error.
      if (res.ok || res.status === 404) {
        revoked += 1;
        continue;
      }
      throw this.blocked(op, `Xero DELETE /connections returned ${res.status}`);
    }
    // The minted token is now worthless and must not be replayed against a
    // reconnected organisation.
    forgetXeroToken(this.config.connectionId);
    return { state: "revoked", connections: revoked };
  }

  // ── State ─────────────────────────────────────────────────────────────────

  /**
   * Map what we know onto the connection-state vocabulary.
   *
   * RESOLVES the credential rather than reading whatever a previous call
   * happened to cache, so a connection that has simply never been read from
   * does not report `disconnected` while being perfectly well configured — the
   * inferred-from-absence failure ADR-041 §5 exists to prevent, and which the
   * QuickBooks track reproduced once inside the very field meant to prevent it.
   */
  private async currentState(): Promise<XeroConnectionState> {
    if (xeroTokenCache.has(this.config.connectionId)) return this.observedState;
    try {
      await this.resolveSecret("clientSecret");
      this.credentialResolved = true;
    } catch {
      // No credential resolvable = the owner has not connected an
      // organisation. Not an error: it is the shipped-off state ADR-041 §2
      // requires.
      return "disconnected";
    }
    return this.observedState;
  }

  async status(): Promise<XeroStatus> {
    const state = await this.currentState();
    return {
      state,
      // One source of truth: `ok` is derived from `state` rather than computed
      // independently, so the two cannot disagree inside one returned object.
      ok: state === "connected",
      // The SMTP settings convention (ADR-042 §4): report THAT a credential
      // exists, never its value. Nothing in this object can carry credential
      // material — `clientId` is a public identifier, not a secret.
      hasCredential: this.credentialResolved,
      hasAccessToken: xeroTokenCache.has(this.config.connectionId),
      credentialVariant: this.variant,
      clientId: this.config.clientId,
      pollIntervalFloorMs: XERO_POLL_INTERVAL_FLOOR_MS,
      remediation: REMEDIATION_BY_STATE[state],
    };
  }

  /** The last computed schema fingerprint, or null before `introspect()`. */
  get schemaFingerprint(): string | null {
    return this.fingerprint;
  }

  /** Case-folded text for a comparison, or undefined for an absent value. */
  private static lowerText(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const raw = value.trim();
    return raw === "" ? undefined : raw.toLowerCase();
  }
}
