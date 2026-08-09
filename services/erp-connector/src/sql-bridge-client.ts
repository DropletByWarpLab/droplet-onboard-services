/**
 * WARP-1106 — HTTP client for the ERP SQL bridge (`services/erp-sql-bridge`).
 *
 * The bridge is the DB-touching half of the direct-SQL track: unixODBC +
 * pyodbc against the practice's SAP SQL Anywhere database. It exists because
 * there is no viable modern Node driver for SQL Anywhere — the `sqlanywhere`
 * addon is abandoned at a Node 12 ceiling. This module is the thin seam that
 * keeps that fact invisible to the rest of the orchestrator.
 *
 * WHAT CROSSES THIS BOUNDARY, AND WHAT DOES NOT
 * ---------------------------------------------
 * Out: a parameterized statement (`sql` + positional `params`) built HERE, by
 * the canonical registries, with identifiers resolved through the introspected
 * schema map. Optionally which box to reach.
 *
 * NEVER out: a credential. The bridge resolves `droplet_ro` / `droplet_rw` from
 * its own container environment and picks between them by ROUTE. The
 * orchestrator holds a `secretRef` pointer and never the secret itself, so
 * there is nothing here to leak even if this module were compromised.
 *
 * The bridge is reachable only on the internal compose network.
 */

/** Where the bridge lives. Internal DNS name, never published off-box. */
export const DEFAULT_BRIDGE_URL = "http://erp-sql-bridge:9095";

/** `fetch`-shaped, so tests can inject a mock and production defaults to the
 *  runtime global at call time. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Which database box to reach. Not secrets — these come off the
 *  IntegrationConnection row, so the setup wizard's host field keeps working
 *  on a box deployed pointing elsewhere. */
export interface BridgeTarget {
  host: string;
  port?: number;
  serverName?: string;
  databaseName?: string;
}

/** A built, ready-to-execute statement. */
export interface BridgeStatement {
  sql: string;
  params: unknown[];
}

/**
 * Bridge-side failure. Carries the bridge's own `code` so callers can tell
 * "the practice's server is unreachable" (degrade honestly) apart from "that
 * statement was rejected" (our bug, should be loud).
 */
export class SqlBridgeError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "SqlBridgeError";
    this.code = code;
    this.status = status;
  }
  /** True when the practice's DB is unreachable/unconfigured rather than the
   *  statement being wrong — the cases that map to honest degradation. */
  get isUpstream(): boolean {
    return this.code === "UPSTREAM_UNAVAILABLE" || this.code === "NOT_CONFIGURED";
  }
}

export interface SqlBridgeOptions {
  baseUrl?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  target?: BridgeTarget;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export class SqlBridgeClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly target?: BridgeTarget;
  private readonly fetchImpl?: FetchLike;

  constructor(opts: SqlBridgeOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BRIDGE_URL).replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.target = opts.target;
    this.fetchImpl = opts.fetchImpl;
  }

  private resolveFetch(): FetchLike {
    if (this.fetchImpl) return this.fetchImpl;
    const g = (globalThis as { fetch?: FetchLike }).fetch;
    if (!g) throw new SqlBridgeError("NO_FETCH", 0, "no fetch implementation available");
    return g;
  }

  private async call<T>(path: string, body: unknown, method = "POST"): Promise<T> {
    const fetchImpl = this.resolveFetch();
    let res: Response;
    try {
      res = await fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: { "content-type": "application/json", accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
        ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      // The bridge container itself is down / unreachable. Same honest
      // degradation as the practice's DB being down — from the orchestrator's
      // point of view there is no live connection either way.
      throw new SqlBridgeError(
        "UPSTREAM_UNAVAILABLE",
        0,
        `erp-sql-bridge unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new SqlBridgeError(
        typeof payload.code === "string" ? payload.code : "BRIDGE_ERROR",
        res.status,
        typeof payload.message === "string" ? payload.message : `bridge returned HTTP ${res.status}`,
      );
    }
    return payload as T;
  }

  /** `SELECT 1`-class probe plus pool state. */
  health(): Promise<{ ok: boolean; reason?: string; lastReadAt?: number | null; pool?: unknown }> {
    return this.call("/health", undefined, "GET");
  }

  /** Run a named read. `name` is for logs/errors only — the SQL is supplied. */
  async runRead(name: string, statement: BridgeStatement): Promise<Record<string, unknown>[]> {
    const out = await this.call<{ rows: Record<string, unknown>[] }>(`/read/${encodeURIComponent(name)}`, {
      ...statement,
      target: this.target,
    });
    return out.rows ?? [];
  }

  /** Apply a named write in one transaction. A zero `rowCount` is the
   *  optimistic guard missing, NOT an error — the caller decides. */
  applyWrite(name: string, statement: BridgeStatement): Promise<{ rowCount: number; applied: boolean }> {
    return this.call(`/write/${encodeURIComponent(name)}`, { ...statement, target: this.target });
  }

  /** Run labelled catalog queries; the caller fingerprints the result. */
  async introspect(queries: Record<string, BridgeStatement>): Promise<Record<string, Record<string, unknown>[]>> {
    const out = await this.call<{ results: Record<string, Record<string, unknown>[]> }>("/introspect", {
      queries,
      target: this.target,
    });
    return out.results ?? {};
  }
}
