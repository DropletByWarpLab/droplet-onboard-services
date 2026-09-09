/**
 * WARP-2218 — the first `ErpSyncCursor` writers.
 *
 * Prisma is a `vi.fn()`-backed in-memory store, per the team rule against
 * mock-database integration tests. The two cases that carry the weight are the
 * exclusive claim (two ticks must not both take one cursor and double-spend a
 * metered vendor call) and the status filter (a DISABLED connection must never
 * be polled).
 */
import { describe, it, expect, vi } from "vitest";

import {
  claimDueErpCursors,
  releaseErpCursorFailure,
  releaseErpCursorSuccess,
  upsertErpCursor,
} from "./cursor.service.js";

const NOW = new Date("2026-08-27T12:00:00Z");

function cursorRow(over: Record<string, unknown> = {}) {
  return {
    id: "cur-1",
    connectionId: "conn-1",
    entity: "invoice",
    watermark: "2026-08-01T00:00:00Z",
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

function connRow(over: Record<string, unknown> = {}) {
  return { id: "conn-1", provider: "quickbooks-online", status: "CONNECTED", ...over };
}

/**
 * In-memory Prisma double.
 *
 * `updateMany` honours the `state` predicate, which is the whole point: a stub
 * that ignored the WHERE would make the exclusivity test pass no matter what
 * the claim did, and the mutation would not be detectable.
 */
function fakePrisma(cursors: Array<Record<string, unknown>>, conns = [connRow()]) {
  const rows = cursors.map((c) => ({ ...c }));
  return {
    __rows: rows,
    __find: (id: string) => rows.find((r) => r.id === id),
    integrationConnection: {
      findMany: vi.fn(async (args: any) => {
        const wanted: string[] = args?.where?.status?.in ?? [];
        return conns.filter((c) => wanted.length === 0 || wanted.includes(c.status));
      }),
    },
    erpSyncCursor: {
      findMany: vi.fn(async (args: any) => {
        const w = args?.where ?? {};
        return rows.filter((r) => {
          if (w.connectionId?.in && !w.connectionId.in.includes(r.connectionId)) return false;
          if (w.state?.in && !w.state.in.includes(r.state)) return false;
          if (Array.isArray(w.OR)) {
            const due =
              r.nextAttemptAt === null ||
              (r.nextAttemptAt as Date).getTime() <= (args.__now ?? NOW).getTime();
            if (!due) return false;
          }
          return true;
        });
      }),
      updateMany: vi.fn(async (args: any) => {
        const { id, state } = args.where;
        const matchesState = (actual: unknown) => {
          if (state === undefined) return true; // the unconditional mutation
          if (state && typeof state === "object" && Array.isArray(state.in)) {
            return state.in.includes(actual);
          }
          return actual === state;
        };
        const row = rows.find((r) => r.id === id && matchesState(r.state));
        if (!row) return { count: 0 };
        Object.assign(row, args.data);
        return { count: 1 };
      }),
      update: vi.fn(async (args: any) => {
        const row = rows.find((r) => r.id === args.where.id);
        if (row) Object.assign(row, args.data);
        return row;
      }),
      upsert: vi.fn(async (args: any) => {
        const { connectionId, entity } = args.where.connectionId_entity;
        const row = rows.find((r) => r.connectionId === connectionId && r.entity === entity);
        if (row) {
          Object.assign(row, args.update);
          return row;
        }
        const created = { id: `cur-${rows.length + 1}`, ...args.create };
        rows.push(created);
        return created;
      }),
    },
  };
}

describe("claimDueErpCursors", () => {
  it("hands one due cursor out exactly ONCE across two concurrent claims", async () => {
    // MUTATION: change the claim's conditional `updateMany({ where: { id,
    // state } })` to an unconditional `update({ where: { id } })` and both
    // ticks receive the cursor — this expectation goes to 2 and red.
    const prisma = fakePrisma([cursorRow()]);
    const [a, b] = await Promise.all([
      claimDueErpCursors(prisma as never, 10, NOW),
      claimDueErpCursors(prisma as never, 10, NOW),
    ]);
    expect(a.length + b.length).toBe(1);
    expect(prisma.__find("cur-1")!.state).toBe("SYNCING");
  });

  it("never returns a cursor whose connection is DISABLED, even alongside a live one", async () => {
    // MUTATION: drop `connectionId: { in: pollableIds }` from the due query →
    // cur-2 comes back → red. Polling a connection an operator turned off
    // ignores them and spends a credential they may have revoked.
    //
    // The LIVE connection in this fixture is load-bearing. With only a
    // disabled connection the function short-circuits on the empty pollable
    // list and never reaches the filter at all, so the mutation stays green
    // and the test proves nothing. Verified: this fixture turns it red.
    const prisma = fakePrisma(
      [cursorRow({ id: "cur-1", connectionId: "conn-live" }), cursorRow({ id: "cur-2", connectionId: "conn-off" })],
      [connRow({ id: "conn-live", status: "CONNECTED" }), connRow({ id: "conn-off", status: "DISABLED" })],
    );
    const claimed = await claimDueErpCursors(prisma as never, 10, NOW);
    expect(claimed.map((c) => c.id)).toEqual(["cur-1"]);
  });

  it("never returns a cursor whose connection is NOT_CONFIGURED, even alongside a live one", async () => {
    const prisma = fakePrisma(
      [cursorRow({ id: "cur-1", connectionId: "conn-live" }), cursorRow({ id: "cur-2", connectionId: "conn-new" })],
      [connRow({ id: "conn-live", status: "CONNECTED" }), connRow({ id: "conn-new", status: "NOT_CONFIGURED" })],
    );
    const claimed = await claimDueErpCursors(prisma as never, 10, NOW);
    expect(claimed.map((c) => c.id)).toEqual(["cur-1"]);
  });

  it("never returns a cursor whose connection is in ERROR or DRIFT_LOCKED", async () => {
    const prisma = fakePrisma(
      [
        cursorRow({ id: "cur-1", connectionId: "conn-live" }),
        cursorRow({ id: "cur-2", connectionId: "conn-err" }),
        cursorRow({ id: "cur-3", connectionId: "conn-locked" }),
      ],
      [
        connRow({ id: "conn-live", status: "CONNECTED" }),
        connRow({ id: "conn-err", status: "ERROR" }),
        connRow({ id: "conn-locked", status: "DRIFT_LOCKED" }),
      ],
    );
    const claimed = await claimDueErpCursors(prisma as never, 10, NOW);
    expect(claimed.map((c) => c.id)).toEqual(["cur-1"]);
  });

  it("returns nothing when the ONLY connection is disabled", async () => {
    const prisma = fakePrisma([cursorRow()], [connRow({ status: "DISABLED" })]);
    expect(await claimDueErpCursors(prisma as never, 10, NOW)).toEqual([]);
  });

  it("polls a DEGRADED connection — a transient failure is what a retry clears", async () => {
    const prisma = fakePrisma([cursorRow()], [connRow({ status: "DEGRADED" })]);
    expect((await claimDueErpCursors(prisma as never, 10, NOW)).map((c) => c.id)).toEqual(["cur-1"]);
  });

  it("polls a CAPABILITY_LIMITED connection — one refused dataset is not a stop (WARP-2623)", async () => {
    // The connection WORKS: the vendor withholds a single resource because of
    // the account's plan or the app's granted scopes, and every other entity
    // reads normally. These rows persisted as ERROR before WARP-2623 and were
    // therefore excluded here, so a Basic-plan store that could read orders,
    // products and inventory silently stopped reading any of them too.
    //
    // MUTATION: drop "CAPABILITY_LIMITED" from POLLABLE_CONNECTION_STATUSES →
    // red. That is the whole assertion; the status filter itself is pinned by
    // the DISABLED test above.
    const prisma = fakePrisma([cursorRow()], [connRow({ status: "CAPABILITY_LIMITED" })]);
    expect((await claimDueErpCursors(prisma as never, 10, NOW)).map((c) => c.id)).toEqual(["cur-1"]);
  });

  it("never returns a FAILED cursor — it needs a person, not a retry", async () => {
    const prisma = fakePrisma([cursorRow({ state: "FAILED" })]);
    expect(await claimDueErpCursors(prisma as never, 10, NOW)).toEqual([]);
  });

  it("never returns a cursor already SYNCING, so two ticks cannot overlap", async () => {
    const prisma = fakePrisma([cursorRow({ state: "SYNCING" })]);
    expect(await claimDueErpCursors(prisma as never, 10, NOW)).toEqual([]);
  });

  it("includes RESYNC_REQUIRED so a dead position is repaired promptly", async () => {
    const prisma = fakePrisma([cursorRow({ state: "RESYNC_REQUIRED", watermark: null })]);
    const claimed = await claimDueErpCursors(prisma as never, 10, NOW);
    expect(claimed.map((c) => c.previousState)).toEqual(["RESYNC_REQUIRED"]);
    expect(claimed[0].watermark).toBeNull();
  });

  it("returns nothing at all when no connection is pollable", async () => {
    const prisma = fakePrisma([cursorRow()], []);
    expect(await claimDueErpCursors(prisma as never, 10, NOW)).toEqual([]);
    expect(prisma.erpSyncCursor.findMany).not.toHaveBeenCalled();
  });
});

describe("releaseErpCursorSuccess", () => {
  it("stores the new watermark and clears the failure streak", async () => {
    const prisma = fakePrisma([cursorRow({ state: "SYNCING", consecutiveFailures: 3 })]);
    await releaseErpCursorSuccess(prisma as never, "cur-1", "2026-08-27T00:00:00Z", NOW);
    const row = prisma.__find("cur-1")!;
    expect(row).toMatchObject({
      watermark: "2026-08-27T00:00:00Z",
      state: "IDLE",
      consecutiveFailures: 0,
      nextAttemptAt: null,
      needsReconnect: false,
      lastError: null,
    });
    expect(row.lastSyncedAt).toEqual(NOW);
  });

  it("clears needsReconnect once the grant works again", async () => {
    const prisma = fakePrisma([cursorRow({ needsReconnect: true })]);
    await releaseErpCursorSuccess(prisma as never, "cur-1", "w", NOW);
    expect(prisma.__find("cur-1")!.needsReconnect).toBe(false);
  });

  it("writes lastSweepAt only when the sweep supplied it", async () => {
    const prisma = fakePrisma([cursorRow()]);
    await releaseErpCursorSuccess(prisma as never, "cur-1", "w", NOW);
    expect(prisma.__find("cur-1")!.lastSweepAt).toBeNull();
    await releaseErpCursorSuccess(prisma as never, "cur-1", "w", NOW, NOW);
    expect(prisma.__find("cur-1")!.lastSweepAt).toEqual(NOW);
  });
});

describe("releaseErpCursorFailure", () => {
  const claimed = { id: "cur-1", consecutiveFailures: 0 };

  it("routes a dead position to RESYNC_REQUIRED, not a failure", async () => {
    // MUTATION: collapse RESYNC_REQUIRED onto the FAILED branch and this goes
    // red. A dead cursor is routine; it does not count toward the streak and
    // takes no backoff, because delaying it only leaves data stale.
    const prisma = fakePrisma([cursorRow({ state: "SYNCING" })]);
    const state = await releaseErpCursorFailure(
      prisma as never,
      claimed,
      { statusCode: 410, message: "gone" },
      null,
      NOW,
    );
    expect(state).toBe("RESYNC_REQUIRED");
    expect(prisma.__find("cur-1")).toMatchObject({
      state: "RESYNC_REQUIRED",
      watermark: null,
      consecutiveFailures: 0,
      nextAttemptAt: null,
      needsReconnect: false,
      lastError: null,
    });
  });

  it("routes a throttle to BACKOFF and OBEYS Retry-After over the exponential curve", async () => {
    // MUTATION: ignore the header and always use computeBackoffMs's
    // exponential growth → nextAttemptAt lands ~30s out (jittered), not the
    // 120s the vendor asked for, and this goes red. Retrying earlier than the
    // vendor asked deepens the throttling it is trying to escape.
    const prisma = fakePrisma([cursorRow({ state: "SYNCING" })]);
    const state = await releaseErpCursorFailure(
      prisma as never,
      claimed,
      { statusCode: 429, message: "slow down" },
      "120",
      NOW,
    );
    expect(state).toBe("BACKOFF");
    expect(prisma.__find("cur-1")!.nextAttemptAt).toEqual(new Date(NOW.getTime() + 120_000));
  });

  it("falls back to exponential backoff when the vendor sends no Retry-After", async () => {
    const prisma = fakePrisma([cursorRow({ state: "SYNCING" })]);
    await releaseErpCursorFailure(
      prisma as never,
      { id: "cur-1", consecutiveFailures: 0 },
      { statusCode: 503 },
      null,
      NOW,
    );
    const next = prisma.__find("cur-1")!.nextAttemptAt as Date;
    const waited = next.getTime() - NOW.getTime();
    // 30s base with full jitter over the top 50% → [15s, 30s].
    expect(waited).toBeGreaterThanOrEqual(15_000);
    expect(waited).toBeLessThanOrEqual(30_000);
  });

  it("flags needsReconnect on a dead grant and KEEPS the watermark", async () => {
    // MUTATION: map AUTH onto FAILED (or onto ERROR) and this goes red.
    // ADR-041 treats a revoked customer credential as routine: the owner
    // pastes a new one. Discarding the watermark would also force a full
    // re-enumeration the moment they do.
    const prisma = fakePrisma([cursorRow({ state: "SYNCING" })]);
    const state = await releaseErpCursorFailure(
      prisma as never,
      claimed,
      { statusCode: 401, message: "grant revoked" },
      null,
      NOW,
    );
    expect(state).toBe("BACKOFF");
    const row = prisma.__find("cur-1")!;
    expect(row.needsReconnect).toBe(true);
    expect(row.watermark).toBe("2026-08-01T00:00:00Z");
    expect(row.state).not.toBe("FAILED");
  });

  it("routes an unretryable failure to FAILED", async () => {
    const prisma = fakePrisma([cursorRow({ state: "SYNCING" })]);
    const state = await releaseErpCursorFailure(
      prisma as never,
      claimed,
      { statusCode: 400, message: "malformed" },
      null,
      NOW,
    );
    expect(state).toBe("FAILED");
    expect(prisma.__find("cur-1")).toMatchObject({
      state: "FAILED",
      needsReconnect: false,
      nextAttemptAt: null,
    });
  });

  it("keeps the three failure classes on three DIFFERENT states", async () => {
    // The distinction is the deliverable: collapsing any two of them loses the
    // only thing that tells an owner whether to wait, to act, or to call.
    const states = new Set<string>();
    for (const err of [
      { statusCode: 410 },
      { statusCode: 429 },
      { statusCode: 400 },
    ]) {
      const prisma = fakePrisma([cursorRow({ state: "SYNCING" })]);
      states.add(await releaseErpCursorFailure(prisma as never, claimed, err, null, NOW));
    }
    expect(states).toEqual(new Set(["RESYNC_REQUIRED", "BACKOFF", "FAILED"]));
  });

  it("never writes a credential or a page cursor into lastError", async () => {
    // Rule 19. The vendor echoes the key that failed and the cursor it choked
    // on; neither may land in a column the dashboard renders.
    const prisma = fakePrisma([cursorRow({ state: "SYNCING" })]);
    await releaseErpCursorFailure(
      prisma as never,
      claimed,
      {
        statusCode: 400,
        message:
          "auth failed for rk_live_51QaBcDeFgHiJkLmNoP while paging starting_after=cus_SECRETCURSOR9",
      },
      null,
      NOW,
    );
    const lastError = String(prisma.__find("cur-1")!.lastError);
    expect(lastError).not.toContain("rk_live_51QaBcDeFgHiJkLmNoP");
    expect(lastError).not.toContain("cus_SECRETCURSOR9");
    // The status code survives, because that is what makes a support search
    // possible — over-redacting into uselessness is its own failure.
    expect(lastError).toContain("400");
  });
});

describe("upsertErpCursor", () => {
  it("creates a cursor with an explicit IDLE state and a null watermark", async () => {
    const prisma = fakePrisma([]);
    await upsertErpCursor(prisma as never, "conn-1", "invoice");
    expect(prisma.__rows[0]).toMatchObject({
      connectionId: "conn-1",
      entity: "invoice",
      state: "IDLE",
      watermark: null,
      needsReconnect: false,
    });
  });

  it("does NOT reset an existing cursor's watermark", async () => {
    // Registration runs every tick; clobbering the position here would
    // re-enumerate the whole account each time.
    const prisma = fakePrisma([cursorRow({ watermark: "2026-08-20T00:00:00Z" })]);
    await upsertErpCursor(prisma as never, "conn-1", "invoice");
    expect(prisma.__find("cur-1")!.watermark).toBe("2026-08-20T00:00:00Z");
  });
});
