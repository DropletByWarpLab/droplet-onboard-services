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

import { createModelsRouter } from "../routes/models.js";
import { getModelsPagePayload } from "../services/models-summary.service.js";

function buildApp(asUser: { username?: string; role?: string }) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: typeof asUser }).user = asUser;
    next();
  });
  app.use("/api", createModelsRouter());
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

  it("DELETE /api/models/:name 404s — read-only enforcement", async () => {
    listModelsMock.mockResolvedValue({ models: [] });
    const app = buildApp({ username: "stefan", role: "owner" });
    const res = await request(app).delete("/api/models/llama3.1");
    expect(res.status).toBe(404);
  });
});
