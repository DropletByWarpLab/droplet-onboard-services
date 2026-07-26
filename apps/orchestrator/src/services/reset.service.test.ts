/**
 * WARP-825 — reset.service: the owner-only factory-reset orchestration.
 *
 * SAFETY: every test here mocks the device-bridge fetch. The real
 * scripts/factory-reset.sh is NEVER invoked — the service only ever POSTs to
 * the device-bridge, and that fetch is stubbed, so nothing on any box is wiped.
 *
 * Contract under test:
 *   - validateConfirmToken() is the SERVER-side friction check: the typed token
 *     must exactly (constant-time) equal the device target name. Whitespace is
 *     trimmed; empty typed → false; case-sensitive.
 *   - requestFactoryReset():
 *       * refuses (throws CONFIRM_MISMATCH) when the typed token doesn't match —
 *         the friction step is verified server-side, not only client-side.
 *       * writes the audit row BEFORE dispatching the wipe.
 *       * creates a ResetJob (status `requested` → `dispatched` on success).
 *       * is double-fire guarded: a second call while a job is in flight throws
 *         RESET_ALREADY_IN_PROGRESS and never dispatches again.
 *       * fails CLOSED with no bridge auth token (BRIDGE_AUTH_UNCONFIGURED) and
 *         marks the job `failed` without ever dispatching.
 *       * on a bridge connection error, marks the job `failed` (box untouched).
 *   - getResetStatus() returns the latest job for the dashboard poll.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../config.js", () => ({
  config: { DEVICE_BRIDGE_URL: "http://bridge.test:9090", agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));

import {
  validateConfirmToken,
  requestFactoryReset,
  getResetStatus,
  ResetError,
} from "./reset.service.js";
import { createTransactionSeam } from "../__tests__/helpers/prisma-tx-harness.js";

const ORIGINAL_ENV = { ...process.env };

// ── In-memory ResetJob + CommandAuditLog fakes ──
//
// A real DB isn't available in unit tests, but the architecture-guard's
// "no mock database in integration tests" rule is about INTEGRATION tests; this
// is a focused unit test of the service's branching, so a tiny in-memory prisma
// double is appropriate (mirrors how other *.service.test.ts files stub prisma).
interface FakeJob {
  id: string;
  status: "requested" | "dispatched" | "failed";
  requestedBy: string | null;
  targetName: string;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function makeFakePrisma() {
  const jobs: FakeJob[] = [];
  const audits: Array<Record<string, unknown>> = [];
  let seq = 0;
  const prisma = {
    // Interactive-transaction double — attached AFTER this object is built (see
    // below) so it can reference `prisma` without a circular initializer. Typed
    // as a callable so the strongly-typed vi.fn assigned later is compatible.
    $transaction: (() => undefined) as unknown as (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>,
    resetJob: {
      create: vi.fn(async ({ data }: { data: Partial<FakeJob> }) => {
        const job: FakeJob = {
          id: `job-${++seq}`,
          status: (data.status as FakeJob["status"]) ?? "requested",
          requestedBy: data.requestedBy ?? null,
          targetName: data.targetName as string,
          failureReason: data.failureReason ?? null,
          createdAt: new Date(seq * 1000),
          updatedAt: new Date(seq * 1000),
        };
        jobs.push(job);
        return job;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Partial<FakeJob> }) => {
          const job = jobs.find((j) => j.id === where.id);
          if (!job) throw new Error("not found");
          Object.assign(job, data, { updatedAt: new Date() });
          return job;
        },
      ),
      findFirst: vi.fn(
        async ({ where, orderBy }: { where?: { status?: { in?: string[] } }; orderBy?: unknown }) => {
          let rows = [...jobs];
          if (where?.status?.in) {
            rows = rows.filter((j) => where.status!.in!.includes(j.status));
          }
          // Default orderBy createdAt desc for "latest" lookups.
          rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
          return rows[0] ?? null;
        },
      ),
      count: vi.fn(async ({ where }: { where?: { status?: { in?: string[] } } }) => {
        if (where?.status?.in) {
          return jobs.filter((j) => where.status!.in!.includes(j.status)).length;
        }
        return jobs.length;
      }),
    },
    commandAuditLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        audits.push(data);
        return { id: `audit-${audits.length}`, ...data };
      }),
    },
  };
  // The service wraps the double-fire guard + audit + job-create in
  // prisma.$transaction(async (tx) => …). The fake runs the callback
  // synchronously against the SAME in-memory client, so the count→create
  // sequence (and a thrown ResetError) behave as in production. A real DB's
  // atomicity isn't under unit test here — the service's branching is.
  // WARP-1570: shared seam. reset.service opens this transaction at
  // { isolationLevel: Serializable } — the local stand-in dropped the
  // options argument, so that could be deleted without failing anything —
  // and it now rolls `jobs` / `audits` back when a ResetError is thrown
  // inside the callback, which the stand-in also did not.
  const seam = createTransactionSeam({
    client: () => prisma,
    stores: { jobs, audits },
  });
  prisma.$transaction = seam.$transaction as typeof prisma.$transaction;
  return { prisma, jobs, audits, seam };
}

function mockFetchOnce(status: number, body: unknown) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

beforeEach(() => {
  process.env.BRIDGE_AUTH_TOKEN = "tok-123";
  delete process.env.SERVICE_TOKEN_DISPLAY;
  vi.restoreAllMocks();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("validateConfirmToken — server-side friction", () => {
  it("accepts an exact match", () => {
    expect(validateConfirmToken("droplet-home", "droplet-home")).toBe(true);
  });
  it("trims surrounding whitespace on the typed value", () => {
    expect(validateConfirmToken("  droplet-home  ", "droplet-home")).toBe(true);
  });
  it("rejects a mismatch", () => {
    expect(validateConfirmToken("droplet", "droplet-home")).toBe(false);
  });
  it("rejects an empty typed value even against an empty target", () => {
    expect(validateConfirmToken("", "")).toBe(false);
    expect(validateConfirmToken("   ", "droplet-home")).toBe(false);
  });
  it("is case-sensitive", () => {
    expect(validateConfirmToken("Droplet-Home", "droplet-home")).toBe(false);
  });
});

describe("requestFactoryReset — friction enforced server-side", () => {
  it("throws CONFIRM_MISMATCH and never dispatches when the typed token is wrong", async () => {
    const { prisma, jobs, audits } = makeFakePrisma();
    const fetchSpy = mockFetchOnce(200, { ok: true });

    await expect(
      requestFactoryReset(prisma as never, {
        userId: "owner-1",
        typedConfirm: "wrong-name",
        targetName: "droplet-home",
      }),
    ).rejects.toMatchObject({ code: "CONFIRM_MISMATCH" });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(jobs).toHaveLength(0);
    // No wipe was attempted, so no audit dispatch row either.
    expect(audits).toHaveLength(0);
  });
});

describe("requestFactoryReset — happy path", () => {
  it("writes the audit row BEFORE dispatching, then POSTs to the bridge and marks dispatched", async () => {
    const { prisma, jobs, audits } = makeFakePrisma();
    const callOrder: string[] = [];

    (prisma.commandAuditLog.create as ReturnType<typeof vi.fn>).mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => {
        callOrder.push("audit");
        audits.push(data);
        return { id: "audit-1", ...data };
      },
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      callOrder.push("dispatch");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const job = await requestFactoryReset(prisma as never, {
      userId: "owner-1",
      typedConfirm: "droplet-home",
      targetName: "droplet-home",
    });

    // Audit must be written before the wipe is dispatched.
    expect(callOrder.indexOf("audit")).toBeLessThan(callOrder.indexOf("dispatch"));

    // Bridge POST shape.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe("http://bridge.test:9090/system/factory-reset");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["X-Droplet-Auth"]).toBe("tok-123");

    expect(job.status).toBe("dispatched");
    expect(jobs[0].status).toBe("dispatched");
    expect(jobs[0].requestedBy).toBe("owner-1");
    expect(jobs[0].targetName).toBe("droplet-home");
  });
});

describe("requestFactoryReset — hostname-only confirm (2026-06-09 sweep)", () => {
  it("REJECTS the legacy universal 'factory reset' phrase — only the device name confirms", async () => {
    // The fixed phrase was public in the repo, so it provided zero per-device
    // friction. Typing it must now read as a mismatch and never dispatch.
    const { prisma, jobs, audits } = makeFakePrisma();
    const fetchSpy = mockFetchOnce(200, { ok: true });

    await expect(
      requestFactoryReset(prisma as never, {
        userId: "owner-1",
        typedConfirm: "factory reset",
        targetName: "droplet-home",
      }),
    ).rejects.toMatchObject({ code: "CONFIRM_MISMATCH" });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(jobs).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });
});

describe("requestFactoryReset — double-fire guard", () => {
  it("refuses a second reset while one is already in flight", async () => {
    const { prisma } = makeFakePrisma();
    mockFetchOnce(200, { ok: true });

    await requestFactoryReset(prisma as never, {
      userId: "owner-1",
      typedConfirm: "droplet-home",
      targetName: "droplet-home",
    });

    // Second confirmed reset with a job already dispatched → refused.
    const fetchSpy2 = mockFetchOnce(200, { ok: true });
    await expect(
      requestFactoryReset(prisma as never, {
        userId: "owner-1",
        typedConfirm: "droplet-home",
        targetName: "droplet-home",
      }),
    ).rejects.toMatchObject({ code: "RESET_ALREADY_IN_PROGRESS" });
    expect(fetchSpy2).not.toHaveBeenCalled();
  });

  it("runs the in-flight guard + create inside ONE transaction, and a refused duplicate writes no audit row", async () => {
    const { prisma, jobs, audits } = makeFakePrisma();
    mockFetchOnce(200, { ok: true });

    // First reset dispatches and creates exactly one job + one audit row.
    await requestFactoryReset(prisma as never, {
      userId: "owner-1",
      typedConfirm: "droplet-home",
      targetName: "droplet-home",
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(jobs).toHaveLength(1);
    expect(audits).toHaveLength(1);

    // A second confirmed reset is refused by the guard INSIDE the transaction.
    await expect(
      requestFactoryReset(prisma as never, {
        userId: "owner-1",
        typedConfirm: "droplet-home",
        targetName: "droplet-home",
      }),
    ).rejects.toMatchObject({ code: "RESET_ALREADY_IN_PROGRESS" });

    // The second attempt opened a transaction but, because it threw before the
    // create, left NO new job and NO orphan audit row (the audit now lives
    // inside the txn so a rejected duplicate rolls back cleanly).
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(jobs).toHaveLength(1);
    expect(audits).toHaveLength(1);
  });
});

describe("requestFactoryReset — transaction isolation closes the TOCTOU window", () => {
  // pr-reviewer (PR #549, finding 1): the default READ COMMITTED isolation does
  // NOT serialize two concurrent count→create transactions — both can read
  // inFlight = 0 before either INSERT commits. The guard transaction must run
  // SERIALIZABLE, and the resulting Postgres serialization failure (Prisma
  // P2034) on the losing transaction must surface as the same
  // RESET_ALREADY_IN_PROGRESS the in-flight guard throws (409 at the route).
  it("opens the guard transaction with Serializable isolation", async () => {
    const { prisma } = makeFakePrisma();
    mockFetchOnce(200, { ok: true });

    await requestFactoryReset(prisma as never, {
      userId: "owner-1",
      typedConfirm: "droplet-home",
      targetName: "droplet-home",
    });

    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: "Serializable" }),
    );
  });

  it("maps a P2034 serialization failure to SERIALIZATION_CONFLICT and never dispatches", async () => {
    const { prisma, jobs } = makeFakePrisma();
    const fetchSpy = mockFetchOnce(200, { ok: true });

    // Model the LOSING side of two concurrent serializable transactions: the
    // engine aborts it with P2034 ("write conflict or deadlock, retry").
    // This could be caused by an unrelated concurrent write (e.g. another
    // action writing to CommandAuditLog) — not necessarily a duplicate reset.
    // SERIALIZATION_CONFLICT → 503 "try again"; RESET_ALREADY_IN_PROGRESS
    // is reserved for the explicit inFlight > 0 guard path.
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error("Transaction failed due to a write conflict or a deadlock. Please retry your transaction"), {
        code: "P2034",
      }),
    );

    await expect(
      requestFactoryReset(prisma as never, {
        userId: "owner-1",
        typedConfirm: "droplet-home",
        targetName: "droplet-home",
      }),
    ).rejects.toMatchObject({ code: "SERIALIZATION_CONFLICT" });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(jobs).toHaveLength(0);
  });
});

describe("requestFactoryReset — DB-level double-fire guard (partial unique index)", () => {
  it("maps a P2002 unique violation on create onto RESET_ALREADY_IN_PROGRESS", async () => {
    // Two concurrent requests can both pass the count check; the
    // ResetJob_at_most_one_nonterminal index makes the second INSERT fail
    // with P2002, which must read as the same 409 a sequential duplicate gets.
    const { prisma } = makeFakePrisma();
    const fetchSpy = mockFetchOnce(200, { ok: true });
    (prisma.resetJob.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );

    await expect(
      requestFactoryReset(prisma as never, {
        userId: "owner-1",
        typedConfirm: "droplet-home",
        targetName: "droplet-home",
      }),
    ).rejects.toMatchObject({ code: "RESET_ALREADY_IN_PROGRESS" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("requestFactoryReset — fail closed without a bridge token", () => {
  it("marks the job failed and never dispatches when no bridge auth token is set", async () => {
    delete process.env.BRIDGE_AUTH_TOKEN;
    delete process.env.SERVICE_TOKEN_DISPLAY;
    const { prisma, jobs } = makeFakePrisma();
    const fetchSpy = mockFetchOnce(200, { ok: true });

    await expect(
      requestFactoryReset(prisma as never, {
        userId: "owner-1",
        typedConfirm: "droplet-home",
        targetName: "droplet-home",
      }),
    ).rejects.toMatchObject({ code: "BRIDGE_AUTH_UNCONFIGURED" });

    expect(fetchSpy).not.toHaveBeenCalled();
    // A job row exists (the attempt is auditable) but is marked failed — the
    // box was never touched.
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe("failed");
  });
});

describe("requestFactoryReset — bridge unreachable", () => {
  it("marks the job failed (box untouched) when the bridge connection fails", async () => {
    const { prisma, jobs } = makeFakePrisma();
    const connErr = Object.assign(new Error("fetch failed"), {
      cause: { code: "ECONNREFUSED" },
    });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(connErr);

    await expect(
      requestFactoryReset(prisma as never, {
        userId: "owner-1",
        typedConfirm: "droplet-home",
        targetName: "droplet-home",
      }),
    ).rejects.toBeInstanceOf(ResetError);

    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe("failed");
    expect(jobs[0].failureReason).toBeTruthy();
  });
});

describe("requestFactoryReset — bridge dispatch timeout", () => {
  // pr-reviewer (PR #549, 2026-06-10 finding 2): dispatchToBridge aborts after
  // 30 s via AbortController; the resulting AbortError (or AbortSignal.timeout's
  // TimeoutError) is NOT a socket-level connection error, so the catch used to
  // fall through to the generic "Reset dispatch failed: The operation was
  // aborted." A timeout must be reported as a timeout — same BRIDGE_UNREACHABLE
  // code (consistent with hostapd-bridge.service.ts, which maps timeout/abort to
  // RouterError.unreachable) but a distinct, truthful message.
  it.each(["AbortError", "TimeoutError"])(
    "reports a %s as a dispatch timeout, not a generic failure",
    async (name) => {
      const { prisma, jobs } = makeFakePrisma();
      const abortErr = Object.assign(new Error("This operation was aborted"), {
        name,
      });
      vi.spyOn(globalThis, "fetch").mockRejectedValue(abortErr);

      await expect(
        requestFactoryReset(prisma as never, {
          userId: "owner-1",
          typedConfirm: "droplet-home",
          targetName: "droplet-home",
        }),
      ).rejects.toMatchObject({
        code: "BRIDGE_UNREACHABLE",
        message:
          "Reset dispatch timed out; the bridge did not respond within 30 s.",
      });

      // Job marked failed with the timeout reason — never "operation aborted".
      expect(jobs).toHaveLength(1);
      expect(jobs[0].status).toBe("failed");
      expect(jobs[0].failureReason).toBe(
        "Reset dispatch timed out; the bridge did not respond within 30 s.",
      );
    },
  );
});

describe("getResetStatus", () => {
  it("returns null when no reset has been requested", async () => {
    const { prisma } = makeFakePrisma();
    expect(await getResetStatus(prisma as never)).toBeNull();
  });

  it("returns the latest job for the dashboard poll", async () => {
    const { prisma } = makeFakePrisma();
    mockFetchOnce(200, { ok: true });
    await requestFactoryReset(prisma as never, {
      userId: "owner-1",
      typedConfirm: "droplet-home",
      targetName: "droplet-home",
    });
    const status = await getResetStatus(prisma as never);
    expect(status?.status).toBe("dispatched");
    expect(status?.targetName).toBe("droplet-home");
  });
});
