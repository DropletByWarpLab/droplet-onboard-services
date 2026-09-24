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
  purgeCursorsForUser,
  recordCheckpoint,
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
    resumeLink: null,
    state: "IDLE",
    consecutiveFailures: 0,
    nextAttemptAt: null,
    lastSyncedAt: null,
    lastError: null,
    ...over,
  };
}

/**
 * `connected` is the set of users whose M365Connection is CONNECTED — the
 * owners `claimDueCursors` may claim for (WARP-3059). Defaults to USER.
 */
function fakePrisma(seed: Array<Record<string, unknown>> = [], connected: string[] = [USER]) {
  let rows = seed.map((r) => ({ ...r }));
  return {
    __rows: () => rows,
    __first: () => rows[0],
    m365Connection: {
      findMany: vi.fn(async ({ where }: any = {}) =>
        where?.state === "CONNECTED" ? connected.map((userId) => ({ userId })) : [],
      ),
    },
    m365DeltaCursor: {
      deleteMany: vi.fn(async ({ where }: any) => {
        const before = rows.length;
        rows = rows.filter((r) => r.userId !== where.userId);
        return { count: before - rows.length };
      }),
      findMany: vi.fn(async ({ where, take }: any = {}) => {
        let out = rows;
        if (where?.userId?.in) out = out.filter((r) => where.userId.in.includes(r.userId));
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

  it("clears the resume checkpoint — the run it belonged to is finished (WARP-3059)", async () => {
    const prisma = fakePrisma([cursor({ resumeLink: "https://graph.microsoft.com/v1.0/x?$skiptoken=p201" })]);
    await recordSuccess(prisma as never, "c1", "https://graph.microsoft.com/v1.0/x?$deltatoken=D", NOW);
    expect((prisma.__first() as any).resumeLink).toBeNull();
  });
});

describe("recordCheckpoint (WARP-3059)", () => {
  const RESUME = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=p201";

  it("stores where the run resumes WITHOUT advancing the delta link", async () => {
    // The cursor advances only at a deltaLink; a checkpoint is a position
    // inside the run, kept apart so that rule still holds.
    const prior = cursor({ deltaLink: null, state: "SYNCING", consecutiveFailures: 2 });
    const prisma = fakePrisma([prior]);

    await recordCheckpoint(prisma as never, "c1", RESUME);

    const row = prisma.__first() as any;
    expect(row.resumeLink).toBe(RESUME);
    expect(row.deltaLink).toBeNull();
    expect(row.state).toBe("IDLE"); // claimable next tick
    expect(row.consecutiveFailures).toBe(0);
    // Not a completed sync: the hub's "last synced" must not move.
    expect(row.lastSyncedAt).toBeNull();
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
    const prisma = fakePrisma([
      cursor({ resumeLink: "https://graph.microsoft.com/v1.0/me/messages/delta?$skiptoken=p201" }),
    ]);

    await recordFailure(prisma as never, "c1", { statusCode: 410 }, undefined, NOW);

    const row = prisma.__first() as any;
    expect(row.state).toBe("RESYNC_REQUIRED");
    expect(row.deltaLink).toBeNull();
    // WARP-3059 — a checkpoint inside the dead enumeration is dead with it.
    expect(row.resumeLink).toBeNull();
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

  it("never writes a driveItem delta token into lastError (WARP-2118)", async () => {
    // driveItem's delta cursor is a BARE `token=`, not `$deltatoken=`. The
    // Outlook-only pattern in redactSyncError could not see it, so a message
    // carrying a files delta URL persisted the credential verbatim — the
    // workload with the largest blast radius. redactDeltaTokens() closes it.
    const prisma = fakePrisma([cursor()]);
    await recordFailure(
      prisma as never,
      "c1",
      {
        statusCode: 400,
        message:
          "GET /me/drive/root/delta?token=DRIVESECRET1234567890 failed",
      },
      undefined,
      NOW,
    );
    const lastError = (prisma.__first() as any).lastError as string;
    expect(lastError).not.toContain("DRIVESECRET1234567890");
    expect(lastError).toContain("[redacted]");
  });

  it("redacts BOTH token shapes in one message — neither pass is a superset", async () => {
    // The guard on collapsing redactSyncError to a single call. redactDeltaTokens
    // anchors on `?`/`&` and cannot see the bare form; the local pattern cannot
    // see driveItem's `token=`. Drop either and exactly one of these leaks.
    const prisma = fakePrisma([cursor()]);
    await recordFailure(
      prisma as never,
      "c1",
      {
        statusCode: 400,
        message:
          "resync after $deltatoken=OUTLOOKSECRET111 then " +
          "GET /me/drive/root/delta?token=DRIVESECRET222 failed",
      },
      undefined,
      NOW,
    );
    const lastError = (prisma.__first() as any).lastError as string;
    expect(lastError).not.toContain("OUTLOOKSECRET111");
    expect(lastError).not.toContain("DRIVESECRET222");
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

  it("never returns a cursor whose owner is not CONNECTED (WARP-3059)", async () => {
    // A disconnected or needs-reconnect person's cursors would otherwise be
    // claimed every tick only to fail at the token — work for nothing, and a
    // stream of failures attributed to cursors that did nothing wrong.
    const prisma = fakePrisma(
      [cursor({ id: "c1", userId: USER }), cursor({ id: "c2", userId: "user-2" })],
      [USER],
    );
    expect((await claimDueCursors(prisma as never, 10, NOW)).map((c) => c.id)).toEqual(["c1"]);
  });

  it("claims nothing, and reads no cursors, when nobody is connected", async () => {
    const prisma = fakePrisma([cursor()], []);
    expect(await claimDueCursors(prisma as never, 10, NOW)).toEqual([]);
    expect(prisma.m365DeltaCursor.findMany).not.toHaveBeenCalled();
  });

  it("hands the resume checkpoint to the run", async () => {
    const prisma = fakePrisma([cursor({ resumeLink: "https://graph.microsoft.com/v1.0/x?$skiptoken=p" })]);
    const [due] = await claimDueCursors(prisma as never, 10, NOW);
    expect(due!.resumeLink).toBe("https://graph.microsoft.com/v1.0/x?$skiptoken=p");
  });
});

describe("purgeCursorsForUser (WARP-3059)", () => {
  it("deletes one person's cursors and nobody else's", async () => {
    // ADR-041: disconnect purges. A delta link is the old account's position;
    // replayed after reconnecting as someone else it would be wrong, and kept
    // after a user is deleted it is residue with no owner.
    const prisma = fakePrisma([
      cursor({ id: "c1", userId: USER }),
      cursor({ id: "c2", userId: USER, resourceId: "sent" }),
      cursor({ id: "c3", userId: "user-2" }),
    ]);
    expect(await purgeCursorsForUser(prisma as never, USER)).toBe(2);
    expect(prisma.__rows().map((r: any) => r.id)).toEqual(["c3"]);
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
