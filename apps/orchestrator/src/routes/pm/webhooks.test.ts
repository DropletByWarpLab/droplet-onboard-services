/**
 * WARP-3532 — /api/pm/webhooks: who may call it, what it refuses, what it
 * returns once, and what it writes to the audit feed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type NextFunction, type Request, type Response } from "express";

vi.mock("../../config.js", () => ({
  config: { AUTH_ENABLED: false, agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));

const { recordActivityMock } = vi.hoisted(() => ({ recordActivityMock: vi.fn().mockResolvedValue(null) }));
vi.mock("../../services/activity.singleton.js", () => ({ recordActivity: recordActivityMock }));

// Counters shared across a file make rate-limit assertions order-dependent; the
// limiter is express-rate-limit's, tested there.
vi.mock("../../middleware/rate-limit.js", () => ({
  sensitiveRateLimit: (_req: Request, _res: Response, next: NextFunction) => next(),
  standardRateLimit: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock("../../services/pm/pm-webhook.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/pm/pm-webhook.service.js")>();
  return {
    ...actual,
    listWebhooks: vi.fn(),
    getWebhook: vi.fn(),
    createWebhook: vi.fn(),
    updateWebhook: vi.fn(),
    deleteWebhook: vi.fn(),
    rotateWebhookSecret: vi.fn(),
    sendTestDelivery: vi.fn(),
    listDeliveries: vi.fn(),
    redeliver: vi.fn(),
  };
});

import { createPmWebhooksRouter } from "./webhooks.js";
import * as svc from "../../services/pm/pm-webhook.service.js";
import type { AuthUser } from "../../middleware/auth.js";

const T0 = "2026-10-04T12:00:00.000Z";
const WEBHOOK: svc.ApiWebhook = {
  id: "hook-1",
  workspaceId: "ws-1",
  projectId: null,
  name: "Team chat",
  destination: "https://hooks.example.com",
  format: "SLACK",
  events: ["work_item.created"],
  enabled: true,
  status: "ACTIVE",
  consecutiveFailures: 0,
  createdAt: T0,
  updatedAt: T0,
  lastDelivery: null,
};
const DELIVERY: svc.ApiDelivery = {
  id: "d-1", event: "work_item.created", status: "DELIVERED", attempts: 1, nextAttemptAt: T0,
  lastStatusCode: 200, lastError: null, createdAt: T0, deliveredAt: T0, subject: "ENG-1 · A",
};
const SECRET = "whsec_this-must-appear-only-once";
const SECRET_URL = "https://hooks.example.com/services/T0/B0/the-credential-in-the-path";

const user = (role: AuthUser["role"], username = "olga"): AuthUser => ({
  id: `user-${role}`, username, displayName: `Display ${username}`, role,
});

function app(as: AuthUser) {
  const a = express();
  a.use(express.json());
  a.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = as;
    next();
  });
  a.use("/api", createPmWebhooksRouter({} as never));
  // The app's own error handler is not mounted here; a thrown error is a 500.
  a.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "internal", detail: err instanceof Error ? err.message : "" });
  });
  return a;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(svc.listWebhooks).mockResolvedValue([WEBHOOK]);
  vi.mocked(svc.getWebhook).mockResolvedValue(WEBHOOK);
  vi.mocked(svc.createWebhook).mockResolvedValue({ webhook: WEBHOOK, secret: SECRET });
  vi.mocked(svc.updateWebhook).mockResolvedValue(WEBHOOK);
  vi.mocked(svc.deleteWebhook).mockResolvedValue(WEBHOOK);
  vi.mocked(svc.rotateWebhookSecret).mockResolvedValue({ webhook: WEBHOOK, secret: SECRET });
  vi.mocked(svc.sendTestDelivery).mockResolvedValue(DELIVERY);
  vi.mocked(svc.listDeliveries).mockResolvedValue({ deliveries: [DELIVERY], nextCursor: null });
  vi.mocked(svc.redeliver).mockResolvedValue(DELIVERY);
});

const body = { name: "Team chat", url: SECRET_URL, format: "SLACK", events: ["work_item.created"] };

// Every route, so a new one cannot ship without a row here.
const ROUTES: ReadonlyArray<[method: "get" | "post" | "patch" | "delete", path: string, payload?: object]> = [
  ["get", "/api/pm/webhooks"],
  ["post", "/api/pm/webhooks", body],
  ["get", "/api/pm/webhooks/hook-1"],
  ["patch", "/api/pm/webhooks/hook-1", { name: "x" }],
  ["delete", "/api/pm/webhooks/hook-1"],
  ["post", "/api/pm/webhooks/hook-1/rotate-secret", {}],
  ["post", "/api/pm/webhooks/hook-1/test", {}],
  ["get", "/api/pm/webhooks/hook-1/deliveries"],
  ["post", "/api/pm/webhooks/hook-1/deliveries/d-1/redeliver", {}],
];

describe("access: owner and admin only, on every route, reads included", () => {
  it.each(ROUTES)("%s %s", async (method, path, payload) => {
    for (const role of ["owner", "admin"] as const) {
      const res = await request(app(user(role)))[method](path).send(payload);
      expect(res.status, role).toBeLessThan(400);
    }
    for (const role of ["family", "guest", "service"] as const) {
      const res = await request(app(user(role)))[method](path).send(payload);
      expect(res.status, role).toBe(403);
    }
    // A refused request reached no service function.
    expect(vi.mocked(svc.createWebhook)).toHaveBeenCalledTimes(method === "post" && path === "/api/pm/webhooks" ? 2 : 0);
  });
});

describe("GET /pm/webhooks", () => {
  it("returns the webhooks and the event catalog for the picker", async () => {
    const res = await request(app(user("owner"))).get("/api/pm/webhooks");
    expect(res.status).toBe(200);
    expect(res.body.webhooks).toEqual([WEBHOOK]);
    expect(res.body.events.map((e: { name: string }) => e.name)).toContain("work_item.state_changed");
    expect(res.body.events[0]).toEqual(expect.objectContaining({ label: expect.any(String), description: expect.any(String) }));
  });
});

describe("POST /pm/webhooks", () => {
  it("creates it, returns the secret exactly here, and audits without the address or the secret", async () => {
    const res = await request(app(user("owner", "olga"))).post("/api/pm/webhooks").send(body);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ webhook: WEBHOOK, secret: SECRET });
    expect(svc.createWebhook).toHaveBeenCalledWith(
      expect.anything(), "user-owner",
      { name: "Team chat", url: SECRET_URL, format: "SLACK", events: ["work_item.created"] },
    );
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    const row = recordActivityMock.mock.calls[0]![0];
    expect(row).toMatchObject({ kind: "system", what: "Work webhook created", sub: "Team chat" });
    expect(row.refs).toMatchObject({ webhookId: "hook-1", destination: "https://hooks.example.com", format: "SLACK" });
    const logged = JSON.stringify(recordActivityMock.mock.calls);
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain("the-credential-in-the-path");
  });

  it("defaults the format to JSON", async () => {
    await request(app(user("admin"))).post("/api/pm/webhooks").send({ name: "n", url: "https://h.example/x", events: ["work_item.created"] });
    expect(vi.mocked(svc.createWebhook).mock.calls[0]![2]).toMatchObject({ format: "JSON" });
  });

  it.each([
    ["no name", { ...body, name: "" }],
    ["no events", { ...body, events: [] }],
    ["an unknown format", { ...body, format: "CARRIER_PIGEON" }],
    ["an unknown field (the body is strict)", { ...body, secret: "choose-my-own" }],
    ["a name past 80 characters", { ...body, name: "x".repeat(81) }],
    ["an address past 2048 characters", { ...body, url: `https://h.example/${"x".repeat(2100)}` }],
  ])("400s on %s, and never echoes what was submitted", async (_label, payload) => {
    const res = await request(app(user("owner"))).post("/api/pm/webhooks").send(payload);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request");
    expect(JSON.stringify(res.body)).not.toContain("the-credential-in-the-path");
    expect(JSON.stringify(res.body)).not.toContain("choose-my-own");
    expect(svc.createWebhook).not.toHaveBeenCalled();
  });

  it("answers a refused address with one fixed message that names no rule", async () => {
    vi.mocked(svc.createWebhook).mockRejectedValue(new Error(svc.PM_WEBHOOK_ERRORS.BLOCKED_DESTINATION));
    const res = await request(app(user("owner"))).post("/api/pm/webhooks").send({ ...body, url: "http://169.254.169.254/x" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("blocked_destination");
    expect(res.body.message).toMatch(/can't be used/);
    expect(JSON.stringify(res.body)).not.toMatch(/169\.254|metadata|loopback|private|link-local/i);
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it.each([
    [svc.PM_WEBHOOK_ERRORS.INVALID_EVENTS, 400],
    [svc.PM_WEBHOOK_ERRORS.LIMIT_REACHED, 409],
    [svc.PM_WEBHOOK_ERRORS.PROJECT_NOT_FOUND, 404],
  ])("maps %s to %i", async (code, status) => {
    vi.mocked(svc.createWebhook).mockRejectedValue(new Error(code));
    const res = await request(app(user("owner"))).post("/api/pm/webhooks").send(body);
    expect(res.status).toBe(status);
    expect(res.body.error).toBe(code);
  });

  it("passes an unexpected failure on as a 500 and writes no audit row", async () => {
    vi.mocked(svc.createWebhook).mockRejectedValue(new Error("db down"));
    const res = await request(app(user("owner"))).post("/api/pm/webhooks").send(body);
    expect(res.status).toBe(500);
    expect(recordActivityMock).not.toHaveBeenCalled();
  });
});

describe("PATCH /pm/webhooks/:id", () => {
  it("refuses an empty change and an unknown field", async () => {
    expect((await request(app(user("owner"))).patch("/api/pm/webhooks/hook-1").send({})).status).toBe(400);
    expect((await request(app(user("owner"))).patch("/api/pm/webhooks/hook-1").send({ secretEnc: "x" })).status).toBe(400);
    expect(svc.updateWebhook).not.toHaveBeenCalled();
  });

  it("audits WHICH fields changed, never their values — the address is a credential", async () => {
    await request(app(user("owner"))).patch("/api/pm/webhooks/hook-1").send({ url: SECRET_URL, name: "Renamed" });
    const row = recordActivityMock.mock.calls[0]![0];
    expect(row.what).toBe("Work webhook changed");
    expect([...row.refs.changed].sort()).toEqual(["name", "url"]);
    expect(JSON.stringify(recordActivityMock.mock.calls)).not.toContain("the-credential-in-the-path");
  });

  it("names pausing and resuming as such", async () => {
    await request(app(user("owner"))).patch("/api/pm/webhooks/hook-1").send({ enabled: false });
    await request(app(user("owner"))).patch("/api/pm/webhooks/hook-1").send({ enabled: true });
    expect(recordActivityMock.mock.calls.map((c) => c[0].what)).toEqual(["Work webhook paused", "Work webhook resumed"]);
  });

  it("lets projectId be cleared with null", async () => {
    await request(app(user("owner"))).patch("/api/pm/webhooks/hook-1").send({ projectId: null });
    expect(svc.updateWebhook).toHaveBeenCalledWith(expect.anything(), "hook-1", { projectId: null });
  });

  it("404s on a webhook that is not there", async () => {
    vi.mocked(svc.updateWebhook).mockRejectedValue(new Error(svc.PM_WEBHOOK_ERRORS.NOT_FOUND));
    expect((await request(app(user("owner"))).patch("/api/pm/webhooks/ghost").send({ name: "x" })).status).toBe(404);
  });
});

describe("the rest", () => {
  it("DELETE answers 204 and audits it", async () => {
    const res = await request(app(user("admin"))).delete("/api/pm/webhooks/hook-1");
    expect(res.status).toBe(204);
    expect(recordActivityMock.mock.calls[0]![0].what).toBe("Work webhook deleted");
  });

  it("rotate-secret returns the new secret once and audits without it", async () => {
    const res = await request(app(user("owner"))).post("/api/pm/webhooks/hook-1/rotate-secret").send({});
    expect(res.body).toEqual({ webhook: WEBHOOK, secret: SECRET });
    expect(recordActivityMock.mock.calls[0]![0].what).toBe("Work webhook secret rotated");
    expect(JSON.stringify(recordActivityMock.mock.calls)).not.toContain(SECRET);
  });

  it("no GET ever returns a secret", async () => {
    for (const path of ["/api/pm/webhooks", "/api/pm/webhooks/hook-1", "/api/pm/webhooks/hook-1/deliveries"]) {
      const res = await request(app(user("owner"))).get(path);
      expect(JSON.stringify(res.body), path).not.toMatch(/whsec_|secret/i);
    }
  });

  it("test answers 200 whatever the receiver said — the result is the body — and passes the actor", async () => {
    vi.mocked(svc.sendTestDelivery).mockResolvedValue({ ...DELIVERY, status: "GIVEN_UP", lastError: "Blocked by egress setting" });
    const res = await request(app(user("owner", "olga"))).post("/api/pm/webhooks/hook-1/test").send({});
    expect(res.status).toBe(200);
    expect(res.body.delivery).toMatchObject({ status: "GIVEN_UP", lastError: "Blocked by egress setting" });
    expect(vi.mocked(svc.sendTestDelivery).mock.calls[0]![2]).toEqual({ id: "user-owner", name: "Display olga" });
  });

  it("deliveries pages with limit and cursor, and bounds the limit", async () => {
    const res = await request(app(user("owner"))).get("/api/pm/webhooks/hook-1/deliveries?limit=25&cursor=abc");
    expect(res.status).toBe(200);
    expect(svc.listDeliveries).toHaveBeenCalledWith(expect.anything(), "hook-1", { limit: 25, cursor: "abc" });
    expect((await request(app(user("owner"))).get("/api/pm/webhooks/hook-1/deliveries?limit=500")).status).toBe(400);
    expect((await request(app(user("owner"))).get("/api/pm/webhooks/hook-1/deliveries?limit=0")).status).toBe(400);
  });

  it("redeliver answers 202 with the new delivery; an unknown row is a 404", async () => {
    const res = await request(app(user("owner"))).post("/api/pm/webhooks/hook-1/deliveries/d-1/redeliver").send({});
    expect(res.status).toBe(202);
    expect(res.body.delivery.id).toBe("d-1");
    vi.mocked(svc.redeliver).mockRejectedValue(new Error(svc.PM_WEBHOOK_ERRORS.DELIVERY_NOT_FOUND));
    expect((await request(app(user("owner"))).post("/api/pm/webhooks/hook-1/deliveries/nope/redeliver").send({})).status).toBe(404);
  });
});
