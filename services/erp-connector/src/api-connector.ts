/**
 * WARP-1294 — EaglesoftApiConnector: the SECOND, dual-track ERP provider.
 *
 * Talks to Patterson's OFFICIAL Eaglesoft REST API (Innovation Connection;
 * ASP.NET Web-API-2 over HTTPS :9888) instead of the SQL Anywhere database.
 * Implements the SAME `Connector` interface as the SQL `EaglesoftConnector`
 * (provider `"eaglesoft"`), returns the SAME named-read row shapes, and reuses
 * the SAME read/write registries and error taxonomy — so the orchestrator,
 * tools-core, dashboard read contract, and the outbox→confirm→apply→verify
 * write pipeline are unchanged. Selected per persisted `provider`.
 *
 * HONEST-BLOCKED BY DEFAULT. Two things are gated on Patterson vendor
 * enrollment + a live box and are NOT in this slice: (1) the real route
 * templates/verbs/field-maps (discovered from the box `/help` page — see
 * api-route-map.ts), and (2) the CLIENTID/SERIALKEY + Provider credentials
 * (behind a secret_ref, resolved by an injected resolver). Until BOTH are
 * present, every I/O method throws `ConnectorBlockedError` — the same typed
 * error the SQL connector throws — so the orchestrator degrades honestly
 * (reads → ERP_NOT_CONNECTED, writes → FAILED, connect stays PROVISIONING),
 * never faking a connection. The full HTTP/auth/mapping machinery is real and
 * unit-tested against a mocked fetch, so wiring it live is config, not code.
 */
import { ConnectorBlockedError, type Connector, type IntrospectionResult } from "./connector.js";
import { getReadQuery } from "./read-queries.js";
import { getWriteCommand, assertTargetAllowed } from "./write-commands.js";
import {
  type EaglesoftApiRouteMap,
  resolveAuthRoute,
  resolveReadRoute,
  routeMapFingerprint,
} from "./api-route-map.js";
import {
  apiRequest,
  authenticate,
  buildBaseUrl,
  blockedSecretResolver,
  EaglesoftApiError,
  type ApiTransport,
  type FetchLike,
  type SecretResolver,
} from "./api-auth.js";
import { aggregateArSummary, mapRows, sortByKey } from "./api-dto.js";

/** Default HTTPS port the Patterson API listens on (HTTP fallback is 8888). */
export const DEFAULT_API_HTTPS_PORT = 9888;

/**
 * What the REST track is waiting on — the counterpart to
 * `SQL_TRACK_REMEDIATION`. Every blocked error this connector raises carries
 * it, so an operator triaging a failed connect is pointed at the things that
 * can actually be wrong on THIS track (vendor enrollment, the discovered route
 * contract, the box's certificate) rather than at a SQL Anywhere client that
 * has no bearing on it.
 *
 * The operation string already carries the specific cause (`connect (request
 * to Authentication.Authenticate failed: ...)`); this is the standing "what
 * would unblock it" half.
 */
export const API_TRACK_REMEDIATION =
  "needs Patterson vendor enrollment (integrationKey + Provider login behind the " +
  "secret_ref), the route contract discovered from the box's /help page, and a " +
  "reachable box whose certificate verifies";

/**
 * Connection config for the API provider. `credentialsSecretRef` is a POINTER
 * into the encrypted secret store — the CLIENTID/SERIALKEY + Provider login
 * live behind it, NEVER cleartext here (deliberately named without the literal
 * substrings `clientid`/`serialkey` so a serialized config never trips a secret
 * scanner). `routeMap` is the discovered `/help` contract; absent → blocked.
 */
export interface EaglesoftApiConfig {
  /** Practice-LAN Eaglesoft server host/IP (from IntegrationConnection.host). */
  host: string;
  /** HTTPS port; defaults to 9888. */
  httpsPort?: number;
  /** Pointer into the secret store holding the integrationKey + provider login. */
  credentialsSecretRef: string;
  /** Pointer to the PdcoTechCA public cert to trust (resolved to a dispatcher). */
  caCertRef?: string;
  /** The discovered route map (verb/template/fields per op). Absent until the
   *  box `/help` page or Patterson SDK method matrix has been read. */
  routeMap?: EaglesoftApiRouteMap;
}

/** Injected collaborators (kept out of the persisted config). Production leaves
 *  these default → the connector stays honestly blocked; tests inject a mock
 *  fetch + resolver + route map to exercise the full path offline. */
export interface EaglesoftApiDeps {
  /** Mock in tests; falls back to the runtime global `fetch` at call time. */
  fetchImpl?: FetchLike;
  /** undici Agent carrying PdcoTechCA trust (built by the caller from caCertRef). */
  dispatcher?: unknown;
  /** Resolves credentialsSecretRef → credentials. Default refuses (no store here). */
  resolveSecret?: SecretResolver;
  /** Per-call timeout (ms). */
  timeoutMs?: number;
}

export class EaglesoftApiConnector implements Connector {
  readonly provider = "eaglesoft-api";

  private token: string | null = null;
  private schema: IntrospectionResult | null = null;
  private readonly resolveSecret: SecretResolver;

  constructor(
    private readonly config: EaglesoftApiConfig,
    private readonly deps: EaglesoftApiDeps = {},
  ) {
    this.resolveSecret = deps.resolveSecret ?? blockedSecretResolver;
  }

  private transport(): ApiTransport {
    return {
      baseUrl: buildBaseUrl(this.config.host, this.config.httpsPort ?? DEFAULT_API_HTTPS_PORT),
      fetchImpl: this.deps.fetchImpl,
      dispatcher: this.deps.dispatcher,
      timeoutMs: this.deps.timeoutMs,
    };
  }

  /** The discovered route map, or a blocked error naming what's missing. */
  private requireRouteMap(op: string): EaglesoftApiRouteMap {
    if (!this.config.routeMap) {
      throw new ConnectorBlockedError(`${op} (route map not discovered)`, API_TRACK_REMEDIATION);
    }
    return this.config.routeMap;
  }

  /** Translate canonical query params to the API's query names via the route's
   *  discovered `params` map; pass-through when no mapping is declared. */
  private toApiQuery(
    route: { params?: Record<string, string> },
    params: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!route.params) return params;
    const out: Record<string, unknown> = {};
    for (const [canonical, apiName] of Object.entries(route.params)) {
      if (params[canonical] !== undefined) out[apiName] = params[canonical];
    }
    return out;
  }

  async connect(): Promise<void> {
    const map = this.requireRouteMap("connect");
    try {
      const creds = await this.resolveSecret(this.config.credentialsSecretRef);
      const authRoute = resolveAuthRoute(map);
      this.token = await authenticate(this.transport(), authRoute, creds);
      // No SQL catalog on the REST track — the "schema" is the discovered route
      // contract, fingerprinted so drift-freeze semantics stay coherent (§9).
      this.schema = { tables: [], fingerprint: routeMapFingerprint(map) };
    } catch (err) {
      this.token = null;
      this.schema = null;
      throw this.asBlocked("connect", err);
    }
  }

  async close(): Promise<void> {
    this.token = null;
    this.schema = null;
  }

  async health(): Promise<{ ok: boolean }> {
    // Health is only meaningful after a successful connect(); before that the
    // connector is blocked (mirrors the SQL connector's contract).
    if (!this.token) throw new ConnectorBlockedError("health (connect required first)", API_TRACK_REMEDIATION);
    return { ok: true };
  }

  async introspect(): Promise<IntrospectionResult> {
    if (!this.schema) throw new ConnectorBlockedError("introspect (connect required first)", API_TRACK_REMEDIATION);
    return this.schema;
  }

  async runRead(name: string, params: Record<string, unknown>): Promise<unknown[]> {
    // Validate the query name against the shared registry FIRST — an unknown
    // name throws UnknownReadQueryError exactly as on the SQL track (before any
    // blocked/route error), so callers get the same validation behaviour.
    getReadQuery(name);
    if (!this.token || !this.schema) {
      throw new ConnectorBlockedError("runRead (connect required first)", API_TRACK_REMEDIATION);
    }
    const map = this.requireRouteMap("runRead");
    try {
      const route = resolveReadRoute(map, name); // throws RouteNotDiscovered → blocked
      const payload = await apiRequest(this.transport(), route, {
        query: this.toApiQuery(route, params),
        token: this.token,
      });
      return this.mapReadResult(name, payload, route);
    } catch (err) {
      throw this.asBlocked(`runRead:${name}`, err);
    }
  }

  private mapReadResult(
    name: string,
    payload: unknown,
    route: Parameters<typeof mapRows>[1],
  ): unknown[] {
    if (name === "get_ar_summary") {
      // Single aggregate row `{ account_count, total_balance }` (minimum-
      // necessary; never the raw ledger rows).
      return [aggregateArSummary(payload, route)];
    }
    const rows = mapRows(payload, route);
    if (name === "get_schedule_today") return sortByKey(rows, "appt_time");
    if (name === "find_patient" || name === "get_recall_due") {
      return sortByKey(sortByKey(rows, "first_name"), "last_name");
    }
    return rows;
  }

  async applyWrite(name: string, _params: Record<string, unknown>): Promise<unknown> {
    // Validate the command name + its forbidden-target guard against the shared
    // registry (same as the SQL track). The live write transport is deferred to
    // a later PR (gated on the discovered write route + a signed BAA), so this
    // stays honestly blocked — never a fake APPLIED.
    const cmd = getWriteCommand(name); // throws UnknownWriteCommandError
    assertTargetAllowed(cmd.targetTable); // throws ForbiddenTargetError
    throw new ConnectorBlockedError("applyWrite (REST write slice deferred to a later PR)", API_TRACK_REMEDIATION);
  }

  /** Map transport/auth/route/secret failures to the shared ConnectorBlockedError
   *  so the orchestrator's `instanceof` degradation path is unchanged; pass a
   *  ConnectorBlockedError through untouched. Registry validation errors
   *  (UnknownReadQueryError etc.) are thrown before this and never reach here. */
  private asBlocked(op: string, err: unknown): Error {
    if (err instanceof ConnectorBlockedError) return err;
    if (err instanceof EaglesoftApiError) return new ConnectorBlockedError(`${op} (${err.message})`, API_TRACK_REMEDIATION);
    if (err instanceof Error) return new ConnectorBlockedError(`${op} (${err.message})`, API_TRACK_REMEDIATION);
    return new ConnectorBlockedError(op, API_TRACK_REMEDIATION);
  }
}
