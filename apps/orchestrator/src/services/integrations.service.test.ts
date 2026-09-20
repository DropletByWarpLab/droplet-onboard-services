/**
 * WARP-1137 — integrations.service unit tests (DB-independent orchestrator
 * layer). Prisma is an in-memory vi.fn() stub (mirrors device-registry.service
 * .test.ts / audit-roots.test.ts); the erp-connector stays STUBBED — every
 * live path throws ConnectorBlockedError, and the service must map that to an
 * honest status (never a fake CONNECTED).
 *
 * Covers: explicit-enum status derivation (never derive from absence), the
 * writeEnabled toggle writing an ErpAuditLog row, and connect/test mapping the
 * connector's blocked stub → NOT_CONFIGURED / PROVISIONING / ERROR.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createIntegrationsService,
  EAGLESOFT_PROVIDER,
  EAGLESOFT_API_PROVIDER,
} from "./integrations.service.js";
import { ConnectorBlockedError } from "@droplet/erp-connector";

type ConnRow = {
  id: string;
  provider: string;
  status: string;
  host: string;
  databaseName: string;
  secretRef: string;
  schemaVersion: string | null;
  schemaHash: string | null;
  writeEnabled: boolean;
  lastHealthyAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function makePrismaMock() {
  const connections = new Map<string, ConnRow>();
  const auditLog: Array<Record<string, unknown>> = [];
  let seq = 0;

  const integrationConnection = {
    findFirst: vi.fn(async ({ where }: any) => {
      for (const c of connections.values()) {
        if (c.provider === where.provider) return { ...c };
      }
      return null;
    }),
    findMany: vi.fn(async () =>
      Array.from(connections.values()).map((c) => ({ ...c })),
    ),
    findUnique: vi.fn(async ({ where }: any) => {
      const c = connections.get(where.id);
      return c ? { ...c } : null;
    }),
    create: vi.fn(async ({ data }: any) => {
      const id = data.id ?? `conn-${++seq}`;
      const row: ConnRow = {
        id,
        provider: data.provider,
        status: data.status ?? "NOT_CONFIGURED",
        host: data.host,
        databaseName: data.databaseName,
        secretRef: data.secretRef,
        schemaVersion: data.schemaVersion ?? null,
        schemaHash: data.schemaHash ?? null,
        writeEnabled: data.writeEnabled ?? false,
        lastHealthyAt: data.lastHealthyAt ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      connections.set(id, row);
      return { ...row };
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const existing = connections.get(where.id);
      if (!existing) throw new Error("not found");
      const merged: ConnRow = { ...existing };
      for (const [k, v] of Object.entries(data)) {
        if (v !== undefined) (merged as any)[k] = v;
      }
      merged.updatedAt = new Date();
      connections.set(where.id, merged);
      return { ...merged };
    }),
  };

  const erpAuditLog = {
    create: vi.fn(async ({ data }: any) => {
      const row = { id: `audit-${auditLog.length + 1}`, at: new Date(), ...data };
      auditLog.push(row);
      return row;
    }),
  };

  return {
    prisma: { integrationConnection, erpAuditLog } as any,
    _state: { connections, auditLog },
  };
}

/** A connector whose live methods are all stubbed (the real WARP-1094 shape). */
function makeBlockedConnector() {
  return {
    provider: "eaglesoft",
    connect: vi.fn(async () => {
      throw new ConnectorBlockedError("connect");
    }),
    close: vi.fn(async () => {}),
    health: vi.fn(async () => {
      throw new ConnectorBlockedError("health");
    }),
    introspect: vi.fn(async () => {
      throw new ConnectorBlockedError("introspect");
    }),
    runRead: vi.fn(async () => {
      throw new ConnectorBlockedError("runRead");
    }),
    applyWrite: vi.fn(async () => {
      throw new ConnectorBlockedError("applyWrite");
    }),
  };
}

describe("integrations.service (WARP-1137, DB-independent)", () => {
  let mock: ReturnType<typeof makePrismaMock>;
  let connector: ReturnType<typeof makeBlockedConnector>;
  let svc: ReturnType<typeof createIntegrationsService>;

  beforeEach(() => {
    mock = makePrismaMock();
    connector = makeBlockedConnector();
    svc = createIntegrationsService(mock.prisma, {
      connectorFor: () => connector as any,
    });
  });

  describe("status derivation (explicit enum, never from absence)", () => {
    it("returns NOT_CONFIGURED for a provider with no row", async () => {
      const detail = await svc.getEaglesoft();
      expect(detail.status).toBe("NOT_CONFIGURED");
      expect(detail.configured).toBe(false);
      // No row means we DERIVE nothing else — writeEnabled is the explicit default.
      expect(detail.writeEnabled).toBe(false);
    });

    it("reflects the stored explicit status column, not row presence", async () => {
      await mock.prisma.integrationConnection.create({
        data: {
          provider: EAGLESOFT_PROVIDER,
          status: "DEGRADED",
          host: "10.0.0.5",
          databaseName: "PattersonPM",
          secretRef: "secret://erp/eaglesoft/ro",
        },
      });
      const detail = await svc.getEaglesoft();
      expect(detail.status).toBe("DEGRADED");
      expect(detail.configured).toBe(true);
    });

    it("lists providers for the hub with their explicit status", async () => {
      const list = await svc.list();
      const eagle = list.find((p) => p.provider === EAGLESOFT_PROVIDER);
      expect(eagle).toBeDefined();
      // With no row the hub still shows the provider as NOT_CONFIGURED.
      expect(eagle!.status).toBe("NOT_CONFIGURED");
    });
  });

  // WARP-1998 — the hub list previously carried no timestamp at all, so any
  // surface listing N connectors had no way to say how stale each one is
  // (lastSyncedAt lived only on the provider-specific detail route).
  describe("lastSyncedAt on the hub list", () => {
    it("is an EXPLICIT null for a provider that has never synced", async () => {
      const list = await svc.list();
      const eagle = list.find((p) => p.provider === EAGLESOFT_PROVIDER)!;
      expect(eagle.lastSyncedAt).toBeNull();
      // Explicit, not merely absent: `undefined` would be dropped by JSON and
      // the client could not tell "never synced" from "field not served".
      expect(Object.prototype.hasOwnProperty.call(eagle, "lastSyncedAt")).toBe(true);
    });

    it("reports the last successful read as an ISO string", async () => {
      const when = new Date("2026-08-14T09:12:00.000Z");
      await mock.prisma.integrationConnection.create({
        data: {
          provider: EAGLESOFT_PROVIDER,
          status: "CONNECTED",
          host: "10.0.0.5",
          databaseName: "PattersonPM",
          secretRef: "secret://erp/eaglesoft/ro",
          lastHealthyAt: when,
        },
      });
      const list = await svc.list();
      const eagle = list.find((p) => p.provider === EAGLESOFT_PROVIDER)!;
      expect(eagle.lastSyncedAt).toBe(when.toISOString());
    });

    it("stays null on a configured-but-never-healthy row", async () => {
      // A connector that was set up and never succeeded must not borrow a
      // timestamp from its creation — that would read as a successful sync.
      await mock.prisma.integrationConnection.create({
        data: {
          provider: EAGLESOFT_PROVIDER,
          status: "ERROR",
          host: "10.0.0.5",
          databaseName: "PattersonPM",
          secretRef: "secret://erp/eaglesoft/ro",
        },
      });
      const list = await svc.list();
      const eagle = list.find((p) => p.provider === EAGLESOFT_PROVIDER)!;
      expect(eagle.configured).toBe(true);
      expect(eagle.lastSyncedAt).toBeNull();
    });

    it("agrees with the detail route for the same row", async () => {
      const when = new Date("2026-08-13T22:05:00.000Z");
      await mock.prisma.integrationConnection.create({
        data: {
          provider: EAGLESOFT_PROVIDER,
          status: "CONNECTED",
          host: "10.0.0.5",
          databaseName: "PattersonPM",
          secretRef: "secret://erp/eaglesoft/ro",
          lastHealthyAt: when,
        },
      });
      const [list, detail] = await Promise.all([svc.list(), svc.getEaglesoft()]);
      const eagle = list.find((p) => p.provider === EAGLESOFT_PROVIDER)!;
      // Two projections of one column; if they ever disagree the UI shows two
      // different staleness answers for the same connector.
      expect(eagle.lastSyncedAt).toBe(detail.lastSyncedAt);
    });
  });

  describe("connect / test — honest mapping of the stubbed connector", () => {
    it("connect leaves status PROVISIONING (never fake CONNECTED) when the connector is blocked", async () => {
      const result = await svc.connect({
        host: "10.0.0.5",
        databaseName: "PattersonPM",
        secretRef: "secret://erp/eaglesoft/ro",
      });
      // The connector.connect() stub threw ConnectorBlockedError → we must NOT
      // report CONNECTED. It stays in a truthful in-progress/blocked state.
      expect(result.status).not.toBe("CONNECTED");
      expect(["PROVISIONING", "NOT_CONFIGURED", "ERROR"]).toContain(result.status);
      expect(connector.connect).toHaveBeenCalled();
    });

    it("persists the secretRef POINTER, never a cleartext password", async () => {
      await svc.connect({
        host: "10.0.0.5",
        databaseName: "PattersonPM",
        secretRef: "secret://erp/eaglesoft/ro",
      });
      const row = Array.from(mock._state.connections.values())[0]!;
      expect(row.secretRef).toBe("secret://erp/eaglesoft/ro");
      // Belt-and-suspenders: no field on the row looks like a password.
      expect(JSON.stringify(row)).not.toMatch(/password/i);
    });

    it("test() reports not-connected (blocked) without saving a row", async () => {
      const result = await svc.test({
        host: "10.0.0.5",
        databaseName: "PattersonPM",
        secretRef: "secret://erp/eaglesoft/ro",
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("ERP_NOT_CONNECTED");
      // test() must not persist anything.
      expect(mock._state.connections.size).toBe(0);
    });

    it("connect(provider: eaglesoft-api) persists the API provider (dual-track)", async () => {
      const result = await svc.connect({
        host: "10.0.0.5",
        provider: EAGLESOFT_API_PROVIDER,
        secretRef: "secret://erp/eaglesoft-api/creds",
      });
      // The row is persisted under the API provider key (no migration — the
      // provider column is free-form TEXT) and, like the SQL path, does NOT
      // fake CONNECTED while the connector is blocked.
      expect(result.provider).toBe("eaglesoft-api");
      expect(result.status).not.toBe("CONNECTED");
      const row = Array.from(mock._state.connections.values())[0]!;
      expect(row.provider).toBe("eaglesoft-api");
      // The API provider has no SQL droplet_ro account to surface.
      expect(result.account).toBeNull();
    });

    it("connect() rejects an unknown provider", async () => {
      await expect(
        svc.connect({ host: "10.0.0.5", provider: "dentrix" }),
      ).rejects.toThrow();
    });
  });

  describe("writeEnabled toggle (writes an audit row)", () => {
    beforeEach(async () => {
      await svc.connect({
        host: "10.0.0.5",
        databaseName: "PattersonPM",
        secretRef: "secret://erp/eaglesoft/ro",
      });
    });

    it("enabling writes flips the explicit column and audits the actor", async () => {
      const detail = await svc.setWriteEnabled({ actor: "user-1" }, "eaglesoft", true);
      expect(detail.writeEnabled).toBe(true);
      const audit = mock._state.auditLog.at(-1)!;
      expect(audit.actor).toBe("user-1");
      expect(audit.action).toBe("write-enable");
    });

    it("disabling writes flips the column back and audits", async () => {
      await svc.setWriteEnabled({ actor: "user-1" }, "eaglesoft", true);
      const detail = await svc.setWriteEnabled({ actor: "user-2" }, "eaglesoft", false);
      expect(detail.writeEnabled).toBe(false);
      const audit = mock._state.auditLog.at(-1)!;
      expect(audit.actor).toBe("user-2");
      expect(audit.action).toBe("write-disable");
    });
  });
});

/**
 * WARP-1964 — a failed reachability test must name the remediation for the
 * track that actually failed.
 *
 * `test()` used to pick its message with a two-way ternary on the REST provider
 * key, so everything that was not `eaglesoft-api` fell through to the SQL text.
 * Once export-drop providers became valid, an installer standing in a practice
 * with a CIFS share was told to go license a SAP SQL Anywhere driver — on the
 * one track that needs no driver at all. The message now comes from the
 * error's own `remediation`, so it stays correct as tracks are added.
 */
describe("integrations.service — blocked test() names the right track (WARP-1964)", () => {
  function serviceWithBlockedConnector(remediation: string) {
    const prisma = {
      integrationConnection: { findFirst: vi.fn(async () => null) },
      erpAuditLog: { create: vi.fn(async () => ({})) },
    } as never;
    return createIntegrationsService(prisma, {
      connectorFor: (() => ({
        provider: "stub",
        connect: async () => {
          throw new ConnectorBlockedError("connect", remediation);
        },
        close: async () => {},
        health: async () => ({ ok: true }),
        introspect: async () => ({ tables: [], fingerprint: "" }),
        runRead: async () => [],
        applyWrite: async () => ({}),
      })) as never,
    });
  }

  it("reports the export-drop remediation, not the SAP driver text", async () => {
    const svc = serviceWithBlockedConnector(
      "needs ERP_EXPORT_DROP_ROOT pointing at a readable export folder",
    );
    const result = await svc.test({
      provider: "eaglesoft-export",
      host: "",
      databaseName: "",
      secretRef: "",
    } as never);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("ERP_NOT_CONNECTED");
    expect(result.message).toContain("ERP_EXPORT_DROP_ROOT");
    expect(result.message).not.toMatch(/SQL Anywhere|PattersonPM/);
  });

  it("still reports each direct track's own remediation", async () => {
    for (const [provider, needle] of [
      [EAGLESOFT_PROVIDER, "SAP SQL Anywhere"],
      [EAGLESOFT_API_PROVIDER, "Patterson vendor enrolment"],
    ] as const) {
      const svc = serviceWithBlockedConnector(`needs ${needle} things`);
      const result = await svc.test({
        provider,
        host: "h",
        databaseName: "d",
        secretRef: "s",
      } as never);
      expect(result.message, provider).toContain(needle);
    }
  });
});
