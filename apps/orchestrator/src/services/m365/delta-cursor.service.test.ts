/**
 * WARP-2118 / ADR-041 — delta-cursor lifecycle.
 *
 * The engine's recovery behaviour lives here: what a cursor does after a
 * success, a throttle, a dead delta token, and a dead grant. Prisma is
 * injected, so these run against an in-memory row store.
 *
 * The one to read closely is the resync path. A dead delta token is a NORMAL
 * transition — Outlook evicts tokens from an internal cache with no fixed
 * lifetime — so it must clear the link and re-enumerate rather than land in a
 * failed state a person has to notice and repair.
 */
import { describe, it, expect, vi } from "vitest";

import {
  claimDueCursors,
  recordSuccess,
  recordFailure,
  upsertCursor,
} from "./delta-cursor.service.js";

const USER = "user-1";
const NOW = new Date("2026-08-21T12:00:00Z");

function cursor(over: Record<string, unknown> = {}) {
  return {
    id: "c1",
    userId: USER,
    workload: "mail",
    resourceId: "inbox",
    deltaLink: "https://graph.microsoft.com/v1.0/me/messages/delta?$deltatoken=abc",
    state: "IDLE",
    consecutiveFailures: 0,
    nextAttemptAt: null,
    lastSyncedAt: null,
    lastError: null,
    ...over,
  };
}

function fakePrisma(seed: Array<Record<string, unknown>> = []) {
  let rows = seed.map((r) => ({ ...r }));
  return {
    __rows: () => rows,
    __first: () => rows[0],
    m365DeltaCursor: {
      findMany: vi.fn(async ({ where, take }: any = {}) => {
        let out = rows;
        if (where?.state?.in) out = out.filter((r) => where.state.in.includes(r.state));
        if (where?.OR) {
          out = out.filter((r) =>
            where.OR.some((c: any) =>
              c.nextAttemptAt === null
                ? r.nextAttemptAt === null
                : (r.nextAttemptAt as Date | null) !== null &&
                  (r.nextAttemptAt as Date) <= c.nextAttemptAt.lte,
            ),
          );
        }
        return out.slice(0, take ?? out.length).map((r) => ({ ...r }));
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const i = rows.findIndex((r) => r.id === where.id);
        if (i < 0) throw new Error("not found");
        rows[i] = { ...rows[i], ...data };
        return { ...rows[i] };
      }),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const key = where.userId_workload_resourceId;
        const i = rows.findIndex(
          (r) =>
            r.userId === key.userId &&
            r.workload === key.workload &&
            r.resourceId === key.resourceId,
        );
        if (i < 0) {
          rows.push({ id: `c${rows.length + 1}`, ...create });
          return { ...rows[rows.length - 1] };
        }
        rows[i] = { ...rows[i], ...update };
        return { ...rows[i] };
      }),
    },
  };
}

describe("recordSuccess", () => {
  it("stores the new delta link whole and clears the failure counter", async () => {
    const prisma = fakePrisma([cursor({ consecutiveFailures: 3, state: "BACKOFF" })]);
    const link = "https://graph.microsoft.com/v1.0/me/messages/delta?$deltatoken=NEW&$select=id";

    await recordSuccess(prisma as never, "c1", link, NOW);

    const row = prisma.__first() as any;
    expect(row.deltaLink).toBe(link); // verbatim — never rebuilt
    expect(row.state).toBe("IDLE");
    expect(row.consecutiveFailures).toBe(0);
    expect(row.lastError).toBeNull();
    expect(row.lastSyncedAt).toEqual(NOW);
  });
});

describe("recordFailure", () => {
  it("backs off on a throttle and obeys Retry-After exactly", async () => {
    // Not a suggestion: throttled requests still count against the tenant's
    // budget, so retrying early deepens the throttling it is escaping.
    const prisma = fakePrisma([cursor()]);

    await recordFailure(prisma as never, "c1", { statusCode: 429 }, "120", NOW);

    const row = prisma.__first() as any;
    expect(row.state).toBe("BACKOFF");
    expect(row.consecutiveFailures).toBe(1);
    expect(row.nextAttemptAt).toEqual(new Date(NOW.getTime() + 120_000));
  });

  it("grows the wait as failures repeat", async () => {
    const prisma = fakePrisma([cursor({ consecutiveFailures: 5 })]);
    await recordFailure(prisma as never, "c1", { statusCode: 503 }, undefined, NOW);

    const row = prisma.__first() as any;
    expect(row.state).toBe("BACKOFF");
    expect(row.consecutiveFailures).toBe(6);
    expect((row.nextAttemptAt as Date).getTime()).toBeGreaterThan(NOW.getTime());
  });

  it("clears the dead token and asks for a resync on 410 Gone", async () => {
    // The important one. A dead delta token is NORMAL — Outlook evicts them
    // from a cache with no fixed lifetime. Keeping the link would replay a
    // token Graph has already rejected, forever.
    const prisma = fakePrisma([cursor()]);

    await recordFailure(prisma as never, "c1", { statusCode: 410 }, undefined, NOW);

    const row = prisma.__first() as any;
    expect(row.state).toBe("RESYNC_REQUIRED");
    expect(row.deltaLink).toBeNull();
    // Re-enumeration is not a failure: it must not be delayed by backoff, and
    // it must not count toward the failure streak.
    expect(row.consecutiveFailures).toBe(0);
    expect(row.nextAttemptAt).toBeNull();
  });

  it("also resyncs on syncStateNotFound", async () => {
    const prisma = fakePrisma([cursor()]);
    await recordFailure(prisma as never, "c1", { code: "syncStateNotFound" }, undefined, NOW);
    expect((prisma.__first() as any).state).toBe("RESYNC_REQUIRED");
    expect((prisma.__first() as any).deltaLink).toBeNull();
  });

  it("parks the cursor on an auth failure WITHOUT discarding its delta link", async () => {
    // The grant is dead, not the token. Throwing the link away would force a
    // full re-download of the mailbox once the person reconnects.
    const prisma = fakePrisma([cursor()]);
    const link = (prisma.__first() as any).deltaLink;

    await recordFailure(prisma as never, "c1", { statusCode: 401 }, undefined, NOW);

    const row = prisma.__first() as any;
    expect(row.state).toBe("BACKOFF");
    expect(row.deltaLink).toBe(link);
  });

  it("marks a genuinely broken request FAILED rather than retrying forever", async () => {
    const prisma = fakePrisma([cursor()]);
    await recordFailure(prisma as never, "c1", { statusCode: 400 }, undefined, NOW);
    expect((prisma.__first() as any).state).toBe("FAILED");
  });

  it("never writes a delta link into lastError", async () => {
    // A delta link carries a token of its own; it must not leak into a field
    // the dashboard renders.
    const prisma = fakePrisma([cursor()]);
    await recordFailure(
      prisma as never,
      "c1",
      { statusCode: 400, message: "bad request for $deltatoken=SECRETTOKENVALUE1234567890" },
      undefined,
      NOW,
    );
    expect((prisma.__first() as any).lastError).not.toContain("SECRETTOKENVALUE1234567890");
  });
});

describe("claimDueCursors", () => {
  it("returns cursors that are idle or due, and skips ones still waiting", async () => {
    const prisma = fakePrisma([
      cursor({ id: "c1", state: "IDLE", nextAttemptAt: null }),
      cursor({ id: "c2", state: "BACKOFF", nextAttemptAt: new Date(NOW.getTime() - 1000) }),
      cursor({ id: "c3", state: "BACKOFF", nextAttemptAt: new Date(NOW.getTime() + 60_000) }),
    ]);

    const due = await claimDueCursors(prisma as never, 10, NOW);
    const ids = due.map((c) => c.id);

    expect(ids).toContain("c1");
    expect(ids).toContain("c2");
    expect(ids).not.toContain("c3"); // still inside its backoff window
  });

  it("includes RESYNC_REQUIRED so a dead token is repaired promptly", async () => {
    const prisma = fakePrisma([
      cursor({ id: "c1", state: "RESYNC_REQUIRED", deltaLink: null, nextAttemptAt: null }),
    ]);
    expect((await claimDueCursors(prisma as never, 10, NOW)).map((c) => c.id)).toEqual(["c1"]);
  });

  it("never returns a FAILED cursor — it needs a person, not a retry", async () => {
    const prisma = fakePrisma([cursor({ id: "c1", state: "FAILED", nextAttemptAt: null })]);
    expect(await claimDueCursors(prisma as never, 10, NOW)).toEqual([]);
  });

  it("never returns a cursor already SYNCING, so two ticks cannot overlap", async () => {
    const prisma = fakePrisma([cursor({ id: "c1", state: "SYNCING", nextAttemptAt: null })]);
    expect(await claimDueCursors(prisma as never, 10, NOW)).toEqual([]);
  });
});

describe("upsertCursor", () => {
  it("creates a cursor for a newly discovered resource", async () => {
    const prisma = fakePrisma([]);
    await upsertCursor(prisma as never, USER, "files", "drive-1");

    const row = prisma.__first() as any;
    expect(row).toMatchObject({ userId: USER, workload: "files", resourceId: "drive-1" });
    expect(row.state).toBe("IDLE");
    expect(row.deltaLink).toBeNull();
  });

  it("does not reset an existing cursor's delta link", async () => {
    // Re-discovering a folder on every tick must not throw away its progress
    // and re-download the mailbox.
    const prisma = fakePrisma([cursor({ deltaLink: "KEEP-ME", lastSyncedAt: NOW })]);
    await upsertCursor(prisma as never, USER, "mail", "inbox");
    expect((prisma.__first() as any).deltaLink).toBe("KEEP-ME");
  });
});
