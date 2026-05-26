/**
 * WARP-455 — guest-expiry-sweep cron job.
 *
 * The nightly cron flips ACTIVE → EXPIRED for any GuestExpiry row
 * whose `expiresAt < now()`, then emits an `auth`-kind ActivityRow
 * per flip and best-effort invalidates any cached Nextcloud session
 * for the affected user so the next API call from a stale browser
 * tab gets a 401 from the OCS validator.
 *
 * Idempotency contract (a re-run on a converged state must be a no-op):
 *   - Only ACTIVE rows are flipped — re-running picks up zero new
 *     rows because the previous run already moved them to EXPIRED.
 *   - The flip writes `expiredAt = now()` so a future fix-up query
 *     can find the actual transition time.
 *   - ActivityRow emission is per-row, so a no-op tick produces zero
 *     audit rows (no \"swept 0 guests\" noise).
 *
 * No `while True`: callers wire this through cron-runtime.service's
 * `scheduleCron(\"15 3 * * *\", ...)` per the chunk plan. The runtime's
 * advisory-lock support keeps multi-instance deploys from double-firing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));

import { sweepExpiredGuests } from "../services/guest-expiry-sweep.service.js";

interface FakeGuestExpiry {
  id: string;
  userId: string;
  expiresAt: Date;
  status: "ACTIVE" | "EXPIRED";
  expiredAt: Date | null;
}

interface FakeUser {
  id: string;
  username: string;
  role: string;
}

function buildPrisma(
  expiries: FakeGuestExpiry[],
  users: FakeUser[] = [],
) {
  const expiryRows = new Map<string, FakeGuestExpiry>(
    expiries.map((e) => [e.id, e]),
  );
  const userRows = new Map<string, FakeUser>(users.map((u) => [u.id, u]));

  return {
    expiryRows,
    userRows,
    guestExpiry: {
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: { status: string; expiresAt: { lt: Date } };
        }) => {
          const result: Array<FakeGuestExpiry & { user: FakeUser | null }> = [];
          for (const row of expiryRows.values()) {
            if (row.status !== where.status) continue;
            if (row.expiresAt >= where.expiresAt.lt) continue;
            result.push({ ...row, user: userRows.get(row.userId) ?? null });
          }
          return result;
        },
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<FakeGuestExpiry>;
        }) => {
          const existing = expiryRows.get(where.id);
          if (!existing) {
            const err: any = new Error("not found");
            err.code = "P2025";
            throw err;
          }
          const merged = { ...existing, ...data };
          expiryRows.set(where.id, merged);
          return merged;
        },
      ),
    },
  };
}

beforeEach(() => {
  recordActivityMock.mockClear();
});

describe("sweepExpiredGuests()", () => {
  it("flips ACTIVE rows past expiresAt to EXPIRED", async () => {
    const past = new Date("2026-05-20T00:00:00Z");
    const now = new Date("2026-05-25T03:15:00Z");
    const prisma = buildPrisma(
      [
        {
          id: "ge1",
          userId: "u1",
          expiresAt: past,
          status: "ACTIVE",
          expiredAt: null,
        },
      ],
      [{ id: "u1", username: "guest-alice", role: "guest" }],
    );

    const result = await sweepExpiredGuests(prisma as any, now);

    expect(result.expired).toBe(1);
    expect(prisma.guestExpiry.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "ge1" },
        data: expect.objectContaining({
          status: "EXPIRED",
          expiredAt: now,
        }),
      }),
    );
  });

  it("skips ACTIVE rows whose expiresAt is in the future", async () => {
    const future = new Date("2026-06-01T00:00:00Z");
    const now = new Date("2026-05-25T03:15:00Z");
    const prisma = buildPrisma(
      [
        {
          id: "ge1",
          userId: "u1",
          expiresAt: future,
          status: "ACTIVE",
          expiredAt: null,
        },
      ],
      [{ id: "u1", username: "alice", role: "guest" }],
    );

    const result = await sweepExpiredGuests(prisma as any, now);

    expect(result.expired).toBe(0);
    expect(prisma.guestExpiry.update).not.toHaveBeenCalled();
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("is idempotent — re-running on a converged DB does nothing", async () => {
    // After the first tick flipped a row to EXPIRED, the next tick
    // sees zero ACTIVE rows past expiresAt and emits zero activity.
    const past = new Date("2026-05-20T00:00:00Z");
    const now = new Date("2026-05-25T03:15:00Z");
    const prisma = buildPrisma(
      [
        {
          id: "ge1",
          userId: "u1",
          expiresAt: past,
          status: "EXPIRED",
          expiredAt: new Date("2026-05-21T03:15:00Z"),
        },
      ],
      [{ id: "u1", username: "alice", role: "guest" }],
    );

    const result = await sweepExpiredGuests(prisma as any, now);

    expect(result.expired).toBe(0);
    expect(prisma.guestExpiry.update).not.toHaveBeenCalled();
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("emits one auth-kind ActivityRow per flipped guest", async () => {
    const past = new Date("2026-05-20T00:00:00Z");
    const now = new Date("2026-05-25T03:15:00Z");
    const prisma = buildPrisma(
      [
        {
          id: "ge1",
          userId: "u1",
          expiresAt: past,
          status: "ACTIVE",
          expiredAt: null,
        },
        {
          id: "ge2",
          userId: "u2",
          expiresAt: past,
          status: "ACTIVE",
          expiredAt: null,
        },
      ],
      [
        { id: "u1", username: "alice", role: "guest" },
        { id: "u2", username: "bob", role: "guest" },
      ],
    );

    await sweepExpiredGuests(prisma as any, now);

    expect(recordActivityMock).toHaveBeenCalledTimes(2);
    const calls = recordActivityMock.mock.calls;
    for (const [arg] of calls) {
      expect(arg.kind).toBe("auth");
      expect(arg.severity).toBe("warn");
      expect(arg.what).toMatch(/Guest expired/i);
      expect(arg.refs).toHaveProperty("targetUserId");
    }
  });

  it("flips two batches without conflating them in audit refs", async () => {
    const past = new Date("2026-05-20T00:00:00Z");
    const now = new Date("2026-05-25T03:15:00Z");
    const prisma = buildPrisma(
      [
        {
          id: "ge1",
          userId: "u1",
          expiresAt: past,
          status: "ACTIVE",
          expiredAt: null,
        },
        {
          id: "ge2",
          userId: "u2",
          expiresAt: past,
          status: "ACTIVE",
          expiredAt: null,
        },
      ],
      [
        { id: "u1", username: "alice", role: "guest" },
        { id: "u2", username: "bob", role: "guest" },
      ],
    );

    await sweepExpiredGuests(prisma as any, now);

    const targets = recordActivityMock.mock.calls.map(
      ([arg]) => arg.refs.targetUserId,
    );
    expect(targets.sort()).toEqual(["u1", "u2"]);
  });

  it("survives a recordActivity throw (audit is best-effort)", async () => {
    // ActivityRow emission failures must not abort the sweep — losing
    // an audit row for a single guest is acceptable; leaving the
    // entire batch in ACTIVE because the audit recorder hiccupped is
    // not. Mirrors the existing best-effort posture in
    // activity.service's recordSafely + the auth route's swallow-on-warn.
    recordActivityMock.mockRejectedValueOnce(new Error("recorder down"));

    const past = new Date("2026-05-20T00:00:00Z");
    const now = new Date("2026-05-25T03:15:00Z");
    const prisma = buildPrisma(
      [
        {
          id: "ge1",
          userId: "u1",
          expiresAt: past,
          status: "ACTIVE",
          expiredAt: null,
        },
        {
          id: "ge2",
          userId: "u2",
          expiresAt: past,
          status: "ACTIVE",
          expiredAt: null,
        },
      ],
      [
        { id: "u1", username: "alice", role: "guest" },
        { id: "u2", username: "bob", role: "guest" },
      ],
    );

    const result = await sweepExpiredGuests(prisma as any, now);

    // Both rows still flipped despite the audit failure on the first.
    expect(result.expired).toBe(2);
    expect(prisma.guestExpiry.update).toHaveBeenCalledTimes(2);
  });
});
