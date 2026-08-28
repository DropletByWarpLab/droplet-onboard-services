/**
 * WARP-1874 — `meetingUrl` on calendar events, at the HTTP boundary.
 *
 * The scheme rule is enforced in shared-types' parseMeetingLink and pinned
 * exhaustively there. What this file pins is that the calendar route
 * actually CALLS it — that a `javascript:` payload is refused with a 400
 * before any prisma write, on both POST and PATCH, and that the row stores
 * the parser's normalized href rather than the raw request string.
 *
 * It also pins the ICS publish feed, because a household member who
 * subscribes from Apple Calendar or Outlook never sees the dashboard card
 * — the link has to reach the client they actually use.
 */

import crypto from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../services/caldav.client.js", () => ({
  fetchIcsFeed: vi.fn(),
  syncCalendarSource: vi.fn(),
}));
vi.mock("../services/encryption.service.js", () => ({
  encryptSecret: (s: string) => `enc:${s}`,
  decryptSecret: (s: string) => s,
}));

import { createCalendarRouter, createCalendarPublicRouter } from "../routes/calendar.js";

interface EventRow {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  location: string | null;
  meetingUrl: string | null;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  source: string;
  createdAt: Date;
  updatedAt: Date;
}

function makeStub(seed: EventRow[] = []) {
  const events: EventRow[] = [...seed];
  let n = 0;
  return {
    events,
    calendarEvent: {
      create: vi.fn(async ({ data }: { data: Partial<EventRow> }) => {
        const ev = {
          id: `ev-${++n}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        } as EventRow;
        events.push(ev);
        return ev;
      }),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          events.find((e) => e.id === where.id) ?? null,
      ),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Partial<EventRow> }) => {
          const ev = events.find((e) => e.id === where.id);
          if (!ev) throw new Error("event_not_found");
          Object.assign(ev, data);
          return ev;
        },
      ),
      findMany: vi.fn(async () => events),
      delete: vi.fn(async () => undefined),
    },
  };
}

function buildApp(stub: ReturnType<typeof makeStub>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user?: { username: string } }).user = { username: "alice" };
    next();
  });
  app.use("/api", createCalendarRouter(stub as never));
  return app;
}

const startsAt = "2026-09-01T10:00:00.000Z";
const endsAt = "2026-09-01T11:00:00.000Z";

function seedRow(over: Partial<EventRow> = {}): EventRow {
  return {
    id: "ev-seed",
    userId: "alice",
    title: "Standup",
    description: null,
    location: null,
    meetingUrl: null,
    startsAt: new Date(startsAt),
    endsAt: new Date(endsAt),
    allDay: false,
    source: "local",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

describe("POST /calendar/events — meetingUrl", () => {
  it("stores an https link alongside a physical location", async () => {
    // Physical location and video link coexist — the ticket's "Google
    // Calendar / Outlook style" requirement.
    const stub = makeStub();
    const res = await request(buildApp(stub))
      .post("/api/calendar/events")
      .send({
        title: "Sprint sync",
        location: "Living Room",
        meetingUrl: "https://warplab.zoom.us/j/98765?pwd=abc",
        startsAt,
        endsAt,
      });

    expect(res.status).toBe(201);
    expect(stub.events[0].location).toBe("Living Room");
    expect(stub.events[0].meetingUrl).toBe("https://warplab.zoom.us/j/98765?pwd=abc");
    expect(res.body.event.meetingUrl).toBe("https://warplab.zoom.us/j/98765?pwd=abc");
  });

  it.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "java\nscript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "http://zoom.us/j/1",
    "//evil.example/j/1",
    "Living Room",
  ])("refuses %s with 400 and never writes", async (hostile) => {
    const stub = makeStub();
    const res = await request(buildApp(stub))
      .post("/api/calendar/events")
      .send({ title: "Sprint sync", meetingUrl: hostile, startsAt, endsAt });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(stub.calendarEvent.create).not.toHaveBeenCalled();
  });

  it("accepts an unrecognized https URL — the allowlist is for labels, not admission", async () => {
    const stub = makeStub();
    const res = await request(buildApp(stub))
      .post("/api/calendar/events")
      .send({
        title: "Family call",
        meetingUrl: "https://vc.warp-lab.ai/room/kitchen",
        startsAt,
        endsAt,
      });
    expect(res.status).toBe(201);
    expect(stub.events[0].meetingUrl).toBe("https://vc.warp-lab.ai/room/kitchen");
  });

  it("stores the parser's normalized href, not the raw string", async () => {
    // What was validated is what gets rendered — nothing re-parses in
    // between and lands somewhere else.
    const stub = makeStub();
    await request(buildApp(stub))
      .post("/api/calendar/events")
      .send({
        title: "Family call",
        meetingUrl: "  https://meet.google.com  ",
        startsAt,
        endsAt,
      });
    expect(stub.events[0].meetingUrl).toBe("https://meet.google.com/");
  });

  it("leaves meetingUrl null when omitted (existing callers are unaffected)", async () => {
    const stub = makeStub();
    const res = await request(buildApp(stub))
      .post("/api/calendar/events")
      .send({ title: "Dentist", location: "Clinic", startsAt, endsAt });
    expect(res.status).toBe(201);
    expect(stub.events[0].meetingUrl).toBeNull();
  });
});

describe("PATCH /calendar/events/:id — meetingUrl", () => {
  it("updates the link", async () => {
    const stub = makeStub([seedRow()]);
    const res = await request(buildApp(stub))
      .patch("/api/calendar/events/ev-seed")
      .send({ meetingUrl: "https://teams.microsoft.com/l/meetup-join/19%3aabc" });
    expect(res.status).toBe(200);
    expect(stub.events[0].meetingUrl).toBe(
      "https://teams.microsoft.com/l/meetup-join/19%3aabc",
    );
  });

  it("clears the link with an explicit null", async () => {
    // "Remove video call link" has to be expressible, and null is the only
    // honest way to say it — an empty string would store a falsy href.
    const stub = makeStub([seedRow({ meetingUrl: "https://zoom.us/j/1" })]);
    const res = await request(buildApp(stub))
      .patch("/api/calendar/events/ev-seed")
      .send({ meetingUrl: null });
    expect(res.status).toBe(200);
    expect(stub.events[0].meetingUrl).toBeNull();
  });

  it("refuses a javascript: payload with 400 and never writes", async () => {
    const stub = makeStub([seedRow()]);
    const res = await request(buildApp(stub))
      .patch("/api/calendar/events/ev-seed")
      .send({ meetingUrl: "javascript:alert(1)" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(stub.calendarEvent.update).not.toHaveBeenCalled();
  });
});

describe("GET /calendar/publish/:user.ics — meetingUrl", () => {
  // Same derivation as the route: no DEVICE_SECRET in tests, so the
  // deterministic dev placeholder applies.
  function tokenFor(username: string): string {
    return crypto
      .createHmac("sha256", "dev-only-not-secure")
      .update(`calendar:${username}`)
      .digest("hex")
      .slice(0, 32);
  }

  function buildPublicApp(stub: ReturnType<typeof makeStub>) {
    const app = express();
    app.use("/api", createCalendarPublicRouter(stub as never));
    return app;
  }

  it("emits the link as a URL property a subscribed client can join from", async () => {
    const stub = makeStub([
      seedRow({
        location: "Living Room",
        meetingUrl: "https://warplab.zoom.us/j/98765?pwd=abc",
      }),
    ]);
    const res = await request(buildPublicApp(stub))
      .get("/api/calendar/publish/alice.ics")
      .query({ token: tokenFor("alice") });

    expect(res.status).toBe(200);
    expect(res.text).toContain("URL:https://warplab.zoom.us/j/98765?pwd=abc");
    // The room survives alongside it — the feed carries both facts.
    expect(res.text).toContain("LOCATION:Living Room");
  });

  it("emits no URL property for an event without a link", async () => {
    const stub = makeStub([seedRow()]);
    const res = await request(buildPublicApp(stub))
      .get("/api/calendar/publish/alice.ics")
      .query({ token: tokenFor("alice") });

    expect(res.status).toBe(200);
    expect(res.text).not.toContain("URL:");
  });

  // CodeQL js/type-confusion-through-parameter-tampering: `?token=a&token=b`
  // reaches Express as an array. Only a single string is ever compared —
  // an array must be refused up front, never length-checked or Buffer'd.
  it("403s a repeated ?token= (array) even when every element is the real token", async () => {
    const stub = makeStub([seedRow()]);
    const real = tokenFor("alice");
    const res = await request(buildPublicApp(stub))
      .get("/api/calendar/publish/alice.ics")
      .query(`token=${real}&token=${real}`);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "invalid_token" });
    expect(stub.calendarEvent.findMany).not.toHaveBeenCalled();
  });
});
