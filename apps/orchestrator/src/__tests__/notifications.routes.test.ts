/**
 * WARP-2909 — /api/notifications carries the deep link, and refuses to author one.
 *
 *   - GET /api/notifications returns `url` and `data` per row — the iOS inbox
 *     polls this list (WARP-2804) and opens `url`.
 *   - POST /api/notifications/send does NOT accept `url`, `data` or `tag`:
 *     the model's send_notification tool and the manual sender both land
 *     here, and neither may author a deep link (a same-origin path is still a
 *     lure if the model can write one). A body carrying them is a 202 whose
 *     persisted row has `url: null`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";

const mqttPublish = vi.fn();
vi.mock("../services/mqtt.service.js", () => ({
  publish: (...a: unknown[]) => mqttPublish(...a),
}));

import { createNotificationsRouter } from "../routes/notifications.js";
import type { AuthUser } from "../middleware/auth.js";

// Distinct id and username on purpose: the notification row and the toast
// topic are keyed on the USERNAME (the WARP-2783 / WARP-2813 trap).
const owner: AuthUser = { id: "u-owner", username: "romain", displayName: "romain", role: "owner" };

function makePrismaStub() {
  const created: Array<Record<string, unknown>> = [];
  const stub = {
    notificationLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `log-${created.length + 1}`, createdAt: new Date(), ...data };
        created.push(row);
        return row;
      }),
      findMany: vi.fn(async ({ where }: { where: { userId: string } }) =>
        created.filter((r) => r.userId === where.userId).slice().reverse(),
      ),
    },
    _created: created,
  };
  return stub as unknown as PrismaClient & { _created: typeof created };
}

function buildApp(user: AuthUser, prisma = makePrismaStub()) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = user;
    next();
  });
  app.use("/api", createNotificationsRouter(prisma));
  return { app, prisma };
}

beforeEach(() => {
  mqttPublish.mockReset();
});

describe("GET /api/notifications — deep link (WARP-2909)", () => {
  it("returns url and data per row", async () => {
    const { app, prisma } = buildApp(owner);
    // Seed the way the worker does: straight into the log with a link.
    await prisma.notificationLog.create({
      data: {
        userId: "romain",
        kind: "ai",
        title: "Approval needed: delete_file",
        body: "b",
        url: "/admin/audit?run=run-1",
        data: { agentRunId: "run-1", pendingTool: "delete_file", needsDecision: true },
        channels: "toast",
        deliveredAt: new Date(),
        error: null,
      },
    });
    await prisma.notificationLog.create({
      data: { userId: "romain", kind: "reminder", title: "Standup", body: null, url: null, channels: "toast", deliveredAt: new Date(), error: null },
    });
    const res = await request(app).get("/api/notifications");
    expect(res.status).toBe(200);
    expect(res.body.notifications).toHaveLength(2);
    expect(res.body.notifications[1]).toMatchObject({
      title: "Approval needed: delete_file",
      url: "/admin/audit?run=run-1",
      data: { agentRunId: "run-1", pendingTool: "delete_file", needsDecision: true },
    });
    expect(res.body.notifications[0]).toMatchObject({ title: "Standup", url: null });
  });
});

describe("POST /api/notifications/send — never authors a deep link (WARP-2909)", () => {
  it("a body carrying url, data and tag is a 202 whose row has url: null and no data", async () => {
    const { app, prisma } = buildApp(owner);
    const res = await request(app)
      .post("/api/notifications/send")
      .send({
        kind: "ai",
        title: "Approval needed: delete_file",
        body: "please approve",
        url: "/admin/audit?run=run-1",
        data: { needsDecision: true },
        tag: "agent-run:run-1",
      });
    expect(res.status).toBe(202);
    expect(prisma._created).toHaveLength(1);
    const row = prisma._created[0];
    expect(row.userId).toBe("romain");
    expect(row.url).toBeNull();
    expect(row.data).toBeUndefined();
    // The toast this route published carries none of the three either.
    expect(mqttPublish).toHaveBeenCalledTimes(1);
    const toast = mqttPublish.mock.calls[0]![1] as Record<string, unknown>;
    expect("url" in toast).toBe(false);
    expect("data" in toast).toBe(false);
    expect("tag" in toast).toBe(false);
  });
});
