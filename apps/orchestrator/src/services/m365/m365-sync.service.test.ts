/**
 * WARP-2118 (review) — the sync engine's OWN failure shapes.
 *
 * `sync-policy.test.ts` pins how Graph's answers are classified. This file
 * pins what the engine does with the failures it raises itself, which the
 * review found were being dressed up as something they were not:
 *
 *   - a page handler that throws used to be recorded under a code the policy
 *     did not know, which fell through to FATAL and parked the cursor in a
 *     state nothing ever claims again — the opposite of the comment above it;
 *   - a token the box could not PRODUCE (a database read that failed) was
 *     rewritten as a synthetic 401, telling the responder to reconnect a grant
 *     that was fine and hiding the real error;
 *   - a live 401/403 from Graph on a token that had refreshed fine parked the
 *     cursor and never touched the connection row, so the dashboard kept
 *     saying CONNECTED while the cursor backed off forever.
 *
 * Prisma is an in-memory row store; the auth service is mocked at the module
 * seam so each case controls exactly what `getAccessToken` does.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { getAccessTokenMock, markNeedsReconnectMock } = vi.hoisted(() => ({
  getAccessTokenMock: vi.fn(),
  markNeedsReconnectMock: vi.fn(async () => undefined),
}));
vi.mock("./m365-auth.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./m365-auth.service.js")>();
  return {
    ...actual,
    getAccessToken: getAccessTokenMock,
    markNeedsReconnect: markNeedsReconnectMock,
  };
});

import { syncCursor, type M365SyncDeps } from "./m365-sync.service.js";
import { GraphRequestError, type GraphPage } from "./graph-client.js";
import { M365NotConnectedError } from "./m365-auth.service.js";
import type { DueCursor } from "./delta-cursor.service.js";

const USER = "user-1";
const NOW = new Date("2026-09-04T12:00:00Z");
const DELTA = "https://graph.microsoft.com/v1.0/me/messages/delta?$deltatoken=abc";

interface Row {
  id: string;
  userId: string;
  workload: string;
  resourceId: string;
  deltaLink: string | null;
  state: string;
  consecutiveFailures: number;
  nextAttemptAt: Date | null;
  lastSyncedAt: Date | null;
  lastError: string | null;
}

function row(over: Partial<Row> = {}): Row {
  return {
    id: "c1",
    userId: USER,
    workload: "mail",
    resourceId: "inbox",
    deltaLink: DELTA,
    state: "SYNCING",
    consecutiveFailures: 0,
    nextAttemptAt: null,
    lastSyncedAt: null,
    lastError: null,
    ...over,
  };
}

function fakePrisma(seed: Row[]) {
  const rows = seed.map((r) => ({ ...r }));
  return {
    __first: () => rows[0],
    m365DeltaCursor: {
      findMany: vi.fn(async ({ where, take }: { where?: { id?: string }; take?: number } = {}) =>
        rows
          .filter((r) => !where?.id || r.id === where.id)
          .slice(0, take ?? rows.length)
          .map((r) => ({ ...r })),
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const i = rows.findIndex((r) => r.id === where.id);
        if (i < 0) throw new Error("not found");
        rows[i] = { ...rows[i], ...data };
        return { ...rows[i] };
      }),
    },
  };
}

function due(over: Partial<DueCursor> = {}): DueCursor {
  return {
    id: "c1",
    userId: USER,
    workload: "mail",
    resourceId: "inbox",
    deltaLink: DELTA,
    state: "SYNCING",
    ...over,
  };
}

function page(): GraphPage {
  return {
    items: [{ id: "m1" }],
    links: { nextLink: null, deltaLink: `${DELTA}-next` },
    raw: {},
  } as unknown as GraphPage;
}

function deps(
  prisma: ReturnType<typeof fakePrisma>,
  over: Partial<M365SyncDeps> = {},
): M365SyncDeps {
  return {
    prisma: prisma as unknown as M365SyncDeps["prisma"],
    client: { getPage: vi.fn(async () => page()) } as unknown as M365SyncDeps["client"],
    entra: {} as M365SyncDeps["entra"],
    initialUrlFor: () => "https://graph.microsoft.com/v1.0/me/messages/delta",
    now: () => NOW,
    ...over,
  };
}

beforeEach(() => {
  getAccessTokenMock.mockReset();
  markNeedsReconnectMock.mockClear();
  getAccessTokenMock.mockResolvedValue("tok");
});

describe("syncCursor — a page handler that throws", () => {
  it("parks the cursor in BACKOFF with its delta link intact, never FAILED", async () => {
    const prisma = fakePrisma([row()]);
    const res = await syncCursor(
      deps(prisma, {
        handlePage: async () => {
          throw new Error("landing table is missing");
        },
      }),
      due(),
    );

    expect(res.completed).toBe(false);
    expect(res.error).toBe("landing table is missing");
    const after = prisma.__first();
    // FAILED is never claimed again; BACKOFF repeats the run from the same
    // deltaLink, which is what the handler contract promises.
    expect(after.state).toBe("BACKOFF");
    expect(after.deltaLink).toBe(DELTA);
    expect(after.nextAttemptAt).not.toBeNull();
    expect(after.consecutiveFailures).toBe(1);
  });
});

describe("syncCursor — Graph refuses a token that refreshed fine", () => {
  it("moves the CONNECTION to NEEDS_RECONNECT on a live 401, not just the cursor", async () => {
    const prisma = fakePrisma([row()]);
    const client = {
      getPage: vi.fn(async () => {
        throw new GraphRequestError({
          statusCode: 401,
          code: "InvalidAuthenticationToken",
          message: "Access token has expired or is not yet valid.",
        });
      }),
    };
    const res = await syncCursor(deps(prisma, { client: client as never }), due());

    expect(res.completed).toBe(false);
    expect(prisma.__first().state).toBe("BACKOFF");
    // The cursor keeps its delta link (a reconnect must not force a full
    // re-download), and the row the dashboard reads is told.
    expect(prisma.__first().deltaLink).toBe(DELTA);
    expect(markNeedsReconnectMock).toHaveBeenCalledTimes(1);
    expect(markNeedsReconnectMock).toHaveBeenCalledWith(prisma, USER, expect.any(String));
  });

  it("does the same on a 403", async () => {
    const prisma = fakePrisma([row()]);
    const client = {
      getPage: vi.fn(async () => {
        throw new GraphRequestError({ statusCode: 403, code: "Forbidden", message: "nope" });
      }),
    };
    await syncCursor(deps(prisma, { client: client as never }), due());
    expect(markNeedsReconnectMock).toHaveBeenCalledTimes(1);
  });

  it("leaves the connection alone on a throttle — 429 is not an auth verdict", async () => {
    const prisma = fakePrisma([row()]);
    const client = {
      getPage: vi.fn(async () => {
        throw new GraphRequestError({
          statusCode: 429,
          code: "TooManyRequests",
          message: "slow down",
          retryAfterHeader: "120",
        });
      }),
    };
    await syncCursor(deps(prisma, { client: client as never }), due());
    expect(prisma.__first().state).toBe("BACKOFF");
    expect(markNeedsReconnectMock).not.toHaveBeenCalled();
  });
});

describe("syncCursor — the box could not produce a token", () => {
  it("records a dead grant as AUTH and leaves the row to the auth service", async () => {
    getAccessTokenMock.mockRejectedValue(new M365NotConnectedError("NEEDS_RECONNECT"));
    const prisma = fakePrisma([row()]);
    const res = await syncCursor(deps(prisma), due());

    expect(res.error).toMatch(/reconnected/);
    expect(prisma.__first().state).toBe("BACKOFF");
    expect(prisma.__first().deltaLink).toBe(DELTA);
    // The auth service moved the connection before it threw; doing it again
    // here would double the audit row.
    expect(markNeedsReconnectMock).not.toHaveBeenCalled();
  });

  it("does NOT dress a non-auth failure up as a 401 — the real error survives", async () => {
    getAccessTokenMock.mockRejectedValue(new Error("database is down"));
    const prisma = fakePrisma([row()]);
    const res = await syncCursor(deps(prisma), due());

    expect(res.error).toBe("database is down");
    // Retryable, so the cursor waits rather than dying — and nobody is told to
    // reconnect a grant that is fine.
    expect(prisma.__first().state).toBe("BACKOFF");
    expect(prisma.__first().lastError ?? "").not.toMatch(/InvalidAuthenticationToken/);
    expect(markNeedsReconnectMock).not.toHaveBeenCalled();
  });
});
