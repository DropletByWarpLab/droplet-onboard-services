/**
 * WARP-2218 — the connector sync runner.
 *
 * The case that carries this whole story is
 * `"finds a record the incremental read dropped"`. It encodes the
 * Xero/HubSpot/Stripe trap: three of the five v1 vendors have delta reads that
 * silently omit records, so a sweep that resumes from the watermark would
 * report a clean account forever. **That test must not be weakened.**
 *
 * The connector is injected and every assertion that matters is on the CALLS
 * MADE, not only the value returned — the budget guard is a promise about
 * requests that must NOT happen, and a return value cannot express that.
 * Prisma is a `vi.fn()` store, per the team rule against mock-database
 * integration tests.
 */
import { describe, it, expect, vi } from "vitest";
import type { Connector } from "@droplet/erp-connector";
import { QuotaExhaustedError, ReauthorizationRequiredError } from "@droplet/erp-connector";

import { createErpSyncRunner, type SyncConnectionRow } from "./erp-sync.service.js";

const NOW = new Date("2026-08-27T12:00:00Z");
const LATER = new Date("2026-08-27T13:00:00Z");

/** A vendor payload carrying every class of content the audit must not leak. */
const INVOICE_ROWS = [
  {
    invoice_id: "INV-1001",
    issued_at: "2026-08-10T00:00:00Z",
    due_at: "2026-09-10T00:00:00Z",
    customer_id: "smith-dental",
    amount: "4210.55",
    balance: "4210.55",
    status: "Open",
    customer_email: "amanda.smith@example.com",
  },
  {
    invoice_id: "INV-1002",
    issued_at: "2026-08-20T00:00:00Z",
    due_at: "2026-09-20T00:00:00Z",
    customer_id: "jones-ortho",
    amount: "980.00",
    balance: "980.00",
    status: "Open",
    customer_email: "b.jones@example.com",
  },
];

function connectionRow(over: Partial<SyncConnectionRow> = {}): SyncConnectionRow {
  return {
    id: "conn-1",
    provider: "quickbooks-online",
    status: "CONNECTED",
    host: null,
    port: null,
    databaseName: null,
    secretRef: "qbo:pointer",
    ...over,
  };
}

function cursorRow(over: Record<string, unknown> = {}) {
  return {
    id: "cur-1",
    connectionId: "conn-1",
    entity: "invoice",
    watermark: "2026-08-15T00:00:00Z",
    state: "IDLE",
    consecutiveFailures: 0,
    nextAttemptAt: null,
    lastSyncedAt: null,
    lastSweepAt: null,
    needsReconnect: false,
    lastError: null,
    ...over,
  };
}

interface Harness {
  prisma: any;
  recorder: { record: ReturnType<typeof vi.fn<(...args: any[]) => any>> };
  connector: Connector & { runRead: ReturnType<typeof vi.fn<(...args: any[]) => any>> };
  budget: {
    assertHeadroom: ReturnType<typeof vi.fn<(...args: any[]) => any>>;
    record: ReturnType<typeof vi.fn<(...args: any[]) => any>>;
  };
}

function harness(opts: {
  cursors?: Array<Record<string, unknown>>;
  connections?: SyncConnectionRow[];
  /** Answers keyed by whether the read carried a `since` param. */
  read?: (name: string, params: Record<string, unknown>) => Promise<unknown[]>;
  headroom?: () => void;
  /** Pre-existing `ErpDriftRecord` rows (WARP-2463's earned cadence). */
  driftRecords?: Array<Record<string, unknown>>;
} = {}): Harness {
  const cursors = (opts.cursors ?? [cursorRow()]).map((c) => ({ ...c }));
  const connections = opts.connections ?? [connectionRow()];
  const driftRows = (opts.driftRecords ?? []).map((r) => ({ ...r }));

  const recorder = { record: vi.fn(async () => ({}) as never) };
  const budget = {
    assertHeadroom: vi.fn(opts.headroom ?? (() => {})),
    record: vi.fn(),
  };

  const runRead = vi.fn(
    opts.read ?? (async () => INVOICE_ROWS),
  );
  const connector = {
    provider: "quickbooks-online",
    servesDatasets: ["invoice", "bill"],
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    health: vi.fn(async () => ({ ok: true })),
    introspect: vi.fn(),
    runRead,
    applyWrite: vi.fn(),
  } as unknown as Connector & { runRead: ReturnType<typeof vi.fn> };

  const prisma = {
    __cursors: cursors,
    __conns: connections,
    __driftRows: driftRows,
    __cursor: (id: string) => cursors.find((c) => c.id === id),
    integrationConnection: {
      findMany: vi.fn(async (args: any) => {
        const wanted: string[] = args?.where?.status?.in ?? [];
        return connections
          .filter((c) => wanted.length === 0 || wanted.includes(c.status))
          .map((c) => ({ id: c.id, provider: c.provider, status: c.status }));
      }),
      findUnique: vi.fn(async (args: any) =>
        connections.find((c) => c.id === args.where.id) ?? null,
      ),
      update: vi.fn(async (args: any) => {
        const c = connections.find((x) => x.id === args.where.id) as any;
        if (c) Object.assign(c, args.data);
        return c;
      }),
    },
    erpSyncCursor: {
      findMany: vi.fn(async (args: any) => {
        const w = args?.where ?? {};
        return cursors.filter((r) => {
          if (w.connectionId?.in && !w.connectionId.in.includes(r.connectionId)) return false;
          if (w.connectionId && typeof w.connectionId === "string" && r.connectionId !== w.connectionId)
            return false;
          if (w.state?.in && !w.state.in.includes(r.state)) return false;
          return true;
        });
      }),
      updateMany: vi.fn(async (args: any) => {
        const { id, state } = args.where;
        const ok = (actual: unknown) =>
          state === undefined
            ? true
            : Array.isArray(state?.in)
              ? state.in.includes(actual)
              : actual === state;
        const row = cursors.find((r) => r.id === id && ok(r.state));
        if (!row) return { count: 0 };
        Object.assign(row, args.data);
        return { count: 1 };
      }),
      update: vi.fn(async (args: any) => {
        const row = cursors.find((r) => r.id === args.where.id);
        if (row) Object.assign(row, args.data);
        return row;
      }),
      upsert: vi.fn(async () => ({})),
    },
    // WARP-2463 — the sweep's drift report is persisted. Seeded rows let a
    // case exercise the earned-cadence path without running N real sweeps.
    erpDriftRecord: {
      create: vi.fn(async (args: any) => {
        driftRows.push({ id: `d-${driftRows.length + 1}`, ...args.data });
        return args.data;
      }),
      findMany: vi.fn(async (args: any) => {
        const w = args?.where ?? {};
        let out = driftRows.filter(
          (r) => !w.connectionId || r.connectionId === w.connectionId,
        );
        if (args?.orderBy?.sweepAt === "desc") {
          out = [...out].sort(
            (a, b) => (b.sweepAt as Date).getTime() - (a.sweepAt as Date).getTime(),
          );
        }
        return typeof args?.take === "number" ? out.slice(0, args.take) : out;
      }),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
  };

  return { prisma, recorder, connector, budget };
}

function runnerFor(h: Harness, extra: Record<string, unknown> = {}) {
  return createErpSyncRunner({
    prisma: h.prisma,
    recorder: h.recorder as never,
    connectorFor: () => h.connector,
    budgetFor: () => h.budget,
    now: () => NOW,
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// The incremental tick
// ---------------------------------------------------------------------------

describe("runIncrementalTick", () => {
  it("advances lastHealthyAt on a CONNECTED row with NO human action", async () => {
    // The defect this story exists to fix: before WARP-2218 the only write of
    // lastHealthyAt in the tree was inside connect(), so "last synced" meant
    // "last connected". This test never goes near the connect path.
    //
    // MUTATION: delete the `advanceLastHealthy` call from the tick handler →
    // `integrationConnection.update` is never called with lastHealthyAt → red.
    const h = harness();
    const out = await runnerFor(h).runIncrementalTick();

    expect(out.succeeded).toBe(1);
    const call = h.prisma.integrationConnection.update.mock.calls.find(
      (c: any[]) => c[0]?.data?.lastHealthyAt !== undefined,
    );
    expect(call).toBeDefined();
    expect(call![0].where).toEqual({ id: "conn-1" });
    expect(call![0].data.lastHealthyAt).toEqual(NOW);
  });

  it("passes the persisted watermark to the vendor read", async () => {
    const h = harness();
    await runnerFor(h).runIncrementalTick();
    expect(h.connector.runRead).toHaveBeenCalledWith("get_open_invoices", {
      since: "2026-08-15T00:00:00Z",
    });
  });

  it("reads tick N+1 from the high-water mark tick N returned", async () => {
    // MUTATION: re-read from the PREVIOUS watermark (i.e. never advance it, or
    // store the old value) → the second read still asks for 2026-08-15 → red.
    const h = harness();
    const runner = runnerFor(h);

    await runner.runIncrementalTick();
    expect(h.prisma.__cursor("cur-1")!.watermark).toBe("2026-08-20T00:00:00Z");

    // Tick N+1: the claim needs the cursor back in a claimable state.
    h.connector.runRead.mockClear();
    await runner.runIncrementalTick();
    expect(h.connector.runRead).toHaveBeenCalledWith("get_open_invoices", {
      since: "2026-08-20T00:00:00Z",
    });
  });

  it("enumerates from the beginning when the cursor has never synced", async () => {
    const h = harness({ cursors: [cursorRow({ watermark: null })] });
    await runnerFor(h).runIncrementalTick();
    expect(h.connector.runRead).toHaveBeenCalledWith("get_open_invoices", {});
  });

  it("never regresses the watermark when a page comes back empty", async () => {
    // An empty page must not reset the position to null and re-enumerate the
    // whole account on the next tick.
    const h = harness({ read: async () => [] });
    await runnerFor(h).runIncrementalTick();
    expect(h.prisma.__cursor("cur-1")!.watermark).toBe("2026-08-15T00:00:00Z");
  });

  it("does not poll a DISABLED connection at all", async () => {
    // MUTATION: drop the status filter from the due-cursor query → the vendor
    // is dialled for a connection an operator turned off → red.
    const h = harness({ connections: [connectionRow({ status: "DISABLED" })] });
    const out = await runnerFor(h).runIncrementalTick();
    expect(out.cursorsClaimed).toBe(0);
    expect(h.connector.runRead).not.toHaveBeenCalled();
    expect(h.connector.connect).not.toHaveBeenCalled();
  });

  it("does not poll a NOT_CONFIGURED connection at all", async () => {
    const h = harness({ connections: [connectionRow({ status: "NOT_CONFIGURED" })] });
    expect((await runnerFor(h).runIncrementalTick()).cursorsClaimed).toBe(0);
    expect(h.connector.runRead).not.toHaveBeenCalled();
  });

  it("checks headroom BEFORE the request, so an exhausted budget costs no network", async () => {
    // The budget guard is a promise about requests that must not happen, so
    // the assertion is on the calls made.
    // MUTATION: exempt the tick from the budget (drop assertHeadroom) → the
    // read happens despite an exhausted allowance → red.
    const h = harness({
      headroom: () => {
        throw new QuotaExhaustedError(5000, 5000);
      },
    });
    await runnerFor(h).runIncrementalTick();
    expect(h.budget.assertHeadroom).toHaveBeenCalled();
    expect(h.connector.runRead).not.toHaveBeenCalled();
  });

  it("records BACKOFF for an exhausted quota — never a zero-row success", async () => {
    // `[]` from an accounting read states "you owe nobody anything". None of
    // QUOTA_EXHAUSTED / REAUTHORIZE / ConnectorBlocked may ever render that way.
    // MUTATION: map QuotaExhaustedError onto a successful empty sync → the
    // state is IDLE and lastSyncedAt moves → red.
    const h = harness({
      headroom: () => {
        throw new QuotaExhaustedError(5000, 5000);
      },
    });
    const out = await runnerFor(h).runIncrementalTick();
    expect(out.succeeded).toBe(0);
    expect(h.prisma.__cursor("cur-1")!.state).toBe("BACKOFF");
    expect(h.prisma.__cursor("cur-1")!.lastSyncedAt).toBeNull();
  });

  it("treats a revoked grant as needsReconnect, never FAILED", async () => {
    // ADR-041: a customer credential dying is ROUTINE. The product asks the
    // owner to paste a new one; it does not raise an incident.
    // MUTATION: route ReauthorizationRequiredError through the FATAL branch →
    // state FAILED and needsReconnect false → red.
    const h = harness({
      read: async () => {
        throw new ReauthorizationRequiredError("refresh token revoked");
      },
    });
    await runnerFor(h).runIncrementalTick();
    const cur = h.prisma.__cursor("cur-1")!;
    expect(cur.needsReconnect).toBe(true);
    expect(cur.state).toBe("BACKOFF");
    expect(cur.state).not.toBe("FAILED");
    // The watermark survives, so reconnecting does not cost a re-enumeration.
    expect(cur.watermark).toBe("2026-08-15T00:00:00Z");
  });

  it("sends RESYNC_REQUIRED back to IDLE via a full re-enumeration, never an error", async () => {
    // MUTATION: map RESYNC_REQUIRED to the error branch → the second tick
    // never runs (FAILED is unclaimable) and the state never returns to IDLE.
    let call = 0;
    const h = harness({
      read: async (_name, params) => {
        call += 1;
        if (call === 1) {
          const err = Object.assign(new Error("cursor expired"), { statusCode: 410 });
          throw err;
        }
        // Tick two must re-enumerate: no watermark at all.
        expect(params).toEqual({});
        return INVOICE_ROWS;
      },
    });
    const runner = runnerFor(h);

    await runner.runIncrementalTick();
    expect(h.prisma.__cursor("cur-1")!.state).toBe("RESYNC_REQUIRED");
    expect(h.prisma.__cursor("cur-1")!.watermark).toBeNull();

    await runner.runIncrementalTick();
    expect(h.prisma.__cursor("cur-1")!.state).toBe("IDLE");
    expect(h.prisma.__cursor("cur-1")!.lastError).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Which value the watermark advances on (WARP-2474)
// ---------------------------------------------------------------------------

describe("watermark source", () => {
  /** A vendor that fills WARP-2464's canonical column: the documents were
   *  issued in August and MODIFIED afterwards. */
  const ROWS_WITH_UPDATED_AT = INVOICE_ROWS.map((r, i) => ({
    ...r,
    updated_at: i === 0 ? "2026-08-24T00:00:00Z" : "2026-08-25T00:00:00Z",
  }));

  /** The QuickBooks Online / Desktop invoice+bill shape: the canonical column
   *  is PRESENT on every row and carries `undefined`, exactly as `status`
   *  does on the same builders. */
  const QUICKBOOKS_ROWS = INVOICE_ROWS.map((r) => ({
    ...r,
    updated_at: undefined as string | undefined,
  }));

  it("advances on `updated_at` when the vendor supplies one", async () => {
    // The defect: an incremental pull keyed on `issued_at` re-reads every row
    // whose only change is a vendor-side modification — the exact case
    // WARP-2464 added the column for.
    // MUTATION: build the watermark from `spec.markerField` alone → the
    // cursor stops at 2026-08-20 → red.
    const h = harness({ read: async () => ROWS_WITH_UPDATED_AT });
    await runnerFor(h).runIncrementalTick();
    expect(h.prisma.__cursor("cur-1")!.watermark).toBe("2026-08-25T00:00:00Z");
  });

  it("reads the next tick from the `updated_at` it advanced to", async () => {
    // The advance is only worth anything if the vendor read inherits it.
    const h = harness({ read: async () => ROWS_WITH_UPDATED_AT });
    const runner = runnerFor(h);
    await runner.runIncrementalTick();
    h.connector.runRead.mockClear();
    await runner.runIncrementalTick();
    expect(h.connector.runRead).toHaveBeenCalledWith("get_open_invoices", {
      since: "2026-08-25T00:00:00Z",
    });
  });

  it("falls back to the ordering key, NON-NULL, when `updated_at` is undefined", async () => {
    // *** THE CASE THE TICKET IS WRITTEN AROUND ***
    // QBO and QBD serve invoice/bill from hand-written row builders that emit
    // `updated_at: undefined`. A fallback that tests COLUMN PRESENCE reads
    // that as "there is an updated_at" and regresses this track to a null —
    // or, once stringified, to the literal "undefined" — watermark.
    //
    // MUTATION: in `identify`, project the column with a presence test
    // (`updatedAtField in rec ? String(...) : null`) → the stored watermark
    // becomes the string "undefined" → red.
    const h = harness({ read: async () => QUICKBOOKS_ROWS });
    await runnerFor(h).runIncrementalTick();
    const watermark = h.prisma.__cursor("cur-1")!.watermark;
    expect(watermark).toBe("2026-08-20T00:00:00Z");
    expect(watermark).not.toBeNull();
    expect(watermark).not.toBe("undefined");
  });

  it("falls back for a dataset whose rows carry no `updated_at` column at all", async () => {
    // The seven datasets WARP-2464 deliberately withheld the column from.
    const h = harness();
    await runnerFor(h).runIncrementalTick();
    expect(h.prisma.__cursor("cur-1")!.watermark).toBe("2026-08-20T00:00:00Z");
  });

  it("adopts the sweep's `updated_at` high-water mark too", async () => {
    // The sweep repairs a watermark left behind, so it must repair it to the
    // same kind of value the tick advances to — otherwise the two legs fight
    // over the cursor every day.
    const h = harness({ read: async () => ROWS_WITH_UPDATED_AT });
    await runnerFor(h).runReconciliationSweep();
    expect(h.prisma.__cursor("cur-1")!.watermark).toBe("2026-08-25T00:00:00Z");
  });
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

describe("audit rows", () => {
  it("writes exactly one row on a SUCCESSFUL tick", async () => {
    const h = harness();
    await runnerFor(h).runIncrementalTick();
    expect(h.recorder.record).toHaveBeenCalledTimes(1);
  });

  it("writes exactly one row on a FAILED tick", async () => {
    // MUTATION: move the `record()` call inside the success branch → this case
    // sees zero rows → red. A job that reaches a customer's Stripe account on
    // a schedule and leaves no trace on failure is the gap the chain exists
    // to close.
    const h = harness({
      read: async () => {
        throw Object.assign(new Error("vendor exploded"), { statusCode: 500 });
      },
    });
    const out = await runnerFor(h).runIncrementalTick();
    expect(out.failed).toBe(1);
    expect(h.recorder.record).toHaveBeenCalledTimes(1);
    expect(h.recorder.record.mock.calls[0][0].severity).toBe("warn");
  });

  it("carries NO customer content into the audit scope", async () => {
    // The vendor payload above contains a customer name, an amount and an
    // email. None may reach the chain.
    const h = harness();
    await runnerFor(h).runIncrementalTick();
    const scope = JSON.stringify(h.recorder.record.mock.calls[0][0].refs);

    expect(scope).not.toContain("smith");
    expect(scope).not.toContain("4210.55");
    expect(scope).not.toContain("amanda.smith@example.com");
    expect(scope).not.toContain("INV-1001");
    // What it DOES carry is what makes the row useful.
    expect(scope).toContain("conn-1");
    expect(scope).toContain("invoice");
    expect(scope).toContain("recordCount");
  });

  it("carries no credential material into the audit scope", async () => {
    // Rule 19 — never log a captured secret. A vendor echoing the key that
    // failed must not put it in the audit chain.
    const h = harness({
      read: async () => {
        throw Object.assign(
          new Error("401 for rk_live_51QaBcDeFgHiJkLmNoP (starting_after=cus_SECRET9)"),
          { statusCode: 400 },
        );
      },
    });
    await runnerFor(h).runIncrementalTick();
    const scope = JSON.stringify(h.recorder.record.mock.calls[0][0].refs);
    expect(scope).not.toContain("rk_live_51QaBcDeFgHiJkLmNoP");
    expect(scope).not.toContain("cus_SECRET9");
  });

  it("goes through activity.service record(), not a second ad-hoc writer", async () => {
    const h = harness();
    await runnerFor(h).runIncrementalTick();
    const params = h.recorder.record.mock.calls[0][0];
    expect(params.kind).toBe("system");
    expect(params.actor).toEqual({ type: "system", id: "erp-sync" });
  });
});

// ---------------------------------------------------------------------------
// The full reconciliation sweep — the load-bearing half
// ---------------------------------------------------------------------------

/**
 * The vendor page the incremental read gets OMITS a record that was
 * genuinely mutated — the Xero/HubSpot/Stripe trap. The full enumeration
 * returns it.
 *
 * Module scope rather than inside `describe("runReconciliationSweep")` because
 * WARP-2463's persistence cases need the same drifted account (a second copy
 * would be free to stop modelling the same defect).
 */
function driftHarness() {
  const mutatedButOmitted = {
    invoice_id: "INV-1003",
    issued_at: "2026-08-26T00:00:00Z",
    due_at: "2026-09-26T00:00:00Z",
    customer_id: "smith-dental",
    amount: "77.10",
    balance: "77.10",
    status: "Open",
  };
  return harness({
    cursors: [cursorRow({ entity: "invoice", watermark: "2026-08-15T00:00:00Z" })],
    read: async (_name, params) => {
      // The delta read honours `since` and — this is the defect being
      // modelled — silently leaves out a record it should have returned.
      if ("since" in params) return INVOICE_ROWS;
      // The full re-enumeration sees everything.
      return [...INVOICE_ROWS, mutatedButOmitted];
    },
  });
}

describe("runReconciliationSweep", () => {
  it("finds a record the incremental read dropped, and says so in the drift report", async () => {
    // ***  THE TEST THIS STORY EXISTS FOR — DO NOT WEAKEN  ***
    //
    // MUTATION: make the sweep resume from the watermark instead of
    // re-enumerating (pass `{ since: watermark }` to the second read) → the
    // full read collapses onto the incremental one, the diff is empty,
    // totalMissed is 0 and driftDetected is false → RED.
    //
    // A sweep that reports a clean account because it stopped looking is
    // exactly the failure mode this guards: a silently-dropped record reports
    // success and the owner has no way to find out.
    const h = driftHarness();
    const { reports } = await runnerFor(h).runReconciliationSweep();

    expect(reports).toHaveLength(1);
    const report = reports[0];
    expect(report.driftDetected).toBe(true);
    expect(report.totalMissed).toBe(1);

    const invoice = report.entities.find((e) => e.entity === "invoice")!;
    expect(invoice.missedCount).toBe(1);
    expect(invoice.fullCount).toBe(3);
    expect(invoice.incrementalCount).toBe(2);
    expect(invoice.classes).toContain("missed-newer");
  });

  it("issues the full read with NO watermark — the property the above rests on", async () => {
    const h = driftHarness();
    await runnerFor(h).runReconciliationSweep();
    const paramSets = h.connector.runRead.mock.calls.map((c: any[]) => c[1]);
    expect(paramSets).toContainEqual({ since: "2026-08-15T00:00:00Z" });
    expect(paramSets).toContainEqual({});
  });

  it("reports a clean sweep when the incremental path missed nothing", async () => {
    // The negative case, so the drift assertion is not vacuously true: with a
    // faithful vendor the same code path must report zero.
    const h = harness({
      read: async (_n, params) =>
        "since" in params ? INVOICE_ROWS : INVOICE_ROWS,
    });
    const { reports } = await runnerFor(h).runReconciliationSweep();
    expect(reports[0].driftDetected).toBe(false);
    expect(reports[0].totalMissed).toBe(0);
  });

  it("adopts the full read's high-water mark, repairing a watermark left behind", async () => {
    const h = driftHarness();
    await runnerFor(h).runReconciliationSweep();
    expect(h.prisma.__cursor("cur-1")!.watermark).toBe("2026-08-26T00:00:00Z");
  });

  it("persists lastSweepAt so a restart does not re-trigger the expensive re-enumeration", async () => {
    const h = driftHarness();
    const runner = runnerFor(h);
    await runner.runReconciliationSweep();
    expect(h.prisma.__cursor("cur-1")!.lastSweepAt).toEqual(NOW);

    // Second pass, same clock: the cursor is not due again.
    h.connector.runRead.mockClear();
    const { reports } = await runner.runReconciliationSweep();
    expect(reports).toHaveLength(0);
    expect(h.connector.runRead).not.toHaveBeenCalled();
  });

  it("runs again once the longer cadence has elapsed", async () => {
    const h = driftHarness();
    await runnerFor(h).runReconciliationSweep();
    // A distinct, longer cadence than the incremental tick.
    const later = createErpSyncRunner({
      prisma: h.prisma,
      recorder: h.recorder as never,
      connectorFor: () => h.connector,
      budgetFor: () => h.budget,
      now: () => new Date(NOW.getTime() + 25 * 60 * 60 * 1000),
    });
    h.connector.runRead.mockClear();
    expect((await later.runReconciliationSweep()).reports).toHaveLength(1);
  });

  it("DEFERS rather than completing when the call budget is exhausted", async () => {
    // MUTATION: exempt the sweep from the budget ("it's internal") → the
    // re-enumeration runs to completion against a spent allowance, deferred is
    // 0, and the cursor is not put into BACKOFF → red. A full re-enumeration
    // against a large Stripe or HubSpot account is precisely the shape that
    // trips a pooled vendor limit for the whole fleet.
    let calls = 0;
    const h = driftHarness();
    h.budget.assertHeadroom.mockImplementation(() => {
      calls += 1;
      if (calls > 1) throw new QuotaExhaustedError(5000, 5000);
    });

    const { reports, deferred } = await runnerFor(h).runReconciliationSweep();
    expect(deferred).toBe(1);
    expect(reports).toHaveLength(0);
    expect(h.prisma.__cursor("cur-1")!.state).toBe("BACKOFF");
  });

  it("emits counts and dataset names only — never customer content", async () => {
    const h = driftHarness();
    const { reports } = await runnerFor(h).runReconciliationSweep();
    const json = JSON.stringify(reports[0]);

    expect(json).not.toContain("smith");
    expect(json).not.toContain("4210.55");
    expect(json).not.toContain("INV-1001");
    expect(json).not.toContain("INV-1003");
    expect(json).not.toContain("example.com");
    // Counts and dataset names are the deliverable.
    expect(json).toContain("invoice");
    expect(json).toContain("missedCount");
  });

  it("writes an audit row for the sweep with no customer content", async () => {
    const h = driftHarness();
    await runnerFor(h).runReconciliationSweep();
    const scope = JSON.stringify(
      h.recorder.record.mock.calls[h.recorder.record.mock.calls.length - 1][0].refs,
    );
    expect(scope).not.toContain("smith");
    expect(scope).not.toContain("INV-1003");
    expect(scope).toContain("totalMissed");
  });

  it("does not sweep a DISABLED connection", async () => {
    const h = harness({ connections: [connectionRow({ status: "DISABLED" })] });
    expect((await runnerFor(h).runReconciliationSweep()).reports).toHaveLength(0);
    expect(h.connector.runRead).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// WARP-2463 — the sweep's drift report reaches storage, not only a log line
// ---------------------------------------------------------------------------

describe("the sweep persists its drift report", () => {
  it("writes ONE row per (connectionId, entity), including a ZERO-DRIFT one", async () => {
    // MUTATION: skip the write when `missedCount === 0` → the `invoice` /
    // `bill` clean rows vanish → red.
    //
    // This is the case the story turns on. With only drifted rows stored,
    // absence means both "the incremental path was trustworthy" and "no sweep
    // ever ran" — and the cadence the sweep is tuned by is read from exactly
    // that distinction.
    const h = harness({
      cursors: [cursorRow(), cursorRow({ id: "cur-2", entity: "bill" })],
    });
    await runnerFor(h).runReconciliationSweep();

    const written = h.prisma.erpDriftRecord.create.mock.calls.map((c: any[]) => c[0].data);
    expect(written).toHaveLength(2);
    expect(written.map((r: any) => r.entity).sort()).toEqual(["bill", "invoice"]);
    for (const row of written) {
      expect(row.connectionId).toBe("conn-1");
      expect(row.provider).toBe("quickbooks-online");
      expect(row.sweepAt).toEqual(NOW);
      // The explicit member, not a null and not a missing row.
      expect(row.classification).toBe("NONE");
      expect(row.missedCount).toBe(0);
    }
  });

  it("stores the classification the sweep actually found", async () => {
    const h = driftHarness();
    await runnerFor(h).runReconciliationSweep();
    const row = h.prisma.erpDriftRecord.create.mock.calls[0][0].data;
    expect(row.classification).toBe("MISSED_NEWER_AND_WATERMARK_BEHIND");
    expect(row.missedCount).toBe(1);
    expect(row.fullCount).toBe(3);
    expect(row.incrementalCount).toBe(2);
  });

  it("puts no customer content in the stored row", async () => {
    // MUTATION: store the first missed record's id "for debugging" → red.
    const h = driftHarness();
    await runnerFor(h).runReconciliationSweep();
    const stored = JSON.stringify(
      h.prisma.erpDriftRecord.create.mock.calls.map((c: any[]) => c[0].data),
    );
    expect(stored).not.toContain("INV-1001");
    expect(stored).not.toContain("INV-1003");
    expect(stored).not.toContain("smith");
    expect(stored).not.toContain("4210.55");
    expect(stored).not.toContain("example.com");
    // The diagnosis survives.
    expect(stored).toContain("MISSED_NEWER");
    expect(stored).toContain("invoice");
  });

  it("writes no drift row for a sweep that DEFERRED on an exhausted budget", async () => {
    // A deferred sweep did not measure anything, so it must not leave a row
    // claiming it did. Storing a clean row here would be worse than storing
    // nothing: it would lengthen the cadence on a sweep that never ran.
    let calls = 0;
    const h = driftHarness();
    h.budget.assertHeadroom.mockImplementation(() => {
      calls += 1;
      if (calls > 1) throw new QuotaExhaustedError(5000, 5000);
    });
    const { deferred } = await runnerFor(h).runReconciliationSweep();
    expect(deferred).toBe(1);
    expect(h.prisma.erpDriftRecord.create).not.toHaveBeenCalled();
  });
});

describe("the sweep cadence is earned per connection", () => {
  /** N clean sweeps for one connection, oldest first, ending `agoMs` back. */
  function cleanHistory(count: number, spacingMs: number, endAgoMs: number) {
    return Array.from({ length: count }, (_, i) => ({
      id: `d-${i}`,
      connectionId: "conn-1",
      provider: "quickbooks-online",
      entity: "invoice",
      sweepAt: new Date(NOW.getTime() - endAgoMs - (count - 1 - i) * spacingMs),
      classification: "NONE",
      missedCount: 0,
      fullCount: 3,
      incrementalCount: 3,
    }));
  }

  const DAY = 24 * 60 * 60 * 1000;

  it("LENGTHENS the interval after three clean sweeps in a row", async () => {
    // MUTATION: ignore the drift-free counter and keep the flat base interval
    // → the cursor is due at 25 h and the sweep runs → red.
    //
    // The cursor was swept 25 h ago: due under the flat 24 h base, NOT due
    // under the 48 h a three-sweep clean streak earns.
    const h = harness({
      cursors: [cursorRow({ lastSweepAt: new Date(NOW.getTime() - 25 * 60 * 60 * 1000) })],
      driftRecords: cleanHistory(3, DAY, 25 * 60 * 60 * 1000),
    });
    const { reports } = await runnerFor(h).runReconciliationSweep();
    expect(reports).toHaveLength(0);
    expect(h.connector.runRead).not.toHaveBeenCalled();
  });

  it("RESETS to the base interval when the most recent sweep caught a miss", async () => {
    // MUTATION: let a miss merely pause the streak instead of resetting it →
    // the connection keeps the earned 48 h and this sweep does not run → red.
    // A connection actively dropping records is the last one that should be
    // swept less often.
    const history = cleanHistory(3, DAY, 25 * 60 * 60 * 1000);
    history[history.length - 1].classification = "MISSED_NEWER";
    history[history.length - 1].missedCount = 1;

    const h = harness({
      cursors: [cursorRow({ lastSweepAt: new Date(NOW.getTime() - 25 * 60 * 60 * 1000) })],
      driftRecords: history,
    });
    const { reports } = await runnerFor(h).runReconciliationSweep();
    expect(reports).toHaveLength(1);
    expect(h.connector.runRead).toHaveBeenCalled();
  });

  it("still sweeps a clean connection once the LONGER interval has elapsed", async () => {
    // The earned interval lengthens the wait; it never stops reconciling.
    const h = harness({
      cursors: [cursorRow({ lastSweepAt: new Date(NOW.getTime() - 49 * 60 * 60 * 1000) })],
      driftRecords: cleanHistory(3, DAY, 49 * 60 * 60 * 1000),
    });
    expect((await runnerFor(h).runReconciliationSweep()).reports).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Error propagation — the handler must not swallow
// ---------------------------------------------------------------------------

describe("error posture", () => {
  it("lets an infrastructure failure propagate to cron-runtime's safeRun", async () => {
    // MUTATION: wrap the tick body in a bare `try/catch {}` → this rejection
    // never surfaces → red. Swallowing here zeroes the per-handler
    // consecutiveFailures canary that downstream alerting reads.
    const h = harness();
    h.prisma.integrationConnection.findMany.mockRejectedValue(new Error("prisma down"));
    await expect(runnerFor(h).runIncrementalTick()).rejects.toThrow("prisma down");
  });

  it("parks a cursor whose entity is no longer served instead of stranding it SYNCING", async () => {
    const h = harness({ cursors: [cursorRow({ entity: "retired-dataset" })] });
    await runnerFor(h).runIncrementalTick();
    expect(h.prisma.__cursor("cur-1")!.state).not.toBe("SYNCING");
    expect(h.recorder.record).toHaveBeenCalledTimes(1);
  });

  it("closes the connector even when the read throws", async () => {
    const h = harness({
      read: async () => {
        throw new Error("boom");
      },
    });
    await runnerFor(h).runIncrementalTick();
    expect(h.connector.close).toHaveBeenCalled();
  });
});

describe("registerCursors", () => {
  it("registers one cursor per live connection and entity", async () => {
    const h = harness();
    await runnerFor(h).registerCursors();
    const entities = h.prisma.erpSyncCursor.upsert.mock.calls.map(
      (c: any[]) => c[0].where.connectionId_entity.entity,
    );
    // The default harness provider is a lan track, so it takes the two
    // accounting entities and none of the eight WARP-2509 added.
    expect(entities).toEqual(["invoice", "bill"]);
  });

  it("registers nothing for a connection that is not live", async () => {
    const h = harness({ connections: [connectionRow({ status: "ERROR" })] });
    await runnerFor(h).registerCursors();
    expect(h.prisma.erpSyncCursor.upsert).not.toHaveBeenCalled();
  });

  // WARP-2533 — the entity loop is filtered by what the provider's descriptor
  // says the track SERVES. Before this, every CONNECTED connection got an
  // `invoice` and a `bill` cursor, so a healthy HubSpot connection's first
  // tick asked it for a dataset it will never have, `DatasetNotServedError`
  // was classified FATAL, the cursor parked FAILED, and `foldSyncState`
  // rendered the connection as a failed sync forever.

  it("registers the CRM datasets for a hubspot connection, and no accounting ones", async () => {
    // WARP-2509 changed this test's expectation, and the change IS the story.
    // It used to assert ZERO cursors, which was correct while the entity table
    // held `invoice` and `bill` alone: HubSpot serves neither, so filtering
    // them out left nothing. What it also meant was that a connected, healthy
    // HubSpot portal was never read — the connector work was reachable from
    // no scheduler at all.
    //
    // Mutation: empty the CRM rows out of ERP_SYNC_ENTITIES → back to zero
    //           → red.
    const h = harness({
      connections: [connectionRow({ provider: "hubspot", secretRef: null })],
    });
    await runnerFor(h).registerCursors();
    const entities = h.prisma.erpSyncCursor.upsert.mock.calls.map(
      (c: any[]) => c[0].where.connectionId_entity.entity,
    );
    expect(entities.sort()).toEqual(["company", "contact", "deal", "engagement", "ticket"]);
  });

  it("registers invoice ONLY for stripe — its descriptor serves no bill", async () => {
    const h = harness({
      connections: [connectionRow({ provider: "stripe", secretRef: null })],
    });
    await runnerFor(h).registerCursors();
    const entities = h.prisma.erpSyncCursor.upsert.mock.calls.map(
      (c: any[]) => c[0].where.connectionId_entity.entity,
    );
    expect(entities).toEqual(["invoice"]);
  });

  it("keeps BOTH accounting cursors for an SQL-track provider, and gains none of the eight", async () => {
    // Two rules meeting, and the reason `openToUndeclaredTracks` exists.
    //
    // KEEP invoice/bill: the lan track's descriptor lists only the practice
    // datasets, but the export-drop connector genuinely serves invoices and
    // bills when the practice's export carries them — that served set is
    // computed from the export, not declared. Filtering lan tracks by the
    // descriptor would silently stop the accounting sync the track shipped
    // with (WARP-2533).
    //
    // REFUSE the other eight: no lan track serves a CRM or marketing dataset,
    // and the failure is not symmetric with a missing cursor. Each unserved
    // cursor fails its first tick with DatasetNotServedError, is classified
    // FATAL, parks FAILED, and `foldSyncState` renders the WHOLE connection as
    // a failed sync — so eight of them would make every Eaglesoft box on earth
    // report a broken integration it never asked for.
    //
    // Mutation: flip `openToUndeclaredTracks` to true on any WARP-2509 row, or
    //           restore `entityServedBy`'s bare `return true` → red, and the
    //           extra entity is named in the diff.
    const h = harness({
      connections: [connectionRow({ provider: "eaglesoft" })],
    });
    await runnerFor(h).registerCursors();
    const entities = h.prisma.erpSyncCursor.upsert.mock.calls.map(
      (c: any[]) => c[0].where.connectionId_entity.entity,
    );
    expect(entities).toEqual(["invoice", "bill"]);
  });

  it("refuses the eight for a provider with no descriptor at all", async () => {
    // No descriptor is no evidence, and the flag decides there too. An unknown
    // provider is most likely a lan/export track the registry has not learned
    // yet, so it keeps the accounting pair and none of the rest.
    const h = harness({
      connections: [connectionRow({ provider: "some-unregistered-provider" })],
    });
    await runnerFor(h).registerCursors();
    const entities = h.prisma.erpSyncCursor.upsert.mock.calls.map(
      (c: any[]) => c[0].where.connectionId_entity.entity,
    );
    expect(entities).toEqual(["invoice", "bill"]);
  });
});

// A guard the story's out-of-scope boundary depends on: this service moves
// cursors and watermarks, never records. If a future change gives the runner
// an `erpEntityCache` writer, this fails — and ADR-041 §4 forbids that until
// WARP-2028 lands the encryption the model's schema already promises.
describe("ADR-041 §4 boundary", () => {
  it("never touches ErpEntityCache", async () => {
    const h = harness();
    const cache = { create: vi.fn(), upsert: vi.fn(), createMany: vi.fn() };
    h.prisma.erpEntityCache = cache;
    const runner = runnerFor(h);
    await runner.runIncrementalTick();
    await runner.runReconciliationSweep();
    expect(cache.create).not.toHaveBeenCalled();
    expect(cache.upsert).not.toHaveBeenCalled();
    expect(cache.createMany).not.toHaveBeenCalled();
  });
});

describe("WARP-2549 — the landing seam", () => {
  const CONTACT_ROWS = [
    {
      contact_id: "p-1",
      created_at: "2026-08-26T00:00:00Z",
      updated_at: "2026-08-26T00:00:00Z",
      first_name: "Ada",
      last_name: "Lovelace",
      email: "ada@example.test",
    },
  ];

  function contactHarness(read?: () => Promise<unknown[]>) {
    return harness({
      cursors: [cursorRow({ entity: "contact" })],
      read: read ?? (async () => CONTACT_ROWS),
    });
  }

  it("hands a landable page to the seam, with the connection that read it", async () => {
    const h = contactHarness();
    const land = vi.fn(async () => ({
      entity: "contact",
      landed: 1,
      skipped: 0,
      reason: null,
    }));

    await runnerFor(h, { land }).runIncrementalTick();

    expect(land).toHaveBeenCalledTimes(1);
    expect(land).toHaveBeenCalledWith({
      connection: { id: "conn-1", provider: "quickbooks-online" },
      entity: "contact",
      rows: CONTACT_ROWS,
      now: NOW,
    });
  });

  it("does not reach the seam at all for a dataset that does not land", async () => {
    // `invoice` is money, not a CRM row. It reaches `/api/money` (WARP-2581)
    // and never these tables — the tick must not even open the transaction.
    const h = harness();
    const land = vi.fn();

    await runnerFor(h, { land }).runIncrementalTick();

    expect(land).not.toHaveBeenCalled();
    // The invoice page still advanced its own watermark — landing is what was
    // skipped, not the sync.
    expect(h.prisma.__cursor("cur-1").watermark).toBe("2026-08-20T00:00:00Z");
  });

  it("lands BEFORE the watermark moves", async () => {
    // The ordering IS the durability guarantee: a watermark that advanced
    // first would mean a crash in the landing loses those rows forever,
    // because the next tick asks the vendor for rows after the mark.
    const h = contactHarness();
    let watermarkAtLandingTime: unknown = "never called";
    const land = vi.fn(async () => {
      watermarkAtLandingTime = h.prisma.__cursor("cur-1").watermark;
      return { entity: "contact", landed: 1, skipped: 0, reason: null };
    });

    await runnerFor(h, { land }).runIncrementalTick();

    expect(watermarkAtLandingTime).toBe("2026-08-15T00:00:00Z");
    expect(h.prisma.__cursor("cur-1").watermark).toBe("2026-08-26T00:00:00Z");
  });

  it("a landing failure parks the cursor and leaves the watermark where it was", async () => {
    const h = contactHarness();
    const land = vi.fn(async () => {
      throw new Error("check constraint violated");
    });

    const outcome = await runnerFor(h, { land }).runIncrementalTick();

    expect(outcome.failed).toBe(1);
    // Unmoved: the next tick re-reads the same page, and re-landing is
    // idempotent on `(connectionId, externalId)`.
    expect(h.prisma.__cursor("cur-1").watermark).toBe("2026-08-15T00:00:00Z");
    expect(h.prisma.__cursor("cur-1").state).not.toBe("IDLE");
  });

  it("reports what it landed as COUNTS, never as content", async () => {
    const h = contactHarness();
    const land = vi.fn(async () => ({
      entity: "contact",
      landed: 1,
      skipped: 2,
      reason: "unidentified" as const,
    }));

    await runnerFor(h, { land }).runIncrementalTick();

    const audit = h.recorder.record.mock.calls
      .map((call: any[]) => call[0])
      .find((row: any) => row?.what === "Connector synced");
    expect(audit.refs).toMatchObject({
      landed: 1,
      landSkipped: 2,
      landSkipReason: "unidentified",
    });
    // Rule 19 — an audit row is exportable and append-only. No names, no
    // addresses, no ids from the vendor payload may appear in it.
    const scope = JSON.stringify(audit.refs);
    expect(scope).not.toContain("ada@example.test");
    expect(scope).not.toContain("Lovelace");
    expect(scope).not.toContain("p-1");
  });
});
