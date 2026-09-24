/**
 * WARP-2909 — /api/notifications carries the deep link out, and never takes
 * one in.
 *
 *   1. GET returns `url` and `data` per row, so the native inboxes can open it.
 *   2. POST /send does NOT accept `url` / `data` / `tag`: the model (via
 *      `send_notification`) and the manual sender must not author deep links —
 *      a same-origin path is still a lure. Only trusted server code sets them.
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
