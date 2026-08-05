/**
 * WARP-1094 — Connector provider interface + EaglesoftConnector (brief §6, §7).
 *
 * The connector framework is designed for N providers; Eaglesoft is provider
 * #1. The orchestrator talks to the sidecar over internal REST (brief §6); the
 * sidecar owns the native SQL Anywhere driver, the connection pool, and the
 * query allow-list. This module defines the provider abstraction and the
 * Eaglesoft implementation.
 *
 * BLOCKED SLICE: every driver / network call is stubbed. The native
 * `sqlanywhere` addon and a restored copy of `PattersonPM.db` are not
 * available in this environment, so no live connection is opened, no
 * introspection is executed, and no read/write runs. The pure pieces that DO
 * ship and are unit-tested — the schema map + fingerprint, the read-query
 * registry, and the write-command registry — are wired in here so the shape
 * of the eventual implementation is fixed, but the I/O boundary throws a
 * typed "blocked" error until the driver + copy DB exist.
 */
import { computeSchemaFingerprint, type IntrospectedTable } from "./schema-map.js";
import {
  LIST_TABLES_SQL,
  LIST_COLUMNS_SQL,
} from "./introspection.js";
import { getReadQuery, type BuiltStatement } from "./read-queries.js";
import { getWriteCommand } from "./write-commands.js";

/** What the direct-SQL track is waiting on. The default, since that track is
 *  where this error originated. */
export const SQL_TRACK_REMEDIATION =
  "needs the SAP SQL Anywhere client + a restored copy of PattersonPM.db " +
  "(WARP-1094 Phase 0 is DB-independent only)";

/**
 * Thrown at every blocked boundary. Both providers throw THIS type so the
 * orchestrator's honest-degradation branch (`instanceof ConnectorBlockedError`)
 * stays single-typed.
 *
 * `remediation` says what is actually missing. It is a parameter rather than a
 * constant because the two tracks are blocked on entirely different things: a
 * REST-track TLS or credential failure has nothing to do with a SQL Anywhere
 * client, and telling an installer otherwise sends them down the wrong path
 * during triage. Callers that don't pass one get the SQL-track text, which is
 * the historical behaviour.
 */
export class ConnectorBlockedError extends Error {
  readonly code = "CONNECTOR_BLOCKED";
  constructor(operation: string, remediation: string = SQL_TRACK_REMEDIATION) {
    super(`"${operation}" is blocked: ${remediation}`);
    this.name = "ConnectorBlockedError";
  }
}

/** Connection config (brief §7.2). `secretRef` is a pointer into the encrypted
 *  secret store — NEVER a cleartext password (brief §7.4). */
export interface ConnectorConfig {
  host: string;
  port: number;
  serverName: string;
  databaseName: string;
  /** Pointer into Droplet's secret store; the password never lives here. */
  readSecretRef: string;
  /** Write account is lazily used and disabled by default (invariant 1). */
  writeSecretRef?: string;
}

/** Result of a live schema-introspection pass (brief §9). */
export interface IntrospectionResult {
  tables: IntrospectedTable[];
  fingerprint: string;
}

/**
 * The provider abstraction (brief §4.4, §6). Keeping this API-shaped means a
 * future "Eaglesoft-via-official-API" or an OpenDental/MySQL provider can drop
 * in behind the same interface. Every method that touches the database is
 * async and, in this slice, rejects with {@link ConnectorBlockedError}.
 */
export interface Connector {
  readonly provider: string;
  /** Open the pooled read connection (brief §7.3). */
  connect(): Promise<void>;
  close(): Promise<void>;
  /** `/health` probe: SELECT 1 + last-read + fingerprint + pool stats (§7.3). */
  health(): Promise<{ ok: boolean }>;
  /** Introspect the live schema and fingerprint it (brief §9). */
  introspect(): Promise<IntrospectionResult>;
  /** Run a NAMED read query (invariant 4). Values bind as `?`. */
  runRead(name: string, params: Record<string, unknown>): Promise<unknown[]>;
  /** Apply a NAMED write command inside one transaction (brief §11.1 step 3). */
  applyWrite(name: string, params: Record<string, unknown>): Promise<unknown>;
}

/**
 * Eaglesoft provider (brief §7). All database I/O is stubbed behind
 * {@link ConnectorBlockedError}; the driver is wired in a later, copy-DB-gated
 * phase. The statement-building helpers (which are pure and unit-tested) are
 * exposed so callers can see exactly what WOULD run.
 */
export class EaglesoftConnector implements Connector {
  readonly provider = "eaglesoft";
  private schema: IntrospectionResult | null = null;

  constructor(private readonly config: ConnectorConfig) {}

  async connect(): Promise<void> {
    // TODO(WARP-1094): blocked on SAP SQL Anywhere client + copy of PattersonPM.db
    // Open the `droplet_ro` pool (config.readSecretRef resolved via secret store).
    void this.config;
    throw new ConnectorBlockedError("connect");
  }

  async close(): Promise<void> {
    // TODO(WARP-1094): blocked on SAP SQL Anywhere client + copy of PattersonPM.db
    // Drain and close the pools. No-op safe until connect() is real.
    this.schema = null;
  }

  async health(): Promise<{ ok: boolean }> {
    // TODO(WARP-1094): blocked on SAP SQL Anywhere client + copy of PattersonPM.db
    // Run a `SELECT 1`-class probe and report pool + fingerprint state.
    throw new ConnectorBlockedError("health");
  }

  async introspect(): Promise<IntrospectionResult> {
    // TODO(WARP-1094): blocked on SAP SQL Anywhere client + copy of PattersonPM.db
    // Execute LIST_TABLES_SQL + LIST_COLUMNS_SQL per table, then fingerprint.
    void LIST_TABLES_SQL;
    void LIST_COLUMNS_SQL;
    throw new ConnectorBlockedError("introspect");
  }

  async runRead(name: string, params: Record<string, unknown>): Promise<unknown[]> {
    // The statement is BUILT from the pinned schema map (pure, tested); only
    // the execution is blocked. Validate the query name + params eagerly so a
    // bad call fails the same way it will once the driver lands.
    if (!this.schema) {
      throw new ConnectorBlockedError("runRead (introspection required first)");
    }
    // getReadQuery throws UnknownReadQueryError on an unregistered name.
    getReadQuery(name).build(this.buildMapStub(), params);
    // TODO(WARP-1094): blocked on SAP SQL Anywhere client + copy of PattersonPM.db
    throw new ConnectorBlockedError("runRead");
  }

  async applyWrite(name: string, params: Record<string, unknown>): Promise<unknown> {
    // getWriteCommand throws on an unregistered name; the command's own
    // buildStatement enforces the allowlist + optimistic guard.
    void getWriteCommand(name);
    void params;
    // TODO(WARP-1094): blocked on SAP SQL Anywhere client + copy of PattersonPM.db
    // Run inside ONE transaction as droplet_rw (brief §11.1 step 3).
    throw new ConnectorBlockedError("applyWrite");
  }

  /** Placeholder for the introspected schema map. The real map is built from
   *  `introspect()`'s result; until the driver lands, callers cannot reach a
   *  non-blocked path, so this is never actually returned to production. */
  private buildMapStub(): never {
    // TODO(WARP-1094): blocked on SAP SQL Anywhere client + copy of PattersonPM.db
    throw new ConnectorBlockedError("schema map (introspection required first)");
  }
}

/** Fingerprint a set of introspected tables (pure re-export for callers that
 *  already hold tables, e.g. a drift re-check before a write, brief §11.5). */
export function fingerprintTables(tables: IntrospectedTable[]): string {
  return computeSchemaFingerprint(tables);
}

export type { BuiltStatement };
