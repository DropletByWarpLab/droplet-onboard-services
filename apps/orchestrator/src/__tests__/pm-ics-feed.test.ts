/**
 * WARP-3533 — the work-item ICS feeds: "my work" and one project, behind the
 * existing CalendarFeedToken mechanism, mounted AHEAD of every gate.
 *
 * Pinned over HTTP, through the real public calendar router, the real feed
 * token service and the real PM feed service, over an in-memory stand-in for
 * the slice of PrismaClient they use:
 *   - what is in a feed: one all-day VEVENT per dated item, the UTC calendar
 *     day, `KEY-123 name`, a /projects?p=&item= link on a host-validated
 *     origin, STATUS:COMPLETED / CANCELLED, nothing archived, nothing undated;
 *   - identity: PM assignees are User.id and the calendar's userId is a
 *     username — a username that equals someone else's id must not borrow
 *     their work;
 *   - a link reads ONLY its own feed (calendar / my work / project A / project
 *     B), and rotating or revoking one feed leaves the others alone;
 *   - the route bypasses every gate, so it re-checks them itself: the
 *     `projects` module switch, the guest tier floor, the person's current
 *     directory status, expiry, and the username in the path;
 *   - a rate limit; and the token never reaches an access-log line.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const h = vi.hoisted(() => ({
  recordActivity: vi.fn(async (..._a: unknown[]) => null),
}));

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    NEXTCLOUD_URL: "http://nextcloud.test",
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    corsAllowedOrigins: ["https://box.test"],
  },
}));
vi.mock("../services/caldav.client.js", () => ({ fetchIcsFeed: vi.fn(), syncCalendarSource: vi.fn() }));
vi.mock("../services/encryption.service.js", () => ({
  encryptSecret: (s: string) => `enc:${s}`,
  decryptSecret: (s: string) => s,
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: (...a: unknown[]) => h.recordActivity(...a),
}));
// supertest's Host (127.0.0.1) is not an allowlisted origin, so trusted-origin
// warns on every request; silence the module loggers (the access log is a
// separate pino-http instance, asserted below).
vi.mock("../lib/logger.js", () => {
  const stub: Record<string | symbol, unknown> = new Proxy(
    {},
    { get: (_t, key) => (key === "then" ? undefined : key === "child" ? () => stub : () => undefined) },
  );
  return { createLogger: () => stub, levelFromEnv: () => "info" };
});

import { createCalendarPublicRouter } from "../routes/calendar.js";
import { createRequestLogger } from "../middleware/request-logger.js";
import { parseIcs } from "../services/ics.js";
import {
  getFeedTokenStatus,
  revokeFeedTokens,
  rotateFeedToken,
  type FeedTarget,
} from "../services/calendar-feed-token.service.js";

type Row = Record<string, unknown>;
interface TokenRow {
  id: string;
  userId: string;
  secretHash: string;
  state: "active" | "rotated" | "revoked" | "expired";
  scope: "calendar" | "pm_my_work" | "pm_project";
  projectId: string | null;
  createdAt: Date;
  expiresAt: Date;
  endedAt: Date | null;
}
interface UserRow {
  id: string;
  username: string;
  role: string;
  directoryStatus: "ACTIVE" | "DEACTIVATED";
}
interface ProjectRow {
  id: string;
  identifier: string;
  name: string;
  isArchived: boolean;
}
interface ItemRow {
  id: string;
  projectId: string;
  sequenceId: number;
  name: string;
  dueDate: Date | null;
  updatedAt: Date;
  isCompleted: boolean;
  isArchived: boolean;
  priority: string;
  state: { name: string; group: string } | null;
  assignees: string[];
}

const DAY = 86_400_000;
/** UTC midnight, `days` from today: how WS-1 stores a due date. */
const dueIn = (days: number): Date => {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()) + days * DAY);
};

function cond(value: unknown, c: unknown): boolean {
  if (c === null) return value === null || value === undefined;
  if (c instanceof Date) return value instanceof Date && value.getTime() === c.getTime();
  if (typeof c === "object") {
    const o = c as Record<string, unknown>;
    if ("in" in o) return (o.in as unknown[]).includes(value);
    if (value === null || value === undefined) return false;
    if ("gt" in o && !((value as Date) > (o.gt as Date))) return false;
    if ("gte" in o && !((value as Date) >= (o.gte as Date))) return false;
    if ("lte" in o && !((value as Date) <= (o.lte as Date))) return false;
    if ("lt" in o && !((value as Date) < (o.lt as Date))) return false;
    return true;
  }
  return value === c;
}
const matchesFlat = (row: Row, where: Row = {}): boolean => Object.entries(where).every(([k, c]) => cond(row[k], c));

function makeDb(opts: { projectsEnabled?: boolean } = {}) {
  const users = new Map<string, UserRow>(
    [
      // id and username deliberately cross: u-alice's name is "alice"; the account
      // whose ID is "alice" is called "mallory". A feed for alice must not read
      // what is assigned to the id "alice".
      ["u-alice", "alice", "family"],
      ["alice", "mallory", "family"],
      ["u-bob", "bob", "family"],
      ["u-guest", "gus", "guest"],
      ["u-admin", "ada", "admin"],
    ].map(([id, username, role]) => [id, { id, username, role, directoryStatus: "ACTIVE" }]),
  );
  const projects: ProjectRow[] = [
    { id: "p-abc", identifier: "ABC", name: "Alpha build", isArchived: false },
    { id: "p-xyz", identifier: "XYZ", name: "Xylophone", isArchived: false },
    { id: "p-old", identifier: "OLD", name: "Old stuff", isArchived: true },
  ];
  const items: ItemRow[] = [];
  const tokens: TokenRow[] = [];
  let n = 0;
  let seq = 0;
  const projectOf = (id: string) => projects.find((p) => p.id === id)!;

  const db = {
    users,
    projects,
    items,
    tokens,
    moduleEnabled: opts.projectsEnabled ?? true,
    moduleSetting: {
      findMany: vi.fn(async () => [{ moduleId: "projects", enabled: db.moduleEnabled }]),
    },
    pmProject: {
      findFirst: vi.fn(async ({ where }: { where: Row }) => {
        const p = projects.find((x) => matchesFlat(x as unknown as Row, where));
        return p ? { id: p.id, name: p.name, identifier: p.identifier } : null;
      }),
    },
    pmWorkItem: {
      findMany: vi.fn(
        async ({ where, take }: { where: Row & { project?: Row; assignees?: { some: { userId: string } } }; take?: number }) => {
          const rows = items
            .filter((it) => {
              if (where.isArchived !== undefined && it.isArchived !== where.isArchived) return false;
              if (where.projectId !== undefined && it.projectId !== where.projectId) return false;
              if (where.dueDate !== undefined && !cond(it.dueDate, where.dueDate)) return false;
              if (where.project && !matchesFlat(projectOf(it.projectId) as unknown as Row, where.project)) return false;
              if (where.assignees && !it.assignees.includes(where.assignees.some.userId)) return false;
              return true;
            })
            .sort((a, b) => +a.dueDate! - +b.dueDate! || a.id.localeCompare(b.id));
          return rows.slice(0, take).map((it) => {
            const p = projectOf(it.projectId);
            return { ...it, project: { id: p.id, identifier: p.identifier, name: p.name } };
          });
        },
      ),
    },
    calendarEvent: { findMany: vi.fn(async () => []) },
    calendarFeedToken: {
      findFirst: vi.fn(async ({ where }: { where: Row }) =>
        tokens
          .filter((r) => matchesFlat(r as unknown as Row, where))
          .sort((a, b) => +b.createdAt - +a.createdAt)[0] ?? null,
      ),
      findMany: vi.fn(async ({ where }: { where: Row }) =>
        tokens.filter((r) => matchesFlat(r as unknown as Row, where)).sort((a, b) => +b.createdAt - +a.createdAt),
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const r = tokens.find((t) => t.id === where.id);
        if (!r) return null;
        const u = users.get(r.userId);
        if (!u) return null;
        return { ...r, user: { username: u.username, directoryStatus: u.directoryStatus, role: u.role } };
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Partial<TokenRow> }) => {
        let count = 0;
        for (const r of tokens) if (matchesFlat(r as unknown as Row, where)) (Object.assign(r, data), count++);
        return { count };
      }),
      create: vi.fn(async ({ data }: { data: Pick<TokenRow, "userId" | "secretHash" | "expiresAt"> & Partial<TokenRow> }) => {
        const r: TokenRow = {
          id: `tok-${++n}`,
          state: "active",
          scope: "calendar",
          projectId: null,
          createdAt: new Date(),
          endedAt: null,
          ...data,
        };
        tokens.push(r);
        return r;
      }),
    },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  };

  const addItem = (over: Partial<ItemRow> & Pick<ItemRow, "projectId" | "name">): ItemRow => {
    const it: ItemRow = {
      id: `it-${++seq}`,
      sequenceId: seq,
      dueDate: dueIn(5),
      updatedAt: new Date("2026-10-01T10:00:00Z"),
      isCompleted: false,
      isArchived: false,
      priority: "medium",
      state: { name: "Todo", group: "unstarted" },
      assignees: [],
      ...over,
    };
    items.push(it);
    return it;
  };
  return Object.assign(db, { addItem });
}
type Db = ReturnType<typeof makeDb>;

function appFor(db: Db) {
  const app = express();
  app.set("trust proxy", 1);
  app.use("/api", createCalendarPublicRouter(db as never));
  return app;
}

/** Mint a link for `userId` the way Settings -> Developer does, and return its URL parts. */
async function link(db: Db, userId: string, target: FeedTarget): Promise<{ path: string; token: string }> {
  const minted = await rotateFeedToken(db as never, userId, target);
  const user = db.users.get(userId)!.username;
  const path =
    target.scope === "calendar"
      ? `/api/calendar/publish/${encodeURIComponent(user)}.ics`
      : target.scope === "pm_my_work"
        ? `/api/calendar/publish/${encodeURIComponent(user)}/my-work.ics`
        : `/api/calendar/publish/${encodeURIComponent(user)}/projects/${target.projectId}.ics`;
  return { path, token: minted.token };
}

const fetchFeed = (db: Db, l: { path: string; token: string }, ip = "10.1.1.1") =>
  request(appFor(db)).get(l.path).query({ token: l.token }).set("X-Forwarded-For", ip);

/** Parse a feed body into events. */
const events = (text: string) => parseIcs(text);

let ipSeq = 0;
const freshIp = () => `10.9.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;

beforeEach(() => h.recordActivity.mockClear());

describe("WARP-3533 — the 'my work' feed", () => {
  it("is an all-day VEVENT per dated item assigned to the person, and nothing else", async () => {
    const db = makeDb();
    const mine = db.addItem({ projectId: "p-abc", name: "Write the spec", assignees: ["u-alice"], dueDate: dueIn(3) });
    db.addItem({ projectId: "p-abc", name: "Someone else's", assignees: ["u-bob"] });
    db.addItem({ projectId: "p-abc", name: "Mine but undated", assignees: ["u-alice"], dueDate: null });
    db.addItem({ projectId: "p-abc", name: "Mine but archived", assignees: ["u-alice"], isArchived: true });
    db.addItem({ projectId: "p-old", name: "Mine in an archived project", assignees: ["u-alice"] });
    db.addItem({ projectId: "p-abc", name: "Too far back", assignees: ["u-alice"], dueDate: dueIn(-31) });
    db.addItem({ projectId: "p-abc", name: "Too far ahead", assignees: ["u-alice"], dueDate: dueIn(366) });
    const l = await link(db, "u-alice", { scope: "pm_my_work" });

    const res = await fetchFeed(db, l);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/calendar");
    expect(res.headers["content-disposition"]).toBe('inline; filename="droplet-alice-my-work.ics"');
    expect(res.text).toContain("X-WR-CALNAME:Droplet — My work");

    const evs = events(res.text);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({
      uid: `pm-${mine.id}@droplet`,
      summary: `ABC-${mine.sequenceId} Write the spec`,
      allDay: true,
    });
    expect(evs[0].startsAt.toISOString()).toBe(dueIn(3).toISOString());
    expect(evs[0].endsAt.toISOString()).toBe(dueIn(4).toISOString());
    expect(res.text).toContain(`DTSTART;VALUE=DATE:`);
    expect(res.text).not.toContain("STATUS:"); // open work carries none
  });

  it("links each event to the item on a host-validated origin: /projects?p=<identifier>&item=<KEY-123>", async () => {
    const db = makeDb();
    const it1 = db.addItem({ projectId: "p-abc", name: "Linked", assignees: ["u-alice"] });
    const l = await link(db, "u-alice", { scope: "pm_my_work" });
    const res = await fetchFeed(db, l);
    expect(res.text).toContain(`URL:https://box.test/projects?p=ABC&item=ABC-${it1.sequenceId}`);

    // A forged Host / X-Forwarded-Host is never embedded.
    const forged = await request(appFor(db))
      .get(l.path)
      .query({ token: l.token })
      .set("Host", "evil.example")
      .set("X-Forwarded-Host", "evil.example")
      .set("X-Forwarded-For", freshIp());
    expect(forged.status).toBe(200);
    expect(forged.text).not.toContain("evil.example");
    expect(forged.text).toContain("URL:https://box.test/projects?");
  });

  it("STATUS:COMPLETED when done, STATUS:CANCELLED when cancelled, none for open work", async () => {
    const db = makeDb();
    db.addItem({ projectId: "p-abc", name: "Open", assignees: ["u-alice"] });
    db.addItem({ projectId: "p-abc", name: "Done", assignees: ["u-alice"], isCompleted: true, state: { name: "Done", group: "completed" } });
    db.addItem({ projectId: "p-abc", name: "Dropped", assignees: ["u-alice"], state: { name: "Cancelled", group: "cancelled" } });
    // `isCompleted` is the canonical signal: a completed-group state alone is not "done".
    db.addItem({ projectId: "p-abc", name: "Odd", assignees: ["u-alice"], state: { name: "Done", group: "completed" } });
    const l = await link(db, "u-alice", { scope: "pm_my_work" });
    const evs = events((await fetchFeed(db, l)).text);
    const byName = (s: string) => evs.find((e) => e.summary.endsWith(s))!;
    expect(byName("Open").status).toBeUndefined();
    expect(byName("Done").status).toBe("COMPLETED");
    expect(byName("Dropped").status).toBe("CANCELLED");
    expect(byName("Odd").status).toBeUndefined();
  });

  it("describes the item in plain text and escapes it", async () => {
    const db = makeDb();
    db.addItem({ projectId: "p-abc", name: "Comma, semi; and\\ more", assignees: ["u-alice"], priority: "urgent" });
    const l = await link(db, "u-alice", { scope: "pm_my_work" });
    const res = await fetchFeed(db, l);
    const [ev] = events(res.text);
    expect(ev.summary).toMatch(/Comma, semi; and\\ more$/);
    expect(ev.description).toBe("Project: Alpha build\nState: Todo\nPriority: urgent");
  });

  it("is the UTC calendar day, whatever time of day is stored", async () => {
    const db = makeDb();
    db.addItem({ projectId: "p-abc", name: "Late stamp", assignees: ["u-alice"], dueDate: new Date(dueIn(7).getTime() + 23 * 3_600_000 + 59 * 60_000) });
    const l = await link(db, "u-alice", { scope: "pm_my_work" });
    const [ev] = events((await fetchFeed(db, l)).text);
    expect(ev.startsAt.toISOString()).toBe(dueIn(7).toISOString());
    expect(ev.endsAt.toISOString()).toBe(dueIn(8).toISOString());
  });

  it("maps username to User.id correctly: a name that equals another account's id borrows nothing", async () => {
    const db = makeDb();
    // Assigned to the account whose ID is "alice" (its username is "mallory").
    db.addItem({ projectId: "p-abc", name: "Mallory's secret", assignees: ["alice"] });
    const aliceOwn = db.addItem({ projectId: "p-abc", name: "Alice's own", assignees: ["u-alice"] });

    const aliceFeed = await fetchFeed(db, await link(db, "u-alice", { scope: "pm_my_work" }));
    const aliceEvents = events(aliceFeed.text);
    expect(aliceEvents.map((e) => e.uid)).toEqual([`pm-${aliceOwn.id}@droplet`]);
    expect(aliceFeed.text).not.toContain("Mallory");

    const malloryFeed = await fetchFeed(db, await link(db, "alice", { scope: "pm_my_work" }), freshIp());
    expect(events(malloryFeed.text).map((e) => e.summary)).toEqual([expect.stringMatching(/Mallory's secret$/)]);
    expect(malloryFeed.text).not.toContain("Alice's own");
  });
});

describe("WARP-3533 — the project feed", () => {
  it("carries every dated item of THAT project and no other", async () => {
    const db = makeDb();
    db.addItem({ projectId: "p-abc", name: "A one", assignees: ["u-bob"] });
    db.addItem({ projectId: "p-abc", name: "A two", assignees: [] });
    db.addItem({ projectId: "p-abc", name: "A undated", dueDate: null });
    db.addItem({ projectId: "p-abc", name: "A archived", isArchived: true });
    db.addItem({ projectId: "p-xyz", name: "X one" });
    const l = await link(db, "u-alice", { scope: "pm_project", projectId: "p-abc" });
    const res = await fetchFeed(db, l);
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toBe('inline; filename="droplet-ABC.ics"');
    expect(res.text).toContain("X-WR-CALNAME:Droplet — Alpha build");
    expect(events(res.text).map((e) => e.summary.replace(/^ABC-\d+ /, "")).sort()).toEqual(["A one", "A two"]);
  });

  it("an archived or missing project is a 404 project_not_found", async () => {
    const db = makeDb();
    const archived = await link(db, "u-alice", { scope: "pm_project", projectId: "p-old" });
    expect((await fetchFeed(db, archived)).body).toEqual({ error: "project_not_found" });
    const gone = await link(db, "u-alice", { scope: "pm_project", projectId: "p-nope" });
    expect((await fetchFeed(db, gone, freshIp())).status).toBe(404);
  });

  it("stops at the cap: at most 500 events, in due-date order", async () => {
    const db = makeDb();
    for (let i = 0; i < 520; i++) db.addItem({ projectId: "p-abc", name: `bulk ${i}`, dueDate: dueIn(1 + (i % 300)) });
    const l = await link(db, "u-alice", { scope: "pm_project", projectId: "p-abc" });
    const evs = events((await fetchFeed(db, l)).text);
    expect(evs).toHaveLength(500);
    const days = evs.map((e) => e.startsAt.getTime());
    expect([...days].sort((a, b) => a - b)).toEqual(days);
  });
});

describe("WARP-3533 — a link reads only its own feed", () => {
  it("each link opens its own feed and every other feed's path is 403", async () => {
    const db = makeDb();
    db.addItem({ projectId: "p-abc", name: "Shared", assignees: ["u-alice"] });
    const calendar = await link(db, "u-alice", { scope: "calendar" });
    const mine = await link(db, "u-alice", { scope: "pm_my_work" });
    const projA = await link(db, "u-alice", { scope: "pm_project", projectId: "p-abc" });
    const projX = await link(db, "u-alice", { scope: "pm_project", projectId: "p-xyz" });

    for (const own of [calendar, mine, projA, projX]) expect((await fetchFeed(db, own, freshIp())).status).toBe(200);

    const paths = { calendar: calendar.path, mine: mine.path, projA: projA.path, projX: projX.path };
    const tokens = { calendar: calendar.token, mine: mine.token, projA: projA.token, projX: projX.token };
    for (const [tName, token] of Object.entries(tokens)) {
      for (const [pName, path] of Object.entries(paths)) {
        if (tName === pName) continue;
        const res = await request(appFor(db)).get(path).query({ token }).set("X-Forwarded-For", freshIp());
        expect(res.status, `${tName} link on ${pName} path`).toBe(403);
        expect(res.body).toEqual({ error: "invalid_token" });
        expect(res.text).not.toContain("Shared");
      }
    }
  });

  it("a link for another PERSON's feed is 403, and so is the right link under the wrong username", async () => {
    const db = makeDb();
    const alice = await link(db, "u-alice", { scope: "pm_my_work" });
    const bob = await link(db, "u-bob", { scope: "pm_my_work" });
    const crossed = await request(appFor(db)).get(bob.path).query({ token: alice.token }).set("X-Forwarded-For", freshIp());
    expect(crossed.status).toBe(403);
    expect(db.pmWorkItem.findMany).not.toHaveBeenCalled();
  });

  it("rotating or revoking one feed leaves every other feed's link alone", async () => {
    const db = makeDb();
    const calendar = await link(db, "u-alice", { scope: "calendar" });
    const mine = await link(db, "u-alice", { scope: "pm_my_work" });
    const projA = await link(db, "u-alice", { scope: "pm_project", projectId: "p-abc" });
    const bobMine = await link(db, "u-bob", { scope: "pm_my_work" });

    // Rotate "my work": the old one dies, the new one lives, nothing else moves.
    const mineNew = await link(db, "u-alice", { scope: "pm_my_work" });
    expect((await fetchFeed(db, mine, freshIp())).status).toBe(403);
    expect((await fetchFeed(db, mineNew, freshIp())).status).toBe(200);
    for (const other of [calendar, projA, bobMine]) expect((await fetchFeed(db, other, freshIp())).status).toBe(200);

    // Re-issue the calendar link: the work feeds keep working.
    await rotateFeedToken(db as never, "u-alice");
    expect((await fetchFeed(db, calendar, freshIp())).status).toBe(403);
    for (const other of [mineNew, projA]) expect((await fetchFeed(db, other, freshIp())).status).toBe(200);

    // Revoke project A only.
    expect(await revokeFeedTokens(db as never, "u-alice", { scope: "pm_project", projectId: "p-abc" })).toBe(1);
    expect((await fetchFeed(db, projA, freshIp())).status).toBe(403);
    expect((await fetchFeed(db, mineNew, freshIp())).status).toBe(200);

    // Status is per feed too.
    expect((await getFeedTokenStatus(db as never, "u-alice", { scope: "pm_my_work" })).state).toBe("active");
    expect((await getFeedTokenStatus(db as never, "u-alice", { scope: "pm_project", projectId: "p-abc" })).state).toBe("none");
    expect((await getFeedTokenStatus(db as never, "u-alice", { scope: "pm_project", projectId: "p-xyz" })).state).toBe("none");
  });

  it("stores only a hash of the secret", async () => {
    const db = makeDb();
    const l = await link(db, "u-alice", { scope: "pm_my_work" });
    expect(JSON.stringify(db.tokens)).not.toContain(l.token.split(".")[1]);
  });
});

describe("WARP-3533 — the gates the route bypasses, re-checked inside it", () => {
  it("the projects module switched off: 404 module_disabled, and no item is read", async () => {
    const db = makeDb({ projectsEnabled: false });
    db.addItem({ projectId: "p-abc", name: "Hidden", assignees: ["u-alice"] });
    const mine = await link(db, "u-alice", { scope: "pm_my_work" });
    const proj = await link(db, "u-alice", { scope: "pm_project", projectId: "p-abc" });
    for (const l of [mine, proj]) {
      const res = await fetchFeed(db, l, freshIp());
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "module_disabled", module: "projects" });
      expect(res.text).not.toContain("Hidden");
    }
    expect(db.pmWorkItem.findMany).not.toHaveBeenCalled();

    // Back on: the same links work again — the switch revoked nothing.
    db.moduleEnabled = true;
    expect((await fetchFeed(db, mine, freshIp())).status).toBe(200);
  });

  it("an unreadable module table fails closed", async () => {
    const db = makeDb();
    const l = await link(db, "u-alice", { scope: "pm_my_work" });
    db.moduleSetting.findMany.mockRejectedValueOnce(new Error("db down"));
    const res = await fetchFeed(db, l);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("module_disabled");
  });

  it("the guest tier floor: a person demoted to guest gets 404, though their link is otherwise valid", async () => {
    const db = makeDb();
    db.addItem({ projectId: "p-abc", name: "Company data", assignees: ["u-alice"] });
    const mine = await link(db, "u-alice", { scope: "pm_my_work" });
    const proj = await link(db, "u-alice", { scope: "pm_project", projectId: "p-abc" });
    db.users.get("u-alice")!.role = "guest"; // demoted AFTER the links were minted
    for (const l of [mine, proj]) {
      const res = await fetchFeed(db, l, freshIp());
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "module_disabled", module: "projects" });
      expect(res.text).not.toContain("Company data");
    }
    // Re-promoted: the role is read now, not frozen into the link.
    db.users.get("u-alice")!.role = "family";
    expect((await fetchFeed(db, mine, freshIp())).status).toBe(200);
  });

  it("owner and admin clear the floor too", async () => {
    const db = makeDb();
    const l = await link(db, "u-admin", { scope: "pm_my_work" });
    expect((await fetchFeed(db, l)).status).toBe(200);
  });

  it("a deactivated person's link is dead, even if the name is reused", async () => {
    const db = makeDb();
    const l = await link(db, "u-alice", { scope: "pm_my_work" });
    db.users.get("u-alice")!.directoryStatus = "DEACTIVATED";
    expect((await fetchFeed(db, l, freshIp())).status).toBe(403);
    db.users.delete("u-alice");
    db.users.set("u-alice2", { id: "u-alice2", username: "alice", role: "family", directoryStatus: "ACTIVE" });
    expect((await fetchFeed(db, l, freshIp())).status).toBe(403);
  });

  it("expiry: an overdue link is refused and stamped expired", async () => {
    const db = makeDb();
    const l = await link(db, "u-alice", { scope: "pm_my_work" });
    db.tokens[0].expiresAt = new Date(Date.now() - 1);
    const res = await fetchFeed(db, l);
    expect(res.status).toBe(403);
    expect(res.text).not.toContain("BEGIN:VCALENDAR");
    expect(db.tokens[0].state).toBe("expired");
  });

  it("no token, two tokens, a forged secret and a half token are all the same 403", async () => {
    const db = makeDb();
    const l = await link(db, "u-alice", { scope: "pm_my_work" });
    const app = appFor(db);
    expect((await request(app).get(l.path).set("X-Forwarded-For", freshIp())).status).toBe(403);
    expect((await request(app).get(`${l.path}?token=${l.token}&token=${l.token}`).set("X-Forwarded-For", freshIp())).status).toBe(403);
    const forged = `${l.token.split(".")[0]}.${"A".repeat(43)}`;
    expect((await request(app).get(l.path).query({ token: forged }).set("X-Forwarded-For", freshIp())).status).toBe(403);
    expect((await request(app).get(l.path).query({ token: "nodot" }).set("X-Forwarded-For", freshIp())).status).toBe(403);
  });
});

describe("WARP-3533 — a hostile name cannot put a line of its own into a colleague's feed", () => {
  // Item, project and state names are free text any member (or any pm:write
  // token) can set, and they land in ANOTHER person's calendar. Every character
  // a strict line reader splits on is tried, in all three places a name appears.
  const NUL = String.fromCharCode(0);
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);
  const NEL = String.fromCharCode(0x85);
  const SEPARATORS = ["\r", "\u000B", "\u000C", NEL, LS, PS, NUL];
  const splitLikePython = (doc: string) => doc.split(new RegExp("\\r\\n|[\\n\\r\\v\\f\\x1c-\\x1e\\x85" + LS + PS + "]"));

  for (const label of ["my work", "a project"]) {
    it(`${label}: every separator in an item, project and state name becomes a space and starts no line`, async () => {
      const db = makeDb();
      for (const ch of SEPARATORS) {
        db.projects.push({ id: `p-h${db.projects.length}`, identifier: "HOS", name: `Proj${ch}BEGIN:VALARM${ch}ACTION:DISPLAY`, isArchived: false });
        const project = db.projects[db.projects.length - 1];
        db.addItem({
          projectId: project.id,
          name: `Standup${ch}ATTENDEE:mailto:evil@x.test${ch}URL:https://evil.test/`,
          assignees: ["u-alice"],
          state: { name: `Todo${ch}X-EVIL:1`, group: "unstarted" },
        });
      }
      const target: FeedTarget =
        label === "my work" ? { scope: "pm_my_work" } : { scope: "pm_project", projectId: db.projects[db.projects.length - 1].id };
      const l = await link(db, "u-alice", target);
      const res = await fetchFeed(db, l, freshIp());
      expect(res.status).toBe(200);

      // none of the characters survives (the CRLF line ends are the only CRs)
      const stripped = res.text.replace(/\r\n/g, "");
      for (const ch of SEPARATORS) expect(stripped.includes(ch), `U+${ch.charCodeAt(0).toString(16)}`).toBe(false);

      // and no reader, however it splits, finds a property or component the person did not get
      const lines = splitLikePython(res.text).filter(Boolean);
      for (const forbidden of ["BEGIN:VALARM", "END:VALARM", "ACTION:", "ATTENDEE", "X-EVIL", "URL:https://evil"]) {
        expect(lines.filter((x) => x.startsWith(forbidden)), forbidden).toEqual([]);
      }
      const eventCount = label === "my work" ? SEPARATORS.length : 1;
      expect(lines.filter((x) => x === "BEGIN:VEVENT")).toHaveLength(eventCount);
      expect(lines.filter((x) => x.startsWith("SUMMARY:"))).toHaveLength(eventCount);
      expect(lines.filter((x) => x.startsWith("URL:"))).toHaveLength(eventCount);

      // the words survive, joined by a space
      expect(res.text).toContain("Standup ATTENDEE:mailto:evil@x.test URL:https://evil.test/");
      expect(res.text).toContain("State: Todo X-EVIL:1");
      expect(events(res.text)).toHaveLength(eventCount);
    });
  }
});

describe("WARP-3533 — the feed routes are rate limited, and never log the link", () => {
  it("the calendar feed and both work feeds share one budget per client, then 429", async () => {
    const db = makeDb();
    const calendar = await link(db, "u-alice", { scope: "calendar" });
    const mine = await link(db, "u-alice", { scope: "pm_my_work" });
    const app = appFor(db);
    const ip = freshIp();
    let ok = 0;
    let limited: request.Response | null = null;
    for (let i = 0; i < 70; i++) {
      const target = i % 2 === 0 ? calendar : mine;
      const res = await request(app).get(target.path).query({ token: target.token }).set("X-Forwarded-For", ip);
      if (res.status === 429) {
        limited = res;
        break;
      }
      expect(res.status).toBe(200);
      ok++;
    }
    expect(ok).toBe(60);
    expect(limited?.body).toEqual({ error: "Too many requests, slow down" });
    expect(limited?.headers["ratelimit"]).toBeDefined();
    // Another client is unaffected.
    expect((await request(app).get(mine.path).query({ token: mine.token }).set("X-Forwarded-For", freshIp())).status).toBe(200);
  });

  it("the access log carries the path and never the ?token= secret", async () => {
    const db = makeDb();
    const l = await link(db, "u-alice", { scope: "pm_project", projectId: "p-abc" });
    const lines: string[] = [];
    const app = express();
    app.set("trust proxy", 1);
    app.use(createRequestLogger({ dest: { write: (s: string) => void lines.push(s) }, level: "info" }));
    app.use("/api", createCalendarPublicRouter(db as never));
    const res = await request(app).get(l.path).query({ token: l.token }).set("X-Forwarded-For", freshIp());
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(lines.length).toBeGreaterThanOrEqual(1));
    const logged = lines.join("\n");
    expect(logged).not.toContain(l.token.split(".")[1]);
    expect(logged).toContain("/projects/p-abc.ics");
  });
});
