/**
 * WARP-3101 — the nine calendar and reminder tools act for the person, on BOTH
 * mcp-server transports.
 *
 * Until WARP-3101 every one of these tools-core handlers keyed
 * `CalendarEvent.userId` / `Reminder.userId` on `ctx.userId` through
 * `ctx.prisma`. Both columns hold a USERNAME (routes/calendar.ts and
 * routes/reminders.ts write `req.user.username`), but `ctx.userId` is
 * `User.username` only on the stdio transport (routes/llm.ts `_meta.userId`);
 * on the HTTP one — the shipped mcp-server container — it is `User.id`
 * (services/mcp-server/src/context.ts: `claims.sub`). So over HTTP:
 *   - create_event / create_reminder / set_timer wrote rows under a User.id
 *     that no dashboard reads;
 *   - list_events / search_calendar_events / list_reminders were always empty;
 *   - update_event / delete_event / complete_reminder refused the person's own
 *     rows as FORBIDDEN;
 *   - and a reminder the assistant set was LOST: the poller stamps `notifiedAt`
 *     first, `sendNotification` then throws NOTIFICATION_RECIPIENT_IS_ID on
 *     the UUID, and the throw is caught as a warning.
 *
 * This file runs the REAL tool handlers, loaded from `@droplet/tools-core` the
 * way the mcp-server loads them, against the REAL calendar and reminders
 * routers, the REAL calendar service and the REAL reminders poller +
 * `sendNotification`, over in-memory tables that evaluate their where-clauses
 * (helpers/fake-table.ts, helpers/fake-notification-log.ts). The two are
 * joined by a `ctx.http.orchestrator` that reaches the routers in-process as
 * `_service:mcp`, carrying the acting-user header mcp-server's
 * `withActingUser` stamps. Only the transports are mocked (MQTT, web push).
 *
 * Fakes return a DISTINCT `User.id` and `User.username`, as production rows do
 * (WARP-2911): a fake that agrees with a UUID key cannot catch one.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Request, type Response as ExpressResponse, type NextFunction } from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { getTool, type ToolContext, type ToolResult } from "@droplet/tools-core";

const { mqttPublish, dispatchToUser, effectiveAccess } = vi.hoisted(() => ({
  mqttPublish: vi.fn((_topic: string, _payload: Record<string, unknown>) => undefined),
  dispatchToUser: vi.fn(async (_prisma: unknown, _username: string, _payload: Record<string, unknown>) => ({
    sent: 0,
    attempted: 0,
    refused: false,
  })),
  effectiveAccess: vi.fn(async (_userId: string): Promise<unknown> => null),
}));

vi.mock("../services/mqtt.service.js", () => ({
  publish: (topic: string, payload: Record<string, unknown>) => mqttPublish(topic, payload),
}));
vi.mock("../services/push-dispatch.service.js", () => ({
  ensurePushDispatch: vi.fn(async () => undefined),
  dispatchToUser: (prisma: unknown, username: string, payload: Record<string, unknown>) =>
    dispatchToUser(prisma, username, payload),
}));
// Axis B (the access role's tool grants) reads the effective-access resolver,
// which needs a bound Prisma + config. Its answer is the fixture here.
vi.mock("../services/effective-access.service.js", () => ({
  resolveEffectiveAccess: (userId: string) => effectiveAccess(userId),
}));
vi.mock("../services/caldav.client.js", () => ({ fetchIcsFeed: vi.fn(), syncCalendarSource: vi.fn() }));
vi.mock("../services/encryption.service.js", () => ({
  encryptSecret: (s: string) => `enc:${s}`,
  decryptSecret: (s: string) => s,
}));

import { createCalendarRouter } from "../routes/calendar.js";
import { createRemindersRouter } from "../routes/reminders.js";
import { startRemindersPoller, stopRemindersPoller } from "../services/reminders-poller.js";
import type { AuthUser } from "../middleware/auth.js";
import { makeFakeTable, type FakeTable, type Row } from "./helpers/fake-table.js";
import { makeFakeNotificationLog, type FakeNotificationLog } from "./helpers/fake-notification-log.js";
import { userDirectory, type DirectoryUser } from "./helpers/user-directory.js";

const MCP: AuthUser = { id: "_service:mcp", username: "_service:mcp", displayName: "MCP Server", role: "service" };

type FakeUser = DirectoryUser & {
  accessRoleId: string | null;
  accessRole: { toolGrants: Array<{ domain: string; level: string }> } | null;
};

function person(over: Partial<FakeUser> & Pick<FakeUser, "id" | "username" | "role">): FakeUser {
  return { nextcloudUsername: null, accessRoleId: null, accessRole: null, ...over };
}

const ALICE = person({ id: "5b0c7a4e-1f2d-4c3b-9a8e-7d6f5e4c3b2a", username: "alice", role: "owner" });
const BOB = person({ id: "1d2c3b4a-5968-4776-8a5b-4c3d2e1f0a9b", username: "bob", role: "owner" });
const KID = person({ id: "0e9d8c7b-6a5f-4e3d-8c2b-1a0f9e8d7c6b", username: "kid", role: "family" });

/** Fixture times derive from the clock, never a hard-coded "future". */
const MIN = 60_000;
const at = (minutesFromNow: number) => new Date(Date.now() + minutesFromNow * MIN);

interface World {
  prisma: PrismaClient;
  events: FakeTable;
  reminders: FakeTable;
  log: FakeNotificationLog;
}

function world(users: FakeUser[] = [ALICE, BOB]): World {
  const events = makeFakeTable(() => ({
    description: null,
    location: null,
    meetingUrl: null,
    allDay: false,
    source: "local",
    sourceId: null,
    externalUid: null,
  }));
  const reminders = makeFakeTable(() => ({
    body: null,
    completedAt: null,
    calendarEventId: null,
    notifiedAt: null,
  }));
  const log = makeFakeNotificationLog(at(-60));
  const prisma = {
    user: userDirectory(users),
    calendarEvent: events.delegate,
    reminder: reminders.delegate,
    notificationLog: log.delegate,
    calendarSource: { findMany: vi.fn(async () => []) },
  };
  return { prisma: prisma as unknown as PrismaClient, events, reminders, log };
}

function appAs(principal: AuthUser, prisma: PrismaClient): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: ExpressResponse, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = principal;
    next();
  });
  app.use("/api", createCalendarRouter(prisma));
  app.use("/api", createRemindersRouter(prisma));
  return app;
}

const browser = (u: FakeUser): AuthUser => ({ id: u.id, username: u.username, displayName: u.username, role: u.role as AuthUser["role"] });

/**
 * `ctx.http.orchestrator` as the mcp-server builds it: every call goes out as
 * `_service:mcp` (the shim above) with `X-Nextcloud-User: <acting user>`, and a
 * per-call header still wins — exactly `withActingUser`'s merge.
 */
function orchestratorClient(app: express.Express, actingUser: string | undefined): ToolContext["http"]["orchestrator"] {
  async function send(
    method: "get" | "post" | "patch" | "delete",
    path: string,
    body: unknown,
    opts?: { headers?: Record<string, string> },
  ): Promise<Response> {
    let req = request(app)[method](path);
    const headers = { ...(actingUser ? { "X-Nextcloud-User": actingUser } : {}), ...(opts?.headers ?? {}) };
    for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
    const res = body === undefined ? await req : await req.send(body as object);
    return new Response(JSON.stringify(res.body), {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  }
  return {
    get: (p, o) => send("get", p, undefined, o),
    post: (p, b, o) => send("post", p, b, o),
    patch: (p, b, o) => send("patch", p, b, o),
    delete: (p, o) => send("delete", p, undefined, o),
  };
}

/**
 * The tool's context. `handlerPrisma` is what the handler would see as
 * `ctx.prisma` — by default the same tables the routers read, so a handler
 * that still bypasses the orchestrator runs against real data and shows the
 * bug rather than a crash.
 */
function toolCtx(w: World, actingUser: string, handlerPrisma: PrismaClient = w.prisma): ToolContext {
  return {
    prisma: handlerPrisma,
    http: { orchestrator: orchestratorClient(appAs(MCP, w.prisma), actingUser) } as unknown as ToolContext["http"],
    matter: {} as ToolContext["matter"],
    userId: actingUser,
    signal: new AbortController().signal,
  } as ToolContext;
}

function run(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const tool = getTool(name);
  if (!tool) throw new Error(`tool ${name} is not registered`);
  return tool.handler(args, ctx);
}

const dataOf = <T,>(r: ToolResult): T => {
  expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
  return (r as { data: T }).data;
};

function seedEvent(w: World, over: Row): Row {
  return w.events.seed({ title: "Event", startsAt: at(60), endsAt: at(90), ...over });
}
function seedReminder(w: World, over: Row): Row {
  return w.reminders.seed({ title: "Reminder", dueAt: at(60), ...over });
}

beforeEach(() => {
  vi.clearAllMocks();
  effectiveAccess.mockImplementation(async () => null);
});

// ── The nine tools, on both transports ───────────────────────────────────────

describe.each([
  ["HTTP transport: the acting user arrives as a User.id", ALICE.id],
  ["stdio transport: the acting user arrives as the username", "alice"],
])("🔴 WARP-3101 %s", (_transport, acting) => {
  it("create_event saves the event on the person's own calendar — the one the dashboard reads", async () => {
    const w = world();
    const r = await run(
      "create_event",
      { title: "Dentist", starts_at: at(60).toISOString(), ends_at: at(120).toISOString() },
      toolCtx(w, acting),
    );
    const data = dataOf<{ id: string; title: string; starts_at: string }>(r);
    expect(data.title).toBe("Dentist");
    expect(w.events.rows.map((e) => [e.title, e.userId])).toEqual([["Dentist", "alice"]]);

    const dash = await request(appAs(browser(ALICE), w.prisma)).get("/api/calendar/events");
    expect(dash.body.events.map((e: { id: string }) => e.id)).toEqual([data.id]);
  });

  it("list_events lists the person's events in the window, and never anyone else's", async () => {
    const w = world();
    seedEvent(w, { id: "ev-a1", userId: "alice", title: "Standup", startsAt: at(60), endsAt: at(75) });
    seedEvent(w, { id: "ev-a2", userId: "alice", title: "Review", startsAt: at(24 * 60), endsAt: at(24 * 60 + 30) });
    seedEvent(w, { id: "ev-b1", userId: "bob", title: "Not yours", startsAt: at(60), endsAt: at(90) });
    seedEvent(w, { id: "ev-a-later", userId: "alice", title: "Too far", startsAt: at(40 * 24 * 60), endsAt: at(40 * 24 * 60 + 30) });

    const r = await run("list_events", {}, toolCtx(w, acting));

    const data = dataOf<{ count: number; events: Array<Record<string, unknown>> }>(r);
    expect(data.events.map((e) => e.id)).toEqual(["ev-a1", "ev-a2"]);
    expect(data.count).toBe(2);
  });

  it("search_calendar_events finds the person's matching events, and never anyone else's", async () => {
    const w = world();
    seedEvent(w, { id: "ev-a1", userId: "alice", title: "Dentist appointment", startsAt: at(60), endsAt: at(90) });
    seedEvent(w, { id: "ev-a2", userId: "alice", title: "Lunch", location: "Next to the DENTIST", startsAt: at(120), endsAt: at(150) });
    seedEvent(w, { id: "ev-a3", userId: "alice", title: "Standup", startsAt: at(180), endsAt: at(190) });
    seedEvent(w, { id: "ev-b1", userId: "bob", title: "Dentist (Bob)", startsAt: at(60), endsAt: at(90) });

    const r = await run("search_calendar_events", { query: "dentist" }, toolCtx(w, acting));

    const data = dataOf<{ count: number; query: string; events: Array<Record<string, unknown>> }>(r);
    expect(data.events.map((e) => e.id)).toEqual(["ev-a1", "ev-a2"]);
    expect(data.query).toBe("dentist");
  });

  it("update_event edits the person's own event", async () => {
    const w = world();
    const ev = seedEvent(w, { userId: "alice", title: "Old" });

    const r = await run("update_event", { id: ev.id, title: "New" }, toolCtx(w, acting));

    expect(dataOf<{ id: string; updated: boolean }>(r)).toEqual({ id: ev.id, updated: true });
    expect(w.events.rows[0]!.title).toBe("New");
  });

  it("update_event refuses someone else's event and leaves it alone", async () => {
    const w = world();
    const ev = seedEvent(w, { userId: "bob", title: "Bob's" });

    const r = await run("update_event", { id: ev.id, title: "hijack" }, toolCtx(w, acting));

    expect(r).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(w.events.rows[0]!.title).toBe("Bob's");
  });

  it("delete_event deletes the person's own event", async () => {
    const w = world();
    const ev = seedEvent(w, { userId: "alice" });

    const r = await run("delete_event", { id: ev.id }, toolCtx(w, acting));

    expect(dataOf<{ id: string; deleted: boolean }>(r)).toEqual({ id: ev.id, deleted: true });
    expect(w.events.rows).toEqual([]);
  });

  it("delete_event refuses someone else's event and leaves it alone", async () => {
    const w = world();
    const ev = seedEvent(w, { userId: "bob" });

    const r = await run("delete_event", { id: ev.id }, toolCtx(w, acting));

    expect(r).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(w.events.rows.map((e) => e.id)).toEqual([ev.id]);
  });

  it("create_reminder saves the reminder under the person's username", async () => {
    const w = world();
    const r = await run("create_reminder", { title: "Call the bank", due_at: at(30).toISOString() }, toolCtx(w, acting));

    const data = dataOf<{ id: string; due_at: string }>(r);
    expect(w.reminders.rows.map((x) => [x.id, x.userId, x.title])).toEqual([[data.id, "alice", "Call the bank"]]);
    expect(data.due_at).toBe((w.reminders.rows[0]!.dueAt as Date).toISOString());
  });

  it("set_timer saves the timer under the person's username", async () => {
    const w = world();
    const r = await run("set_timer", { label: "pasta", minutes: 10 }, toolCtx(w, acting));

    const data = dataOf<{ id: string; title: string; duration_seconds: number }>(r);
    expect(data).toMatchObject({ title: "pasta", duration_seconds: 600 });
    expect(w.reminders.rows.map((x) => [x.id, x.userId, x.title])).toEqual([[data.id, "alice", "pasta"]]);
  });

  it("list_reminders lists the person's active reminders, and never anyone else's", async () => {
    const w = world();
    seedReminder(w, { id: "rm-a1", userId: "alice", title: "Soon", dueAt: at(10) });
    seedReminder(w, { id: "rm-a2", userId: "alice", title: "Later", dueAt: at(100) });
    seedReminder(w, { id: "rm-a-done", userId: "alice", title: "Done", dueAt: at(5), completedAt: at(-1) });
    seedReminder(w, { id: "rm-b1", userId: "bob", title: "Not yours", dueAt: at(10) });

    const r = await run("list_reminders", {}, toolCtx(w, acting));

    const data = dataOf<{ count: number; reminders: Array<Record<string, unknown>> }>(r);
    expect(data.reminders.map((x) => x.id)).toEqual(["rm-a1", "rm-a2"]);
    expect(data.count).toBe(2);
  });

  it("complete_reminder completes the person's own reminder", async () => {
    const w = world();
    const rm = seedReminder(w, { userId: "alice" });

    const r = await run("complete_reminder", { id: rm.id }, toolCtx(w, acting));

    expect(dataOf<{ id: string; completed: boolean }>(r)).toEqual({ id: rm.id, completed: true });
    expect(w.reminders.rows[0]!.completedAt).toBeInstanceOf(Date);
  });

  it("complete_reminder cannot touch someone else's reminder", async () => {
    const w = world();
    const rm = seedReminder(w, { userId: "bob" });

    const r = await run("complete_reminder", { id: rm.id }, toolCtx(w, acting));

    expect(r.ok).toBe(false);
    expect(w.reminders.rows[0]!.completedAt).toBeNull();
  });

  it("🔴 a reminder the assistant sets is DELIVERED to the person when it falls due — not lost", async () => {
    const w = world();
    await run("create_reminder", { title: "Take the bins out", due_at: at(-1).toISOString() }, toolCtx(w, acting));

    startRemindersPoller(w.prisma);
    try {
      await vi.waitFor(() => expect(w.reminders.rows[0]!.notifiedAt).toBeInstanceOf(Date));
      await vi.waitFor(() => expect(mqttPublish).toHaveBeenCalled());
    } finally {
      stopRemindersPoller();
    }

    expect(mqttPublish.mock.calls.map(([topic]) => topic)).toEqual(["droplet/notifications/alice"]);
    expect(w.log.rows.map((n) => [n.username, n.kind, n.title])).toEqual([["alice", "reminder", "Take the bins out"]]);
  });
});

// ── The tools read and write through the orchestrator, never ctx.prisma ─────

describe("WARP-3101 the calendar and reminder tools go through the orchestrator, never ctx.prisma", () => {
  /** A ctx.prisma whose CalendarEvent and Reminder tables refuse every call. */
  function refusingPrisma() {
    const refuse = vi.fn(async () => {
      throw new Error("a calendar/reminder tool touched ctx.prisma — the row key would depend on the transport");
    });
    const table = new Proxy({}, { get: () => refuse });
    return { refuse, prisma: { calendarEvent: table, reminder: table } as unknown as PrismaClient };
  }

  const CASES: Array<[string, (w: World) => Record<string, unknown>]> = [
    ["create_event", () => ({ title: "x", starts_at: at(60).toISOString(), ends_at: at(90).toISOString() })],
    ["list_events", () => ({})],
    ["search_calendar_events", () => ({ query: "x" })],
    ["update_event", (w) => ({ id: seedEvent(w, { userId: "alice" }).id, title: "y" })],
    ["delete_event", (w) => ({ id: seedEvent(w, { userId: "alice" }).id })],
    ["create_reminder", () => ({ title: "x", due_at: at(30).toISOString() })],
    ["set_timer", () => ({ minutes: 5 })],
    ["list_reminders", () => ({})],
    ["complete_reminder", (w) => ({ id: seedReminder(w, { userId: "alice" }).id })],
  ];

  it.each(CASES)("%s", async (name, argsFor) => {
    const w = world();
    const { refuse, prisma } = refusingPrisma();

    const r = await run(name, argsFor(w), toolCtx(w, ALICE.id, prisma));

    expect(refuse).not.toHaveBeenCalled();
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
  });
});

// ── What the tools keep doing ────────────────────────────────────────────────

/**
 * Behaviour the tools had before WARP-3101 and must keep. Run on the stdio
 * transport (the username), where the old handlers worked, so each case is
 * green before the fix and after it: the contract survived the move.
 */
describe("WARP-3101 the tools keep their contract through the routes", () => {
  const STDIO = "alice";

  it("list_events returns the same event shape, meeting link and source included", async () => {
    const w = world();
    const ev = seedEvent(w, {
      userId: "alice",
      title: "Standup",
      location: "Room 2",
      meetingUrl: "https://warplab.zoom.us/j/1",
      startsAt: at(60),
      endsAt: at(75),
    });

    const r = await run("list_events", {}, toolCtx(w, STDIO));

    expect(dataOf<{ events: unknown[] }>(r).events).toEqual([
      {
        id: ev.id,
        title: "Standup",
        starts_at: (ev.startsAt as Date).toISOString(),
        ends_at: (ev.endsAt as Date).toISOString(),
        all_day: false,
        location: "Room 2",
        meeting_url: "https://warplab.zoom.us/j/1",
        source: "local",
      },
    ]);
  });

  it("create_event accepts a time without a zone, as the model sometimes sends it, and stores the https link", async () => {
    const w = world();
    const starts = at(60);
    const ends = at(120);
    // `YYYY-MM-DDTHH:mm:ss` with no zone — parsed as local time, as before.
    const local = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T` +
      `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:00`;

    const r = await run(
      "create_event",
      { title: "Sync", starts_at: local(starts), ends_at: local(ends), meeting_url: "https://meet.google.com/abc-defg-hij" },
      toolCtx(w, STDIO),
    );

    dataOf(r);
    const row = w.events.rows[0]!;
    expect((row.startsAt as Date).getTime()).toBe(new Date(local(starts)).getTime());
    expect(row.meetingUrl).toBe("https://meet.google.com/abc-defg-hij");
    expect(row.source).toBe("local");
  });

  it("update_event refuses a partial patch that would put the end before the start", async () => {
    const w = world();
    const ev = seedEvent(w, { userId: "alice", startsAt: at(60), endsAt: at(90) });

    const r = await run("update_event", { id: ev.id, starts_at: at(120).toISOString() }, toolCtx(w, STDIO));

    expect(r).toMatchObject({ ok: false, error: { code: "INVALID_RANGE" } });
    expect((w.events.rows[0]!.startsAt as Date).getTime()).toBe((ev.startsAt as Date).getTime());
  });

  it("update_event clears the meeting link on an empty string", async () => {
    const w = world();
    const ev = seedEvent(w, { userId: "alice", meetingUrl: "https://warplab.zoom.us/j/1" });

    dataOf(await run("update_event", { id: ev.id, meeting_url: "" }, toolCtx(w, STDIO)));

    expect(w.events.rows[0]!.meetingUrl).toBeNull();
  });

  it("update_event and delete_event refuse an externally-synced event", async () => {
    const w = world();
    const ev = seedEvent(w, { userId: "alice", source: "external" });

    const upd = await run("update_event", { id: ev.id, title: "x" }, toolCtx(w, STDIO));
    const del = await run("delete_event", { id: ev.id }, toolCtx(w, STDIO));

    expect(upd).toMatchObject({ ok: false, error: { code: "EXTERNAL_SOURCE" } });
    expect(del).toMatchObject({ ok: false, error: { code: "EXTERNAL_SOURCE" } });
    expect(w.events.rows[0]!.title).toBe("Event");
  });

  it("update_event, delete_event and complete_reminder say NOT_FOUND for an id that does not exist", async () => {
    const w = world();
    for (const name of ["update_event", "delete_event", "complete_reminder"]) {
      const r = await run(name, { id: "4f3e2d1c-0b0a-4988-8776-655443322110", title: "x" }, toolCtx(w, STDIO));
      expect(r, name).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    }
  });

  it("list_reminders includes completed reminders when asked", async () => {
    const w = world();
    seedReminder(w, { id: "rm-open", userId: "alice", dueAt: at(10) });
    seedReminder(w, { id: "rm-done", userId: "alice", dueAt: at(5), completedAt: at(-1) });

    const r = await run("list_reminders", { include_completed: true }, toolCtx(w, STDIO));

    const data = dataOf<{ reminders: Array<{ id: string; completed: boolean }> }>(r);
    expect(data.reminders.map((x) => [x.id, x.completed]).sort()).toEqual([
      ["rm-done", true],
      ["rm-open", false],
    ]);
  });

  it("complete_reminder with completed=false re-opens the reminder", async () => {
    const w = world();
    const rm = seedReminder(w, { userId: "alice", completedAt: at(-1) });

    dataOf(await run("complete_reminder", { id: rm.id, completed: false }, toolCtx(w, STDIO)));

    expect(w.reminders.rows[0]!.completedAt).toBeNull();
  });
});

// ── Who the routes act for, when the caller is the assistant ─────────────────

describe("WARP-3101 the calendar and reminder routes, as the MCP principal", () => {
  const as = (app: express.Express, method: "get" | "post" | "patch" | "delete", path: string, acting?: string) => {
    const req = request(app)[method](path);
    return acting ? req.set("X-Nextcloud-User", acting) : req;
  };

  it("read the acting person's rows — by User.id and by username alike", async () => {
    const w = world();
    seedEvent(w, { id: "ev-a", userId: "alice" });
    seedEvent(w, { id: "ev-b", userId: "bob" });
    seedReminder(w, { id: "rm-a", userId: "alice" });
    seedReminder(w, { id: "rm-b", userId: "bob" });
    const app = appAs(MCP, w.prisma);

    for (const acting of [ALICE.id, "alice"]) {
      const ev = await as(app, "get", "/api/calendar/events", acting);
      expect(ev.status, acting).toBe(200);
      expect(ev.body.events.map((e: { id: string }) => e.id), acting).toEqual(["ev-a"]);
      const rm = await as(app, "get", "/api/reminders", acting);
      expect(rm.status, acting).toBe(200);
      expect(rm.body.reminders.map((x: { id: string }) => x.id), acting).toEqual(["rm-a"]);
    }
  });

  it("write under the acting person's username", async () => {
    const w = world();
    const app = appAs(MCP, w.prisma);

    const ev = await as(app, "post", "/api/calendar/events", ALICE.id).send({
      title: "x",
      startsAt: at(60).toISOString(),
      endsAt: at(90).toISOString(),
    });
    const rm = await as(app, "post", "/api/reminders", ALICE.id).send({ title: "x", dueAt: at(30).toISOString() });

    expect([ev.status, rm.status]).toEqual([201, 201]);
    expect(w.events.rows.map((e) => e.userId)).toEqual(["alice"]);
    expect(w.reminders.rows.map((r) => r.userId)).toEqual(["alice"]);
  });

  it("no acting user → 403 acting_user_required; the service principal's own rows are never read or written", async () => {
    const w = world();
    seedEvent(w, { userId: "_service:mcp" });
    seedReminder(w, { userId: "_service:mcp" });
    const app = appAs(MCP, w.prisma);

    const reads = [await as(app, "get", "/api/calendar/events"), await as(app, "get", "/api/reminders")];
    const writes = [
      await as(app, "post", "/api/calendar/events").send({ title: "x", startsAt: at(60).toISOString(), endsAt: at(90).toISOString() }),
      await as(app, "post", "/api/reminders").send({ title: "x", dueAt: at(30).toISOString() }),
    ];

    for (const res of [...reads, ...writes]) {
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "acting_user_required" });
    }
    expect(w.events.delegate.findMany).not.toHaveBeenCalled();
    expect(w.reminders.delegate.findMany).not.toHaveBeenCalled();
    expect(w.events.rows).toHaveLength(1);
    expect(w.reminders.rows).toHaveLength(1);
  });

  it("an acting user who matches nobody, a deactivated one, or an ambiguous one → 403 acting_user_required", async () => {
    // `bob` is also another row's nextcloudUsername: "bob" names two people.
    const shadow = person({ id: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", username: "robert", role: "owner", nextcloudUsername: "bob" });
    const gone = person({ id: "2b3c4d5e-6f70-4812-9a3b-4c5d6e7f8091", username: "gone", role: "owner", directoryStatus: "DEACTIVATED" });
    const w = world([ALICE, BOB, shadow, gone]);
    seedEvent(w, { userId: "gone" });
    seedEvent(w, { userId: "bob" });
    const app = appAs(MCP, w.prisma);

    for (const acting of ["mallory", gone.id, "gone", "bob"]) {
      const res = await as(app, "get", "/api/calendar/events", acting);
      expect(res.status, acting).toBe(403);
      expect(res.body, acting).toEqual({ error: "acting_user_required" });
    }
    expect(w.events.delegate.findMany).not.toHaveBeenCalled();
  });

  it("a family member reads their calendar and reminders but cannot write them (ADR-004 write tier)", async () => {
    const w = world([ALICE, KID]);
    seedEvent(w, { id: "ev-kid", userId: "kid" });
    seedReminder(w, { id: "rm-kid", userId: "kid" });
    const app = appAs(MCP, w.prisma);

    const ev = await as(app, "get", "/api/calendar/events", KID.id);
    const rm = await as(app, "get", "/api/reminders", KID.id);
    expect(ev.body.events.map((e: { id: string }) => e.id)).toEqual(["ev-kid"]);
    expect(rm.body.reminders.map((x: { id: string }) => x.id)).toEqual(["rm-kid"]);

    const writes = [
      await as(app, "post", "/api/calendar/events", KID.id).send({ title: "x", startsAt: at(60).toISOString(), endsAt: at(90).toISOString() }),
      await as(app, "patch", "/api/calendar/events/ev-kid", KID.id).send({ title: "y" }),
      await as(app, "delete", "/api/calendar/events/ev-kid", KID.id),
      await as(app, "post", "/api/reminders", KID.id).send({ title: "x", dueAt: at(30).toISOString() }),
      await as(app, "patch", "/api/reminders/rm-kid", KID.id).send({ completed: true }),
    ];
    for (const res of writes) {
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("forbidden_tool_for_role");
    }
    expect(w.events.rows.map((e) => [e.id, e.title])).toEqual([["ev-kid", "Event"]]);
    expect(w.reminders.rows.map((r) => [r.id, r.completedAt])).toEqual([["rm-kid", null]]);
  });

  it("an admin whose access role does not reach the calendar → 403 forbidden_tool_for_role (axis B), nothing read", async () => {
    const ops = person({
      id: "7c6b5a49-3827-4165-9f4e-3d2c1b0a9f8e",
      username: "ops",
      role: "admin",
      accessRoleId: "role-files-only",
      accessRole: { toolGrants: [{ domain: "files", level: "use" }] },
    });
    effectiveAccess.mockImplementation(async () => ({ tier: "admin", toolDomains: ["files"], locks: false }));
    const w = world([ops]);
    seedEvent(w, { userId: "ops" });
    seedReminder(w, { userId: "ops" });
    const app = appAs(MCP, w.prisma);

    for (const path of ["/api/calendar/events", "/api/reminders"]) {
      const res = await as(app, "get", path, ops.id);
      expect(res.status, path).toBe(403);
      expect(res.body.error, path).toBe("forbidden_tool_for_role");
    }
    expect(w.events.delegate.findMany).not.toHaveBeenCalled();
    expect(w.reminders.delegate.findMany).not.toHaveBeenCalled();
  });

  it("a person in the browser acts for themselves, and the header means nothing from them", async () => {
    const w = world();
    seedEvent(w, { id: "ev-a", userId: "alice" });
    seedEvent(w, { id: "ev-b", userId: "bob" });
    seedReminder(w, { id: "rm-b", userId: "bob" });
    const app = appAs(browser(BOB), w.prisma);

    const ev = await as(app, "get", "/api/calendar/events", "alice");
    const rm = await as(app, "post", "/api/reminders", "alice").send({ title: "x", dueAt: at(30).toISOString() });

    expect(ev.body.events.map((e: { id: string }) => e.id)).toEqual(["ev-b"]);
    expect(rm.status).toBe(201);
    expect(w.reminders.rows.map((r) => r.userId)).toEqual(["bob", "bob"]);
  });
});
