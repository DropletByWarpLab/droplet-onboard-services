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
  exportProviders,
  parseProfileJson,
  vendorFromExportProvider,
  type Connector,
  type EaglesoftApiRouteMap,
  type ExportProfile,
  type QboTokens,
  type AscendToken,
} from "@droplet/erp-connector";

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
 */
export const KNOWN_ERP_PROVIDERS: readonly string[] = [
  EAGLESOFT_PROVIDER,
  EAGLESOFT_API_PROVIDER,
  // WARP-2137 — the ADR-041 cloud tracks. They reach a vendor SaaS rather than
  // a box on the practice LAN, so `host` is unused and the account is named by
  // `providerConfig` instead. Both connectors shipped with their packages
  // (WARP-2109 / WARP-2127) but had no key mapped here, which made
  // `validateProvider` reject them and left them unreachable from the API.
  QUICKBOOKS_ONLINE_PROVIDER,
  DENTRIX_ASCEND_PROVIDER,
];

/** The cloud tracks, which take their account identity from `providerConfig`
 *  and their credentials from `providerTokensEnc` rather than from the LAN
 *  columns. Used to decide whether a row needs cloud material resolved. */
export const CLOUD_ERP_PROVIDERS: readonly string[] = [
  QUICKBOOKS_ONLINE_PROVIDER,
  DENTRIX_ASCEND_PROVIDER,
];

export function isCloudErpProvider(provider: string): boolean {
  return CLOUD_ERP_PROVIDERS.includes(provider);
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
  if (KNOWN_ERP_PROVIDERS.includes(provider)) return true;
  if (!vendorFromExportProvider(provider)) return false;
  return exportProviders(loadOperatorExportProfiles().profiles).includes(provider);
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

/** The validated shape of `IntegrationConnection.providerConfig`, discriminated
 *  by the row's provider. A cloud track cannot address an account without it. */
export type ProviderConfig =
  | { provider: typeof QUICKBOOKS_ONLINE_PROVIDER; realmId: string; baseUrl?: string; callCeiling?: number }
  | {
      provider: typeof DENTRIX_ASCEND_PROVIDER;
      organizationId: string;
      locationId?: string;
      baseUrl?: string;
    };

function optionalString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

/**
 * Narrow a persisted `providerConfig` for `provider`.
 *
 * Structural check, not a cast — the same rule `parseRouteMap` follows, and for
 * the same reason: a row written by an older build, by hand, or for a different
 * provider must not be handed to a connector as though it were a contract.
 *
 * Returns undefined when the value is absent, malformed, or missing the
 * identifier the track cannot work without (`realmId` / `organizationId`). The
 * factory reads undefined as "not configured" and constructs the connector in
 * its blocked state, so the connection degrades to ERP_NOT_CONNECTED instead of
 * calling Intuit with an empty company id and collecting an opaque 4xx.
 *
 * `callCeiling` is accepted only as a positive integer: a zero or negative
 * ceiling would either block every read or, read as falsy, silently restore the
 * default — both worse than ignoring a nonsense value and using the default
 * deliberately.
 */
export function parseProviderConfig(provider: string, value: unknown): ProviderConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;

  if (provider === QUICKBOOKS_ONLINE_PROVIDER) {
    const realmId = optionalString(v.realmId);
    if (!realmId) return undefined;
    const rawCeiling = v.callCeiling;
    const callCeiling =
      typeof rawCeiling === "number" && Number.isInteger(rawCeiling) && rawCeiling > 0
        ? rawCeiling
        : undefined;
    return {
      provider: QUICKBOOKS_ONLINE_PROVIDER,
      realmId,
      baseUrl: optionalString(v.baseUrl),
      callCeiling,
    };
  }

  if (provider === DENTRIX_ASCEND_PROVIDER) {
    const organizationId = optionalString(v.organizationId);
    if (!organizationId) return undefined;
    return {
      provider: DENTRIX_ASCEND_PROVIDER,
      organizationId,
      // Optional by design: without a location the connector still serves the
      // schedule and patients and refuses only the AR read, which is more
      // useful than refusing the whole connection.
      locationId: optionalString(v.locationId),
      baseUrl: optionalString(v.baseUrl),
    };
  }

  return undefined;
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
  providerTokensEnc?: string | null;
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
const callBudgets = new Map<string, { budget: CallBudget; ceiling: number }>();

export function sharedCallBudget(
  connectionId: string,
  ceiling: number,
  now: () => number = () => Date.now(),
): CallBudget {
  const existing = callBudgets.get(connectionId);
  if (existing && existing.ceiling === ceiling) return existing.budget;
  const budget = new CallBudget(ceiling, now);
  callBudgets.set(connectionId, { budget, ceiling });
  return budget;
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

  return { connectionId: row.id, providerConfig: undefined, cloudTokens: undefined };
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
 */
export function dispatcherForCa(caPem: string | undefined): unknown {
  if (!caPem) return undefined;
  return new Agent({ connect: { ca: caPem } });
}

/** Build the Connector for `sel.provider`. Unknown providers fall back to the
 *  SQL connector (the framework default) so a stray value can never route to a
 *  surprise transport. */
export function connectorForProvider(sel: ConnectorSelector): Connector {
  // WARP-1964 — the export-drop track. Matched on the `-export` suffix rather
  // than an enumerated list because the vendor set is open: an operator profile
  // can add one without a release.
  const exportVendor = vendorFromExportProvider(sel.provider);
  if (exportVendor) {
    const { profiles, error } = loadOperatorExportProfiles();
    return new ExportDropConnector(
      {
        vendor: exportVendor,
        // Operator configuration only. `sel.host` is ignored on this track:
        // the share is mounted by the host, so the practice's file server is
        // named in the mount, not in a connection row we would then have to
        // trust with a path.
        root: config.ERP_EXPORT_DROP_ROOT,
        // `subdirectory` is intentionally left unset. The connector supports it
        // (with containment validation) for a future per-practice layout, but
        // no connection column means "which folder" today, and borrowing
        // `databaseName` would collide with its "PattersonPM" default and send
        // every export connection looking for a folder that does not exist.
      },
      { profiles, configError: error ?? undefined },
    );
  }

  // WARP-2137 — the ADR-041 cloud tracks. Both run IN-PROCESS, not in the
  // erp-sql-bridge sidecar: that sidecar exists to isolate a NATIVE driver, and
  // an HTTPS API needs none (ADR-041, and the eaglesoft-api precedent above).
  //
  // Each is constructed from `providerConfig` and, when present, a resolver
  // over the decrypted token blob. An absent config or absent tokens leaves the
  // connector's own blocked resolver in place — the same honest-degradation
  // rule the REST track follows — so a half-configured connection reports
  // ERP_NOT_CONNECTED rather than reaching a vendor with a missing identifier.
  if (sel.provider === QUICKBOOKS_ONLINE_PROVIDER) {
    const cfg = sel.providerConfig?.provider === QUICKBOOKS_ONLINE_PROVIDER ? sel.providerConfig : undefined;
    const ceiling = cfg?.callCeiling ?? DEFAULT_CALL_CEILING;
    // Unlike DentrixAscendConnector, QuickBooksOnlineConnector does NOT
    // validate its realm id — an empty one builds fine and produces the URL
    // `/v3/company//query`, so an unconfigured row would spend a METERED call
    // asking Intuit about a company that does not exist. Refuse here, where the
    // row is known to be unconfigured, and refuse as a ConnectorBlockedError so
    // the read degrades to ERP_NOT_CONNECTED like every other absent-material
    // path rather than surfacing as a fault.
    if (!cfg?.realmId) {
      throw new ConnectorBlockedError(
        "construct (no QuickBooks company id configured)",
        QBO_TRACK_REMEDIATION,
      );
    }
    return new QuickBooksOnlineConnector(
      {
        realmId: cfg.realmId,
        baseUrl: cfg.baseUrl,
        credentialsSecretRef: sel.secretRef ?? "",
        callCeiling: ceiling,
      },
      {
        resolveTokens: sel.cloudTokens?.resolveQbo,
        persistTokens: sel.cloudTokens?.persistQbo,
        // The budget must OUTLIVE this connector — see sharedCallBudget. With
        // no connection id (the `test()` path, which has no row yet) there is
        // no identity to key a shared budget by, so none is injected and the
        // connector falls back to its own per-instance one. That path performs
        // a validation handshake, not a metered read loop.
        budget: sel.connectionId ? sharedCallBudget(sel.connectionId, ceiling) : undefined,
      },
    );
  }

  if (sel.provider === DENTRIX_ASCEND_PROVIDER) {
    const cfg = sel.providerConfig?.provider === DENTRIX_ASCEND_PROVIDER ? sel.providerConfig : undefined;
    return new DentrixAscendConnector(
      {
        organizationId: cfg?.organizationId ?? "",
        locationId: cfg?.locationId,
        baseUrl: cfg?.baseUrl,
        credentialsSecretRef: sel.secretRef ?? "",
      },
      { resolveToken: sel.cloudTokens?.resolveAscend },
    );
  }

  if (sel.provider === EAGLESOFT_API_PROVIDER) {
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
        // unconfigured connection blocks honestly instead of authenticating
        // with empty strings and getting an opaque 401.
        resolveSecret: credentials ? async () => credentials : undefined,
      },
    );
  }
  return new EaglesoftConnector(
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
  );
}
