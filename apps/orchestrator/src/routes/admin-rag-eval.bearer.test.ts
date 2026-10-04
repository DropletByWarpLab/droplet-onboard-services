/**
 * WARP-3625 — the rag-eval trigger server fails closed without a shared
 * bearer, so the orchestrator's admin proxy must present it.
 *
 * MUTATION: drop serviceBearerHeader() from admin-rag-eval.ts proxy() and the
 * first case goes red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express, { type NextFunction, type Request, type Response } from "express";

const internalFetchMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/internal-tls.js", () => ({
  internalFetch: internalFetchMock,
  internalBaseUrl: (u: string) => u,
}));
vi.mock("../middleware/auth.js", () => ({ recordAccessDenied: vi.fn() }));

import { createAdminRagEvalRouter } from "./admin-rag-eval.js";
import type { Role } from "../services/jwt.service.js";

function ownerApp() {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: unknown }).user = {
      id: "u1",
      username: "owner",
      displayName: "Owner",
      role: "owner" as Role,
    };
    next();
  });
  app.use("/api", createAdminRagEvalRouter());
  return app;
}

const ORIGINAL_URL = process.env.RAG_EVAL_URL;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.RAG_EVAL_URL = "http://rag-eval.test:8090";
  internalFetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => "[]",
  });
});

afterEach(() => {
  delete process.env.RAG_EVAL_SERVICE_TOKEN;
  if (ORIGINAL_URL === undefined) delete process.env.RAG_EVAL_URL;
  else process.env.RAG_EVAL_URL = ORIGINAL_URL;
});

describe("rag-eval service bearer (WARP-3625)", () => {
  it("presents RAG_EVAL_SERVICE_TOKEN upstream", async () => {
    process.env.RAG_EVAL_SERVICE_TOKEN = "rag-eval-secret";
    await request(ownerApp()).get("/api/admin/rag-eval/runs");
    const init = internalFetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer rag-eval-secret",
    );
  });

  it("sends no Authorization header when the token is unset", async () => {
    await request(ownerApp()).get("/api/admin/rag-eval/runs");
    const init = internalFetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});
