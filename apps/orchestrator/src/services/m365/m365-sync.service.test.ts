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

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  MAX_PAGES_PER_TICK,
  discoverResources,
  grantCoversNoWorkload,
  runSyncTick,
  syncCursor,
  type M365SyncDeps,
} from "./m365-sync.service.js";
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
  resumeLink: string | null;
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
    resumeLink: null,
    state: "SYNCING",
    consecutiveFailures: 0,
    nextAttemptAt: null,
    lastSyncedAt: null,
    lastError: null,
    ...over,
  };
}

function fakePrisma(seed: Row[], connected: string[] = [USER]) {
  let rows = seed.map((r) => ({ ...r }));
  return {
    __first: () => rows[0],
    __rows: () => rows,
    /** What a disconnect does to the person's cursors (WARP-3059). */
    __purge: (userId: string) => {
      rows = rows.filter((r) => r.userId !== userId);
    },
    m365Connection: {
      findMany: vi.fn(async () => connected.map((userId) => ({ userId }))),
    },
    m365DeltaCursor: {
      findMany: vi.fn(
        async ({ where, take }: { where?: { id?: string; userId?: { in: string[] } }; take?: number } = {}) =>
          rows
            .filter((r) => !where?.id || r.id === where.id)
            .filter((r) => !where?.userId?.in || where.userId.in.includes(r.userId))
            .slice(0, take ?? rows.length)
            .map((r) => ({ ...r })),
      ),
      // Throws on a missing row, as Prisma does (P2025).
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const i = rows.findIndex((r) => r.id === where.id);
        if (i < 0) throw new Error("not found");
        rows[i] = { ...rows[i], ...data };
        return { ...rows[i] };
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const i = rows.findIndex((r) => r.id === where.id);
        if (i < 0) return { count: 0 };
        rows[i] = { ...rows[i], ...data };
        return { count: 1 };
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
    resumeLink: null,
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

// --- WARP-3059: an enumeration bigger than one tick -------------------------

describe("syncCursor — an enumeration bigger than one tick's page budget (WARP-3059)", () => {
  const TOTAL = MAX_PAGES_PER_TICK + 50;

  /** Graph, paginated: page n links to n+1, and the last page carries the deltaLink. */
  function pagedClient(fail?: (n: number) => Error | null) {
    const fetched: string[] = [];
    const getPage = vi.fn(async (url: string) => {
      fetched.push(url);
      const n = Number(/p=(\d+)/.exec(url)![1]);
      const err = fail?.(n);
      if (err) throw err;
      return {
        items: [{ id: `m${n}` }],
        links:
          n < TOTAL
            ? { nextLink: `https://graph.microsoft.com/v1.0/me/messages/delta?p=${n + 1}`, deltaLink: null }
            : { nextLink: null, deltaLink: `${DELTA}-after-${n}` },
        raw: {},
      } as unknown as GraphPage;
    });
    return { fetched, client: { getPage } as unknown as M365SyncDeps["client"] };
  }
  const first = () => "https://graph.microsoft.com/v1.0/me/messages/delta?p=1";

  it("checkpoints at the budget and finishes on the next tick, fetching no page twice", async () => {
    // Before WARP-3059 the first tick persisted nothing and the second started
    // again at page 1 — a folder over the budget re-read the same pages every
    // five minutes and never produced a deltaLink.
    const prisma = fakePrisma([row({ deltaLink: null })]);
    const { fetched, client } = pagedClient();

    const tick1 = await syncCursor(deps(prisma, { client, initialUrlFor: first }), due({ deltaLink: null }));
    expect(tick1).toMatchObject({ completed: false, checkpointed: true, pages: MAX_PAGES_PER_TICK });
    expect(prisma.__first()).toMatchObject({
      deltaLink: null, // the cursor has NOT advanced
      resumeLink: `https://graph.microsoft.com/v1.0/me/messages/delta?p=${MAX_PAGES_PER_TICK + 1}`,
      state: "IDLE",
    });

    const saved = prisma.__first()!;
    const tick2 = await syncCursor(
      deps(prisma, { client, initialUrlFor: first }),
      due({ deltaLink: saved.deltaLink, resumeLink: saved.resumeLink }),
    );
    expect(tick2).toMatchObject({ completed: true, pages: TOTAL - MAX_PAGES_PER_TICK });
    expect(prisma.__first()).toMatchObject({ deltaLink: `${DELTA}-after-${TOTAL}`, resumeLink: null });

    expect(fetched).toHaveLength(TOTAL);
    expect(new Set(fetched).size).toBe(TOTAL);
  });

  it("resumes from the checkpoint, not from the start, after a failure past it", async () => {
    const prisma = fakePrisma([row({ deltaLink: null })]);
    const flaky = pagedClient((n) =>
      n === MAX_PAGES_PER_TICK + 5
        ? new GraphRequestError({ statusCode: 503, code: "serviceNotAvailable", message: "throttled" })
        : null,
    );

    await syncCursor(deps(prisma, { client: flaky.client, initialUrlFor: first }), due({ deltaLink: null }));
    const checkpoint = prisma.__first()!.resumeLink;
    await syncCursor(
      deps(prisma, { client: flaky.client, initialUrlFor: first }),
      due({ deltaLink: null, resumeLink: checkpoint }),
    );

    // The failure kept the last checkpoint — pages before it were handled —
    // and did not throw the run back to page 1.
    expect(prisma.__first()).toMatchObject({ resumeLink: checkpoint, state: "BACKOFF", deltaLink: null });
  });

  it("does not checkpoint a run that was handed neither link", async () => {
    // A page with no nextLink and no deltaLink is Graph misbehaving, not a
    // position to resume from.
    const prisma = fakePrisma([row({ deltaLink: null })]);
    const client = {
      getPage: vi.fn(async () => ({ items: [], links: { nextLink: null, deltaLink: null }, raw: {} })),
    } as unknown as M365SyncDeps["client"];
    const res = await syncCursor(deps(prisma, { client, initialUrlFor: first }), due({ deltaLink: null }));
    expect(res).toMatchObject({ completed: false, checkpointed: false });
    expect(prisma.__first()!.resumeLink).toBeNull();
  });
});

// --- WARP-3059: discovery follows the grant --------------------------------

describe("discoverResources — only what the grant covers (WARP-3059)", () => {
  function discoveryPrisma(grantedScopes: string | null) {
    const upserts: Array<{ workload: string; resourceId: string }> = [];
    return {
      upserts,
      m365Connection: { findUnique: vi.fn(async () => ({ grantedScopes })) },
      m365DeltaCursor: {
        upsert: vi.fn(async ({ where }: any) => {
          upserts.push({
            workload: where.userId_workload_resourceId.workload,
            resourceId: where.userId_workload_resourceId.resourceId,
          });
          return {};
        }),
      },
    };
  }
  /** Every folder listing is empty; the calls themselves are what we watch. */
  const emptyListing = () =>
    ({
      getPage: vi.fn(async () => ({ items: [], links: { nextLink: null, deltaLink: null }, raw: {} })),
    }) as unknown as M365SyncDeps["client"];

  it("does not attempt To Do without a Tasks grant, and does not report it as a fault", async () => {
    // What the connector actually requests (M365_SCOPES), as Microsoft returns it.
    const prisma = discoveryPrisma(
      "offline_access User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite Contacts.ReadWrite Files.ReadWrite.All",
    );
    const client = emptyListing();

    const found = await discoverResources(
      { prisma: prisma as never, client, entra: {} as never, initialUrlFor: () => null, now: () => NOW },
      USER,
    );

    expect(found.notGranted).toEqual(["todo"]);
    expect(found.skipped).toEqual([]); // nothing index.ts would log as a fault
    const urls = vi.mocked(client.getPage).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/todo/"))).toBe(false);
    // The singletons still register.
    expect(prisma.upserts.map((u) => u.workload).sort()).toEqual(["calendar", "files"]);
  });

  it("attempts nothing for a grant it cannot read", async () => {
    // No recorded grant is not a grant: guessing "probably everything" would
    // walk workloads nobody consented to.
    const prisma = discoveryPrisma(null);
    const client = emptyListing();
    const found = await discoverResources(
      { prisma: prisma as never, client, entra: {} as never, initialUrlFor: () => null, now: () => NOW },
      USER,
    );
    expect(found.notGranted).toEqual(["mail", "calendar", "contacts", "files", "todo"]);
    expect(client.getPage).not.toHaveBeenCalled();
  });
});

// --- #2347 review: a disconnect during a tick -------------------------------

describe("runSyncTick — a person disconnects while the tick holds their cursor (#2347 review)", () => {
  it("finishes the tick, and syncs everyone else's cursors", async () => {
    // disconnect() deletes the person's cursors while the tick may be running
    // one. The run's closing write used to be an `update` by id, which throws
    // on a missing row: syncCursor threw, and every cursor after it in the
    // tick, other people's included, waited for the next one.
    const OTHER = "user-2";
    const prisma = fakePrisma(
      [row({ id: "c1", userId: USER, state: "IDLE" }), row({ id: "c2", userId: OTHER, state: "IDLE" })],
      [USER, OTHER],
    );
    const tick = await runSyncTick(
      deps(prisma, {
        handlePage: async (cursor) => {
          if (cursor.userId === USER) prisma.__purge(USER); // Disconnect, mid-run
        },
      }),
    );

    expect(tick.cursorsClaimed).toBe(2);
    expect(prisma.__rows()).toEqual([
      expect.objectContaining({ id: "c2", userId: OTHER, deltaLink: `${DELTA}-next`, state: "IDLE" }),
    ]);
  });
});

// --- #2347 review: a grant that covers nothing ------------------------------

describe("a grant that covers no workload says so (#2347 review)", () => {
  function prismaWithGrant(grantedScopes: string | null) {
    return {
      m365Connection: { findUnique: vi.fn(async () => ({ grantedScopes })) },
      m365DeltaCursor: { upsert: vi.fn(async () => ({})) },
    };
  }
  const discover = (grantedScopes: string | null) =>
    discoverResources(
      {
        prisma: prismaWithGrant(grantedScopes) as never,
        client: {
          getPage: vi.fn(async () => ({ items: [], links: { nextLink: null, deltaLink: null }, raw: {} })),
        } as unknown as M365SyncDeps["client"],
        entra: {} as never,
        initialUrlFor: () => null,
        now: () => NOW,
      },
      USER,
    );

  it.each([
    ["no recorded grant", null],
    ["an empty grant", ""],
    ["a grant naming no workload", "offline_access User.Read openid profile"],
  ])("is true for %s", async (_label, scopes) => {
    expect(grantCoversNoWorkload(await discover(scopes))).toBe(true);
  });

  it("is false for the scopes the connector requests, where only To Do is not granted", async () => {
    const found = await discover(
      "offline_access User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite Contacts.ReadWrite Files.ReadWrite.All",
    );
    expect(found.notGranted).toEqual(["todo"]);
    expect(grantCoversNoWorkload(found)).toBe(false);
  });

  it("is false when the grant covers a workload discovery could not list — that is logged as skipped", async () => {
    const found = await discoverResources(
      {
        prisma: prismaWithGrant("Mail.Read") as never,
        client: {
          getPage: vi.fn(async () => {
            throw new GraphRequestError({ statusCode: 404, code: "MailboxNotEnabledForRESTAPI", message: "no mailbox" });
          }),
        } as unknown as M365SyncDeps["client"],
        entra: {} as never,
        initialUrlFor: () => null,
        now: () => NOW,
      },
      USER,
    );
    expect(found).toMatchObject({ registered: 0, skipped: ["mail"] });
    expect(grantCoversNoWorkload(found)).toBe(false);
  });

  it("is false when the token could not be produced — that is reported as skipped, not as the grant", async () => {
    getAccessTokenMock.mockRejectedValue(new M365NotConnectedError("NEEDS_RECONNECT"));
    expect(grantCoversNoWorkload(await discover(null))).toBe(false);
  });

  it("the scheduler logs it: index.ts is the only caller, and the unit lane cannot run it", () => {
    // `notGranted` is never logged on its own (for To Do it is the expected
    // outcome), so without this line a box whose grant covers nothing syncs
    // nothing and nothing says so. A source pin, as brain-pass-trigger-wiring
    // does: index.ts opens sockets and connects to Postgres on import.
    const index = readFileSync(resolve(__dirname, "../../index.ts"), "utf8");
    const block = index.slice(index.indexOf("discoverResources(m365Deps, userId)"), index.indexOf("runSyncTick(m365Deps)"));
    expect(block.length).toBeGreaterThan(0);
    expect(block).toMatch(/if \(grantCoversNoWorkload\(found\)\)\s*\{\s*logger\.warn\(/);
  });
});
