/**
 * WARP-1294 — dual-track ERP connector selection (the single place a provider
 * key maps to a concrete Connector).
 *
 *  - "eaglesoft"      → EaglesoftConnector    (direct SAP SQL Anywhere)
 *  - "eaglesoft-api"  → EaglesoftApiConnector (Patterson official REST API,
 *                       Innovation Connection, HTTPS :9888)
 *
 * Both implement the SAME `Connector` interface. integrations.service
 * (connect / test) selects the provider from the ConnectInput and persists it
 * on `IntegrationConnection.provider` (free-form TEXT). erp.service (read /
 * write) hands this factory `conn.provider` from the row it resolves — and that
 * resolver now finds EITHER track's row, so the API branch is reached in
 * production, not only from tests.
 *
 * This module also assembles the three things the REST connector needs before
 * it can reach a box, all of which live on the connection row:
 *
 *   apiCredentialsEnc  → decrypted here into a `resolveSecret` closure
 *   apiRouteMap        → validated here into the discovered route contract
 *   apiCaCert          → turned here into a CA-trusting undici dispatcher
 *
 * Each is optional, and each resolves to `undefined` when absent or unusable.
 * That is the honest-degradation contract: an unconfigured or half-configured
 * connection leaves the connector blocked (ERP_NOT_CONNECTED) rather than
 * authenticating with empty strings, trusting an unverified certificate, or
 * guessing a URL. The SQL branch is byte-for-byte the prior behaviour and
 * ignores all three.
 */
import { Agent } from "undici";
import { config } from "../config.js";
import { encryptSecret, decryptSecret } from "./encryption.service.js";
import { deriveErpCloudTokenKey, encryptColumn, decryptColumn } from "./column-crypto.service.js";
// WARP-2466 — the customer-supplied credential store (WARP-2275). Imported
// for `openSaasCredentials` only: this module builds connectors, and the
// sealing/validation half stays where the route can reach it.
import { openSaasCredentials } from "./saas-credential.service.js";
import { readFileSync } from "node:fs";
import {
  EaglesoftConnector,
  EaglesoftApiConnector,
  ExportDropConnector,
  QuickBooksOnlineConnector,
  DentrixAscendConnector,
  CallBudget,
  ConnectorBlockedError,
  QBO_TRACK_REMEDIATION,
  DEFAULT_PORT,
  DEFAULT_DATABASE_NAME,
  DEFAULT_API_HTTPS_PORT,
  DEFAULT_CALL_CEILING,
  QUICKBOOKS_ONLINE_PROVIDER,
  DENTRIX_ASCEND_PROVIDER,
  // WARP-2466 — the three WARP-2214 SaaS tracks.
  StripeConnector,
  HubSpotConnector,
  MailchimpConnector,
  STRIPE_PROVIDER,
  HUBSPOT_PROVIDER,
  MAILCHIMP_PROVIDER,
  HUBSPOT_TRACK_REMEDIATION,
  MAILCHIMP_TRACK_REMEDIATION,
  // WARP-2296 — the fourth WARP-2214 SaaS track.
  ShopifyConnector,
  SHOPIFY_PROVIDER,
  SHOPIFY_TRACK_REMEDIATION,
  // WARP-2383 — the Xero accounting track.
  XeroConnector,
  XERO_PROVIDER,
  XERO_TRACK_REMEDIATION,
  // WARP-2708 / WARP-2709 / WARP-2710 — wave 1 of the ADR-046 vendor programme.
  // Two fixed-host tracks and one per-account host.
  BrevoConnector,
  BREVO_PROVIDER,
  KlaviyoConnector,
  KLAVIYO_PROVIDER,
  PipedriveConnector,
  PIPEDRIVE_PROVIDER,
  PIPEDRIVE_TRACK_REMEDIATION,
  exportProviders,
  parseProfileJson,
  vendorFromExportProvider,
  type Connector,
  type EaglesoftApiRouteMap,
  type ExportProfile,
  type QboTokens,
  type AscendToken,
} from "@droplet/erp-connector";
// WARP-2217 — the declarative provider registry. Provider identity, credential
// field definitions, egress hosts, datasets and rate-limit policy are DATA in
// `@droplet/shared-types`, read by this module AND by the dashboard's connector
// catalog, so the two can no longer hold divergent ideas of what a provider is.
import {
  providerDescriptor,
  buildableProviderIds,
  cloudProviderIds,
  parseProviderConfigWith,
  providerConfigNumber,
  providerConfigString,
  CREDENTIAL_VARIANT_FIELD,
  type ProviderConfig,
  type ProviderDescriptor,
} from "@droplet/shared-types";

/** The flagship direct-SQL provider (framework provider #1). */
export const EAGLESOFT_PROVIDER = "eaglesoft";
/** The dual-track official-REST-API provider. */
export const EAGLESOFT_API_PROVIDER = "eaglesoft-api";
/**
 * The direct-connection provider keys — the two tracks that reach a practice's
 * system of record over the network.
 *
 * The export-drop track (WARP-1964) is deliberately NOT in this list: its
 * provider keys are `<vendor>-export` and the set of vendors is open, because
 * an operator profile can introduce one at runtime. Use
 * {@link isKnownErpProvider}, which covers both, rather than testing membership
 * here.
 *
 * WARP-2217 — DERIVED from the descriptor registry rather than hand-written.
 * Catalog-only descriptors (hub cards with no shipped transport) are excluded,
 * so a placeholder can never be named by a connection row. Pinned against the
 * pre-change literal list by a set-equality test: dropping a descriptor goes
 * red rather than silently un-shipping a provider.
 */
export const KNOWN_ERP_PROVIDERS: readonly string[] = buildableProviderIds();

/** The cloud tracks, which take their account identity from `providerConfig`
 *  and their credentials from `providerTokensEnc` rather than from the LAN
 *  columns. Used to decide whether a row needs cloud material resolved.
 *
 *  WARP-2217 — derived from the descriptors' `track`, not hand-maintained
 *  alongside the list above. The cloud/LAN distinction is preserved as a
 *  descriptor field rather than erased: a cloud row genuinely needs different
 *  material resolved, so a caller has to be able to ask. */
export const CLOUD_ERP_PROVIDERS: readonly string[] = cloudProviderIds();

export function isCloudErpProvider(provider: string): boolean {
  return providerDescriptor(provider)?.track === "cloud";
}

/**
 * Operator-authored export profiles, read fresh on every call.
 *
 * Deliberately not memoized: an installer correcting a column mapping at a
 * practice should be able to fix the file and reconnect, not restart the
 * orchestrator. The file is small and this runs once per connector build.
 *
 * A malformed file yields no profiles plus the parser's message, which the
 * connector reports as its blocked reason — so a JSON typo says "your profile
 * file has a typo, here it is" instead of the misleading "no profile is
 * registered for this vendor".
 */
export function loadOperatorExportProfiles(): { profiles: ExportProfile[]; error: string | null } {
  const path = config.ERP_EXPORT_DROP_PROFILES;
  if (!path) return { profiles: [], error: null };
  try {
    return { profiles: parseProfileJson(readFileSync(path, "utf8")), error: null };
  } catch (err) {
    return { profiles: [], error: `ERP_EXPORT_DROP_PROFILES: ${(err as Error).message}` };
  }
}

/** True for a provider key this factory can build — either direct-connection
 *  track, or an export-drop key for a vendor we have a profile for. */
export function isKnownErpProvider(provider: string): boolean {
  // Read the registry live rather than the import-time snapshot above, so a
  // descriptor registered at runtime is admitted without a restart.
  //
  // WARP-2650 — an explicit `lan | cloud` allow-list, matching
  // `buildableProviderIds()`. It was `!== "catalog"`, which was the same set
  // while three tracks existed; the `mcp` track is a valid connection provider
  // with no connector at all, so the negative form would have answered "yes,
  // this factory can build it" and then thrown.
  const descriptor = providerDescriptor(provider);
  if (descriptor) return descriptor.track === "lan" || descriptor.track === "cloud";
  if (!vendorFromExportProvider(provider)) return false;
  return exportProviders(loadOperatorExportProfiles().profiles).includes(provider);
}

/**
 * True for a provider key that can hold an `IntegrationConnection` row.
 *
 * WARP-2659 — wider than {@link isKnownErpProvider} by exactly the `mcp`
 * track, and the two are deliberately separate predicates. `isKnownErpProvider`
 * answers "can this factory build a connector", which is the right gate for
 * `connect()`, `test()` and the write toggle: every one of them needs a
 * connector, and ADR-043 §3 forbids writing through an MCP track in any case.
 * An MCP track has NO connector — it holds a row and a sealed credential
 * (`saas-credential.service.ts`), and its session is the bridge's — so a
 * lifecycle operation that acts on the ROW, `disconnect()`'s purge, has to
 * admit it or ADR-043 §7's "purged on disconnect" has no implementation.
 *
 * An explicit allow-list, like the predicate above and for the same reason:
 * `!== "catalog"` would admit a fifth track the day it appears, before anyone
 * has said whether it holds a row.
 */
export function isConnectionProvider(provider: string): boolean {
  const descriptor = providerDescriptor(provider);
  if (descriptor) {
    return (
      descriptor.track === "lan" || descriptor.track === "cloud" || descriptor.track === "mcp"
    );
  }
  // No descriptor: the export-drop family, which `isKnownErpProvider` owns.
  return isKnownErpProvider(provider);
}

/** The connection facts both call sites share (a ConnectInput or a ConnRow).
 *  `secretRef` is a POINTER into the encrypted secret store — never cleartext. */
export interface ConnectorSelector {
  provider: string;
  host: string;
  /** SQL: TCP port (default 2638). API: HTTPS port (default 9888). */
  port?: number;
  serverName?: string;
  databaseName?: string;
  secretRef?: string;

  // --- REST-track material (ignored by the SQL provider) -------------------

  /** CLEARTEXT credentials for this call only — resolved by the caller from
   *  `IntegrationConnection.apiCredentialsEnc`, held just long enough to build
   *  the connector, and never persisted or logged from here. */
  apiCredentials?: ResolvedApiCredentials;
  /** The DISCOVERED route contract. Absent → the connector stays blocked and
   *  says so, rather than guessing a URL. */
  apiRouteMap?: EaglesoftApiRouteMap;
  /** PEM of the CA to trust for this box. Absent → system trust store. */
  apiCaCert?: string;

  // --- Cloud-track material (ignored by every LAN provider) ----------------

  /** The connection row's id. Identity for the shared call budget and the AAD
   *  the token blob is sealed against — absent means neither can be used, which
   *  is why `test()` (which has no row yet) never reaches a metered read. */
  connectionId?: string;
  /** Validated per-provider connection facts from `providerConfig`. Absent →
   *  the connector is constructed blocked, never with a guessed identifier. */
  providerConfig?: ProviderConfig;
  /** Resolve/persist hooks for the track's OAuth tokens. Absent → the
   *  connector keeps its own blocked resolver and degrades honestly. */
  cloudTokens?: CloudTokenAccess;
}

/** Read/rotate the cloud track's tokens. `persist` exists because Intuit
 *  rotates the refresh token on every use — see `providerTokensEnc`. */
export interface CloudTokenAccess {
  resolveQbo?: () => Promise<QboTokens>;
  persistQbo?: (tokens: QboTokens) => Promise<void>;
  resolveAscend?: () => Promise<AscendToken>;
  /**
   * WARP-2466 — resolve one named secret field out of the sealed
   * customer-credential bundle.
   *
   * GENERIC BY FIELD NAME, never by vendor: which fields exist and which are
   * secret is the descriptor's answer, so this seam has no idea whether it is
   * handing back a Stripe restricted key or a HubSpot token. A `provider ===`
   * comparison in here would mean the descriptor was under-specified, which is
   * the bug to fix instead.
   *
   * REJECTS rather than returning `""` when the field is absent: an empty
   * credential is indistinguishable from "not configured", and the connector
   * would then reach the vendor with nothing and collect an opaque 401 in
   * place of a diagnosable refusal.
   */
  resolveSaasSecret?: (field: string) => Promise<string>;
}

/** The credential triple the REST track authenticates with. */
export interface ResolvedApiCredentials {
  integrationKey: string;
  userId: string;
  password: string;
}

/** Encrypt the credential triple for storage in
 *  `IntegrationConnection.apiCredentialsEnc`. The caller persists the returned
 *  blob verbatim; cleartext never leaves this call. */
export function encodeApiCredentials(creds: ResolvedApiCredentials): string {
  return encryptSecret(JSON.stringify(creds));
}

/**
 * Decrypt a stored credential blob.
 *
 * Returns `undefined` — rather than throwing — when the blob is absent,
 * undecryptable (e.g. DEVICE_SECRET_KEY rotated), or not the expected shape.
 * That is deliberate and load-bearing: `connectorForProvider` reads undefined
 * as "no credentials", which leaves the connector's own `blockedSecretResolver`
 * in place, so the connection degrades to the honest ERP_NOT_CONNECTED path
 * instead of throwing out of a read handler. Callers should log the miss —
 * silent is fine for the USER, not for the operator.
 */
export function decodeApiCredentials(enc: string | null | undefined): ResolvedApiCredentials | undefined {
  if (!enc) return undefined;
  try {
    const parsed: unknown = JSON.parse(decryptSecret(enc));
    if (!parsed || typeof parsed !== "object") return undefined;
    const { integrationKey, userId, password } = parsed as Record<string, unknown>;
    if (typeof integrationKey !== "string" || typeof userId !== "string" || typeof password !== "string") {
      return undefined;
    }
    return { integrationKey, userId, password };
  } catch {
    return undefined;
  }
}

/**
 * Narrow a persisted JSON value to a route map.
 *
 * Structural check, not a cast: a row written by an older build (or by hand)
 * must not be handed to the connector as though it were a contract. A map that
 * fails this returns undefined, and the connector then blocks and says the
 * route map is missing — which is true and actionable — rather than throwing
 * somewhere deeper with a confusing message.
 *
 * The check is deliberately shallow. Per-route validity (does this op have a
 * verb AND a template?) is the connector's own `isRouteDiscovered`, which
 * refuses per-operation; duplicating it here would just add a second place to
 * keep in sync.
 */
export function parseRouteMap(value: unknown): EaglesoftApiRouteMap | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { authenticate, reads, writes } = value as Record<string, unknown>;
  const isObj = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v);
  if (!isObj(authenticate) || !isObj(reads) || !isObj(writes)) return undefined;
  return value as EaglesoftApiRouteMap;
}

/** The REST-track columns, as they come off an IntegrationConnection row. */
export interface ApiConnectionRow {
  apiCredentialsEnc?: string | null;
  apiRouteMap?: unknown;
  apiCaCert?: string | null;
}

/** Map a persisted row's REST-track columns onto the selector fields
 *  `connectorForProvider` consumes. Decryption/validation failures collapse to
 *  undefined, i.e. "not configured" — see decodeApiCredentials. */
export function apiMaterialFromRow(row: ApiConnectionRow): Pick<
  ConnectorSelector,
  "apiCredentials" | "apiRouteMap" | "apiCaCert"
> {
  return {
    apiCredentials: decodeApiCredentials(row.apiCredentialsEnc),
    apiRouteMap: parseRouteMap(row.apiRouteMap),
    apiCaCert: row.apiCaCert ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// WARP-2137 — cloud-track connection material.
// ---------------------------------------------------------------------------

/** The validated shape of `IntegrationConnection.providerConfig`. Defined in
 *  `@droplet/shared-types` and re-exported here so existing importers of this
 *  module are unaffected by where it moved. */
export type { ProviderConfig };

/**
 * Narrow a persisted `providerConfig` for `provider`.
 *
 * Structural check, not a cast — the same rule `parseRouteMap` follows, and for
 * the same reason: a row written by an older build, by hand, or for a different
 * provider must not be handed to a connector as though it were a contract.
 *
 * Returns undefined when the value is absent, malformed, missing the identifier
 * the track cannot work without (`realmId` / `organizationId`), or belongs to a
 * provider that has no `providerConfig` concept at all. The factory reads
 * undefined as "not configured" and constructs the connector in its blocked
 * state, so the connection degrades to ERP_NOT_CONNECTED instead of calling
 * Intuit with an empty company id and collecting an opaque 4xx.
 *
 * WARP-2217 — the per-provider `switch` is gone. Field-by-field validation now
 * walks the descriptor's `credentialFields`, so a new provider's rules are
 * declared once alongside the form that collects them instead of being
 * re-implemented in a new case arm. `erp-provider.equivalence.test.ts` pins
 * this against the switch's captured behaviour, fixture by fixture, including
 * every rejection path — that table was written and watched pass BEFORE the
 * switch was deleted, and it is the whole safety argument for this change.
 *
 * The behaviours that table locks in, so a later edit does not quietly lose
 * them: strings are validated but NOT trimmed; a required field that is absent,
 * blank or the wrong type rejects the whole config; an optional one is simply
 * dropped (a nonsense `callCeiling` must not block a connection that is
 * otherwise fine, and must not silently restore the default while the row looks
 * configured); every declared field is emitted as a key in declaration order,
 * present even when undefined, because a persisted config is JSON.
 */
export function parseProviderConfig(provider: string, value: unknown): ProviderConfig | undefined {
  return parseProviderConfigWith(providerDescriptor(provider), value);
}

/** Encrypt a cloud track's tokens for `providerTokensEnc`. AAD-bound to the
 *  connection id so a blob on the wrong row fails closed. */
export function encodeCloudTokens(connectionId: string, tokens: unknown): string {
  return encryptColumn(deriveErpCloudTokenKey(), JSON.stringify(tokens), connectionId);
}

/**
 * Decrypt a stored cloud-token blob.
 *
 * Returns undefined rather than throwing on every failure path — absent,
 * undecryptable (DEVICE_SECRET_KEY rotated by a factory reset), sealed against
 * a different row, or not JSON. Same honest-degradation contract as
 * `decodeApiCredentials`: undefined leaves the connector's own blocked resolver
 * in place instead of throwing out of a read handler.
 */
function decodeCloudTokens(connectionId: string, enc: string | null | undefined): unknown {
  if (!enc) return undefined;
  try {
    return JSON.parse(decryptColumn(deriveErpCloudTokenKey(), enc, connectionId));
  } catch {
    return undefined;
  }
}

/** Narrow a decoded blob to QuickBooks Online's token quadruple. */
export function parseQboTokens(value: unknown): QboTokens | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { accessToken, refreshToken, accessExpiresAt, refreshExpiresAt } = value as Record<
    string,
    unknown
  >;
  if (typeof accessToken !== "string" || typeof refreshToken !== "string") return undefined;
  if (typeof accessExpiresAt !== "number" || typeof refreshExpiresAt !== "number") return undefined;
  return { accessToken, refreshToken, accessExpiresAt, refreshExpiresAt };
}

/** Narrow a decoded blob to Dentrix Ascend's bearer token. */
export function parseAscendToken(value: unknown): AscendToken | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { accessToken, expiresAt } = value as Record<string, unknown>;
  if (typeof accessToken !== "string" || typeof expiresAt !== "number") return undefined;
  return { accessToken, expiresAt };
}

/** The cloud-track columns, as they come off an IntegrationConnection row. */
export interface CloudConnectionRow {
  id: string;
  provider: string;
  providerConfig?: unknown;
  /**
   * The cloud-track credential column, and the ONE the SaaS resolver reads.
   *
   * ADR-042 §5 is the authority: a customer-supplied credential is sealed here
   * under `deriveSaasCredentialKey()`, AAD-bound to the row id. WARP-2453
   * (#1827) reconciled the configurator onto it after WARP-2275 had written
   * `apiCredentialsEnc` — that column is the Eaglesoft REST track's static
   * {integrationKey,userId,password} triple under the older `encryptSecret`,
   * on a LAN transport this never touches.
   *
   * TWO WRITERS, disjoint by PROVIDER and each failing closed against the
   * other. The ERP cloud track (QuickBooks Online, Dentrix Ascend) seals
   * rotating OAuth material under `deriveErpCloudTokenKey()`; the SaaS tracks
   * seal a pasted credential bundle under `deriveSaasCredentialKey()` with the
   * `saas-credential:<rowId>` AAD. A row is one provider, so only one writer
   * ever owns a given blob — and if the wrong opener is tried, GCM's tag check
   * fails and the caller sees "no credential", never somebody else's. The
   * branches below reflect that: QBO and Ascend return before the generic
   * SaaS branch is reached.
   */
  providerTokensEnc?: string | null;
  /** The Eaglesoft REST triple. Read by the LAN path, never by the SaaS
   *  resolver — a different transport with its own encryption vintage. */
  apiCredentialsEnc?: string | null;
}

/**
 * The per-connection metered-call budget, kept OUTSIDE the connector.
 *
 * WARP-2137 finding #2, and the reason this module owns a module-level map:
 * `erp.service` builds and closes a connector per read ("one handshake per
 * read"). A `CallBudget` constructed inside the factory would therefore be born
 * fresh on every read, and QuickBooks Online's ceiling — the thing standing
 * between one box and the whole fleet's metered Intuit allowance — would reset
 * before it could ever be reached. Keying it by connection id makes the ceiling
 * mean what its name says: per connection, across reads, for the life of the
 * process.
 *
 * Rebuilt when the configured ceiling changes so an operator lowering it takes
 * effect without a restart; the spend resets in that case, which is the honest
 * reading of "a new ceiling was chosen deliberately".
 */
const callBudgets = new Map<
  string,
  { budget: CallBudget; ceiling: number; periodMs: number | undefined }
>();

export function sharedCallBudget(
  connectionId: string,
  ceiling: number,
  now: () => number = () => Date.now(),
  /** Budget period. Undefined keeps `CallBudget`'s own 30-day default, which is
   *  what every caller got before the descriptor supplied one. */
  periodMs?: number,
): CallBudget {
  const existing = callBudgets.get(connectionId);
  if (existing && existing.ceiling === ceiling && existing.periodMs === periodMs) {
    return existing.budget;
  }
  const budget = new CallBudget(ceiling, now, periodMs);
  callBudgets.set(connectionId, { budget, ceiling, periodMs });
  return budget;
}

/**
 * WARP-2217 — the metered-call policy, read from the descriptor.
 *
 * The ceiling used to be a bare `DEFAULT_CALL_CEILING` constant reached for at
 * the QuickBooks branch of the factory, which meant a second metered provider
 * would have had to add a second constant and a second branch. It is now a
 * per-provider `rateLimit` on the descriptor, with the operator override named
 * by the descriptor too (`ceilingOverrideField`) so the override cannot drift
 * away from the field definition that validates it.
 *
 * The shipped values are UNCHANGED and pinned by a table test — this is a move,
 * not a retune. `DEFAULT_CALL_CEILING` survives as the last resort so a
 * descriptor that loses its `rateLimit` degrades to today's number rather than
 * to an unmetered connection.
 */
function meteredBudgetFor(
  descriptor: ProviderDescriptor | undefined,
  config: ProviderConfig | undefined,
  connectionId: string | undefined,
): { ceiling: number; budget: CallBudget | undefined } {
  const rateLimit = descriptor?.rateLimit;
  const override = rateLimit?.ceilingOverrideField
    ? providerConfigNumber(config, rateLimit.ceilingOverrideField)
    : undefined;
  const ceiling = override ?? rateLimit?.callCeiling ?? DEFAULT_CALL_CEILING;
  return {
    ceiling,
    // The budget must OUTLIVE this connector — see sharedCallBudget. With no
    // connection id (the `test()` path, which has no row yet) there is no
    // identity to key a shared budget by, so none is injected and the connector
    // falls back to its own per-instance one. That path performs a validation
    // handshake, not a metered read loop.
    budget: connectionId
      ? sharedCallBudget(connectionId, ceiling, undefined, rateLimit?.periodMs)
      : undefined,
  };
}

/** Drop a connection's budget — call when the connection is deleted, so a
 *  reused id cannot inherit a stranger's spend. Also the test seam. */
export function forgetCallBudget(connectionId: string): void {
  callBudgets.delete(connectionId);
}

/** Test seam: clear every budget between cases. */
export function __resetCallBudgetsForTest(): void {
  callBudgets.clear();
}

/**
 * Map a persisted row's cloud columns onto the selector fields the factory
 * consumes. Validation failures collapse to undefined — "not configured".
 */
export function cloudMaterialFromRow(
  row: CloudConnectionRow,
): Pick<ConnectorSelector, "connectionId" | "providerConfig" | "cloudTokens"> {
  const providerConfig = parseProviderConfig(row.provider, row.providerConfig);
  const decoded = decodeCloudTokens(row.id, row.providerTokensEnc);

  if (row.provider === QUICKBOOKS_ONLINE_PROVIDER) {
    const tokens = parseQboTokens(decoded);
    return {
      connectionId: row.id,
      providerConfig,
      cloudTokens: tokens
        ? {
            resolveQbo: async () => tokens,
            // Intuit rotates the refresh token on every use. Writing it back is
            // not bookkeeping: skip it and the NEXT refresh replays a superseded
            // token, which Intuit rejects, and the connection is stranded until
            // a human re-consents.
            persistQbo: async (next: QboTokens) => {
              await persistCloudTokens(row.id, next);
            },
          }
        : undefined,
    };
  }

  if (row.provider === DENTRIX_ASCEND_PROVIDER) {
    const token = parseAscendToken(decoded);
    return {
      connectionId: row.id,
      providerConfig,
      cloudTokens: token ? { resolveAscend: async () => token } : undefined,
    };
  }

  // WARP-2466 — every other cloud track: the customer-supplied credential
  // bundle. Descriptor-driven and vendor-free, so a fourth SaaS vendor needs
  // no edit here at all.
  //
  // The provider must be a KNOWN cloud descriptor before we hand back a
  // resolver: an unrecognised key reaching this line means a row written by a
  // newer build, and `connectorForProvider` refuses it by name a moment later.
  const descriptor = providerDescriptor(row.provider);
  if (descriptor?.track === "cloud" && row.providerTokensEnc) {
    const blob = row.providerTokensEnc;
    return {
      connectionId: row.id,
      providerConfig,
      cloudTokens: {
        resolveSaasSecret: async (field: string) => {
          // Opened per call and never cached: the cleartext lives for the
          // length of one request. `openSaasCredentials` THROWS on a blob
          // sealed for another row (the AAD tag check), which is the failure
          // we want — a credential that silently belonged to someone else
          // would authenticate as the wrong company.
          const secrets = openSaasCredentials(row.id, blob);
          const value = secrets[field];
          if (!value) {
            throw new ConnectorBlockedError(
              `resolve the ${row.provider} credential`,
              "the stored credential bundle carries no value for this field — " +
                "re-enter it from the Integrations page",
            );
          }
          return value;
        },
      },
    };
  }

  return { connectionId: row.id, providerConfig, cloudTokens: undefined };
}

/**
 * Write rotated tokens back to the row.
 *
 * Injected rather than imported so this module keeps its "build a connector"
 * job and does not take a Prisma dependency; `erp.service` supplies the real
 * writer at startup. Unset in a unit test, the persister is a no-op, which is
 * correct for a test that never rotates a real token.
 */
type CloudTokenWriter = (connectionId: string, blob: string) => Promise<void>;
let cloudTokenWriter: CloudTokenWriter | null = null;

export function setCloudTokenWriter(writer: CloudTokenWriter | null): void {
  cloudTokenWriter = writer;
}

async function persistCloudTokens(connectionId: string, tokens: unknown): Promise<void> {
  if (!cloudTokenWriter) return;
  await cloudTokenWriter(connectionId, encodeCloudTokens(connectionId, tokens));
}

/**
 * Build an undici dispatcher that trusts `caPem` — how the connector is given
 * TLS trust for a box whose certificate chains to a private CA (Patterson's
 * PdcoTechCA in production, the harness's own CA in a rehearsal).
 *
 * Returns undefined when no CA is supplied, which falls back to the system
 * trust store. There is deliberately no "skip verification" path: a box we
 * cannot verify is a box we refuse, and that refusal is asserted by
 * erp-connector's live-box suite.
 *
 * WARP-2626 — this Agent comes from the npm `undici`, and a dispatcher is only
 * honoured by the undici that minted it. The connector therefore routes any
 * dispatcher-carrying request through that same package's `fetch` rather than
 * the runtime's built-in one (`api-auth.ts:resolveFetch`), so this trust model
 * survives a Node major bump instead of degrading into a bare `fetch failed`
 * that reads as an unreachable box. Nothing extra is needed here — but do NOT
 * "simplify" the connector back onto `globalThis.fetch`; that is the defect.
 */
export function dispatcherForCa(caPem: string | undefined): unknown {
  if (!caPem) return undefined;
  return new Agent({ connect: { ca: caPem } });
}

// ---------------------------------------------------------------------------
// WARP-2217 — the connector factory registry.
//
// This replaces the if-chain that used to dispatch on `sel.provider`. Each
// provider's construction lives in one registered function keyed by its
// descriptor id, so adding a vendor is registering one more entry rather than
// editing a chain every other vendor PR is also editing.
//
// The factories are kept HERE rather than on the descriptor on purpose: a
// descriptor is pure data shipped to the browser, and a closure that constructs
// a `@droplet/erp-connector` class would drag a server-only package across the
// dashboard's RSC boundary — a break neither `tsc` nor `vitest` can see.
// ---------------------------------------------------------------------------

/** What a factory is handed. The config is ALREADY narrowed to this provider,
 *  so no factory re-checks whose config it was given. */
export interface ConnectorBuildContext {
  readonly selector: ConnectorSelector;
  /** The descriptor for `selector.provider`. Absent only for the export-drop
   *  track, whose keys are an open family rather than enumerated descriptors. */
  readonly descriptor?: ProviderDescriptor;
  /** The row's validated `providerConfig`, or undefined when the row carries
   *  none / carries one belonging to a different provider. */
  readonly config?: ProviderConfig;
}

export type ConnectorFactory = (ctx: ConnectorBuildContext) => Connector;

const connectorFactories = new Map<string, ConnectorFactory>();

/**
 * Register a provider's connector factory.
 *
 * The extension seam that makes AC #7 true: a sixth provider is one descriptor
 * plus one registration plus its egress allowlist entries — this module is not
 * edited at all. Exercised in-repo by the fixture provider in
 * `erp-provider.descriptor.test.ts`.
 */
export function registerConnectorFactory(provider: string, factory: ConnectorFactory): void {
  connectorFactories.set(provider, factory);
}

/** Drop a registration. Test seam, so a fixture provider does not leak into the
 *  next file's registry. */
export function unregisterConnectorFactory(provider: string): void {
  connectorFactories.delete(provider);
}

/**
 * The SQL track (framework provider #1), and the historical default shape.
 *
 * No longer the fallback for an unrecognised key — see `connectorForProvider`.
 */
registerConnectorFactory(EAGLESOFT_PROVIDER, ({ selector: sel }) =>
  new EaglesoftConnector(
    {
      host: sel.host,
      port: sel.port ?? DEFAULT_PORT,
      serverName: sel.serverName ?? sel.databaseName ?? DEFAULT_DATABASE_NAME,
      databaseName: sel.databaseName || DEFAULT_DATABASE_NAME,
      readSecretRef: sel.secretRef ?? "",
    },
    {
      // Same honest-degradation rule as the API track's three optionals: an
      // empty URL leaves `bridgeUrl` undefined, so the connector keeps its
      // blocked I/O boundary and reports that the SAP client is missing —
      // which is the accurate remediation for a box with no bridge deployed.
      bridgeUrl: config.ERP_SQL_BRIDGE_URL || undefined,
    },
  ),
);

/** The Patterson official-REST track (Innovation Connection, HTTPS :9888). */
registerConnectorFactory(EAGLESOFT_API_PROVIDER, ({ selector: sel }) => {
  const credentials = sel.apiCredentials;
  return new EaglesoftApiConnector(
    {
      host: sel.host,
      httpsPort: sel.port ?? DEFAULT_API_HTTPS_PORT,
      // Pointer only — the label that appears in logs and audit rows. The
      // cleartext arrives out-of-band via `apiCredentials` below and is never
      // written into the config object.
      credentialsSecretRef: sel.secretRef ?? "",
      routeMap: sel.apiRouteMap,
    },
    {
      dispatcher: dispatcherForCa(sel.apiCaCert),
      // Only wire a resolver when credentials were actually resolved. Leaving
      // it undefined keeps the connector's own `blockedSecretResolver`, so an
      // unconfigured connection blocks honestly instead of authenticating with
      // empty strings and getting an opaque 401.
      resolveSecret: credentials ? async () => credentials : undefined,
    },
  );
});

// WARP-2137 — the ADR-041 cloud tracks. Both run IN-PROCESS, not in the
// erp-sql-bridge sidecar: that sidecar exists to isolate a NATIVE driver, and
// an HTTPS API needs none (ADR-041, and the eaglesoft-api precedent above).
//
// Each is constructed from `providerConfig` and, when present, a resolver over
// the decrypted token blob. An absent config or absent tokens leaves the
// connector's own blocked resolver in place — the same honest-degradation rule
// the REST track follows — so a half-configured connection reports
// ERP_NOT_CONNECTED rather than reaching a vendor with a missing identifier.
registerConnectorFactory(QUICKBOOKS_ONLINE_PROVIDER, ({ selector: sel, descriptor, config: cfg }) => {
  const realmId = providerConfigString(cfg, "realmId");
  // Unlike DentrixAscendConnector, QuickBooksOnlineConnector does NOT validate
  // its realm id — an empty one builds fine and produces the URL
  // `/v3/company//query`, so an unconfigured row would spend a METERED call
  // asking Intuit about a company that does not exist. Refuse here, where the
  // row is known to be unconfigured, and refuse as a ConnectorBlockedError so
  // the read degrades to ERP_NOT_CONNECTED like every other absent-material
  // path rather than surfacing as a fault.
  if (!realmId) {
    throw new ConnectorBlockedError(
      "construct (no QuickBooks company id configured)",
      QBO_TRACK_REMEDIATION,
    );
  }
  const { ceiling, budget } = meteredBudgetFor(descriptor, cfg, sel.connectionId);
  return new QuickBooksOnlineConnector(
    {
      realmId,
      baseUrl: providerConfigString(cfg, "baseUrl"),
      credentialsSecretRef: sel.secretRef ?? "",
      callCeiling: ceiling,
    },
    {
      resolveTokens: sel.cloudTokens?.resolveQbo,
      persistTokens: sel.cloudTokens?.persistQbo,
      budget,
    },
  );
});

registerConnectorFactory(DENTRIX_ASCEND_PROVIDER, ({ selector: sel, config: cfg }) =>
  new DentrixAscendConnector(
    {
      // Empty rather than refused here: unlike QuickBooks, this connector
      // validates its own Organization-ID at construction and blocks, so
      // duplicating the refusal would just move the same message.
      organizationId: providerConfigString(cfg, "organizationId") ?? "",
      locationId: providerConfigString(cfg, "locationId"),
      baseUrl: providerConfigString(cfg, "baseUrl"),
      credentialsSecretRef: sel.secretRef ?? "",
    },
    { resolveToken: sel.cloudTokens?.resolveAscend },
  ),
);

/**
 * WARP-2466 — the three WARP-2214 SaaS tracks.
 *
 * Each takes an injected `fetch` (defaulted inside the connector) and a
 * resolver over the sealed credential bundle. An absent bundle leaves the
 * connector's OWN blocked resolver in place, so a half-configured row reports
 * ERP_NOT_CONNECTED rather than dialing a vendor with nothing — the same
 * honest-degradation rule every other track follows.
 *
 * Note what is NOT here: no key material, no vendor host, no `if (provider
 * === …)` inside the resolver. The factories name their descriptor's field
 * names and nothing else about the credential.
 */
registerConnectorFactory(STRIPE_PROVIDER, ({ selector: sel, config: cfg }) => {
  const resolve = sel.cloudTokens?.resolveSaasSecret;
  return new StripeConnector(
    {
      credentialsSecretRef: sel.secretRef ?? "",
      baseUrl: providerConfigString(cfg, "baseUrl"),
      monthlyReadAllocation: providerConfigNumber(cfg, "monthlyReadAllocation"),
    },
    // `resolveApiKey` left undefined when nothing is sealed, so the connector
    // keeps `blockedStripeKeyResolver` and says what is missing.
    { resolveApiKey: resolve ? () => resolve("apiKey") : undefined },
  );
});

registerConnectorFactory(HUBSPOT_PROVIDER, ({ selector: sel, config: cfg }) => {
  const portalId = providerConfigString(cfg, "portalId");
  // Refused here rather than inside the connector, for the QuickBooks reason:
  // the Search governor is keyed on the portal id, and a connection that
  // cannot name its portal cannot share the ACCOUNT-wide 5 req/s ceiling with
  // its siblings. Building it anyway would produce a connector that looks
  // correct and 429s under load.
  if (!portalId) {
    throw new ConnectorBlockedError(
      "construct (no HubSpot portal id configured)",
      HUBSPOT_TRACK_REMEDIATION,
    );
  }
  const resolve = sel.cloudTokens?.resolveSaasSecret;
  return new HubSpotConnector(
    {
      portalId,
      credentialsSecretRef: sel.secretRef ?? "",
      baseUrl: providerConfigString(cfg, "baseUrl"),
    },
    { resolveToken: resolve ? () => resolve("accessToken") : undefined },
  );
});

registerConnectorFactory(MAILCHIMP_PROVIDER, ({ selector: sel, config: cfg }) => {
  const datacenter = providerConfigString(cfg, "datacenter");
  // The datacentre SELECTS THE HOST. Without it there is no destination at
  // all, and guessing one would mean assembling a URL whose first label is the
  // string "undefined". Read from `providerConfig`, never re-derived from the
  // key, so answering "where does this dial?" never decrypts a credential.
  if (!datacenter) {
    throw new ConnectorBlockedError(
      "construct (no Mailchimp datacentre configured)",
      MAILCHIMP_TRACK_REMEDIATION,
    );
  }
  const resolve = sel.cloudTokens?.resolveSaasSecret;
  return new MailchimpConnector(
    {
      credentialsSecretRef: sel.secretRef ?? "",
      datacenter,
      connectionId: sel.connectionId ?? "",
      baseUrl: providerConfigString(cfg, "baseUrl"),
    },
    { resolveApiKey: resolve ? () => resolve("apiKey") : undefined },
  );
});

registerConnectorFactory(SHOPIFY_PROVIDER, ({ selector: sel, config: cfg }) => {
  const shopDomain = providerConfigString(cfg, "shopDomain");
  // The store domain SELECTS THE HOST — for the API *and* for the token mint,
  // because Shopify's client-credentials grant posts to the store's own origin
  // rather than to a central OAuth host. Without it there is no destination at
  // all, and guessing one would mean assembling a URL whose first label is the
  // string "undefined". Read from `providerConfig`, never derived from the
  // credentials, so answering "where does this dial?" never decrypts a secret.
  //
  // Refused HERE rather than inside the connector, for the QuickBooks reason:
  // the row is known to be unconfigured at this point, and a
  // ConnectorBlockedError degrades to ERP_NOT_CONNECTED like every other
  // absent-material path instead of surfacing as a fault.
  if (!shopDomain) {
    throw new ConnectorBlockedError(
      "construct (no Shopify store domain configured)",
      SHOPIFY_TRACK_REMEDIATION,
    );
  }
  const resolve = sel.cloudTokens?.resolveSaasSecret;
  return new ShopifyConnector(
    {
      credentialsSecretRef: sel.secretRef ?? "",
      shopDomain,
      connectionId: sel.connectionId ?? "",
      baseUrl: providerConfigString(cfg, "baseUrl"),
    },
    // Both halves of the pair come through the SAME generic seam, named by
    // descriptor field name and nothing else. `resolveCredential` is left
    // undefined when nothing is sealed, so the connector keeps
    // `blockedShopifyCredentialResolver` and says what is missing.
    { resolveCredential: resolve ? (field) => resolve(field) : undefined },
  );
});

// WARP-2708 — Brevo. One FIXED host, so unlike Mailchimp and Pipedrive there is
// nothing to select and no per-connection destination to refuse: the base URL is
// a constant in the connector and `baseUrl` here is a test/staging override only.
registerConnectorFactory(BREVO_PROVIDER, ({ selector: sel, config: cfg }) => {
  const resolve = sel.cloudTokens?.resolveSaasSecret;
  return new BrevoConnector(
    {
      credentialsSecretRef: sel.secretRef ?? "",
      connectionId: sel.connectionId ?? "",
      baseUrl: providerConfigString(cfg, "baseUrl"),
      // NOT passing `dealCurrency`, deliberately. `parseProviderConfig` builds
      // its output from the DECLARED credential fields only, so a key the
      // descriptor does not declare never survives parsing and the read would
      // be `undefined` on every call — a dead read that looks like a
      // configurable setting. The connector resolves the account's display
      // currency itself instead. If per-connection override is ever wanted, it
      // is a descriptor field first, and this line second.
    },
    // Named by DESCRIPTOR FIELD NAME and nothing else — the same generic seam
    // every other cloud track uses. Left undefined when nothing is sealed, so
    // the connector keeps its blocked resolver and says what is missing.
    { resolveApiKey: resolve ? () => resolve("apiKey") : undefined },
  );
});

// WARP-2709 — Klaviyo. Fixed host. `apiRevision` is a non-secret connection
// fact in providerConfig rather than a constant, because the `revision` header
// is effectively an API-version pin: a connection that was working must be able
// to stay on the revision it was built against when the shipped default moves.
registerConnectorFactory(KLAVIYO_PROVIDER, ({ selector: sel, config: cfg }) => {
  const resolve = sel.cloudTokens?.resolveSaasSecret;
  return new KlaviyoConnector(
    {
      credentialsSecretRef: sel.secretRef ?? "",
      connectionId: sel.connectionId ?? "",
      baseUrl: providerConfigString(cfg, "baseUrl"),
      // Only `conversionMetricId` is read, because it is the only one of the
      // three the descriptor DECLARES — and an undeclared key does not survive
      // `parseProviderConfig`, so reading it would be `undefined` forever.
      //
      // `apiRevision` and `reportTimeframeKey` are deliberately NOT surfaced:
      // Klaviyo's `revision` header is an API-version pin, and putting a dated
      // string in front of a small-business owner is a worse failure than
      // shipping one considered default. The connector's own constant is that
      // default. Pinning a revision per connection is a real future need — it
      // is a descriptor field and a wizard decision when it arrives, not a
      // silent config key nothing can write.
      conversionMetricId: providerConfigString(cfg, "conversionMetricId"),
    },
    { resolveApiKey: resolve ? () => resolve("apiKey") : undefined },
  );
});

// WARP-2710 — Pipedrive. The company domain SELECTS THE HOST, so this is the
// Mailchimp shape: without it there is no destination at all, and guessing one
// would assemble a URL whose first label is the string "undefined". Read from
// `providerConfig`, never derived from the token, so answering "where does this
// dial?" never decrypts a credential — and a token swapped out-of-band cannot
// move the destination.
//
// Refused HERE rather than inside the connector, for the QuickBooks reason: the
// row is known to be unconfigured at this point, and a ConnectorBlockedError
// degrades to ERP_NOT_CONNECTED like every other absent-material path instead
// of surfacing as a fault.
registerConnectorFactory(PIPEDRIVE_PROVIDER, ({ selector: sel, config: cfg }) => {
  const companyDomain = providerConfigString(cfg, "companyDomain");
  if (!companyDomain) {
    throw new ConnectorBlockedError(
      "construct (no Pipedrive company domain configured)",
      PIPEDRIVE_TRACK_REMEDIATION,
    );
  }
  const resolve = sel.cloudTokens?.resolveSaasSecret;
  return new PipedriveConnector(
    {
      credentialsSecretRef: sel.secretRef ?? "",
      companyDomain,
      connectionId: sel.connectionId ?? "",
      baseUrl: providerConfigString(cfg, "baseUrl"),
      // NOT passing `burstCeiling` — same reason as Brevo's `dealCurrency`: an
      // undeclared key is dropped by `parseProviderConfig`, so the read is
      // `undefined` on every call. Pipedrive's burst allowance also scales with
      // the customer's plan and seat count, which is a fact to MEASURE from the
      // vendor's own rate-limit headers rather than to ask an owner to type.
    },
    { resolveApiToken: resolve ? () => resolve("apiToken") : undefined },
  );
});

/**
 * WARP-2383 — the Xero accounting track.
 *
 * Three things are refused HERE rather than inside the connector, all for the
 * QuickBooks reason — the row is known to be unconfigured at this point, and a
 * connector built anyway would look correct and then spend a metered call to
 * find out:
 *
 *   - **no connection id.** It is the minted-token cache's key. Without one,
 *     two connections would share a cache slot and one organisation's token
 *     could be presented against another's books.
 *   - **no client id.** The Custom Connection cannot be authenticated without
 *     it, and an empty one produces a Basic header of `:<secret>` — a request
 *     that ships the secret to Xero for no possible benefit.
 *   - **the wrong credential variant.** `assertXeroVariantImplemented` inside
 *     the connector's constructor turns a `pkce-app` row into a named,
 *     actionable refusal rather than an obscure failure at read time. It throws
 *     from the constructor, which is inside `connectorFor`'s try in both call
 *     sites, so it degrades like every other absent-material path.
 */
registerConnectorFactory(XERO_PROVIDER, ({ selector: sel, config: cfg }) => {
  const clientId = providerConfigString(cfg, "clientId");
  if (!sel.connectionId || !clientId) {
    throw new ConnectorBlockedError(
      sel.connectionId
        ? "construct (no Xero client id configured)"
        : "construct (no Xero connection row id)",
      XERO_TRACK_REMEDIATION,
    );
  }
  const resolve = sel.cloudTokens?.resolveSaasSecret;
  return new XeroConnector(
    {
      connectionId: sel.connectionId,
      clientId,
      // Read from the parsed config, which `parseProviderConfigResult` writes
      // under `CREDENTIAL_VARIANT_FIELD` for every variants-declaring
      // descriptor. NEVER defaulted here: which authentication path a
      // connection is on is persisted state, and guessing it is the
      // no-guessing-from-absence rule. An absent value reaches
      // `assertXeroVariantImplemented` and is refused by name.
      credentialVariant: providerConfigString(cfg, CREDENTIAL_VARIANT_FIELD) ?? "",
      credentialsSecretRef: sel.secretRef ?? "",
      baseUrl: providerConfigString(cfg, "baseUrl"),
    },
    // `resolveSecret` left undefined when nothing is sealed, so the connector
    // keeps `blockedXeroSecretResolver` and says what is missing.
    { resolveSecret: resolve ? (field: string) => resolve(field) : undefined },
  );
});

/**
 * WARP-1964 — the export-drop track.
 *
 * Matched on the `-export` SUFFIX rather than by descriptor id because the
 * vendor set is genuinely open: an operator profile can introduce
 * `<vendor>-export` at runtime, with no release and therefore no descriptor.
 * It is the one provider family that cannot be enumerated, which is why it
 * resolves before the registry rather than living in it.
 */
const exportDropFactory: ConnectorFactory = ({ selector: sel }) => {
  const { profiles, error } = loadOperatorExportProfiles();
  return new ExportDropConnector(
    {
      vendor: vendorFromExportProvider(sel.provider) ?? "",
      // Operator configuration only. `sel.host` is ignored on this track: the
      // share is mounted by the host, so the practice's file server is named in
      // the mount, not in a connection row we would then have to trust with a
      // path.
      root: config.ERP_EXPORT_DROP_ROOT,
      // `subdirectory` is intentionally left unset. The connector supports it
      // (with containment validation) for a future per-practice layout, but no
      // connection column means "which folder" today, and borrowing
      // `databaseName` would collide with its "PattersonPM" default and send
      // every export connection looking for a folder that does not exist.
    },
    { profiles, configError: error ?? undefined },
  );
};

function connectorFactoryFor(provider: string): ConnectorFactory | undefined {
  if (vendorFromExportProvider(provider)) return exportDropFactory;
  return connectorFactories.get(provider);
}

/** Remediation for a row naming a provider this build cannot construct. Says
 *  what to do (re-connect the integration) rather than naming an internal
 *  registry the owner has never heard of. */
const UNKNOWN_PROVIDER_REMEDIATION =
  "this connection names an integration this version of Droplet does not ship — " +
  "reconnect it from the Integrations page, or update the appliance if it was " +
  "connected on a newer build";

/**
 * Build the Connector for `sel.provider` — a single registry lookup.
 *
 * WARP-2217 — an unknown provider now THROWS. It used to fall through to the
 * SQL connector, on the reasoning that a stray value should not reach a
 * surprise transport. But the fallback WAS a surprise transport: a row naming
 * anything unrecognised got a SQL Anywhere connector pointed at that row's
 * `host`, and reported its failure as an Eaglesoft failure. Absence is never a
 * silent success (the no-guessing-state rule), so it is refused by name.
 *
 * It is a `ConnectorBlockedError` rather than a bare `Error` deliberately: both
 * call sites already treat that as ERP_NOT_CONNECTED, so a stale row degrades
 * to "this integration isn't connected" instead of a 500. Neither call site can
 * reach here in normal operation — `integrations.service` rejects an unknown
 * provider at `resolveProvider` before ever building, and `erp.service` builds
 * from a row whose provider passed that gate — so this is the belt to that
 * braces, for a row written by an older or newer build.
 */
export function connectorForProvider(sel: ConnectorSelector): Connector {
  const factory = connectorFactoryFor(sel.provider);
  if (!factory) {
    throw new ConnectorBlockedError(
      `construct (unknown ERP provider "${sel.provider}")`,
      UNKNOWN_PROVIDER_REMEDIATION,
    );
  }
  return factory({
    selector: sel,
    descriptor: providerDescriptor(sel.provider),
    // Narrowed once, here, rather than in every factory: a config belonging to
    // a different provider is no config at all.
    config: sel.providerConfig?.provider === sel.provider ? sel.providerConfig : undefined,
  });
}
