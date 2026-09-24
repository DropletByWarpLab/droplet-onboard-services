/**
 * WARP-2909 — /api/notifications carries the deep link out, and never takes
 * one in.
 *
 *   1. GET returns `url` and `data` per row, so the native inboxes can open it.
 *   2. POST /send does NOT accept `url` / `data` / `tag`: the model (via
 *      `send_notification`) and the manual sender must not author deep links —
 *      a same-origin path is still a lure. Only trusted server code sets them.
 *
 * WARP-2804 — routes N1–N4: the recipient reads and acknowledges their OWN
 * notifications, and nobody else's (see the second half of this file).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";

const mqttPublish = vi.fn();
vi.mock("../services/mqtt.service.js", () => ({
  publish: (...a: unknown[]) => mqttPublish(...a),
}));

import { createNotificationsRouter } from "../routes/notifications.js";
import { makeFakeNotificationLog } from "./helpers/fake-notification-log.js";

function makeApp() {
  const log = makeFakeNotificationLog();
  const created = log.rows as unknown as Array<Record<string, unknown>>;
  const prisma = { notificationLog: log.delegate } as unknown as PrismaClient;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: unknown }).user = { id: "u-romain", username: "romain", role: "owner" };
    next();
  });
  app.use("/api", createNotificationsRouter(prisma));
  return { app, created };
}

beforeEach(() => vi.clearAllMocks());

describe("/api/notifications deep link (WARP-2909)", () => {
  it("GET carries url and data per row", async () => {
    const { app, created } = makeApp();
    created.push({
      id: "n1",
      username: "romain",
      kind: "ai",
      title: "Approval needed: delete_file",
      body: null,
      url: "/workshop?run=r1",
      data: { agentRunId: "r1", needsDecision: true },
      channels: "toast",
      deliveredAt: null,
      error: null,
      pushOutcome: null,
      createdAt: new Date(),
      ackState: "unacked",
      ackedAt: null,
      ackMethod: null,
      ackSessionId: null,
      ackClient: null,
    });
    const res = await request(app).get("/api/notifications");
    expect(res.status).toBe(200);
    expect(res.body.notifications[0]).toMatchObject({
      url: "/workshop?run=r1",
      data: { agentRunId: "r1", needsDecision: true },
    });
  });

  it("POST /send ignores url, data and tag — the row has url: null", async () => {
    const { app, created } = makeApp();
    const res = await request(app)
      .post("/api/notifications/send")
      .send({ title: "hi", url: "/workshop?run=r1", data: { agentRunId: "r1" }, tag: "agent-run:r1" });
    expect(res.status).toBe(202);
    expect(created[0]!.url).toBeNull();
    expect(created[0]!.data ?? null).toBeNull();
    const toast = mqttPublish.mock.calls[0]![1] as Record<string, unknown>;
    expect(toast).not.toHaveProperty("url");
  });
});

// ── WARP-2804: acknowledgement (routes N1–N4) ───────────────────────────────
//
// The acting person is chosen per request by a test-only header, so one app
// (one fake log) can hold Stefan's, Maria's and a service principal's
// requests — which is what "someone else's id" and "a script probing ids"
// need.

const PEOPLE: Record<string, { id: string; username: string; role: string; sid?: string }> = {
  stefan: { id: "3b7d0195-6c1e-4f2a-9d8b-2a4c6e8f0a1b", username: "stefan", role: "owner", sid: "sid-stefan-1" },
  maria: { id: "7f6e5d4c-3b2a-4190-8f7e-6d5c4b3a2918", username: "maria", role: "family", sid: "sid-maria-1" },
  legacy: { id: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", username: "legacy", role: "family" },
  mcp: { id: "_service:mcp", username: "_service:mcp", role: "service" },
};

/** Fixture times DERIVE from the clock: N4 refuses a `before` more than 60 s
 *  ahead of the box's clock, so a hard-coded date turns red the day the
 *  calendar passes it — or, run early, is "the future". */
const HOUR_AGO = Date.now() - 60 * 60_000;
const ago = (min: number) => new Date(HOUR_AGO + min * 60_000);

function makeAckApp() {
  const log = makeFakeNotificationLog(ago(0));
  const prisma = { notificationLog: log.delegate } as unknown as PrismaClient;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: unknown }).user = PEOPLE[String(req.headers["x-test-as"] ?? "stefan")];
    next();
  });
  app.use("/api", createNotificationsRouter(prisma));
  return { app, log };
}

const IOS = "droplet-ios/1.4.0 (iOS 18.2)";
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1";

describe("N3 POST /api/notifications/:id/ack (WARP-2804)", () => {
  it("acks the recipient's own row: 200 changed:true, stored with the sign-in and the client", async () => {
    const { app, log } = makeAckApp();
    const row = log.seed({ username: "stefan" });
    const res = await request(app).post(`/api/notifications/${row.id}/ack`).set("X-Droplet-Client", IOS).send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: true, notification: { id: row.id, ackState: "acked", ackMethod: "inbox" } });
    expect(typeof res.body.notification.ackedAt).toBe("string");
    expect(log.rows[0]).toMatchObject({ ackSessionId: "sid-stefan-1", ackClient: IOS });
    // Stored, never returned.
    expect(res.body.notification).not.toHaveProperty("ackSessionId");
    expect(res.body.notification).not.toHaveProperty("ackClient");
  });

  it("with no X-Droplet-Client, the client is a coarse User-Agent label", async () => {
    const { app, log } = makeAckApp();
    const row = log.seed({ username: "stefan" });
    await request(app).post(`/api/notifications/${row.id}/ack`).set("User-Agent", SAFARI_IPHONE).send({});
    expect(log.rows[0]!.ackClient).toBe("Safari on iPhone");
  });

  it("a token with no sid stores a NULL session", async () => {
    const { app, log } = makeAckApp();
    const row = log.seed({ username: "legacy" });
    const res = await request(app).post(`/api/notifications/${row.id}/ack`).set("x-test-as", "legacy").send({});
    expect(res.status).toBe(200);
    expect(log.rows[0]!.ackSessionId).toBeNull();
  });

  it("a second ack → 200 changed:false with the original ackedAt and method", async () => {
    const { app, log } = makeAckApp();
    const row = log.seed({ username: "stefan" });
    const first = await request(app).post(`/api/notifications/${row.id}/ack`).send({ via: "opened" });
    await new Promise((r) => setTimeout(r, 5));
    const second = await request(app).post(`/api/notifications/${row.id}/ack`).send({});
    expect(second.status).toBe(200);
    expect(second.body.changed).toBe(false);
    expect(second.body.notification.ackedAt).toBe(first.body.notification.ackedAt);
    expect(second.body.notification.ackMethod).toBe("opened");
  });

  it("via:'opened' → method opened", async () => {
    const { app, log } = makeAckApp();
    const row = log.seed({ username: "stefan" });
    const res = await request(app).post(`/api/notifications/${row.id}/ack`).send({ via: "opened" });
    expect(res.body.notification.ackMethod).toBe("opened");
  });

  it("MUTATION: another person's id → 404 with exactly the body of a missing id, and their row is untouched", async () => {
    const { app, log } = makeAckApp();
    const maria = log.seed({ username: "maria" });
    const theirs = await request(app).post(`/api/notifications/${maria.id}/ack`).send({});
    const missing = await request(app).post(`/api/notifications/log-999/ack`).send({});
    expect(theirs.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(theirs.body).toEqual(missing.body);
    expect(theirs.body.error.code).toBe("NOTIFICATION_NOT_FOUND");
    expect(log.rows[0]).toMatchObject({ ackState: "unacked", ackedAt: null, ackSessionId: null });
  });

  it("a service principal → 403 HUMAN_ONLY, before anything is looked up", async () => {
    const { app, log } = makeAckApp();
    const row = log.seed({ username: "stefan" });
    const res = await request(app).post(`/api/notifications/${row.id}/ack`).set("x-test-as", "mcp").send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("HUMAN_ONLY");
    expect(log.delegate.updateMany).not.toHaveBeenCalled();
    expect(log.delegate.findFirst).not.toHaveBeenCalled();
    expect(log.rows[0]!.ackState).toBe("unacked");
  });

  it.each([
    ["an id with a dot", "log.1"],
    ["an id with a space", "log%201"],
    ["an id over 64 chars", "a".repeat(65)],
  ])("400 VALIDATION_ERROR for %s", async (_label, id) => {
    const { app, log } = makeAckApp();
    const res = await request(app).post(`/api/notifications/${id}/ack`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(log.delegate.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown via", { via: "all" }],
    ["via: incident (WARP-2978's, never a route's)", { via: "incident" }],
    ["an unknown key", { via: "opened", method: "all" }],
  ])("400 VALIDATION_ERROR for %s (the body is strict)", async (_label, body) => {
    const { app, log } = makeAckApp();
    const row = log.seed({ username: "stefan" });
    const res = await request(app).post(`/api/notifications/${row.id}/ack`).send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(log.rows[0]!.ackState).toBe("unacked");
  });
});

describe("N4 POST /api/notifications/ack-all (WARP-2804)", () => {
  it("acks up to `before` and never a later row; `untracked` rows are neither swept nor counted", async () => {
    const { app, log } = makeAckApp();
    const early = log.seed({ username: "stefan", createdAt: ago(1) });
    const shown = log.seed({ username: "stefan", createdAt: ago(5) });
    const late = log.seed({ username: "stefan", createdAt: ago(10) });
    const history = log.seed({ username: "stefan", createdAt: ago(-60), ackState: "untracked" });
    const res = await request(app)
      .post("/api/notifications/ack-all")
      .set("X-Droplet-Client", IOS)
      .send({ before: shown.createdAt.toISOString() });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ acked: 2, unread: 1 });
    const byId = (id: string) => log.rows.find((r) => r.id === id)!;
    expect(byId(early.id)).toMatchObject({ ackState: "acked", ackMethod: "all", ackSessionId: "sid-stefan-1", ackClient: IOS });
    expect(byId(shown.id).ackState).toBe("acked");
    expect(byId(late.id).ackState).toBe("unacked");
    expect(byId(history.id).ackState).toBe("untracked");
  });

  it("never touches another person's rows", async () => {
    const { app, log } = makeAckApp();
    log.seed({ username: "maria", createdAt: ago(1) });
    const res = await request(app).post("/api/notifications/ack-all").send({ before: ago(30).toISOString() });
    expect(res.body).toEqual({ acked: 0, unread: 0 });
    expect(log.rows[0]!.ackState).toBe("unacked");
  });

  it("a service principal → 403 HUMAN_ONLY", async () => {
    const { app, log } = makeAckApp();
    const res = await request(app).post("/api/notifications/ack-all").set("x-test-as", "mcp").send({ before: new Date().toISOString() });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("HUMAN_ONLY");
    expect(log.delegate.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ["no before", {}],
    ["a before that is not ISO-8601", { before: "yesterday" }],
    ["a date-only before", { before: "2026-09-24" }],
    ["a before more than 60 s in the future", { before: new Date(Date.now() + 5 * 60_000).toISOString() }],
    ["an unknown key", { before: new Date().toISOString(), all: true }],
  ])("400 VALIDATION_ERROR for %s", async (_label, body) => {
    const { app, log } = makeAckApp();
    const res = await request(app).post("/api/notifications/ack-all").send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(log.delegate.updateMany).not.toHaveBeenCalled();
  });

  it("a before a few seconds ahead (client clock skew) is accepted", async () => {
    const { app } = makeAckApp();
    const res = await request(app).post("/api/notifications/ack-all").send({ before: new Date(Date.now() + 30_000).toISOString() });
    expect(res.status).toBe(200);
  });
});

describe("N1 GET /api/notifications and N2 GET /api/notifications/unread-count (WARP-2804)", () => {
  function seedMixed(log: ReturnType<typeof makeAckApp>["log"]) {
    const t = ago;
    log.seed({ id: "n-1", username: "stefan", createdAt: t(1), title: "one" });
    log.seed({ id: "n-2", username: "stefan", createdAt: t(2), title: "two", ackState: "untracked" });
    log.seed({
      id: "n-3",
      username: "stefan",
      createdAt: t(3),
      title: "three",
      ackState: "acked",
      ackedAt: t(4),
      ackMethod: "opened",
      ackSessionId: "sid-x",
      ackClient: "Safari on iPhone",
    });
    log.seed({ id: "n-4", username: "stefan", createdAt: t(5), title: "four" });
    log.seed({ id: "n-5", username: "maria", createdAt: t(6), title: "not yours" });
  }

  it("`unread` counts only `unacked`; every row carries its ack state; nothing carries the device facts", async () => {
    const { app, log } = makeAckApp();
    seedMixed(log);
    const res = await request(app).get("/api/notifications");
    expect(res.status).toBe(200);
    expect(res.body.unread).toBe(2);
    expect(res.body.nextCursor).toBeNull();
    expect(res.body.notifications.map((r: { id: string }) => r.id)).toEqual(["n-4", "n-3", "n-2", "n-1"]);
    expect(res.body.notifications.map((r: { ackState: string }) => r.ackState)).toEqual([
      "unacked",
      "acked",
      "untracked",
      "unacked",
    ]);
    for (const row of res.body.notifications) {
      expect(row).not.toHaveProperty("ackSessionId");
      expect(row).not.toHaveProperty("ackClient");
      expect(row).not.toHaveProperty("username");
    }
  });

  it("state=unacked filters to unread", async () => {
    const { app, log } = makeAckApp();
    seedMixed(log);
    const res = await request(app).get("/api/notifications?state=unacked");
    expect(res.body.notifications.map((r: { id: string }) => r.id)).toEqual(["n-4", "n-1"]);
    expect(res.body.unread).toBe(2);
  });

  it("the cursor pages", async () => {
    const { app, log } = makeAckApp();
    seedMixed(log);
    const first = await request(app).get("/api/notifications?limit=3");
    expect(first.body.notifications.map((r: { id: string }) => r.id)).toEqual(["n-4", "n-3", "n-2"]);
    expect(first.body.nextCursor).toMatch(/^\d+\.n-2$/);
    const second = await request(app).get(`/api/notifications?limit=3&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(second.body.notifications.map((r: { id: string }) => r.id)).toEqual(["n-1"]);
    expect(second.body.nextCursor).toBeNull();
  });

  it.each([
    ["limit=0", "limit=0"],
    ["limit=201", "limit=201"],
    ["limit=abc", "limit=abc"],
    ["a bad state", "state=read"],
    ["a bad cursor", "cursor=nope"],
    ["an unknown query key", "userId=maria"],
  ])("400 VALIDATION_ERROR for %s", async (_label, qs) => {
    const { app } = makeAckApp();
    const res = await request(app).get(`/api/notifications?${qs}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("N2 answers the unread count alone", async () => {
    const { app, log } = makeAckApp();
    seedMixed(log);
    const res = await request(app).get("/api/notifications/unread-count");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ unread: 2 });
  });
});
