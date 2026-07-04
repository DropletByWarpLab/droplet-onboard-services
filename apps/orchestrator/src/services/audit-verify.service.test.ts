/**
 * WARP-237 — nightly tamper detection. The chain-walk semantics
 * (origin-anchor trust, first-break stop) are already pinned at route
 * level in __tests__/activity-chain.test.ts; here we pin the extracted
 * service + the nightly job's alarm side effects.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  verifyActivityChain,
  runNightlyChainVerification,
} from "./audit-verify.service.js";
import {
  createActivityRecorder,
  _resetDefaultRecorderForTests,
} from "./activity.service.js";
import { _setActivityRecorderForTests } from "./activity.singleton.js";
import { createHmacSigner } from "./audit-signing.service.js";

vi.mock("./notifications.service.js", () => ({
  sendNotification: vi.fn().mockResolvedValue({
    id: "n1",
    channels: ["toast"],
    delivered: true,
  }),
}));
import { sendNotification } from "./notifications.service.js";

const KEY = Buffer.from("warp-237-verify-test-key-32bytes!", "utf8");

/** In-memory ActivityRow store good enough for the chain walk + recorder. */
function makeChainFake() {
  const rows: Array<Record<string, unknown> & { id: bigint }> = [];
  let nextId = 1n;
  const prisma = {
    activityRow: {
      async create({ data }: { data: Record<string, unknown> }) {
        const refs = data.refs as { _tag?: string } | null | undefined;
        const row = {
          id: nextId++,
          ...data,
          sub: (data.sub as string | null) ?? null,
          refs:
            refs && typeof refs === "object" && refs._tag === "Prisma.DbNull"
              ? null
              : (refs ?? null),
        } as Record<string, unknown> & { id: bigint };
        rows.push(row);
        return row;
      },
      async findMany(args: {
        where?: { id?: { gt?: bigint } };
        orderBy: { id: "asc" };
        take: number;
      }) {
        const gt = args.where?.id?.gt ?? -1n;
        return rows
          .filter((r) => r.id > gt)
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .slice(0, args.take);
      },
    },
    async $queryRawUnsafe<T>(query: string) {
      if (query.includes("pg_advisory_xact_lock")) {
        return [{ locked: true }] as unknown as T;
      }
      if (rows.length === 0) return [] as unknown as T;
      return [
        { signature: rows[rows.length - 1]!.signature },
      ] as unknown as T;
    },
    async $transaction<T>(fn: (tx: unknown) => Promise<T>) {
      return fn(prisma);
    },
    user: {
      async findMany() {
        return [{ id: "admin-1" }, { id: "owner-1" }];
      },
    },
  };
  return { prisma: prisma as never, rows };
}

describe("verifyActivityChain / runNightlyChainVerification", () => {
  const signer = createHmacSigner(KEY);
  let fake: ReturnType<typeof makeChainFake>;

  beforeEach(async () => {
    fake = makeChainFake();
    const recorder = createActivityRecorder({ prisma: fake.prisma, signer });
    _setActivityRecorderForTests(recorder, signer);
    for (let i = 0; i < 5; i++) {
      await recorder.record({
        kind: "system",
        severity: "info",
        sourceIcon: "info",
        what: `row ${i}`,
        actor: { type: "system" },
      });
    }
  });

  afterEach(() => {
    _setActivityRecorderForTests(null, null);
    _resetDefaultRecorderForTests();
    vi.clearAllMocks();
  });

  it("an intact chain verifies ok", async () => {
    const res = await verifyActivityChain(fake.prisma, signer);
    expect(res).toEqual({ ok: true, rowsChecked: 5, brokenAtId: null });
  });

  it("a tampered row breaks the walk at that row", async () => {
    fake.rows[2]!.what = "tampered";
    const res = await verifyActivityChain(fake.prisma, signer);
    expect(res.ok).toBe(false);
    expect(res.brokenAtId).toBe(fake.rows[2]!.id.toString());
  });

  it("nightly job on a broken chain appends an err row and notifies every owner/admin", async () => {
    fake.rows[2]!.what = "tampered";
    const res = await runNightlyChainVerification(fake.prisma);
    expect(res?.ok).toBe(false);
    // Alarm row landed through the singleton recorder:
    const alarm = fake.rows[fake.rows.length - 1]!;
    expect(alarm.kind).toBe("system");
    expect(alarm.severity).toBe("err");
    expect(String(alarm.what)).toContain("Audit chain verification FAILED");
    // One notification per owner/admin:
    expect(vi.mocked(sendNotification)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(sendNotification).mock.calls[0]![1]).toMatchObject({
      kind: "system",
      title: "Audit log integrity check failed",
    });
  });

  it("nightly job on an intact chain appends nothing and notifies nobody", async () => {
    const before = fake.rows.length;
    const res = await runNightlyChainVerification(fake.prisma);
    expect(res?.ok).toBe(true);
    expect(fake.rows.length).toBe(before);
    expect(vi.mocked(sendNotification)).not.toHaveBeenCalled();
  });
});
