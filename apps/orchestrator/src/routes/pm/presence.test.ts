/**
 * WARP-3536 — POST/GET /api/pm/work-items/:id/presence.
 *
 * Mounted on a bare Express app with a stub auth middleware, like the other PM
 * route suites. The module gate and the guest tier floor are mounted by
 * `mountModuleGates` off the `/api/pm` prefix in the real app (pinned by
 * module-mounts.test.ts); what is checked here is the route's own contract:
 * the same read check as the item, an existing item, a human viewer, and a
 * rate limit.
 */
import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { NextFunction, Request, Response } from "express";
import type { AuthUser } from "../../middleware/auth.js";
import { createRateLimit } from "../../middleware/rate-limit.js";
import { createPresenceStore } from "../../services/pm/pm-presence.js";
import { createPmPresenceRouter } from "./presence.js";

const ITEMS = new Set(["wi-1", "wi-2"]);
const GUEST_ASSIGNED = new Set(["wi-1"]); // wi-1 is assigned to the guest, wi-2 is not

const prisma = {
  pmWorkItem: {
    findUnique: async ({ where }: { where: { id: string } }) => (ITEMS.has(where.id) ? { id: where.id } : null),
  },
  pmWorkItemAssignee: {
    findFirst: async ({ where }: { where: { workItemId: string; userId: string } }) =>
      where.userId === "u-guest" && GUEST_ASSIGNED.has(where.workItemId) ? { id: "a" } : null,
  },
};

function user(over: Partial<AuthUser> & { id: string; role: AuthUser["role"] }): AuthUser {
  return { username: over.id, displayName: over.id, ...over } as AuthUser;
}

function app(who: AuthUser | null, store = createPresenceStore(), opts: { rateLimit?: express.RequestHandler } = {}) {
  const a = express();
  a.use(express.json());
  a.use((req: Request, _res: Response, next: NextFunction) => {
    if (who) req.user = who;
    next();
  });
  a.use("/api", createPmPresenceRouter(prisma as never, { store, ...opts }));
  return { app: a, store };
}

describe("POST /pm/work-items/:id/presence — the heartbeat", () => {
  it("records the caller and answers with everybody ELSE who is on the item", async () => {
    const store = createPresenceStore();
    store.beat("wi-1", "u-ben");

    const res = await request(app(user({ id: "u-ana", role: "family" }), store).app).post("/api/pm/work-items/wi-1/presence");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ viewers: ["u-ben"] });
    expect(store.others("wi-1", "someone-else")).toEqual(["u-ben", "u-ana"]);
  });

  it("answers an empty list when nobody else is there", async () => {
    const res = await request(app(user({ id: "u-ana", role: "owner" })).app).post("/api/pm/work-items/wi-1/presence");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ viewers: [] });
  });

  it("is 404 for an item that does not exist, and records nothing", async () => {
    const { app: a, store } = app(user({ id: "u-ana", role: "family" }));
    const res = await request(a).post("/api/pm/work-items/nope/presence");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "work_item_not_found" });
    expect(store.size()).toBe(0);
  });

  it("is refused for the service principal: there is nobody to show", async () => {
    const { app: a, store } = app(user({ id: "_service:mcp", role: "service" }));
    const res = await request(a).post("/api/pm/work-items/wi-1/presence");
    expect(res.status).toBe(403);
    expect(store.size()).toBe(0);
  });

  it("is refused without a session", async () => {
    const res = await request(app(null).app).post("/api/pm/work-items/wi-1/presence");
    expect(res.status).toBe(401);
  });

  it("carries the item's own read check: a guest passes only on an item assigned to them", async () => {
    const guest = user({ id: "u-guest", role: "guest" });
    const shared = await request(app(guest).app).post("/api/pm/work-items/wi-1/presence");
    expect(shared.status).toBe(200);

    const { app: a, store } = app(guest);
    const other = await request(a).post("/api/pm/work-items/wi-2/presence");
    expect(other.status).toBe(404);
    expect(other.body).toEqual({ error: "module_disabled", module: "projects" });
    expect(store.size()).toBe(0);
  });
});

describe("GET /pm/work-items/:id/presence — a read", () => {
  it("lists the others without joining the item", async () => {
    const store = createPresenceStore();
    store.beat("wi-1", "u-ben");

    const res = await request(app(user({ id: "u-ana", role: "family" }), store).app).get("/api/pm/work-items/wi-1/presence");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ viewers: ["u-ben"] });
    expect(store.others("wi-1", "x")).toEqual(["u-ben"]); // u-ana was NOT recorded
  });

  it("never lists the caller", async () => {
    const store = createPresenceStore();
    store.beat("wi-1", "u-ana");
    const res = await request(app(user({ id: "u-ana", role: "family" }), store).app).get("/api/pm/work-items/wi-1/presence");
    expect(res.body).toEqual({ viewers: [] });
  });

  it("is 404 for an item that does not exist", async () => {
    const res = await request(app(user({ id: "u-ana", role: "family" })).app).get("/api/pm/work-items/nope/presence");
    expect(res.status).toBe(404);
  });
});

describe("rate limiting", () => {
  it("is on by default (the draft-8 RateLimit headers are sent)", async () => {
    const res = await request(app(user({ id: "u-ana", role: "family" })).app).post("/api/pm/work-items/wi-1/presence");
    expect(res.headers["ratelimit"]).toBeTruthy();
    expect(res.headers["ratelimit-policy"]).toBeTruthy();
  });

  describe("past the ceiling", () => {
    let limited: express.Express;
    beforeEach(() => {
      limited = app(user({ id: "u-ana", role: "family" }), createPresenceStore(), {
        rateLimit: createRateLimit("pm-presence-test", { windowMs: 60_000, limit: 2 }),
      }).app;
    });

    it("answers 429 and records nothing more", async () => {
      expect((await request(limited).post("/api/pm/work-items/wi-1/presence")).status).toBe(200);
      expect((await request(limited).get("/api/pm/work-items/wi-1/presence")).status).toBe(200);
      const res = await request(limited).post("/api/pm/work-items/wi-1/presence");
      expect(res.status).toBe(429);
      expect(res.body).toEqual({ error: "Too many requests, slow down" });
    });
  });
});
