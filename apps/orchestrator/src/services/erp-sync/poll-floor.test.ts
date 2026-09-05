/**
 * WARP-2417 — the per-provider poll cadence floor.
 *
 * `ProviderDescriptor.pollIntervalFloorMs` has existed since WARP-2217 and had
 * NO consumer: Stripe declared 900,000 ms and nothing read it, so the field
 * documented a policy the scheduler did not apply. Xero is the track that makes
 * it matter — its allowance is 5,000 calls a day per organisation and the limit
 * that actually binds is app-wide and POOLED at 10,000 calls a minute across
 * every box we ship.
 *
 * These tests pin the claim-time behaviour: a provider with a floor is read at
 * that cadence, jittered per box; a provider without one is claimed exactly as
 * before; and the two cases where there is no evidence (a cursor that never
 * synced, a connection with no provider) stay claimable, because a
 * wrongly-skipped tick leaves a customer's books stale with nothing reporting
 * it while a wrongly-taken one costs a handful of vendor calls.
 *
 * Every test names the mutation that must turn it red.
 */
import { describe, it, expect, vi } from "vitest";

import { XERO_POLL_INTERVAL_FLOOR_MS, XERO_PROVIDER } from "@droplet/erp-connector";
import { providerDescriptor } from "@droplet/shared-types";
import { claimDueErpCursors, type ErpCursorPrisma } from "./cursor.service.js";
import { jitteredPeriodMs } from "./schedule-jitter.js";

const NOW = new Date("2026-09-02T12:00:00.000Z");
const DEVICE = "droplet-test-0001";

/** A Prisma double whose two reads are scripted and whose claim always wins. */
function prismaFor(
  connections: { id: string; provider: string }[],
  cursors: Record<string, unknown>[],
): { prisma: ErpCursorPrisma; claims: unknown[] } {
  const claims: unknown[] = [];
  const prisma: ErpCursorPrisma = {
    integrationConnection: {
      findMany: vi.fn(async () =>
        connections.map((c) => ({ ...c, status: "CONNECTED" })),
      ),
    },
    erpSyncCursor: {
      findMany: vi.fn(async () => cursors),
      updateMany: vi.fn(async (args: unknown) => {
        claims.push(args);
        return { count: 1 };
      }),
      update: vi.fn(async () => ({})),
      upsert: vi.fn(async () => ({})),
    },
  };
  return { prisma, claims };
}

function cursorRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "cur-1",
    connectionId: "conn-1",
    entity: "invoice",
    watermark: null,
    state: "IDLE",
    consecutiveFailures: 0,
    lastSweepAt: null,
    lastSyncedAt: null,
    ...over,
  };
}

describe("the descriptor declares the floor this test is about", () => {
  it("gives Xero four hours and leaves the LAN tracks with none", () => {
    // Mutation: drop `pollIntervalFloorMs` from the Xero descriptor → every
    // assertion below still passes vacuously, because a provider with no floor
    // is always due. This is what stops that being a silent green.
    expect(providerDescriptor(XERO_PROVIDER)?.pollIntervalFloorMs).toBe(
      XERO_POLL_INTERVAL_FLOOR_MS,
    );
    expect(providerDescriptor("eaglesoft")?.pollIntervalFloorMs).toBeUndefined();
  });
});

describe("claimDueErpCursors honours the provider's cadence floor", () => {
  it("skips a Xero cursor read inside the floor", async () => {
    // The whole point of WARP-2417. Mutation: delete the `pollFloorElapsed`
    // guard → the cursor is claimed on the 15-minute tick, i.e. 16 reads a day
    // per entity instead of six, against a pooled per-minute vendor limit.
    const lastSyncedAt = new Date(NOW.getTime() - 60 * 60 * 1000); // 1h ago
    const { prisma, claims } = prismaFor(
      [{ id: "conn-1", provider: XERO_PROVIDER }],
      [cursorRow({ lastSyncedAt })],
    );
    const claimed = await claimDueErpCursors(prisma, 10, NOW, { deviceId: DEVICE });
    expect(claimed).toHaveLength(0);
    // Not merely "returned nothing": the compare-and-swap must never have run,
    // or the cursor would be left SYNCING with no tick to release it.
    expect(claims).toHaveLength(0);
  });

  it("claims a Xero cursor once this box's jittered floor has elapsed", async () => {
    // The jitter is derived, not random, so the exact due time is computable —
    // which is the property `schedule-jitter.ts` exists for: during an incident
    // the question is "why did THIS box call at THAT moment".
    // Mutation: use the bare floor instead of the jittered one → the fleet
    // converges on the same four instants a day.
    const period = jitteredPeriodMs(
      XERO_POLL_INTERVAL_FLOOR_MS,
      `${DEVICE}:${XERO_PROVIDER}`,
    );
    expect(period).toBeGreaterThan(XERO_POLL_INTERVAL_FLOOR_MS);

    const justShort = new Date(NOW.getTime() - period + 1000);
    const justPast = new Date(NOW.getTime() - period);

    const before = prismaFor(
      [{ id: "conn-1", provider: XERO_PROVIDER }],
      [cursorRow({ lastSyncedAt: justShort })],
    );
    expect(await claimDueErpCursors(before.prisma, 10, NOW, { deviceId: DEVICE })).toHaveLength(0);

    const after = prismaFor(
      [{ id: "conn-1", provider: XERO_PROVIDER }],
      [cursorRow({ lastSyncedAt: justPast })],
    );
    expect(await claimDueErpCursors(after.prisma, 10, NOW, { deviceId: DEVICE })).toHaveLength(1);
  });

  it("always claims a cursor that has NEVER synced", async () => {
    // NULL is not "a long time ago" and it is not "not due": a newly connected
    // organisation must be read immediately rather than four hours later.
    // Mutation: treat a null `lastSyncedAt` as epoch-zero and compare → the
    // first read still happens, but treat it as `now` and a new connection sits
    // idle for four hours looking broken.
    const { prisma } = prismaFor(
      [{ id: "conn-1", provider: XERO_PROVIDER }],
      [cursorRow({ lastSyncedAt: null })],
    );
    expect(await claimDueErpCursors(prisma, 10, NOW, { deviceId: DEVICE })).toHaveLength(1);
  });

  it("leaves a provider with no declared floor exactly as it was", async () => {
    // The floor is opt-in per descriptor. Mutation: apply a default floor to
    // every provider → the Eaglesoft and export-drop tracks, which have no
    // vendor limit at all, silently slow down.
    const { prisma } = prismaFor(
      [{ id: "conn-1", provider: "eaglesoft" }],
      [cursorRow({ lastSyncedAt: new Date(NOW.getTime() - 1000) })],
    );
    expect(await claimDueErpCursors(prisma, 10, NOW, { deviceId: DEVICE })).toHaveLength(1);
  });

  it("claims when the cursor's connection is not in the pollable set's provider map", async () => {
    // Belt-and-braces: a cursor whose connection row carries no provider has
    // no evidence to skip on. Mutation: default an unknown provider to "skip"
    // → a cursor stops being read and nothing says why.
    const { prisma } = prismaFor(
      [{ id: "conn-1", provider: "" }],
      [cursorRow({ lastSyncedAt: new Date(NOW.getTime() - 1000) })],
    );
    expect(await claimDueErpCursors(prisma, 10, NOW, { deviceId: DEVICE })).toHaveLength(1);
  });

  it("keeps the floor OFF when no device identity is supplied", async () => {
    // A unit test (and any caller that has no identity) gets the bare floor
    // rather than a jittered one, so behaviour stays explainable.
    // Mutation: read the device id from `process.env` at module import → the
    // `INFERENCE_RUNTIME` bug again, where `docker restart` cannot change it.
    const { prisma } = prismaFor(
      [{ id: "conn-1", provider: XERO_PROVIDER }],
      [cursorRow({ lastSyncedAt: new Date(NOW.getTime() - XERO_POLL_INTERVAL_FLOOR_MS) })],
    );
    expect(await claimDueErpCursors(prisma, 10, NOW, {})).toHaveLength(1);
  });

  it("takes an injected floor over the descriptor's", async () => {
    // The seam a fixture provider needs — it has no descriptor to declare one.
    // Mutation: ignore `pollFloorMsFor` → a test provider cannot express a
    // cadence and this whole behaviour becomes untestable in isolation.
    const { prisma } = prismaFor(
      [{ id: "conn-1", provider: "fixture-ledger" }],
      [cursorRow({ lastSyncedAt: new Date(NOW.getTime() - 60_000) })],
    );
    expect(
      await claimDueErpCursors(prisma, 10, NOW, {
        pollFloorMsFor: () => 3600_000,
      }),
    ).toHaveLength(0);
  });
});
