/**
 * WARP-1137 — erp.service unit tests (DB-independent orchestrator layer).
 *
 * In-memory vi.fn() Prisma stub (mirrors device-registry.service.test.ts). The
 * erp-connector stays STUBBED: every read/apply throws ConnectorBlockedError,
 * so the service must degrade honestly (ERP_NOT_CONNECTED / empty) — never
 * fabricate PHI. Covers:
 *  • read paths degrade to not-connected + still write an audit row;
 *  • the reachable write-request lifecycle (PENDING_CONFIRMATION → APPLYING →
 *    APPLIED | FAILED), explicit-enum only; DISCREPANCY lands with the live
 *    verify step (WARP-1095+) and CONFIRMED is unused in this slice;
 *  • a write is never applied without a confirmed request;
 *  • an audit row on every read AND every write transition.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createErpService } from "./erp.service.js";
import { ConnectorBlockedError } from "@droplet/erp-connector";

type ConnRow = {
  id: string;
  provider: string;
  status: string;
  writeEnabled: boolean;
  schemaHash: string | null;
};
type WriteReq = {
  id: string;
  connectionId: string;
  command: string;
  params: unknown;
  status: string;
  requestedBy: string;
  confirmedBy: string | null;
  reversal: unknown;
  discrepancy: unknown;
  createdAt: Date;
  updatedAt: Date;
};

function makePrismaMock(opts?: { writeEnabled?: boolean; connected?: boolean }) {
  const conn: ConnRow = {
    id: "conn-1",
    provider: "eaglesoft",
    status: opts?.connected ? "CONNECTED" : "PROVISIONING",
    writeEnabled: opts?.writeEnabled ?? false,
    schemaHash: null,
  };
  const writeRequests = new Map<string, WriteReq>();
  const auditLog: Array<Record<string, unknown>> = [];
  let seq = 0;

  const integrationConnection = {
    findFirst: vi.fn(async ({ where }: any) =>
      where.provider === conn.provider ? { ...conn } : null,
    ),
  };
  const erpWriteRequest = {
    create: vi.fn(async ({ data }: any) => {
      const id = `wr-${++seq}`;
      const row: WriteReq = {
        id,
        connectionId: data.connectionId,
        command: data.command,
        params: data.params,
        status: data.status ?? "PENDING_CONFIRMATION",
        requestedBy: data.requestedBy,
        confirmedBy: data.confirmedBy ?? null,
        reversal: data.reversal ?? null,
        discrepancy: data.discrepancy ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      writeRequests.set(id, row);
      return { ...row };
    }),
    findUnique: vi.fn(async ({ where }: any) => {
      const r = writeRequests.get(where.id);
      return r ? { ...r } : null;
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const existing = writeRequests.get(where.id);
      if (!existing) throw new Error("not found");
      const merged: WriteReq = { ...existing };
      for (const [k, v] of Object.entries(data)) {
        if (v !== undefined) (merged as any)[k] = v;
      }
      merged.updatedAt = new Date();
      writeRequests.set(where.id, merged);
      return { ...merged };
    }),
  };
  const erpAuditLog = {
    create: vi.fn(async ({ data }: any) => {
      const row = { id: `a-${auditLog.length + 1}`, at: new Date(), ...data };
      auditLog.push(row);
      return row;
    }),
  };

  return {
    prisma: { integrationConnection, erpWriteRequest, erpAuditLog } as any,
    _state: { conn, writeRequests, auditLog },
  };
}

/** Connector whose live methods are all stubbed (real WARP-1094 shape). */
function makeBlockedConnector(overrides?: Partial<Record<string, any>>) {
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
    ...overrides,
  };
}

const OWNER = { id: "user-owner", role: "owner" as const };

describe("erp.service (WARP-1137, DB-independent)", () => {
  let mock: ReturnType<typeof makePrismaMock>;
  let connector: ReturnType<typeof makeBlockedConnector>;
  let svc: ReturnType<typeof createErpService>;

  function build(o?: { writeEnabled?: boolean; connector?: any }) {
    mock = makePrismaMock({ writeEnabled: o?.writeEnabled });
    connector = o?.connector ?? makeBlockedConnector();
    svc = createErpService(mock.prisma, {
      connectorFor: () => connector as any,
    });
  }

  beforeEach(() => build());

  describe("read paths — honest degradation + audit", () => {
    it("getSchedule returns an empty, not-connected result when the connector is blocked", async () => {
      const res = await svc.getSchedule({ date: "2026-07-08" }, OWNER);
      expect(res.connected).toBe(false);
      expect(res.reason).toBe("ERP_NOT_CONNECTED");
      expect(res.items).toEqual([]);
      // audited even on a degraded read (invariant 11 / §14)
      const audit = mock._state.auditLog.at(-1)!;
      expect(audit.action).toBe("read:schedule");
      expect(audit.actor).toBe(OWNER.id);
    });

    it("searchPatients degrades to empty + not-connected, audits, and keeps the term OUT of scope", async () => {
      const res = await svc.searchPatients({ query: "smith" }, OWNER);
      expect(res.connected).toBe(false);
      expect(res.items).toEqual([]);
      const audit = mock._state.auditLog.at(-1)!;
      expect(audit.action).toBe("read:patients");
      // PHI-free audit scope (§14): the raw term (a name) is never persisted —
      // only its length.
      expect((audit.scope as { termLength?: number }).termLength).toBe(5);
      expect(JSON.stringify(audit.scope)).not.toContain("smith");
    });

    it("getPatient degrades to not-found/not-connected and audits the id scope", async () => {
      const res = await svc.getPatient("p-123", OWNER);
      expect(res.connected).toBe(false);
      expect(res.patient).toBeNull();
      const audit = mock._state.auditLog.at(-1)!;
      expect(audit.action).toBe("read:patient");
      expect((audit.scope as any).patientId).toBe("p-123");
    });

    it("getArSummary degrades to not-connected (no fabricated totals) and audits", async () => {
      const res = await svc.getArSummary(OWNER);
      expect(res.connected).toBe(false);
      expect(res.totalBalance).toBeNull();
      expect(res.accountCount).toBeNull();
      expect(mock._state.auditLog.at(-1)!.action).toBe("read:ar-summary");
    });

    it("getRecallDue degrades to empty + not-connected and audits", async () => {
      const res = await svc.getRecallDue(OWNER);
      expect(res.connected).toBe(false);
      expect(res.items).toEqual([]);
      expect(mock._state.auditLog.at(-1)!.action).toBe("read:recall-due");
    });
  });

  describe("write-request outbox lifecycle (explicit-enum state machine)", () => {
    beforeEach(() => build({ writeEnabled: true }));

    it("createWriteRequest stages PENDING_CONFIRMATION, touches nothing in Eaglesoft, and audits", async () => {
      const req = await svc.createWriteRequest(
        {
          command: "reschedule_appointment",
          params: { appt_id: "a1", last_modified: "t0", appt_time: "t1" },
        },
        OWNER,
      );
      expect(req.status).toBe("PENDING_CONFIRMATION");
      // The connector's applyWrite must NOT have been called at intent time.
      expect(connector.applyWrite).not.toHaveBeenCalled();
      expect(mock._state.auditLog.at(-1)!.action).toBe("write:request");
    });

    it("createWriteRequest is refused when writes are disabled (opt-in gate)", async () => {
      build({ writeEnabled: false });
      await expect(
        svc.createWriteRequest(
          { command: "reschedule_appointment", params: { appt_id: "a1" } },
          OWNER,
        ),
      ).rejects.toMatchObject({ code: "WRITE_NOT_ENABLED" });
    });

    it("createWriteRequest rejects an unregistered command name", async () => {
      await expect(
        svc.createWriteRequest(
          { command: "delete_everything", params: {} },
          OWNER,
        ),
      ).rejects.toMatchObject({ code: "VALIDATION" });
    });

    it("confirm advances PENDING_CONFIRMATION → APPLYING → FAILED when the connector is blocked (honest, no fake APPLIED)", async () => {
      const req = await svc.createWriteRequest(
        {
          command: "reschedule_appointment",
          params: { appt_id: "a1", last_modified: "t0", appt_time: "t1" },
        },
        OWNER,
      );
      const applied = await svc.confirmWriteRequest(req.id, OWNER);
      // The stubbed connector can't apply → we surface FAILED, never APPLIED.
      expect(applied.status).toBe("FAILED");
      expect(applied.confirmedBy).toBe(OWNER.id);
      expect(connector.applyWrite).toHaveBeenCalledTimes(1);
      // Transitions are audited (confirm + apply-result).
      const actions = mock._state.auditLog.map((a) => a.action);
      expect(actions).toContain("write:confirm");
    });

    it("confirm refuses a request that is not PENDING_CONFIRMATION (no double-apply)", async () => {
      const req = await svc.createWriteRequest(
        {
          command: "reschedule_appointment",
          params: { appt_id: "a1", last_modified: "t0", appt_time: "t1" },
        },
        OWNER,
      );
      await svc.confirmWriteRequest(req.id, OWNER); // → FAILED
      await expect(svc.confirmWriteRequest(req.id, OWNER)).rejects.toMatchObject({
        code: "INVALID_STATE",
      });
    });

    it("confirm 404s an unknown request id", async () => {
      await expect(svc.confirmWriteRequest("nope", OWNER)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    });

    it("getWriteRequest reads the current explicit status", async () => {
      const req = await svc.createWriteRequest(
        {
          command: "reschedule_appointment",
          params: { appt_id: "a1", last_modified: "t0", appt_time: "t1" },
        },
        OWNER,
      );
      const read = await svc.getWriteRequest(req.id, OWNER);
      expect(read.status).toBe("PENDING_CONFIRMATION");
      expect(read.command).toBe("reschedule_appointment");
    });

    it("APPLIED is reachable when the connector applies + verify matches (live-path shape)", async () => {
      // Prove the state machine can reach APPLIED — even though the real
      // connector is stubbed, the service maps a successful apply correctly.
      const applyingConnector = makeBlockedConnector({
        applyWrite: vi.fn(async () => ({ ok: true })),
      });
      build({ writeEnabled: true, connector: applyingConnector });
      const req = await svc.createWriteRequest(
        {
          command: "reschedule_appointment",
          params: { appt_id: "a1", last_modified: "t0", appt_time: "t1" },
        },
        OWNER,
      );
      const applied = await svc.confirmWriteRequest(req.id, OWNER);
      expect(applied.status).toBe("APPLIED");
    });

    it("a non-blocked apply failure records FAILED with a discrepancy (never a fake APPLIED)", async () => {
      const failing = makeBlockedConnector({
        applyWrite: vi.fn(async () => {
          throw new Error("optimistic guard miss");
        }),
      });
      build({ writeEnabled: true, connector: failing });
      const req = await svc.createWriteRequest(
        { command: "reschedule_appointment", params: { appt_id: "a1", last_modified: "t0", appt_time: "t1" } },
        OWNER,
      );
      const applied = await svc.confirmWriteRequest(req.id, OWNER);
      expect(applied.status).toBe("FAILED");
      expect(applied.discrepancy).toBeTruthy();
    });

    it("confirm is refused when writes were turned off after staging (kill-switch, invariant 1)", async () => {
      const req = await svc.createWriteRequest(
        { command: "reschedule_appointment", params: { appt_id: "a1", last_modified: "t0", appt_time: "t1" } },
        OWNER,
      );
      // Flip the per-practice kill-switch after the request was staged.
      mock._state.conn.writeEnabled = false;
      await expect(svc.confirmWriteRequest(req.id, OWNER)).rejects.toMatchObject({
        code: "WRITE_NOT_ENABLED",
      });
    });
  });

  describe("RBAC — PHI minimum-necessary (§14)", () => {
    const FAMILY = { id: "u-family", role: "family" };
    const GUEST = { id: "u-guest", role: "guest" };

    it("denies a non-clinical role (family/guest) every PHI read — and never audits the denial", async () => {
      for (const u of [FAMILY, GUEST]) {
        const before = mock._state.auditLog.length;
        await expect(svc.getSchedule({ date: "2026-07-08" }, u)).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(svc.searchPatients({ query: "smith" }, u)).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(svc.getPatient("p-1", u)).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(svc.getArSummary(u)).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(svc.getRecallDue(u)).rejects.toMatchObject({ code: "FORBIDDEN" });
        expect(mock._state.auditLog.length).toBe(before); // a denied read touches nothing
      }
    });

    it("denies a non-owner/admin role staging or confirming a write", async () => {
      build({ writeEnabled: true });
      await expect(
        svc.createWriteRequest({ command: "reschedule_appointment", params: {} }, FAMILY),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(svc.confirmWriteRequest("wr-x", FAMILY)).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  });
});
