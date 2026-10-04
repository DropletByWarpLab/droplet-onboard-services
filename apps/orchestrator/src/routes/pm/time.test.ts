/**
 * WARP-3526 (ADR-069 WS-10) — route tests for the time-tracking surface:
 *
 *   GET/POST /api/pm/work-items/:id/worklogs     PATCH/DELETE /api/pm/worklogs/:id
 *   GET /api/pm/timer     POST /api/pm/timer/start|stop
 *   GET /api/pm/timesheet      GET /api/pm/time/report  (+ CSV)
 *
 * A bare Express app with a stub auth middleware that sets `req.user` per test,
 * so the REAL `requireRole` guards run. The service is replaced wholesale: this
 * file is about the HTTP contract — who is let in, what is validated, which
 * service code becomes which status, what the CSV looks like on the wire. What
 * the service does to a database (one timer per person, the minutes CHECK, the
 * cascades, report totals equal the sum of the worklogs) is proven against real
 * Postgres in __tests__/pm-time.pg.test.ts.
 *
 * Guests never reach any of this in the real app — the `projects` tier floor
 * answers 404 before a route runs; that is pinned through the real gates in
 * __tests__/pm-time-guest.test.ts. Here a guest is simply a role the write
 * guards refuse.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { NextFunction, Request, Response } from "express";
import type { PrismaClient } from "@prisma/client";
import type { AuthUser } from "../../middleware/auth.js";

vi.mock("../../services/pm/pm-time.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/pm/pm-time.service.js")>();
  return {
    ...actual,
    listWorklogs: vi.fn(),
    createWorklog: vi.fn(),
    updateWorklog: vi.fn(),
    deleteWorklog: vi.fn(),
    getTimer: vi.fn(),
    startTimer: vi.fn(),
    stopTimer: vi.fn(),
    getTimesheet: vi.fn(),
    getTimeReport: vi.fn(),
  };
});

import * as time from "../../services/pm/pm-time.service.js";
import { createPmTimeRouter } from "./time.js";

const svc = vi.mocked(time);

const PRINCIPALS: Record<string, AuthUser> = {
  owner: { id: "u-owner", username: "owner", displayName: "Owner", role: "owner" },
  admin: { id: "u-admin", username: "admin", displayName: "Admin", role: "admin" },
  family: { id: "u-family", username: "fam", displayName: "Fam", role: "family" },
  guest: { id: "u-guest", username: "guest", displayName: "Guest", role: "guest" },
  mcp: { id: "_service:mcp", username: "mcp", displayName: "MCP", role: "service" },
};

const prisma = {} as PrismaClient;

function appAs(who: keyof typeof PRINCIPALS = "family") {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.user = PRINCIPALS[who];
    next();
  });
  app.use("/api", createPmTimeRouter(prisma));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "handler_error", message: String(err) });
  });
  return app;
}

const WORKLOG = {
  id: "wl-1",
  workItemId: "wi-1",
  userId: "u-family",
  startedAt: "2026-10-04T09:00:00.000Z",
  minutes: 30,
  note: "",
  createdAt: "2026-10-04T09:30:00.000Z",
  updatedAt: "2026-10-04T09:30:00.000Z",
};
const ITEM = { id: "wi-1", key: "INBOX-1", name: "First", projectId: "p-1", archived: false };

beforeEach(() => {
  vi.resetAllMocks();
});

const WRITES: Array<[string, "post" | "patch" | "delete", string, object?]> = [
  ["log time", "post", "/api/pm/work-items/wi-1/worklogs", { minutes: 5 }],
  ["edit an entry", "patch", "/api/pm/worklogs/wl-1", { minutes: 5 }],
  ["delete an entry", "delete", "/api/pm/worklogs/wl-1"],
  ["start a timer", "post", "/api/pm/timer/start", { work_item_id: "wi-1" }],
  ["stop a timer", "post", "/api/pm/timer/stop", {}],
];

describe("who may write", () => {
  for (const who of ["owner", "admin", "family"] as const) {
    it(`${who} reaches every write route`, async () => {
      svc.createWorklog.mockResolvedValue(WORKLOG);
      svc.updateWorklog.mockResolvedValue(WORKLOG);
      svc.deleteWorklog.mockResolvedValue(undefined);
      svc.startTimer.mockResolvedValue({
        timer: { userId: "x", workItemId: "wi-1", startedAt: WORKLOG.startedAt, workItem: ITEM },
        stopped: null,
      });
      svc.stopTimer.mockResolvedValue({ worklog: WORKLOG, capped: false });
      for (const [name, method, path, body] of WRITES) {
        const res = await request(appAs(who))[method](path).send(body ?? {});
        expect(res.status, `${who}: ${name}`).toBeLessThan(300);
      }
    });
  }

  for (const who of ["guest", "mcp"] as const) {
    it(`${who} is refused on every write route and nothing reaches the service`, async () => {
      for (const [name, method, path, body] of WRITES) {
        const res = await request(appAs(who))[method](path).send(body ?? {});
        expect(res.status, `${who}: ${name}`).toBe(403);
      }
      expect(svc.createWorklog).not.toHaveBeenCalled();
      expect(svc.updateWorklog).not.toHaveBeenCalled();
      expect(svc.deleteWorklog).not.toHaveBeenCalled();
      expect(svc.startTimer).not.toHaveBeenCalled();
      expect(svc.stopTimer).not.toHaveBeenCalled();
    });
  }

  it("the assistant's service principal has no person to own time, so it can neither log it nor run a clock", async () => {
    // Stated as its own case because it is the one that differs from the
    // work-item routes, which DO admit `_service:mcp`.
    const res = await request(appAs("mcp")).post("/api/pm/timer/start").send({ work_item_id: "wi-1" });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/forbidden/i);
  });
});

describe("POST /pm/work-items/:id/worklogs", () => {
  it("logs time for the caller: 201, the entry, and the actor the service needs to decide who may do what", async () => {
    svc.createWorklog.mockResolvedValue(WORKLOG);
    const res = await request(appAs("family"))
      .post("/api/pm/work-items/wi-1/worklogs")
      .send({ minutes: 30, started_at: "2026-10-04T09:00:00.000Z", note: "Fixed it" });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ worklog: WORKLOG });
    expect(svc.createWorklog).toHaveBeenCalledWith(
      prisma,
      { id: "u-family", canManageAll: false },
      "wi-1",
      { minutes: 30, startedAt: new Date("2026-10-04T09:00:00.000Z"), note: "Fixed it", userId: undefined },
    );
  });

  it("tells the service an owner or admin may manage everyone's entries, and a member may not", async () => {
    svc.createWorklog.mockResolvedValue(WORKLOG);
    for (const [who, canManageAll] of [
      ["owner", true],
      ["admin", true],
      ["family", false],
    ] as const) {
      svc.createWorklog.mockClear();
      await request(appAs(who)).post("/api/pm/work-items/wi-1/worklogs").send({ minutes: 5, user_id: "u-sam" });
      const [, actor, , input] = svc.createWorklog.mock.calls[0];
      expect(actor).toEqual({ id: PRINCIPALS[who].id, canManageAll });
      expect(input).toMatchObject({ userId: "u-sam" });
    }
  });

  it("accepts a start time with a UTC offset, and no start time at all", async () => {
    svc.createWorklog.mockResolvedValue(WORKLOG);
    const withOffset = await request(appAs())
      .post("/api/pm/work-items/wi-1/worklogs")
      .send({ minutes: 5, started_at: "2026-10-04T11:00:00+02:00" });
    expect(withOffset.status).toBe(201);
    expect(svc.createWorklog.mock.calls[0][3].startedAt).toEqual(new Date("2026-10-04T09:00:00.000Z"));
    svc.createWorklog.mockClear();
    const without = await request(appAs()).post("/api/pm/work-items/wi-1/worklogs").send({ minutes: 5 });
    expect(without.status).toBe(201);
    expect(svc.createWorklog.mock.calls[0][3]).toMatchObject({ startedAt: undefined, note: undefined });
  });

  it("enforces 1 minute to 24 hours, whole minutes, at the boundary of the API — 400, never the service", async () => {
    const post = (body: object) => request(appAs()).post("/api/pm/work-items/wi-1/worklogs").send(body);
    for (const bad of [0, -1, 1441, 100000, 1.5, "30", null, Number.NaN]) {
      const res = await post({ minutes: bad });
      expect(res.status, `minutes=${String(bad)}`).toBe(400);
      expect(res.body.error).toBe("invalid_request");
    }
    expect((await post({})).status).toBe(400);
    expect(svc.createWorklog).not.toHaveBeenCalled();

    svc.createWorklog.mockResolvedValue(WORKLOG);
    expect((await post({ minutes: 1 })).status).toBe(201);
    expect((await post({ minutes: 1440 })).status).toBe(201);
  });

  it("rejects a malformed start, an oversized note and an empty user id", async () => {
    const post = (body: object) => request(appAs()).post("/api/pm/work-items/wi-1/worklogs").send(body);
    expect((await post({ minutes: 5, started_at: "yesterday" })).status).toBe(400);
    expect((await post({ minutes: 5, started_at: "2026-10-04" })).status).toBe(400);
    expect((await post({ minutes: 5, note: "x".repeat(2001) })).status).toBe(400);
    expect((await post({ minutes: 5, user_id: "" })).status).toBe(400);
    expect(svc.createWorklog).not.toHaveBeenCalled();
  });

  it.each([
    ["work_item_not_found", 404],
    ["work_item_archived", 409],
    ["started_at_in_future", 422],
    ["worklog_forbidden", 403],
    ["user_not_found", 404],
    ["invalid_minutes", 400],
  ])("maps the service code %s to %i", async (code, status) => {
    svc.createWorklog.mockRejectedValue(new Error(code));
    const res = await request(appAs()).post("/api/pm/work-items/wi-1/worklogs").send({ minutes: 5 });
    expect(res.status).toBe(status);
    expect(res.body.error).toBe(code);
  });

  it("lets an unexpected failure through as a 500 rather than a made-up status", async () => {
    svc.createWorklog.mockRejectedValue(new Error("connection reset"));
    const res = await request(appAs()).post("/api/pm/work-items/wi-1/worklogs").send({ minutes: 5 });
    expect(res.status).toBe(500);
  });
});

describe("GET /pm/work-items/:id/worklogs", () => {
  it("is open to every member role — a read — and returns the entries with totals over all of them", async () => {
    svc.listWorklogs.mockResolvedValue({ worklogs: [WORKLOG], totalMinutes: 90, totalEntries: 3 });
    for (const who of ["owner", "admin", "family"] as const) {
      const res = await request(appAs(who)).get("/api/pm/work-items/wi-1/worklogs");
      expect(res.status, who).toBe(200);
      expect(res.body).toEqual({ worklogs: [WORKLOG], total_minutes: 90, total_entries: 3 });
    }
    expect(svc.listWorklogs).toHaveBeenCalledWith(prisma, "wi-1");
  });

  it("is 404 for an item that is not there", async () => {
    svc.listWorklogs.mockRejectedValue(new Error("work_item_not_found"));
    const res = await request(appAs()).get("/api/pm/work-items/nope/worklogs");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("work_item_not_found");
  });
});

describe("PATCH /pm/worklogs/:id", () => {
  it("edits minutes, start and note, and passes only what was sent", async () => {
    svc.updateWorklog.mockResolvedValue({ ...WORKLOG, minutes: 45 });
    const res = await request(appAs("owner")).patch("/api/pm/worklogs/wl-1").send({ minutes: 45 });
    expect(res.status).toBe(200);
    expect(res.body.worklog.minutes).toBe(45);
    expect(svc.updateWorklog).toHaveBeenCalledWith(
      prisma,
      { id: "u-owner", canManageAll: true },
      "wl-1",
      { minutes: 45, startedAt: undefined, note: undefined },
    );
  });

  it("clears a note with null or an empty string — both mean no note", async () => {
    svc.updateWorklog.mockResolvedValue(WORKLOG);
    await request(appAs()).patch("/api/pm/worklogs/wl-1").send({ note: null });
    expect(svc.updateWorklog.mock.calls[0][3]).toMatchObject({ note: "" });
    await request(appAs()).patch("/api/pm/worklogs/wl-1").send({ note: "" });
    expect(svc.updateWorklog.mock.calls[1][3]).toMatchObject({ note: "" });
  });

  it("refuses an empty patch and the same bounds as a create", async () => {
    const patch = (body: object) => request(appAs()).patch("/api/pm/worklogs/wl-1").send(body);
    expect((await patch({})).status).toBe(400);
    for (const bad of [0, 1441, 2.5, "9"]) expect((await patch({ minutes: bad })).status, String(bad)).toBe(400);
    expect((await patch({ started_at: "soon" })).status).toBe(400);
    expect(svc.updateWorklog).not.toHaveBeenCalled();
  });

  it.each([
    ["worklog_not_found", 404],
    ["worklog_forbidden", 403],
    ["started_at_in_future", 422],
  ])("maps %s to %i", async (code, status) => {
    svc.updateWorklog.mockRejectedValue(new Error(code));
    const res = await request(appAs()).patch("/api/pm/worklogs/wl-1").send({ minutes: 5 });
    expect(res.status).toBe(status);
    expect(res.body.error).toBe(code);
  });
});

describe("DELETE /pm/worklogs/:id", () => {
  it("deletes and answers {deleted}", async () => {
    svc.deleteWorklog.mockResolvedValue(undefined);
    const res = await request(appAs("admin")).delete("/api/pm/worklogs/wl-1");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: "wl-1" });
    expect(svc.deleteWorklog).toHaveBeenCalledWith(prisma, { id: "u-admin", canManageAll: true }, "wl-1");
  });

  it.each([
    ["worklog_not_found", 404],
    ["worklog_forbidden", 403],
  ])("maps %s to %i", async (code, status) => {
    svc.deleteWorklog.mockRejectedValue(new Error(code));
    const res = await request(appAs()).delete("/api/pm/worklogs/wl-1");
    expect(res.status).toBe(status);
  });
});

describe("the timer", () => {
  const TIMER = { userId: "u-family", workItemId: "wi-1", startedAt: WORKLOG.startedAt, workItem: ITEM };

  it("GET answers {timer: null} when nothing is running, and the timer with its item when something is", async () => {
    svc.getTimer.mockResolvedValue(null);
    expect((await request(appAs()).get("/api/pm/timer")).body).toEqual({ timer: null });
    svc.getTimer.mockResolvedValue(TIMER);
    const res = await request(appAs("family")).get("/api/pm/timer");
    expect(res.body).toEqual({ timer: TIMER });
    expect(svc.getTimer).toHaveBeenLastCalledWith(prisma, "u-family");
  });

  it("GET is the CALLER'S timer: the assistant's principal has none, so it is a 400, not somebody else's", async () => {
    const res = await request(appAs("mcp")).get("/api/pm/timer");
    expect(res.status).toBe(400);
    expect(svc.getTimer).not.toHaveBeenCalled();
  });

  it("start takes a work item, runs the caller's clock, and reports the timer it stopped", async () => {
    svc.startTimer.mockResolvedValue({ timer: TIMER, stopped: WORKLOG });
    const res = await request(appAs("family")).post("/api/pm/timer/start").send({ work_item_id: "wi-1" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ timer: TIMER, stopped: WORKLOG });
    expect(svc.startTimer).toHaveBeenCalledWith(prisma, "u-family", "wi-1");
  });

  it("start refuses a body without a work item id", async () => {
    for (const body of [{}, { work_item_id: "" }, { work_item_id: 7 }, { workItemId: "wi-1" }]) {
      expect((await request(appAs()).post("/api/pm/timer/start").send(body)).status).toBe(400);
    }
    expect(svc.startTimer).not.toHaveBeenCalled();
  });

  it.each([
    ["work_item_not_found", 404],
    ["work_item_archived", 409],
  ])("start maps %s to %i", async (code, status) => {
    svc.startTimer.mockRejectedValue(new Error(code));
    const res = await request(appAs()).post("/api/pm/timer/start").send({ work_item_id: "wi-1" });
    expect(res.status).toBe(status);
  });

  it("a start that lost a race with itself is a 409 CONCURRENT_MUTATION — nothing applied, try again", async () => {
    svc.startTimer.mockRejectedValue(new Error("concurrent_mutation"));
    const res = await request(appAs()).post("/api/pm/timer/start").send({ work_item_id: "wi-1" });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "concurrent_mutation", code: "CONCURRENT_MUTATION" });
    expect(typeof res.body.message).toBe("string");
  });

  it("stop writes the worklog and says when a forgotten timer was capped at a day", async () => {
    svc.stopTimer.mockResolvedValue({ worklog: { ...WORKLOG, minutes: 1440 }, capped: true });
    const res = await request(appAs("family")).post("/api/pm/timer/stop").send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ worklog: { ...WORKLOG, minutes: 1440 }, capped: true });
    expect(svc.stopTimer).toHaveBeenCalledWith(prisma, "u-family");
  });

  it("stop with no timer running is 404 timer_not_found", async () => {
    svc.stopTimer.mockRejectedValue(new Error("timer_not_found"));
    const res = await request(appAs()).post("/api/pm/timer/stop").send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("timer_not_found");
  });
});

describe("GET /pm/timesheet", () => {
  const SHEET = {
    userId: "u-family",
    tz: "UTC",
    weekStart: "2026-09-28",
    days: [],
    rows: [],
    dayTotals: [],
    totalMinutes: 0,
    entries: [],
  };

  it("defaults to the caller, the current week and UTC — and passes a person, a week and a zone when given", async () => {
    svc.getTimesheet.mockResolvedValue(SHEET);
    const bare = await request(appAs("family")).get("/api/pm/timesheet");
    expect(bare.status).toBe(200);
    expect(bare.body).toEqual({ timesheet: SHEET });
    expect(svc.getTimesheet).toHaveBeenLastCalledWith(prisma, {
      userId: "u-family",
      weekStart: undefined,
      tz: undefined,
    });

    await request(appAs("family")).get("/api/pm/timesheet?userId=u-sam&weekStart=2026-10-04&tz=America/New_York");
    expect(svc.getTimesheet).toHaveBeenLastCalledWith(prisma, {
      userId: "u-sam",
      weekStart: "2026-10-04",
      tz: "America/New_York",
    });
  });

  it("is household-shared like every PM read: a member may read another person's week", async () => {
    svc.getTimesheet.mockResolvedValue(SHEET);
    expect((await request(appAs("family")).get("/api/pm/timesheet?userId=u-someone-else")).status).toBe(200);
  });

  it("needs a person: the assistant's principal has no timesheet of its own", async () => {
    svc.getTimesheet.mockResolvedValue(SHEET);
    expect((await request(appAs("mcp")).get("/api/pm/timesheet")).status).toBe(400);
    expect((await request(appAs("mcp")).get("/api/pm/timesheet?userId=u-sam")).status).toBe(200);
  });

  it("validates its parameters at the boundary", async () => {
    for (const q of ["weekStart=10/04/2026", "weekStart=2026-10-4", "userId=", `tz=${"x".repeat(65)}`, "userId=a&userId=b"]) {
      expect((await request(appAs()).get(`/api/pm/timesheet?${q}`)).status, q).toBe(400);
    }
    expect(svc.getTimesheet).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid_timezone", 400],
    ["invalid_week_start", 400],
  ])("maps %s to %i", async (code, status) => {
    svc.getTimesheet.mockRejectedValue(new Error(code));
    const res = await request(appAs()).get("/api/pm/timesheet?tz=Mars/Base");
    expect(res.status).toBe(status);
    expect(res.body.error).toBe(code);
  });
});

describe("GET /pm/time/report", () => {
  const rows = [
    { key: "u-1", label: "Sam", itemKey: null, minutes: 90, entries: 2 },
    { key: "u-2", label: "=cmd|' /C calc'!A1", itemKey: null, minutes: 30, entries: 1 },
  ];
  const REPORT = {
    groupBy: "user" as const,
    from: "2026-09-01",
    to: "2026-09-30",
    tz: "UTC",
    projectId: null,
    rows,
    total: { minutes: 120, entries: 3 },
  };
  const Q = "from=2026-09-01&to=2026-09-30";

  it("returns the report as JSON by default and passes every filter through", async () => {
    svc.getTimeReport.mockResolvedValue(REPORT);
    const res = await request(appAs("family")).get(
      `/api/pm/time/report?${Q}&projectId=p-1&groupBy=item&tz=Europe/Paris`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ report: REPORT });
    expect(svc.getTimeReport).toHaveBeenCalledWith(prisma, {
      projectId: "p-1",
      from: "2026-09-01",
      to: "2026-09-30",
      groupBy: "item",
      tz: "Europe/Paris",
    });
  });

  it("needs a window, and only the three groupings and two formats", async () => {
    for (const q of [
      "",
      "from=2026-09-01",
      "to=2026-09-30",
      "from=2026-9-1&to=2026-09-30",
      `${Q}&groupBy=week`,
      `${Q}&format=xlsx`,
      `${Q}&projectId=`,
    ]) {
      expect((await request(appAs()).get(`/api/pm/time/report?${q}`)).status, q).toBe(400);
    }
    expect(svc.getTimeReport).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid_range", 400],
    ["invalid_timezone", 400],
    ["project_not_found", 404],
  ])("maps %s to %i", async (code, status) => {
    svc.getTimeReport.mockRejectedValue(new Error(code));
    const res = await request(appAs()).get(`/api/pm/time/report?${Q}`);
    expect(res.status).toBe(status);
    expect(res.body.error).toBe(code);
  });

  describe("format=csv", () => {
    it("is an attachment, never cached, with the rows quoted per RFC 4180 and formulas neutralised", async () => {
      svc.getTimeReport.mockResolvedValue({
        ...REPORT,
        rows: [
          { key: "u-1", label: "Sam, the owner", itemKey: null, minutes: 90, entries: 2 },
          { key: "u-2", label: '=HYPERLINK("http://evil","x")', itemKey: null, minutes: 30, entries: 1 },
          { key: "u-3", label: "Line one\nline two", itemKey: null, minutes: 15, entries: 1 },
        ],
      });
      const res = await request(appAs()).get(`/api/pm/time/report?${Q}&format=csv`).buffer(true);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/^text\/csv; charset=utf-8/);
      expect(res.headers["content-disposition"]).toBe(
        'attachment; filename="droplet-time-user-2026-09-01-to-2026-09-30.csv"',
      );
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.text).toBe(
        [
          "User,Minutes,Hours,Entries",
          '"Sam, the owner",90,1.50,2',
          '"\'=HYPERLINK(""http://evil"",""x"")",30,0.50,1',
          '"Line one\nline two",15,0.25,1',
          "",
        ].join("\r\n"),
      );
    });

    it("has the columns of the grouping: an item report leads with the key, a day report with the date", async () => {
      svc.getTimeReport.mockResolvedValue({
        ...REPORT,
        groupBy: "item",
        rows: [{ key: "wi-1", label: "Fix the printer", itemKey: "INBOX-7", minutes: 61, entries: 1 }],
      });
      const item = await request(appAs()).get(`/api/pm/time/report?${Q}&groupBy=item&format=csv`);
      expect(item.text).toBe("Item,Title,Minutes,Hours,Entries\r\nINBOX-7,Fix the printer,61,1.02,1\r\n");
      expect(item.headers["content-disposition"]).toContain("droplet-time-item-");

      svc.getTimeReport.mockResolvedValue({
        ...REPORT,
        groupBy: "day",
        rows: [{ key: "2026-09-02", label: "2026-09-02", itemKey: null, minutes: 60, entries: 2 }],
      });
      const day = await request(appAs()).get(`/api/pm/time/report?${Q}&groupBy=day&format=csv`);
      expect(day.text).toBe("Date,Minutes,Hours,Entries\r\n2026-09-02,60,1.00,2\r\n");
    });

    it("an empty report is a header and nothing else", async () => {
      svc.getTimeReport.mockResolvedValue({ ...REPORT, rows: [], total: { minutes: 0, entries: 0 } });
      const res = await request(appAs()).get(`/api/pm/time/report?${Q}&format=csv`);
      expect(res.text).toBe("User,Minutes,Hours,Entries\r\n");
    });

    it("streams a large report in full — every row arrives, in order, with nothing doubled or cut", async () => {
      const many = Array.from({ length: 20_000 }, (_, i) => ({
        key: `u-${i}`,
        label: `Person ${i}, "the ${i}th"`,
        itemKey: null,
        minutes: (i % 90) + 1,
        entries: 1,
      }));
      svc.getTimeReport.mockResolvedValue({ ...REPORT, rows: many });
      const res = await request(appAs()).get(`/api/pm/time/report?${Q}&format=csv`).buffer(true);
      const lines = res.text.split("\r\n");
      expect(lines.pop()).toBe(""); // the final CRLF
      expect(lines).toHaveLength(20_001);
      expect(lines[0]).toBe("User,Minutes,Hours,Entries");
      expect(lines[1]).toBe('"Person 0, ""the 0th""",1,0.02,1');
      expect(lines[20_000]).toBe(`"Person 19999, ""the 19999th""",${(19_999 % 90) + 1},${(((19_999 % 90) + 1) / 60).toFixed(2)},1`);
    });

    it("a failure BEFORE the first byte is an ordinary JSON error, not a half-written file", async () => {
      svc.getTimeReport.mockRejectedValue(new Error("invalid_range"));
      const res = await request(appAs()).get(`/api/pm/time/report?${Q}&format=csv`);
      expect(res.status).toBe(400);
      expect(res.headers["content-type"]).toMatch(/json/);
      expect(res.headers["content-disposition"]).toBeUndefined();
    });
  });
});
