/**
 * WARP-1094 — Connector provider interface + EaglesoftConnector (brief §6, §7).
 *
 * The connector framework is designed for N providers; Eaglesoft is provider
 * #1. The orchestrator talks to the sidecar over internal REST (brief §6); the
 * sidecar owns the native SQL Anywhere driver, the connection pool, and the
 * query allow-list. This module defines the provider abstraction and the
 * Eaglesoft implementation.
 *
 * WARP-1106 replaced the stubbed I/O boundary with the real one: database
 * calls go to the `erp-sql-bridge` sidecar (unixODBC + pyodbc), which owns the
 * native SQL Anywhere driver because no viable modern Node driver exists. What
 * decides WHAT runs stays here — the read/write registries, the introspected
 * schema map, the drift fingerprint — so there remains exactly one definition
 * of the SQL that reaches a practice's database.
 *
 * The blocked boundary did not go away, it moved: with no bridge configured
 * (the default, since the SAP client is license-gated and operator-supplied)
 * every I/O method still throws {@link ConnectorBlockedError}, and an
 * unreachable bridge degrades to the same thing. A deployment that cannot
 * reach a practice's database says so rather than pretending.
 */
import {
  buildSchemaMap,
  computeSchemaFingerprint,
  type IntrospectedTable,
  type SchemaMap,
} from "./schema-map.js";
import { SqlBridgeClient, SqlBridgeError } from "./sql-bridge-client.js";
import {
  catalogQueriesFor,
  type CatalogQuerySet,
} from "./introspection.js";
import type { CatalogDialect } from "./version-detect.js";
import type { DatasetName } from "./export-drop/profiles.js";
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
  /**
   * The standing "what would unblock this" text, kept as a field and not only
   * baked into `message`. Callers that render their own copy — the connect/test
   * route's blocked branch — need the per-track text; without it they have to
   * re-derive it by branching on the provider key, and that branch goes stale
   * the moment a track is added (WARP-1964: an export-drop test failure was
   * reported as "install the SAP SQL Anywhere driver").
   */
  readonly remediation: string;
  constructor(operation: string, remediation: string = SQL_TRACK_REMEDIATION) {
    super(`"${operation}" is blocked: ${remediation}`);
    this.name = "ConnectorBlockedError";
    this.remediation = remediation;
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
 * Thrown when a caller asks a track for a dataset that track does not serve.
 *
 * WARP-2107. Distinct from `ConnectorBlockedError` on purpose, and the
 * distinction is the point: blocked means "this connection is not working and
 * here is what would fix it"; NOT_SERVED means "this connection is working
 * perfectly and will never have that data". A QuickBooks connection has no
 * appointments and a Dentrix connection has no vendor bills — neither is a
 * fault, and neither is fixed by anything an installer can do.
 *
 * The alternative — returning an empty array — was rejected explicitly. `[]`
 * from `get_open_bills` reads as "you owe nobody anything", which is a
 * confident false statement about money, and no caller can tell it apart from
 * a genuinely empty payables ledger.
 */
export class DatasetNotServedError extends Error {
  readonly code = "DATASET_NOT_SERVED";
  constructor(
    readonly provider: string,
    readonly query: string,
    readonly missing: readonly string[],
  ) {
    super(
      `"${query}" needs ${missing.map((d) => `"${d}"`).join(", ")}, ` +
        `which the "${provider}" track does not serve`,
    );
    this.name = "DatasetNotServedError";
  }
}

/**
 * Refuse a read whose datasets this track has not declared.
 *
 * Called by every connector at the top of `runRead`, after the registry lookup
 * and before any I/O, so an unserved read costs nothing and cannot half-run.
 * Placing it here rather than in each connector keeps one definition of what
 * "serves" means — three copies of this check would drift the moment a track
 * grew a dataset.
 */
export function assertDatasetsServed(
  provider: string,
  serves: readonly string[],
  queryName: string,
  dependsOn: readonly string[],
): void {
  const missing = dependsOn.filter((d) => !serves.includes(d));
  if (missing.length > 0) {
    throw new DatasetNotServedError(provider, queryName, missing);
  }
}

/**
 * The provider abstraction (brief §4.4, §6). Keeping this API-shaped means a
 * future "Eaglesoft-via-official-API" or an OpenDental/MySQL provider can drop
 * in behind the same interface. Every method that touches the database is
 * async and, in this slice, rejects with {@link ConnectorBlockedError}.
 */
export interface Connector {
  readonly provider: string;
  /**
   * The logical datasets this track can serve (WARP-2107).
   *
   * Declared rather than inferred. Before this existed, "can this track answer
   * that?" was answered by attempting the read and seeing what fell out —
   * a schema-resolution failure on the SQL track, a `rowsFor` miss on the
   * export track — which produced three different errors for one question and
   * made a genuinely-absent dataset indistinguishable from a broken one.
   *
   * A track whose datasets depend on runtime configuration (export-drop, whose
   * datasets are whatever the practice actually exported) computes this; the
   * fixed-schema tracks hardcode it.
   */
  readonly servesDatasets: readonly string[];
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

/** What the SQL connector can be handed at construction. Every field is
 *  optional; with none of them the connector keeps its blocked I/O boundary
 *  and degrades honestly (see {@link EaglesoftConnector}). */
export interface EaglesoftConnectorDeps {
  /** A pre-built bridge client (tests, or a shared pool). */
  bridge?: SqlBridgeClient;
  /** Where the `erp-sql-bridge` sidecar lives. Absent ⇒ no database I/O. */
  bridgeUrl?: string;
  /** Override the catalog family outright — a suite introspecting a
   *  non-SQL-Anywhere database to prove the pipeline end to end. */
  catalog?: CatalogQuerySet;
  /** Pick the catalog family by engine band instead of supplying it outright.
   *  Ignored when `catalog` is set. Defaults to "modern". */
  dialect?: CatalogDialect;
}

/**
 * Eaglesoft provider (brief §7), direct-SQL track.
 *
 * Database I/O goes through the `erp-sql-bridge` sidecar (unixODBC + pyodbc),
 * because no viable modern Node driver for SQL Anywhere exists. Everything
 * that decides WHAT runs stays here: the read/write registries, the
 * introspected schema map, and the drift fingerprint. The bridge only executes
 * the parameterized statement it is handed, so there is exactly one definition
 * of the SQL that reaches a practice's database.
 *
 * The connector stays honestly blocked when no bridge is configured — a
 * deployment without the (license-governed, operator-supplied) SAP client
 * degrades to ERP_NOT_CONNECTED rather than pretending.
 */
/**
 * The datasets a practice-management system's own schema carries.
 *
 * Shared by both Eaglesoft tracks because they read the SAME product by two
 * transports — if one grew a dataset the other did not, that would be a bug in
 * one of them, not a capability difference.
 */
export const PRACTICE_DATASETS: readonly DatasetName[] = ["appointment", "patient", "account"];

export class EaglesoftConnector implements Connector {
  readonly provider = "eaglesoft";
  /** Eaglesoft's schema is dental practice management; it carries no
   *  accounts-payable ledger, so the accounting reads are refused up front. */
  readonly servesDatasets = PRACTICE_DATASETS;
  private schema: IntrospectionResult | null = null;
  private map: SchemaMap | null = null;
  private readonly bridge: SqlBridgeClient | null;

  /**
   * Which catalog-view family to introspect with. Genuinely varies in
   * production: SA10+ uses SYS.SYSTAB*, ASA7 uses SYSTABLE/SYSCOLUMN, and
   * introspecting one with the other's views fails on exactly the installs
   * where it matters (review C-5). Defaults to the modern set, which covers
   * every engine band Eaglesoft 16+ ships on.
   */
  private readonly catalog: CatalogQuerySet;

  constructor(
    private readonly config: ConnectorConfig,
    deps: EaglesoftConnectorDeps = {},
  ) {
    this.catalog = deps.catalog ?? catalogQueriesFor(deps.dialect ?? "modern");
    // A bridge is wired when one is injected, or when a URL is configured.
    // Absent both, every I/O method blocks — see the class docstring.
    this.bridge =
      deps.bridge ??
      (deps.bridgeUrl
        ? new SqlBridgeClient({
            baseUrl: deps.bridgeUrl,
            target: {
              host: config.host,
              port: config.port,
              serverName: config.serverName,
              databaseName: config.databaseName,
            },
          })
        : null);
  }

  /** The bridge, or a blocked error naming what is missing. */
  private requireBridge(op: string): SqlBridgeClient {
    if (!this.bridge) throw new ConnectorBlockedError(op, SQL_TRACK_REMEDIATION);
    return this.bridge;
  }

  /** Map a bridge failure onto the connector's error contract. An unreachable
   *  practice server becomes ConnectorBlockedError (honest degradation); a
   *  rejected statement is a bug on our side and is rethrown as-is so it stays
   *  loud rather than being laundered into "not connected". */
  private asConnectorError(op: string, err: unknown): Error {
    if (err instanceof ConnectorBlockedError) return err;
    if (err instanceof SqlBridgeError && err.isUpstream) {
      return new ConnectorBlockedError(`${op} (${err.message})`, SQL_TRACK_REMEDIATION);
    }
    return err instanceof Error ? err : new Error(String(err));
  }

  async connect(): Promise<void> {
    const bridge = this.requireBridge("connect");
    try {
      const probe = await bridge.health();
      if (!probe.ok) {
        throw new ConnectorBlockedError(
          `connect (${probe.reason ?? "bridge reports not ok"})`,
          SQL_TRACK_REMEDIATION,
        );
      }
      // Pin the schema up front: identifier resolution and the drift
      // fingerprint both depend on it, and a read must never run against an
      // un-introspected database.
      await this.introspect();
    } catch (err) {
      this.schema = null;
      this.map = null;
      throw this.asConnectorError("connect", err);
    }
  }

  async close(): Promise<void> {
    // Pooling lives in the bridge (it owns the ODBC handles), so there is
    // nothing to drain here — just drop the pinned schema so a reconnect
    // re-introspects rather than trusting a stale map.
    this.schema = null;
    this.map = null;
  }

  async health(): Promise<{ ok: boolean }> {
    const bridge = this.requireBridge("health");
    try {
      const probe = await bridge.health();
      if (!probe.ok) {
        throw new ConnectorBlockedError(`health (${probe.reason ?? "not ok"})`, SQL_TRACK_REMEDIATION);
      }
      return { ok: true };
    } catch (err) {
      throw this.asConnectorError("health", err);
    }
  }

  async introspect(): Promise<IntrospectionResult> {
    const bridge = this.requireBridge("introspect");
    try {
      // Catalog family is chosen once, in the constructor (see `catalog`).
      // `/introspect` runs a whole batch on ONE connection, so the column pass
      // is a single round trip rather than one per table.
      const { tables: tableRows = [] } = await bridge.introspect({
        tables: { sql: this.catalog.listTables, params: [] },
      });

      // Column names come back in whatever case the catalog reports; SQL
      // Anywhere is case-insensitive and the schema map normalizes, so accept
      // either and let an empty name fall out as a skipped row.
      const named = tableRows
        .map((t) => ({
          name: String(t.table_name ?? t.TABLE_NAME ?? ""),
          owner: String(t.owner ?? t.OWNER ?? "dba"),
        }))
        .filter((t) => t.name !== "");

      // Labelled by table name so the results match back up without relying on
      // ordering. The name binds as `?` — never concatenated (invariant 3).
      const columnQueries = Object.fromEntries(
        named.map((t) => [t.name, { sql: this.catalog.listColumns, params: [t.name] }]),
      );
      const columnResults = named.length ? await bridge.introspect(columnQueries) : {};

      const tables: IntrospectedTable[] = named.map((t) => ({
        name: t.name,
        owner: t.owner,
        columns: (columnResults[t.name] ?? []).map((c) => ({
          name: String(c.column_name ?? c.COLUMN_NAME ?? ""),
          type: String(c.type ?? c.TYPE ?? ""),
        })),
      }));
      const result: IntrospectionResult = {
        tables,
        fingerprint: computeSchemaFingerprint(tables),
      };
      this.schema = result;
      this.map = buildSchemaMap(tables);
      return result;
    } catch (err) {
      throw this.asConnectorError("introspect", err);
    }
  }

  async runRead(name: string, params: Record<string, unknown>): Promise<unknown[]> {
    // Validate the name against the shared registry FIRST, so an unknown query
    // is an UnknownReadQueryError regardless of connection state.
    const query = getReadQuery(name);
    // Then the capability check, before any I/O: asking this track for a bill
    // is not a connection fault and must not be reported as one.
    assertDatasetsServed(this.provider, this.servesDatasets, name, query.dependsOnTables);
    const bridge = this.requireBridge("runRead");
    if (!this.map) {
      throw new ConnectorBlockedError("runRead (introspection required first)", SQL_TRACK_REMEDIATION);
    }
    try {
      // Identifiers resolve through the introspected map; values bind as `?`.
      const built = query.build(this.map, params);
      return await bridge.runRead(name, built);
    } catch (err) {
      throw this.asConnectorError(`runRead:${name}`, err);
    }
  }

  async applyWrite(name: string, params: Record<string, unknown>): Promise<unknown> {
    // The command's own buildStatement enforces the column allowlist, the
    // required optimistic-guard params, and the forbidden-target check.
    const command = getWriteCommand(name);
    const bridge = this.requireBridge("applyWrite");
    if (!this.map) {
      throw new ConnectorBlockedError("applyWrite (introspection required first)", SQL_TRACK_REMEDIATION);
    }
    try {
      const built = command.buildStatement(this.map, params);
      const result = await bridge.applyWrite(name, built);
      // A guard miss (0 rows) is NOT an error — the row moved under us. The
      // caller decides; reporting it as success would be a lie, and throwing
      // would invite a blind retry over a front-desk edit.
      return { applied: result.applied, rowCount: result.rowCount };
    } catch (err) {
      throw this.asConnectorError(`applyWrite:${name}`, err);
    }
  }
}

/** Fingerprint a set of introspected tables (pure re-export for callers that
 *  already hold tables, e.g. a drift re-check before a write, brief §11.5). */
export function fingerprintTables(tables: IntrospectedTable[]): string {
  return computeSchemaFingerprint(tables);
}

export type { BuiltStatement };
