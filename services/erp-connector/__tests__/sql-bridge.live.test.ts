/**
 * EaglesoftConnector (direct-SQL track) against a LIVE bridge and a LIVE
 * database — the full path, end to end:
 *
 *   EaglesoftConnector → SqlBridgeClient → HTTP → erp-sql-bridge (FastAPI)
 *     → pyodbc → unixODBC → a real server → real rows
 *
 * Nothing is mocked. The SQL executed here is the SQL the canonical registries
 * generate (`read-queries.ts` / `write-commands.ts`), with identifiers resolved
 * through a schema map built by introspecting the live catalog. That is the
 * property no unit test can establish: `connector.test.ts` proves the
 * statements are BUILT correctly; this proves they RUN.
 *
 * WHY THE DATABASE IS POSTGRES
 * ----------------------------
 * The SAP SQL Anywhere client is license-gated, account-walled and x86_64-only,
 * so it cannot be present in CI. The bridge reaches it through unixODBC, which
 * is driver-agnostic — so the suite points ERP_ODBC_DRIVER at psqlODBC and runs
 * against the same synthetic PattersonPM schema the SQL-track harness defines
 * (`harness/init/`), including its least-privilege grants. Everything above
 * `pyodbc.connect` is identical either way. What stays unproven until a real
 * install is the SAP connection string and SQL Anywhere's own dialect
 * behaviour. Since WARP-2874 the lane runs the SHIPPING catalog statements
 * (the harness defines SQL Anywhere-shaped SYS.* views over the mock schema,
 * `harness/init/04-sa-catalog.sql`) rather than injecting a Postgres-flavoured
 * pair — the bridge accepts only the registered ones.
 *
 * Gated on ERP_BRIDGE_LIVE_URL, exported by `scripts/test-erp-sql-bridge.sh`,
 * which boots the database, seeds it, and starts the bridge. Without it the
 * whole file skips — a contributor running `npm test` needs no Postgres.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConnectorBlockedError, EaglesoftConnector } from "../src/connector.js";
import { SqlBridgeClient } from "../src/sql-bridge-client.js";
import { UnknownReadQueryError } from "../src/read-queries.js";
import { DisallowedColumnError, MissingParamError } from "../src/write-commands.js";
import type { CatalogQuerySet } from "../src/introspection.js";

const BRIDGE_URL = process.env.ERP_BRIDGE_LIVE_URL;

/**
 * WARP-2590 — the bridge's service bearer. `scripts/test-erp-sql-bridge.sh`
 * exports the same value it starts the bridge with, so this lane exercises the
 * REAL authenticated path rather than a bridge with the gate disabled. A lane
 * that ran unauthenticated would prove nothing about what ships.
 */
const BRIDGE_TOKEN = process.env.SERVICE_TOKEN_ERP_BRIDGE;

/**
 * WARP-2874 — this lane used to hand the connector Postgres-flavoured catalog
 * SQL (`information_schema`), because `/introspect` ran whatever the wire
 * carried. It no longer does: only the statements in `introspection.ts` are
 * registered, so the harness answers THOSE — `harness/init/04-sa-catalog.sql`
 * defines the SYS.SYSTAB / SYS.SYSTABCOL / SYS.SYSUSER / SYS.SYSDOMAIN views
 * over the mock schema, privilege-filtered the way `information_schema` was.
 * The lane now introspects with the statements that actually ship.
 *
 * An off-registry catalog query is kept only as the refusal case below.
 */
const OFF_REGISTRY_CATALOG: CatalogQuerySet = {
  listTables: `SELECT table_name, table_schema AS owner FROM information_schema.tables
WHERE table_schema = 'dba' AND table_type = 'BASE TABLE'`,
  listColumns: `SELECT column_name, data_type AS type FROM information_schema.columns
WHERE table_schema = 'dba' AND table_name = ? ORDER BY ordinal_position`,
};

/** The target lives in the bridge's own environment, so the connector's
 *  host/port fields are unused here — but they are required by the config
 *  shape, so they carry the real values the script configured. */
const CONFIG = {
  host: process.env.ERP_DB_HOST ?? "127.0.0.1",
  port: Number(process.env.ERP_DB_PORT ?? 5432),
  serverName: process.env.ERP_DB_SERVER_NAME ?? "pattersonpm_mock",
  databaseName: process.env.ERP_DB_NAME ?? "pattersonpm_mock",
  readSecretRef: "secret://erp/eaglesoft/read",
  writeSecretRef: "secret://erp/eaglesoft/write",
};

type ConnectorDeps = NonNullable<ConstructorParameters<typeof EaglesoftConnector>[1]>;

const makeConnector = (over: ConnectorDeps = {}) =>
  new EaglesoftConnector(CONFIG, {
    bridgeUrl: BRIDGE_URL,
    bridgeAuthToken: BRIDGE_TOKEN,
    ...over,
  });

/** Raw bridge access for test setup only (reading a guard watermark). The
 *  connector has no read query that exposes `last_modified`, by design — and
 *  since WARP-2540 the bridge accepts only registered statement shapes, so
 *  this scaffolding borrows one: `get_schedule_today` (six columns, a
 *  half-open window, one ORDER BY) over a window wide enough to hold every
 *  seeded appointment. Column names are free under the allowlist, so the
 *  projection can carry `last_modified`; since WARP-2874 the TABLE is not —
 *  which is why this borrows the one registered read that is already on
 *  `appointment`, instead of pointing `get_patient` at it. */
const raw = () => new SqlBridgeClient({ baseUrl: BRIDGE_URL, authToken: BRIDGE_TOKEN });

const VERIFY_APPT_SQL =
  'SELECT "appt_id", "last_modified", "status", "operatory_id", "provider_id", "patient_id" ' +
  'FROM "dba"."appointment" WHERE "appt_time" >= ? AND "appt_time" < ? ORDER BY "appt_time"';
const EVERY_APPT: unknown[] = ["2000-01-01T00:00:00", "2100-01-01T00:00:00"];

async function apptRow(apptId: number): Promise<Record<string, unknown>> {
  const rows = (await raw().runRead("get_schedule_today", {
    sql: VERIFY_APPT_SQL,
    params: EVERY_APPT,
  })) as Record<string, unknown>[];
  const row = rows.find((r) => Number(r.appt_id) === apptId);
  if (!row) throw new Error(`appointment ${apptId} not found`);
  return row;
}

async function lastModified(apptId: number): Promise<string> {
  return String((await apptRow(apptId)).last_modified);
}

describe.skipIf(!BRIDGE_URL)("EaglesoftConnector over a live bridge", () => {
  let connector: EaglesoftConnector;

  beforeAll(async () => {
    connector = makeConnector();
    await connector.connect();
  });

  afterAll(async () => {
    await connector?.close();
  });

  describe("connect + introspection", () => {
    it("reports healthy against a reachable database", async () => {
      await expect(connector.health()).resolves.toEqual({ ok: true });
    });

    it("discovers the real schema rather than trusting a hardcoded one", async () => {
      const { tables } = await connector.introspect();
      expect(tables.map((t) => t.name).sort()).toEqual([
        "account",
        "appointment",
        "operatory",
        "patient",
        "provider",
        "recall",
        "serv_trans",
        "service",
      ]);
      expect(tables.every((t) => t.owner === "dba")).toBe(true);
    });

    it("discovers each table's real columns", async () => {
      const { tables } = await connector.introspect();
      const appt = tables.find((t) => t.name === "appointment");
      expect(appt?.columns.map((c) => c.name)).toEqual([
        "appt_id",
        "patient_id",
        "provider_id",
        "operatory_id",
        "appt_time",
        "status",
        "reason",
        "last_modified",
      ]);
    });

    it("fingerprints the live schema stably across passes", async () => {
      const a = await connector.introspect();
      const b = await connector.introspect();
      expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(b.fingerprint).toBe(a.fingerprint);
    });

    // WARP-2874 removed "produces a different fingerprint for a different
    // schema": it re-proved a PURE property (already covered by
    // schema-map.test.ts) by introspecting with an ad-hoc catalog query, and
    // the bridge now runs only the registered pair. The refusal it turned
    // into lives under "the bridge refuses unregistered statements" below.
  });

  describe("named reads execute against real rows", () => {
    it("runs get_schedule_today over the bound [from, to) window", async () => {
      const rows = (await connector.runRead("get_schedule_today", {
        from: "2000-01-01T00:00:00",
        to: "2100-01-01T00:00:00",
      })) as Record<string, unknown>[];
      // Five seeded appointments: yesterday, three today, tomorrow.
      expect(rows.map((r) => r.appt_id)).toEqual([5004, 5001, 5002, 5003, 5005]);
    });

    it("really applies the window rather than returning everything", async () => {
      const rows = await connector.runRead("get_schedule_today", {
        from: "2000-01-01T00:00:00",
        to: "2000-01-02T00:00:00",
      });
      expect(rows).toEqual([]);
    });

    it("returns only the minimum-necessary columns the query names", async () => {
      const rows = (await connector.runRead("get_patient", { patientId: 1003 })) as Record<
        string,
        unknown
      >[];
      // No DOB, no phone — the query selects three columns and gets three.
      expect(rows).toEqual([{ patient_id: 1003, first_name: "Barbara", last_name: "Liskov" }]);
    });

    it("finds patients by last-name prefix", async () => {
      const rows = (await connector.runRead("find_patient", { query: "Lis" })) as Record<
        string,
        unknown
      >[];
      expect(rows.map((r) => r.last_name)).toEqual(["Liskov"]);
    });

    it("escapes a wildcard search term instead of dumping the table", async () => {
      // Without escapeLike this is `LIKE '%%'` and returns every patient — a
      // PHI over-fetch that looks like success.
      const rows = await connector.runRead("find_patient", { query: "%" });
      expect(rows).toEqual([]);
    });

    it("treats a SQL fragment in a search term as data", async () => {
      const rows = await connector.runRead("find_patient", { query: "' OR 1=1 --" });
      expect(rows).toEqual([]);
    });

    it("aggregates AR server-side rather than pulling the ledger", async () => {
      const rows = (await connector.runRead("get_ar_summary", {})) as Record<string, unknown>[];
      expect(rows).toEqual([{ account_count: 5, total_balance: 634.5 }]);
    });

    it("rejects an unregistered query name before touching the bridge", async () => {
      await expect(connector.runRead("drop_everything", {})).rejects.toBeInstanceOf(
        UnknownReadQueryError,
      );
    });
  });

  describe("the single v1 write command", () => {
    it("applies a reschedule and reports it applied", async () => {
      const guard = await lastModified(5002);
      const result = await connector.applyWrite("reschedule_appointment", {
        appt_id: 5002,
        last_modified: guard,
        status: "confirmed",
        operatory_id: 2,
      });
      expect(result).toEqual({ applied: true, rowCount: 1 });

      expect(await apptRow(5002)).toMatchObject({ status: "confirmed", operatory_id: 2 });
    });

    it("reports a stale optimistic guard as applied:false, not as an error", async () => {
      // The row moved under us. Throwing would invite a blind retry over a
      // front-desk edit; reporting success would be a lie.
      const result = await connector.applyWrite("reschedule_appointment", {
        appt_id: 5001,
        last_modified: "1999-01-01T00:00:00",
        status: "cancelled",
      });
      expect(result).toEqual({ applied: false, rowCount: 0 });

      expect((await apptRow(5001)).status).not.toBe("cancelled");
    });

    it("refuses a column outside the allowlist without reaching the database", async () => {
      await expect(
        connector.applyWrite("reschedule_appointment", {
          appt_id: 5001,
          last_modified: await lastModified(5001),
          reason: "not on the allowlist",
        }),
      ).rejects.toBeInstanceOf(DisallowedColumnError);
    });

    it("refuses a write with no optimistic guard", async () => {
      await expect(
        connector.applyWrite("reschedule_appointment", { appt_id: 5001, status: "confirmed" }),
      ).rejects.toBeInstanceOf(MissingParamError);
    });
  });

  describe("the bridge refuses unregistered statements (WARP-2540)", () => {
    it("refuses an unknown statement name at the bridge, not the database", async () => {
      await expect(
        raw().runRead("__not_registered", { sql: VERIFY_APPT_SQL, params: EVERY_APPT }),
      ).rejects.toMatchObject({ code: "UNKNOWN_STATEMENT", status: 400 });
    });

    it("refuses a reshaped statement under a registered name", async () => {
      await expect(
        raw().runRead("get_schedule_today", {
          sql: `${VERIFY_APPT_SQL} OR 1=1`,
          params: EVERY_APPT,
        }),
      ).rejects.toMatchObject({ code: "STATEMENT_MISMATCH", status: 400 });
    });

    it("refuses a registry-shaped statement pointed at another table (WARP-2874)", async () => {
      // `get_patient` and this statement are the same shape — three columns,
      // one equality predicate — so before the table entered the skeleton the
      // bridge ran this and logged it as a patient read.
      await expect(
        raw().runRead("get_patient", {
          sql: 'SELECT "appt_id", "status", "reason" FROM "dba"."appointment" WHERE "appt_id" = ?',
          params: [5001],
        }),
      ).rejects.toMatchObject({ code: "STATEMENT_MISMATCH", status: 400 });
    });

    it("refuses an off-registry catalog query on /introspect (WARP-2874)", async () => {
      // The route used to run any SELECT the wire carried, which made the
      // allowlist optional for anything holding the service bearer.
      await expect(
        raw().introspect({ tables: { sql: OFF_REGISTRY_CATALOG.listTables, params: [] } }),
      ).rejects.toMatchObject({ code: "STATEMENT_MISMATCH", status: 400 });
    });
  });

  describe("honest degradation", () => {
    it("blocks every I/O method when no bridge is configured", async () => {
      const unwired = new EaglesoftConnector(CONFIG);
      await expect(unwired.connect()).rejects.toBeInstanceOf(ConnectorBlockedError);
      await expect(unwired.health()).rejects.toBeInstanceOf(ConnectorBlockedError);
      await expect(unwired.introspect()).rejects.toBeInstanceOf(ConnectorBlockedError);
      await expect(unwired.runRead("get_ar_summary", {})).rejects.toBeInstanceOf(
        ConnectorBlockedError,
      );
    });

    it("blocks — rather than reporting healthy — when the bridge is unreachable", async () => {
      const orphan = new EaglesoftConnector(CONFIG, {
        // Nothing listens here; a bridge container that failed to start looks
        // exactly like this, and must not read as a working integration.
        bridgeUrl: "http://127.0.0.1:9",
      });
      await expect(orphan.health()).rejects.toBeInstanceOf(ConnectorBlockedError);
    });

    it("refuses to read before introspection has pinned the schema", async () => {
      const fresh = makeConnector();
      await expect(fresh.runRead("get_ar_summary", {})).rejects.toBeInstanceOf(
        ConnectorBlockedError,
      );
    });

    it("drops the pinned schema on close so a reconnect re-introspects", async () => {
      const cycled = makeConnector();
      await cycled.connect();
      await cycled.close();
      await expect(cycled.runRead("get_ar_summary", {})).rejects.toBeInstanceOf(
        ConnectorBlockedError,
      );
      await cycled.connect();
      await expect(cycled.runRead("get_ar_summary", {})).resolves.toHaveLength(1);
    });
  });
});
