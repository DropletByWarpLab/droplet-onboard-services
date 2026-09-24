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
import { NotificationRecipientError } from "./notification-recipient.js";
import { createTransactionSeam } from "../__tests__/helpers/prisma-tx-harness.js";

/** What `transaction_timestamp()::text` reports inside the fake transaction (WARP-2977 P2b). */
const FAKE_TXTS = "2026-09-24 09:00:00.000001+00";
/** Where Prisma puts its transaction's id on an interactive-transaction client; the chain append requires it and keys its queue on it (WARP-2977 P2b). */
const PRISMA_TX_ID = Symbol.for("prisma.client.transaction.id");
/** Like Prisma, every `$transaction` hands its callback a FRESH handle with a unique transaction id. */
let fakeTxSeq = 0;

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
        // WARP-2977 P2b: the append reads the isolation level in the same round-trip.
        // …and the transaction start time: the append checks the tail read ran in the same transaction.
        return [{ locked: true, iso: "read committed", txts: FAKE_TXTS }] as unknown as T;
      }
      // The tail read: one row even when empty (a scalar subquery), same transaction.
      return [
        { txts: FAKE_TXTS, signature: rows[rows.length - 1]?.signature ?? null },
      ] as unknown as T;
    },
    async $transaction<T>(fn: (tx: unknown) => Promise<T>, options?: unknown): Promise<T> {
      return seam.$transaction(fn, options) as Promise<T>;
    },
    user: {
      // Ids and usernames are DELIBERATELY different here, the way they are in
      // production (`User.id` is a uuid, `User.username` is the login name).
      // A fake that conflated them would let the notification-key regression
      // through — see the "keyed by username" test below.
      async findMany() {
        return [
          { id: "8c1f4e2a-uuid-admin", username: "admin-1" },
          { id: "3b7d0195-uuid-owner", username: "owner-1" },
        ];
      },
    },
  };
  // WARP-1570: the shared transaction seam,
  // never a hand-rolled stub — it records the options argument, and record()
  // opens its transaction with READ_COMMITTED_TX. Like Prisma, every
  // transaction hands its callback a FRESH handle with a unique transaction id
  // and no `$transaction` (the chain append requires both, WARP-2977 P2b).
  const seam = createTransactionSeam({
    client: () => {
      const tx: Record<string | symbol, unknown> = { ...prisma, [PRISMA_TX_ID]: `fake-tx-${++fakeTxSeq}` };
      delete tx.$transaction;
      return tx;
    },
  });
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

  // WARP-2977 P2b: the pg lane verifies only the rows a file appended, on a shared DB.
  it("from a row: walks only the rows after it, the first anchored on that row's signature", async () => {
    const from = { id: fake.rows[1]!.id, signature: fake.rows[1]!.signature as string };
    // A row BEFORE the segment that would break a whole-table walk does not matter…
    fake.rows[0]!.what = "someone else's row";
    expect(await verifyActivityChain(fake.prisma, signer, from)).toEqual({ ok: true, rowsChecked: 3, brokenAtId: null });
    // …but the first row of the segment must link to the anchor.
    const wrongAnchor = { id: fake.rows[1]!.id, signature: fake.rows[0]!.signature as string };
    expect(await verifyActivityChain(fake.prisma, signer, wrongAnchor)).toMatchObject({ ok: false, brokenAtId: fake.rows[2]!.id.toString() });
    // …and a tampered row inside it still breaks it.
    fake.rows[3]!.what = "tampered";
    expect(await verifyActivityChain(fake.prisma, signer, from)).toMatchObject({ ok: false, brokenAtId: fake.rows[3]!.id.toString() });
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

  it("keys the alert by username, so the toast and the stored row actually reach an admin", async () => {
    // Regression pin. `sendNotification` publishes to
    // `droplet/notifications/${username}`, ws-bridge subscribes
    // `droplet/notifications/${user.username}`, and both readers of the
    // persisted NotificationLog filter by username. Passing `User.id` here
    // made the one alert that must never be missed reach nobody: the broker
    // dropped the toast and no reader could see the row.
    fake.rows[2]!.what = "tampered";
    await runNightlyChainVerification(fake.prisma);

    const keys = vi
      .mocked(sendNotification)
      .mock.calls.map((call) => (call[1] as { username: string }).username);
    expect(keys).toEqual(["admin-1", "owner-1"]);
    for (const key of keys) {
      expect(key).not.toContain("uuid");
    }
  });

  it("🔴 WARP-2911 one admin whose notification is refused does not cost the others the alert", async () => {
    // A username with the shape of a User.id (an account from before creation
    // refused it) is refused by sendNotification. Without a per-recipient
    // catch that throw ended the loop, and every admin after it never heard
    // that the audit chain was broken.
    vi.mocked(sendNotification).mockRejectedValueOnce(NotificationRecipientError.isId("sendNotification", null));
    fake.rows[2]!.what = "tampered";
    const res = await runNightlyChainVerification(fake.prisma);
    expect(res?.ok).toBe(false);
    const keys = vi.mocked(sendNotification).mock.calls.map((call) => (call[1] as { username: string }).username);
    expect(keys).toEqual(["admin-1", "owner-1"]);
  });

  it("nightly job on an intact chain appends nothing and notifies nobody", async () => {
    const before = fake.rows.length;
    const res = await runNightlyChainVerification(fake.prisma);
    expect(res?.ok).toBe(true);
    expect(fake.rows.length).toBe(before);
    expect(vi.mocked(sendNotification)).not.toHaveBeenCalled();
  });
});
