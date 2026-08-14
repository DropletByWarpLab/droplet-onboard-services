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
      // The block is caught at connect(), so the write is never even attempted
      // against the practice — a stronger guarantee than "applyWrite refused",
      // which is what this asserted before the service opened a session first.
      expect(connector.connect).toHaveBeenCalledTimes(1);
      expect(connector.applyWrite).not.toHaveBeenCalled();
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
        // A connector that can apply is one that can also connect — the
        // service opens a session first (as it must against a real box).
        connect: vi.fn(async () => {}),
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
        // Connects fine; it is the APPLY that fails, which is the scenario
        // under test (a non-blocked failure → FAILED + discrepancy).
        connect: vi.fn(async () => {}),
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

  // ── WARP-1530 / ADR-032 §8 O-2 ──────────────────────────────────
  //
  // The route resolves the person's connector reach (effective-access
  // service) and threads it down as `ErpUser.connectorLevel`. The service
  // keeps its OWN assertion so a future mis-registered route can never
  // fail open onto PHI: the tier set is NOT widened — `family` is admitted
  // only when it arrives carrying a resolved grant.
  describe("RBAC — O-2 connector floor (WARP-1530)", () => {
    const RECEPTION = { id: "u-reception", role: "family", connectorLevel: "read" as const };
    const FAMILY_NO_GRANT = { id: "u-family", role: "family" };
    const A_GUEST = { id: "u-guest", role: "guest" };

    it("admits a family person carrying a resolved connector grant to every PHI read", async () => {
      for (const call of [
        () => svc.getSchedule({ date: "2026-07-08" }, RECEPTION),
        () => svc.searchPatients({ query: "smith" }, RECEPTION),
        () => svc.getPatient("p-1", RECEPTION),
        () => svc.getArSummary(RECEPTION),
        () => svc.getRecallDue(RECEPTION),
      ]) {
        const before = mock._state.auditLog.length;
        await expect(call()).resolves.toMatchObject({ connected: false });
        // An admitted read is audited like any other (§14).
        expect(mock._state.auditLog.length).toBe(before + 1);
        expect(mock._state.auditLog.at(-1)!.actor).toBe(RECEPTION.id);
      }
    });

    it("still refuses a family person with NO resolved grant (the tier set is not widened)", async () => {
      await expect(
        svc.getSchedule({ date: "2026-07-08" }, FAMILY_NO_GRANT),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        svc.getSchedule({ date: "2026-07-08" }, { ...FAMILY_NO_GRANT, connectorLevel: null }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("refuses a guest even with a grant somehow attached — reads are family-AND-UP", async () => {
      await expect(
        svc.getSchedule({ date: "2026-07-08" }, { ...A_GUEST, connectorLevel: "read_write" as const }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("keeps writes admin-tier: a family person with read_write reach still cannot stage or confirm", async () => {
      build({ writeEnabled: true });
      const familyRw = { id: "u-reception", role: "family", connectorLevel: "read_write" as const };
      await expect(
        svc.createWriteRequest({ command: "reschedule_appointment", params: {} }, familyRw),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(svc.confirmWriteRequest("wr-x", familyRw)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    });

    it("leaves owner/admin unchanged whether or not a level is threaded (no accessRole = today)", async () => {
      await expect(svc.getSchedule({ date: "2026-07-08" }, OWNER)).resolves.toMatchObject({
        connected: false,
      });
      await expect(
        svc.getSchedule({ date: "2026-07-08" }, { id: "u-admin", role: "admin" }),
      ).resolves.toMatchObject({ connected: false });
    });
  });

  // ── WARP-1579 ───────────────────────────────────────────────────
  //
  // The route's write gate reads the RAW role grant and threads it down as
  // `ErpUser.connectorGrantLevel`. The service keeps its own assertion for
  // the same reason the read side does: a future route registered without
  // the gate must not silently regain write reach the operator revoked.
  //
  // ABSENT is deliberately not a denial here. Every caller that predates
  // RBAC v2 — and every role-less admin today — arrives with no grant at
  // all, and turning that into a 403 would take ERP writes away from the
  // people who have them. Only an EXPLICIT read-only grant refuses.
  describe("RBAC — the connector grant level gates writes (WARP-1579)", () => {
    const READONLY_ADMIN = {
      id: "u-readonly-admin",
      role: "admin",
      connectorLevel: "read" as const,
      connectorGrantLevel: "read" as const,
    };

    it("refuses an admin carrying an explicit READ-ONLY connector grant", async () => {
      build({ writeEnabled: true });
      await expect(
        svc.createWriteRequest({ command: "reschedule_appointment", params: {} }, READONLY_ADMIN),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(svc.confirmWriteRequest("wr-x", READONLY_ADMIN)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    });

    it("…while that same admin keeps every PHI read (read-only is a level, not a lockout)", async () => {
      await expect(
        svc.getSchedule({ date: "2026-07-08" }, READONLY_ADMIN),
      ).resolves.toMatchObject({ connected: false });
    });

    it("admits a read_write grant, and an ABSENT grant (today's world) unchanged", async () => {
      build({ writeEnabled: true });
      for (const user of [
        { ...READONLY_ADMIN, connectorLevel: "read_write" as const, connectorGrantLevel: "read_write" as const },
        { id: "u-admin", role: "admin" },
        { id: "u-admin", role: "admin", connectorGrantLevel: null },
        OWNER,
      ]) {
        await expect(
          svc.createWriteRequest({ command: "reschedule_appointment", params: {} }, user),
        ).resolves.toMatchObject({ status: "PENDING_CONFIRMATION" });
      }
    });

    it("never narrows an OWNER — §3's one bypass holds at this layer too", async () => {
      // The route lets owners bypass layer 2 and so never threads them a
      // grant; this shape should not occur. Pinned in the ADR's direction
      // rather than the strict one: `assertCanReadPhi` already admits owner
      // unconditionally, and an owner locked out of their own ERP by a stray
      // grant row would be a worse failure than the one being fixed.
      build({ writeEnabled: true });
      await expect(
        svc.createWriteRequest(
          { command: "reschedule_appointment", params: {} },
          { ...OWNER, connectorGrantLevel: "read" as const },
        ),
      ).resolves.toMatchObject({ status: "PENDING_CONFIRMATION" });
    });
  });
});

/**
 * WARP-1964 — the export-drop track must be reachable from the read service.
 *
 * `eaglesoftRow()` is the single row resolver behind all five named reads. It
 * originally looked up only the two direct-connection provider keys, so a fully
 * connected `<vendor>-export` row was invisible: every read answered
 * NOT_CONFIGURED with zero rows while a working export drop sat on disk. The
 * connector was correct and simply never called.
 */
describe("erp.service — export-drop row selection (WARP-1964)", () => {
  const OWNER_USER = { id: "u-owner", role: "owner" as const, connectorGrantLevel: null };

  /** Prisma stub that understands both `provider: "x"` and `provider: { in: [...] }`. */
  function prismaWithRows(rows: Array<{ provider: string; status: string }>) {
    const full = rows.map((r, i) => ({
      id: `conn-${i}`,
      provider: r.provider,
      status: r.status,
      writeEnabled: false,
      schemaHash: null,
    }));
    return {
      integrationConnection: {
        findFirst: vi.fn(async ({ where }: any) => {
          const matches = full.filter((row) => {
            const p = where.provider;
            const byProvider =
              typeof p === "string" ? row.provider === p : p?.in?.includes(row.provider);
            const byStatus = where.status === undefined || row.status === where.status;
            return byProvider && byStatus;
          });
          return matches[0] ? { ...matches[0] } : null;
        }),
      },
      erpAuditLog: { create: vi.fn(async () => ({})) },
    } as never;
  }

  function serviceOver(
    rows: Array<{ provider: string; status: string }>,
    runRead: () => Promise<unknown[]>,
  ) {
    const seen: string[] = [];
    const svc = createErpService(prismaWithRows(rows), {
      connectorFor: ((conn: { provider: string }) => {
        seen.push(conn.provider);
        return {
          provider: conn.provider,
          connect: async () => {},
          close: async () => {},
          health: async () => ({ ok: true }),
          introspect: async () => ({ tables: [], fingerprint: "f" }),
          runRead,
          applyWrite: async () => ({}),
        };
      }) as never,
    });
    return { svc, seen };
  }

  it("reaches an export-drop connection — the reads are not NOT_CONFIGURED", async () => {
    const { svc, seen } = serviceOver(
      [{ provider: "eaglesoft-export", status: "CONNECTED" }],
      async () => [{ patient_id: "P1", first_name: "Ada", last_name: "Lovelace" }],
    );
    const result = await svc.searchPatients({ query: "Love" }, OWNER_USER);
    expect(result.connected).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(seen).toEqual(["eaglesoft-export"]);
  });

  it("serves any vendor's export key, not just Eaglesoft's", async () => {
    for (const provider of ["dentrix-export", "opendental-export", "generic-export"]) {
      const { svc, seen } = serviceOver([{ provider, status: "CONNECTED" }], async () => []);
      const result = await svc.getArSummary(OWNER_USER);
      expect(result.connected, provider).toBe(true);
      expect(seen).toEqual([provider]);
    }
  });

  it("does not let an export row shadow a CONNECTED direct-track row", async () => {
    const { svc, seen } = serviceOver(
      [
        { provider: "eaglesoft", status: "CONNECTED" },
        { provider: "eaglesoft-export", status: "CONNECTED" },
      ],
      async () => [],
    );
    await svc.getArSummary(OWNER_USER);
    expect(seen).toEqual(["eaglesoft"]);
  });

  it("prefers a CONNECTED export row over a direct row that is not connected", async () => {
    // A permanently-blocked SQL row must not shadow a track that actually works
    // — the same reasoning the SQL-vs-API precedence was written for.
    const { svc, seen } = serviceOver(
      [
        { provider: "eaglesoft", status: "PROVISIONING" },
        { provider: "eaglesoft-export", status: "CONNECTED" },
      ],
      async () => [],
    );
    await svc.getArSummary(OWNER_USER);
    expect(seen).toEqual(["eaglesoft-export"]);
  });

  it("still answers NOT_CONFIGURED when there is no row at all", async () => {
    const { svc } = serviceOver([], async () => []);
    const result = await svc.getArSummary(OWNER_USER);
    expect(result.connected).toBe(false);
    expect(result.reason).toBe("NOT_CONFIGURED");
  });
});
