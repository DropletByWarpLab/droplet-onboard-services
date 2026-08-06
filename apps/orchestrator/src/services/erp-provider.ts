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
import { encryptSecret, decryptSecret } from "./encryption.service.js";
import {
  EaglesoftConnector,
  EaglesoftApiConnector,
  DEFAULT_PORT,
  DEFAULT_DATABASE_NAME,
  DEFAULT_API_HTTPS_PORT,
  type Connector,
  type EaglesoftApiRouteMap,
} from "@droplet/erp-connector";

/** The flagship direct-SQL provider (framework provider #1). */
export const EAGLESOFT_PROVIDER = "eaglesoft";
/** The dual-track official-REST-API provider. */
export const EAGLESOFT_API_PROVIDER = "eaglesoft-api";
/** Every provider key the control plane knows how to build a connector for. */
export const KNOWN_ERP_PROVIDERS: readonly string[] = [EAGLESOFT_PROVIDER, EAGLESOFT_API_PROVIDER];

/** True for a provider key this factory can build. */
export function isKnownErpProvider(provider: string): boolean {
  return KNOWN_ERP_PROVIDERS.includes(provider);
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
  return new EaglesoftConnector({
    host: sel.host,
    port: sel.port ?? DEFAULT_PORT,
    serverName: sel.serverName ?? sel.databaseName ?? DEFAULT_DATABASE_NAME,
    databaseName: sel.databaseName || DEFAULT_DATABASE_NAME,
    readSecretRef: sel.secretRef ?? "",
  });
}
