/**
 * WARP-2752 (ADR-051) — the delivery POLICY.
 *
 * These are the tests that decide whether an operator keeps notifications on.
 * The detector pass runs hourly; the naive wiring pushes the same overdue
 * invoice every hour, and the app is muted inside a week. So the cases below
 * are about restraint as much as delivery:
 *
 *   once      — a finding is announced ONCE, however long the condition lasts
 *   batching  — twenty findings in a week are one notification, not twenty
 *   holding   — a digest that is not due yet must NOT stamp the findings it
 *               declined to send, or they are silently swallowed forever
 *   threshold — only a large loss earns an interruption
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// `vi.mock` is hoisted above every const, so the spy has to be hoisted with it
// — the repo's `vi.hoisted` pattern (agent-runs.routes.test.ts).
const { sendNotification } = vi.hoisted(() => ({
  sendNotification: vi.fn(async (_p: unknown, _i: { title: string; body: string | null }) => ({
    id: "n1",
    channels: ["toast"],
    delivered: true,
  })),
}));
vi.mock("../services/notifications.service.js", () => ({ sendNotification }));
vi.mock("../services/notifications.service", () => ({ sendNotification }));

import { notifyFindings, DEFAULT_MIN_IMPACT_MINOR } from "../services/brain/brain-notify.service";

const NOW = new Date("2026-09-05T12:00:00.000Z");

function finding(over: Record<string, unknown> = {}) {
  return {
    id: "f1",
    kind: "loss",
    title: "Acme is 90 days past due",
    rationale: "An invoice fell due 90 days ago.",
    impactMinor: 4_000_000n,
    currency: "USD",
    firstSeenAt: NOW,
    // Every row has one; `company` is what the three shipped detectors write.
    scope: "company",
    ...over,
  };
}

function db(pending: unknown[], over: Record<string, unknown> = {}) {
  return {
    // DISTINCT id and username, as production rows are (WARP-2813). The fake
    // used to return `{ id }` alone, which meant it agreed with the bug: the
    // service selected `id`, handed a UUID to a subsystem keyed on username,
    // and every assertion here still passed. A revert to `id` now yields
    // `undefined` and fails, instead of silently notifying nobody.
    user: { findFirst: vi.fn(async () => ({ id: "u-owner", username: "owner" })) },
    brainFinding: {
      // HONOURS `where` (WARP-2811). A mock that returns its fixture whatever
      // it is asked cannot fail when a filter is wrong — which is how the money
      // detectors shipped a query naming a retired enum and stayed green
      // (WARP-2754). Only the predicates this service actually uses.
      findMany: vi.fn(async ({ where }: { where?: Record<string, unknown> } = {}) =>
        pending.filter((row) => {
          const f = row as Record<string, unknown>;
          if (!where) return true;
          if ("scope" in where && f.scope !== where.scope) return false;
          if ("status" in where && f.status !== undefined && f.status !== where.status) return false;
          return true;
        }),
      ),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: pending.length })),
    },
    systemFlag: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({})),
    },
    ...over,
  } as never;
}

beforeEach(() => {
  // Block body: an expression body returns the mock, and vitest types a hook's
  // return as a cleanup callback.
  sendNotification.mockClear();
});

describe("notifyFindings — interruption threshold (WARP-2752)", () => {
  it("interrupts for a large loss", async () => {
    const out = await notifyFindings(db([finding()]), { now: NOW });
    expect(out.immediate).toBe(1);
    expect(sendNotification).toHaveBeenCalledOnce();
  });

  it("does NOT interrupt for a loss below the threshold — it batches it", async () => {
    const small = finding({ impactMinor: DEFAULT_MIN_IMPACT_MINOR - 1n });
    const out = await notifyFindings(db([small]), { now: NOW });
    expect(out.immediate).toBe(0);
    expect(out.digestSent).toBe(true);
  });

  it("does NOT interrupt for a loss with no impact figure", async () => {
    // A finding without a number is still a finding, but it is not worth a
    // phone buzz — it waits on /brief.
    const out = await notifyFindings(db([finding({ impactMinor: null })]), { now: NOW });
    expect(out.immediate).toBe(0);
  });

  it("does NOT interrupt for a RISK, however large", async () => {
    // Money owed or a slipped forecast is not money lost. Interrupting for it
    // is what makes the loss alerts stop meaning anything.
    const out = await notifyFindings(
      db([finding({ kind: "risk", impactMinor: 99_000_000n })]),
      { now: NOW },
    );
    expect(out.immediate).toBe(0);
  });
});

describe("notifyFindings — announce once (WARP-2752)", () => {
  it("only ever reads findings that have not been notified", async () => {
    const prisma = db([]);
    await notifyFindings(prisma, { now: NOW });
    const where = (
      (prisma as unknown as { brainFinding: { findMany: { mock: { calls: [{ where: unknown }][] } } } })
        .brainFinding.findMany.mock.calls[0]![0] as { where: Record<string, unknown> }
    ).where;
    expect(where).toMatchObject({ notifiedAt: null, status: "new" });
  });

  it("stamps each urgent finding immediately after ITS OWN send", async () => {
    // A batch stamp after the loop would re-announce everything if the process
    // died midway through.
    const prisma = db([finding({ id: "a" }), finding({ id: "b" })]);
    await notifyFindings(prisma, { now: NOW });
    const update = (prisma as unknown as { brainFinding: { update: ReturnType<typeof vi.fn> } })
      .brainFinding.update;
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[0]![0]).toMatchObject({ where: { id: "a" } });
  });
});

describe("notifyFindings — batching (WARP-2752)", () => {
  const small = (i: number) => finding({ id: `f${i}`, kind: "risk", impactMinor: 100n });

  it("twenty findings become ONE digest notification", async () => {
    const out = await notifyFindings(db(Array.from({ length: 20 }, (_, i) => small(i))), {
      now: NOW,
    });
    expect(sendNotification).toHaveBeenCalledOnce();
    expect(out.digested).toBe(20);
  });

  it("names the top item, not just a count", async () => {
    // "3 new findings" and nothing else is a notification nobody opens.
    await notifyFindings(db([small(1), small(2)]), { now: NOW });
    const arg = sendNotification.mock.calls[0]![1];
    expect(arg.title).toContain("2 new findings");
    expect(arg.body).toContain("past due");
  });

  it("HOLDS findings when the digest is not yet due — and does not stamp them", async () => {
    // The bug this guards: stamping `notifiedAt` on findings you declined to
    // send swallows them forever. They must roll into the next digest.
    const recent = new Date(NOW.getTime() - 60_000).toISOString();
    const prisma = db([small(1)], {
      systemFlag: {
        findUnique: vi.fn(async () => ({ valueJson: { at: recent } })),
        upsert: vi.fn(async () => ({})),
      },
    });
    const out = await notifyFindings(prisma, { now: NOW });

    expect(out.digestSent).toBe(false);
    expect(out.digested).toBe(0);
    expect(sendNotification).not.toHaveBeenCalled();
    expect(
      (prisma as unknown as { brainFinding: { updateMany: ReturnType<typeof vi.fn> } })
        .brainFinding.updateMany,
    ).not.toHaveBeenCalled();
  });

  it("sends once the interval has elapsed", async () => {
    const old = new Date(NOW.getTime() - 8 * 24 * 60 * 60_000).toISOString();
    const prisma = db([small(1)], {
      systemFlag: {
        findUnique: vi.fn(async () => ({ valueJson: { at: old } })),
        upsert: vi.fn(async () => ({})),
      },
    });
    const out = await notifyFindings(prisma, { now: NOW });
    expect(out.digestSent).toBe(true);
  });

  it("an urgent loss still goes out while the digest is on hold", async () => {
    // Rate-limiting the digest must not gag a $40k alert.
    const recent = new Date(NOW.getTime() - 60_000).toISOString();
    const prisma = db([finding(), small(2)], {
      systemFlag: {
        findUnique: vi.fn(async () => ({ valueJson: { at: recent } })),
        upsert: vi.fn(async () => ({})),
      },
    });
    const out = await notifyFindings(prisma, { now: NOW });
    expect(out.immediate).toBe(1);
    expect(out.digestSent).toBe(false);
  });
});

describe("notifyFindings — no owner (WARP-2752)", () => {
  it("does nothing, and leaves the queue intact for when there is one", async () => {
    const prisma = db([finding()], {
      user: { findFirst: vi.fn(async () => null) },
    });
    const out = await notifyFindings(prisma, { now: NOW });
    expect(out).toEqual({ immediate: 0, digested: 0, digestSent: false });
    expect(sendNotification).not.toHaveBeenCalled();
    expect(
      (prisma as unknown as { brainFinding: { update: ReturnType<typeof vi.fn> } })
        .brainFinding.update,
    ).not.toHaveBeenCalled();
  });
});

describe("notifyFindings — who it is addressed to (WARP-2813)", () => {
  it("addresses the owner by USERNAME, not by id", async () => {
    // The notifications subsystem is keyed on `User.username` end to end:
    // `sendNotification` publishes `droplet/notifications/${userId}`, ws-bridge
    // subscribes `droplet/notifications/${user.username}`, and both readers of
    // the persisted NotificationLog filter by username. A UUID here is dropped
    // by the broker AND invisible to every reader — the notification exists and
    // reaches nobody. The fake returns distinct values so this cannot pass by
    // coincidence.
    await notifyFindings(db([finding()]), { now: NOW });
    expect(sendNotification).toHaveBeenCalledOnce();
    const [, input] = sendNotification.mock.calls[0]!;
    expect((input as unknown as { userId: string }).userId).toBe("owner");
    expect((input as unknown as { userId: string }).userId).not.toBe("u-owner");
  });

  it("addresses the digest to the username too", async () => {
    await notifyFindings(db([finding({ impactMinor: 1n })]), { now: NOW });
    expect(sendNotification).toHaveBeenCalledOnce();
    const [, input] = sendNotification.mock.calls[0]!;
    expect((input as unknown as { userId: string }).userId).toBe("owner");
  });
});

describe("notifyFindings — scope (WARP-2811)", () => {
  it("never sends someone else's personal finding to the owner", async () => {
    // `personal` scope means the finding is ABOUT a particular person and is
    // owner-scoped by a CHECK constraint. Sending it here would hand the box
    // owner another person's business — the title plus 300 characters of
    // rationale — over a channel with no scope check at all. It waits on
    // /brief instead.
    const mine = finding({ id: "f-personal", scope: "personal", ownerId: "u-someone-else" });
    const out = await notifyFindings(db([mine]), { now: NOW });
    expect(out).toEqual({ immediate: 0, digested: 0, digestSent: false });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("never sends a department finding to the owner", async () => {
    const dept = finding({ id: "f-dept", scope: "department", departmentId: "d1" });
    const out = await notifyFindings(db([dept]), { now: NOW });
    expect(out).toEqual({ immediate: 0, digested: 0, digestSent: false });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("leaves an un-notifiable finding UNSTAMPED, so a later policy can deliver it", async () => {
    // Stamping `notifiedAt` on a row nobody was told about would swallow it
    // permanently: per-recipient delivery, when it is built, would find the
    // queue already marked sent.
    const prisma = db([finding({ scope: "personal", ownerId: "u-someone-else" })]);
    await notifyFindings(prisma, { now: NOW });
    const bf = (prisma as unknown as {
      brainFinding: { update: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
    }).brainFinding;
    expect(bf.update).not.toHaveBeenCalled();
    expect(bf.updateMany).not.toHaveBeenCalled();
  });

  it("still notifies a company finding — the scope the detectors write", async () => {
    const out = await notifyFindings(db([finding()]), { now: NOW });
    expect(out.immediate).toBe(1);
  });
});
