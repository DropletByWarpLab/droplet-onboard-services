/**
 * WARP-471 — /api/models READ-ONLY surface (Phase F3).
 *
 * Two layers:
 *   - Service: getModelsPagePayload composes from ai-gateway + static
 *     cloud catalogue. Mock ai-gateway.listModels and snapshot the
 *     shape.
 *   - Route: GET returns 200 + payload. Asserts no PATCH/POST/DELETE
 *     handlers registered (one-model rule enforcement).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false, AI_GATEWAY_URL: "http://ai-gateway:8000" },
}));

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
}));

const listModelsMock = vi.fn();
vi.mock("../services/ai-gateway.client.js", () => ({
  listModels: () => listModelsMock(),
}));

// WARP-1112 — the active-model PATCH audits via recordActivity. Mock it so
// tests don't touch the real activity singleton (which needs a DB).
const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));

import { createModelsRouter } from "../routes/models.js";
import { getModelsPagePayload } from "../services/models-summary.service.js";

/**
 * Minimal prisma stub backing the `ai.model.chat` WorkspaceSetting. Starts at
 * `initialActive` (null = unset) and mutates on upsert so a GET-after-PATCH
 * round-trips in-test.
 */
function createPrismaMock(initialActive: string | null = null) {
  let active = initialActive;
  return {
    workspaceSetting: {
      findUnique: vi.fn(async () =>
        active == null ? null : { valueJson: active },
      ),
      upsert: vi.fn(async ({ update }: { update: { valueJson: string } }) => {
        active = update.valueJson;
        return {};
      }),
    },
    _active: () => active,
  };
}

function buildApp(
  asUser: { username?: string; role?: string },
  prismaMock: ReturnType<typeof createPrismaMock> = createPrismaMock(),
) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { user?: typeof asUser }).user = asUser;
    next();
  });
  app.use("/api", createModelsRouter(prismaMock as never));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("WARP-471 — models page payload", () => {
  it("composes local list from ai-gateway with family inference", async () => {
    listModelsMock.mockResolvedValue({
      models: [
        { id: "1", provider: "ollama", name: "gpt-oss:20b", context_window: 8192 },
        { id: "2", provider: "ollama", name: "llama3.1:70b", context_window: 131072 },
        { id: "3", provider: "ollama", name: "qwen2.5:32b", context_window: null },
      ],
    });
    const payload = await getModelsPagePayload();
    expect(payload.local).toHaveLength(3);
    expect(payload.local[0]?.family).toBe("gpt-oss");
    expect(payload.local[1]?.family).toBe("llama");
    expect(payload.local[2]?.family).toBe("qwen");
    expect(payload.local[0]?.status).toBe("ready");
  });

  it("returns 3 cloud providers all default-off", async () => {
    listModelsMock.mockResolvedValue({ models: [] });
    const payload = await getModelsPagePayload();
    expect(payload.cloud.map((c) => c.provider).sort()).toEqual([
      "anthropic",
      "gemini",
      "openai",
    ]);
    expect(payload.cloud.every((c) => c.enabled === false)).toBe(true);
    expect(payload.cloud.every((c) => c.spendUsd === 0)).toBe(true);
  });

  it("degrades gracefully when ai-gateway is unreachable", async () => {
    listModelsMock.mockRejectedValue(new Error("connection refused"));
    const payload = await getModelsPagePayload();
    expect(payload.local).toEqual([]);
    expect(payload.cloud).toHaveLength(3);
    expect(payload.gpu).toBeNull();
    expect(payload.cloudSpendUsd).toBe(0);
  });

  // ── WARP-1289 — honest degraded signal (same blindspot WARP-1284 fixed
  //    for the wizard): an empty local list from a DOWN gateway must carry
  //    `degraded: true`, never masquerade as "no local models". ──

  it("flags degraded when ai-gateway is unreachable (WARP-1289)", async () => {
    listModelsMock.mockRejectedValue(new Error("connection refused"));
    const payload = await getModelsPagePayload();
    expect(payload.local).toEqual([]);
    expect(payload.degraded).toBe(true);
  });

  it("flags degraded when the gateway reports its ollama provider failed (WARP-1289)", async () => {
    listModelsMock.mockResolvedValue({
      models: [],
      degraded_providers: ["ollama"],
    });
    const payload = await getModelsPagePayload();
    expect(payload.local).toEqual([]);
    expect(payload.degraded).toBe(true);
  });

  it("does NOT flag degraded for a cloud-only provider failure (WARP-1289)", async () => {
    // Parity with GET /api/llm/models: only ollama serves LOCAL models, so a
    // cloud provider erroring during the gateway's listing fan-out does not
    // impugn the local list.
    listModelsMock.mockResolvedValue({
      models: [
        { id: "1", provider: "ollama", name: "llama3.1:70b", context_window: 131072 },
      ],
      degraded_providers: ["openai"],
    });
    const payload = await getModelsPagePayload();
    expect(payload.local).toHaveLength(1);
    expect(payload.degraded).toBe(false);
  });

  it("healthy listing reports degraded: false (WARP-1289)", async () => {
    listModelsMock.mockResolvedValue({
      models: [
        { id: "1", provider: "ollama", name: "llama3.1:70b", context_window: 131072 },
      ],
    });
    const payload = await getModelsPagePayload();
    expect(payload.degraded).toBe(false);
  });

  it("placeholder fields return safe defaults (gpu null, avg latency 0)", async () => {
    listModelsMock.mockResolvedValue({ models: [] });
    const payload = await getModelsPagePayload();
    expect(payload.gpu).toBeNull();
    expect(payload.avgLatencyMs).toBe(0);
    expect(payload.cloudSpendUsd).toBe(0);
  });
});

describe("WARP-471 — /api/models route", () => {
  it("GET returns 200 + payload shape", async () => {
    listModelsMock.mockResolvedValue({
      models: [{ id: "1", provider: "ollama", name: "llama3.1:70b", context_window: 131072 }],
    });
    const app = buildApp({ username: "stefan", role: "family" });
    const res = await request(app).get("/api/models");
    expect(res.status).toBe(200);
    expect(res.body.local).toHaveLength(1);
    expect(res.body.cloud).toHaveLength(3);
    expect(res.body.gpu).toBeNull();
  });

  it("serves a degraded payload UNCACHED so it self-heals (WARP-1289)", async () => {
    // Mirror of the WARP-1284 rule on /api/llm/models: never cache the
    // degraded fallback — the next request retries the gateway so the page
    // recovers the moment the AI service is reachable again.
    const { cacheSet } = await import("../services/cache.service.js");
    listModelsMock.mockRejectedValue(new Error("connection refused"));
    const app = buildApp({ username: "stefan", role: "family" });
    const res = await request(app).get("/api/models");
    expect(res.status).toBe(200);
    expect(res.body.degraded).toBe(true);
    expect(res.body.local).toEqual([]);
    expect(vi.mocked(cacheSet)).not.toHaveBeenCalled();
  });

  it("caches a healthy payload (WARP-1289 leaves the happy path alone)", async () => {
    const { cacheSet } = await import("../services/cache.service.js");
    listModelsMock.mockResolvedValue({ models: [] });
    const app = buildApp({ username: "stefan", role: "family" });
    const res = await request(app).get("/api/models");
    expect(res.status).toBe(200);
    expect(res.body.degraded).toBe(false);
    expect(vi.mocked(cacheSet)).toHaveBeenCalledTimes(1);
  });

  it("PATCH /api/models 404s — read-only enforcement", async () => {
    listModelsMock.mockResolvedValue({ models: [] });
    const app = buildApp({ username: "stefan", role: "owner" });
    const res = await request(app).patch("/api/models").send({ name: "foo" });
    expect(res.status).toBe(404);
  });

  it("POST /api/models 404s — read-only enforcement", async () => {
    listModelsMock.mockResolvedValue({ models: [] });
    const app = buildApp({ username: "stefan", role: "owner" });
    const res = await request(app).post("/api/models").send({});
    expect(res.status).toBe(404);
  });

  it("DELETE /api/models/:name 404s — no delete/pull on this surface", async () => {
    listModelsMock.mockResolvedValue({ models: [] });
    const app = buildApp({ username: "stefan", role: "owner" });
    const res = await request(app).delete("/api/models/llama3.1");
    expect(res.status).toBe(404);
  });
});

describe("WARP-1112 — PATCH /api/models/active", () => {
  const installed = {
    models: [
      { id: "gpt-oss:20b", provider: "ollama", name: "gpt-oss:20b", context_window: 131072 },
      { id: "llama3.2:3b", provider: "ollama", name: "llama3.2:3b", context_window: 131072 },
    ],
  };

  it("owner sets an installed model → 200, persists, audits", async () => {
    listModelsMock.mockResolvedValue(installed);
    const prisma = createPrismaMock(null);
    const app = buildApp({ username: "stefan", role: "owner" }, prisma);
    const res = await request(app)
      .patch("/api/models/active")
      .send({ model: "llama3.2:3b" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ activeModel: "llama3.2:3b", changed: true });
    expect(prisma._active()).toBe("llama3.2:3b");
    expect(prisma.workspaceSetting.upsert).toHaveBeenCalledTimes(1);
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
  });

  it("admin is allowed too", async () => {
    listModelsMock.mockResolvedValue(installed);
    const app = buildApp(
      { username: "ada", role: "admin" },
      createPrismaMock(null),
    );
    const res = await request(app)
      .patch("/api/models/active")
      .send({ model: "gpt-oss:20b" });
    expect(res.status).toBe(200);
  });

  it("re-selecting the current model is a no-op (no write, no audit)", async () => {
    listModelsMock.mockResolvedValue(installed);
    const prisma = createPrismaMock("gpt-oss:20b");
    const app = buildApp({ username: "stefan", role: "owner" }, prisma);
    const res = await request(app)
      .patch("/api/models/active")
      .send({ model: "gpt-oss:20b" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ activeModel: "gpt-oss:20b", changed: false });
    expect(prisma.workspaceSetting.upsert).not.toHaveBeenCalled();
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("rejects a model that isn't installed → 400 not_installed", async () => {
    listModelsMock.mockResolvedValue(installed);
    const prisma = createPrismaMock(null);
    const app = buildApp({ username: "stefan", role: "owner" }, prisma);
    const res = await request(app)
      .patch("/api/models/active")
      .send({ model: "gemma4:26b" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("not_installed");
    expect(prisma.workspaceSetting.upsert).not.toHaveBeenCalled();
  });

  it("rejects a cloud model — the active model is local-only → 400", async () => {
    listModelsMock.mockResolvedValue({
      models: [
        { id: "gpt-oss:20b", provider: "ollama", name: "gpt-oss:20b", context_window: 131072 },
        { id: "claude-sonnet", provider: "anthropic", name: "claude-sonnet", context_window: 200000 },
      ],
    });
    const app = buildApp(
      { username: "stefan", role: "owner" },
      createPrismaMock(null),
    );
    const res = await request(app)
      .patch("/api/models/active")
      .send({ model: "claude-sonnet" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("not_installed");
  });

  it("empty / missing model → 400", async () => {
    listModelsMock.mockResolvedValue(installed);
    const app = buildApp(
      { username: "stefan", role: "owner" },
      createPrismaMock(null),
    );
    const blank = await request(app)
      .patch("/api/models/active")
      .send({ model: "  " });
    expect(blank.status).toBe(400);
    const missing = await request(app).patch("/api/models/active").send({});
    expect(missing.status).toBe(400);
  });

  it("members (family) are forbidden → 403", async () => {
    listModelsMock.mockResolvedValue(installed);
    const prisma = createPrismaMock(null);
    const app = buildApp({ username: "kid", role: "family" }, prisma);
    const res = await request(app)
      .patch("/api/models/active")
      .send({ model: "gpt-oss:20b" });
    expect(res.status).toBe(403);
    expect(prisma.workspaceSetting.upsert).not.toHaveBeenCalled();
  });

  it("gateway unreachable → 503 (can't confirm installed, so refuse)", async () => {
    listModelsMock.mockRejectedValue(new Error("connection refused"));
    const prisma = createPrismaMock(null);
    const app = buildApp({ username: "stefan", role: "owner" }, prisma);
    const res = await request(app)
      .patch("/api/models/active")
      .send({ model: "gpt-oss:20b" });
    expect(res.status).toBe(503);
    expect(prisma.workspaceSetting.upsert).not.toHaveBeenCalled();
  });

  it("GET /api/models surfaces the active model when it's installed", async () => {
    listModelsMock.mockResolvedValue(installed);
    const prisma = createPrismaMock("llama3.2:3b");
    const app = buildApp({ username: "stefan", role: "family" }, prisma);
    const res = await request(app).get("/api/models");
    expect(res.status).toBe(200);
    expect(res.body.activeModel).toBe("llama3.2:3b");
  });

  it("GET /api/models resolves activeModel to null when the stored tag isn't installed", async () => {
    listModelsMock.mockResolvedValue(installed);
    // Stored model was since removed from the box.
    const prisma = createPrismaMock("gemma4:26b");
    const app = buildApp({ username: "stefan", role: "family" }, prisma);
    const res = await request(app).get("/api/models");
    expect(res.status).toBe(200);
    expect(res.body.activeModel).toBeNull();
  });
});
