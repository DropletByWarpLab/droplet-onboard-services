/**
 * WARP-3127 — `POST /api/llm/warm`: start loading the box's active model the
 * moment the voice module hears the wake word, so the (re)load after the 5 min
 * residency (WARP-1826) overlaps the user speaking + STT.
 *
 * Covers:
 *   - guard: the pinned `_service:voice` principal, owner and admin are
 *     admitted; family, guest and every OTHER service principal are 403 and
 *     never start a warm;
 *   - 202 IMMEDIATELY with the advisory `{ state }`, the warm fire-and-forget
 *     (a load that never finishes does not hold the response);
 *   - through the real on-demand warm with the runtime's fetch mocked: warm
 *     fired when cold, no warm when loaded, ONE warm under concurrent wakes,
 *     DMR registry-qualified names matched, runtime unreachable → still 202;
 *   - the default wiring resolves the ACTIVE model (active-model.service).
 *
 * Harness: req.user injected upstream of the router (admin-retrieval-eval
 * pattern). The router's `warm` dependency is injected so each case names its
 * model; the default is pinned separately.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";

// middleware/auth.ts reads config at module load.
vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    NEXTCLOUD_URL: "http://nextcloud.test",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

const warmActiveModelOnDemand = vi.hoisted(() => vi.fn(async (_prisma: unknown) => undefined));
vi.mock("../services/active-model.service.js", () => ({ warmActiveModelOnDemand }));

import { createLlmWarmRouter } from "./llm-warm.js";
import type { AuthUser } from "../middleware/auth.js";
import {
  resetWarmStateForTests,
  warmModelIfCold,
  type OnDemandWarmOutcome,
} from "../services/model-readiness.service.js";

function mkUser(role: AuthUser["role"], id = `user-${role}`): AuthUser {
  return { id, username: id, displayName: id, role };
}

const VOICE = mkUser("service", "_service:voice");
const GPT = "gpt-oss:20b";

function buildApp(
  user: AuthUser | null,
  deps: Parameters<typeof createLlmWarmRouter>[1] = {},
  prisma = {} as PrismaClient,
) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (user) (req as Request & { user: AuthUser }).user = user;
    next();
  });
  app.use("/api", createLlmWarmRouter(prisma, deps));
  return app;
}

/** Records every on-demand job the router kicks, so a test can await it. */
function trackedWarm(model: string) {
  const jobs: Promise<OnDemandWarmOutcome>[] = [];
  return {
    jobs,
    warm: () => {
      const job = warmModelIfCold(model);
      jobs.push(job);
      return job;
    },
  };
}

type ListAnswer = unknown[] | Error;

/** Runtime fetch: /api/ps + /api/tags feed the probe, /v1/chat/completions is the warm. */
function runtimeFetch(opts: { loaded: ListAnswer; installed: ListAnswer; warm?: () => Promise<Response> }) {
  const list = (v: ListAnswer): Promise<Response> =>
    v instanceof Error
      ? Promise.reject(v)
      : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ models: v }) } as unknown as Response);
  return vi.fn((url: string, _init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/api/ps")) return list(opts.loaded);
    if (u.endsWith("/api/tags")) return list(opts.installed);
    if (u.endsWith("/v1/chat/completions")) {
      return opts.warm
        ? opts.warm()
        : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) } as unknown as Response);
    }
    return Promise.reject(new Error(`unexpected fetch ${u}`));
  });
}

function warmBodies(fetchMock: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter((c) => String(c[0]).endsWith("/v1/chat/completions"))
    .map((c) => JSON.parse((c[1] as RequestInit).body as string) as Record<string, unknown>);
}

const realFetch = global.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  resetWarmStateForTests();
});

afterEach(() => {
  global.fetch = realFetch;
});

describe("POST /api/llm/warm — guard: requireRoleOrService('_service:voice', 'owner', 'admin')", () => {
  it.each([
    ["the voice service principal", VOICE],
    ["an owner", mkUser("owner")],
    ["an admin", mkUser("admin")],
  ])("admits %s with 202 and starts a warm", async (_label, user) => {
    const warm = vi.fn(async () => undefined);
    const res = await request(buildApp(user, { warm })).post("/api/llm/warm").send({});
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(warm).toHaveBeenCalledTimes(1));
  });

  it.each(["family", "guest"] as const)("403s the %s role and starts nothing", async (role) => {
    const warm = vi.fn(async () => undefined);
    const res = await request(buildApp(mkUser(role), { warm })).post("/api/llm/warm").send({});
    expect(res.status).toBe(403);
    await new Promise((r) => setImmediate(r));
    expect(warm).not.toHaveBeenCalled();
  });

  it.each(["_service:mcp", "_service:email", "_service:display"])(
    "403s the non-voice service principal %s",
    async (id) => {
      const warm = vi.fn(async () => undefined);
      const res = await request(buildApp(mkUser("service", id), { warm })).post("/api/llm/warm").send({});
      expect(res.status).toBe(403);
      await new Promise((r) => setImmediate(r));
      expect(warm).not.toHaveBeenCalled();
    },
  );

  it("does not admit the voice id without the service role", async () => {
    const warm = vi.fn(async () => undefined);
    const res = await request(buildApp(mkUser("family", "_service:voice"), { warm }))
      .post("/api/llm/warm")
      .send({});
    expect(res.status).toBe(403);
  });

  it("403s a request with no session principal", async () => {
    const res = await request(buildApp(null, { warm: vi.fn() })).post("/api/llm/warm").send({});
    expect(res.status).toBe(403);
  });
});

describe("POST /api/llm/warm — 202 immediately, work fire-and-forget", () => {
  it("answers 202 with the advisory state before the load finishes", async () => {
    // A load that never completes (a wedged runtime) must not hold the reply.
    const warm = vi.fn(() => new Promise<void>(() => undefined));
    const res = await request(buildApp(VOICE, { warm, state: () => "warming" })).post("/api/llm/warm").send({});
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ state: "warming" });
  });

  it.each(["warm", "warming", "unknown"] as const)("passes the %s state through", async (state) => {
    const res = await request(buildApp(VOICE, { warm: vi.fn(async () => undefined), state: () => state }))
      .post("/api/llm/warm")
      .send({});
    expect(res.body).toEqual({ state });
  });

  it("a warm that rejects or throws synchronously is swallowed (202, no unhandled rejection)", async () => {
    const rejecting = vi.fn(() => Promise.reject(new Error("boom")));
    const throwing = vi.fn(() => {
      throw new Error("sync boom");
    });
    const a = await request(buildApp(VOICE, { warm: rejecting })).post("/api/llm/warm").send({});
    const b = await request(buildApp(VOICE, { warm: throwing })).post("/api/llm/warm").send({});
    expect([a.status, b.status]).toEqual([202, 202]);
    await vi.waitFor(() => expect(rejecting).toHaveBeenCalled());
    await vi.waitFor(() => expect(throwing).toHaveBeenCalled());
  });

  it("an unreadable state still answers 202 'unknown'", async () => {
    const res = await request(
      buildApp(VOICE, {
        warm: vi.fn(async () => undefined),
        state: () => {
          throw new Error("state read failed");
        },
      }),
    )
      .post("/api/llm/warm")
      .send({});
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ state: "unknown" });
  });

  it("default wiring warms the box's ACTIVE model (active-model.service)", async () => {
    const prisma = { marker: "prisma" } as unknown as PrismaClient;
    const res = await request(buildApp(VOICE, {}, prisma)).post("/api/llm/warm").send({});
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(warmActiveModelOnDemand).toHaveBeenCalledWith(prisma));
  });

  it("default state is 'unknown' on a box that has not warmed anything yet", async () => {
    const res = await request(buildApp(VOICE)).post("/api/llm/warm").send({});
    expect(res.body).toEqual({ state: "unknown" });
  });
});

describe("POST /api/llm/warm — probe-first on-demand warm (real service, runtime mocked)", () => {
  it("cold model: 202, then ONE warm of that model with no keep_alive", async () => {
    const fetchMock = runtimeFetch({ loaded: [], installed: [{ name: GPT }] });
    global.fetch = fetchMock as unknown as typeof fetch;
    const t = trackedWarm(GPT);

    const res = await request(buildApp(VOICE, { warm: t.warm })).post("/api/llm/warm").send({});
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(t.jobs).toHaveLength(1));
    await expect(t.jobs[0]).resolves.toBe("warmed");

    const bodies = warmBodies(fetchMock);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.model).toBe(GPT);
    expect(bodies[0]).not.toHaveProperty("keep_alive");
  });

  it("loaded model: 202 and no warm", async () => {
    const fetchMock = runtimeFetch({ loaded: [{ name: GPT }], installed: [{ name: GPT }] });
    global.fetch = fetchMock as unknown as typeof fetch;
    const t = trackedWarm(GPT);

    const res = await request(buildApp(VOICE, { warm: t.warm })).post("/api/llm/warm").send({});
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(t.jobs).toHaveLength(1));
    await expect(t.jobs[0]).resolves.toBe("loaded");
    expect(warmBodies(fetchMock)).toEqual([]);
  });

  it("concurrent wakes: every call is 202, exactly ONE load reaches the runtime", async () => {
    let finish: () => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      finish = () =>
        resolve({ ok: true, status: 200, json: () => Promise.resolve({}) } as unknown as Response);
    });
    const fetchMock = runtimeFetch({ loaded: [], installed: [{ name: GPT }], warm: () => pending });
    global.fetch = fetchMock as unknown as typeof fetch;
    const t = trackedWarm(GPT);
    const app = buildApp(VOICE, { warm: t.warm });

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => request(app).post("/api/llm/warm").send({})),
    );
    expect(responses.map((r) => r.status)).toEqual([202, 202, 202, 202, 202]);
    await vi.waitFor(() => expect(t.jobs).toHaveLength(5));
    await vi.waitFor(() => expect(warmBodies(fetchMock)).toHaveLength(1));
    finish();

    await Promise.all(t.jobs);
    expect(warmBodies(fetchMock)).toHaveLength(1);
  });

  it("DMR: a registry-qualified /api/ps entry matches the active model, so no reload", async () => {
    const fetchMock = runtimeFetch({
      loaded: [{ name: "docker.io/ai/gpt-oss:20B-F16", model: "docker.io/ai/gpt-oss:20B-F16" }],
      installed: [{ name: "docker.io/ai/gpt-oss:20B-F16" }],
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const t = trackedWarm("ai/gpt-oss:20B-F16");

    await request(buildApp(VOICE, { warm: t.warm })).post("/api/llm/warm").send({});
    await vi.waitFor(() => expect(t.jobs).toHaveLength(1));
    await expect(t.jobs[0]).resolves.toBe("loaded");
    expect(warmBodies(fetchMock)).toEqual([]);
  });

  it("runtime unreachable: still 202, the job settles without throwing", async () => {
    global.fetch = vi.fn(() => Promise.reject(new Error("connect ECONNREFUSED"))) as unknown as typeof fetch;
    const t = trackedWarm(GPT);

    const res = await request(buildApp(VOICE, { warm: t.warm })).post("/api/llm/warm").send({});
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(t.jobs).toHaveLength(1));
    await expect(t.jobs[0]).resolves.toBe("warm-failed");
  });
});
