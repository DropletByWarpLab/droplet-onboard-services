/**
 * WARP-3299 — deleting a chat that started a background run which is still
 * working. Without `cancelRuns` the route answers 409 with the live runs so
 * the client can ask; `cancelRuns=true` stops them first, `false` keeps them.
 * A chat with no live run deletes exactly as before.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false, agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));
vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/mqtt.service.js", () => ({ publish: vi.fn() }));
vi.mock("../services/activity.singleton.js", () => ({ recordActivity: vi.fn().mockResolvedValue(null) }));

const { deleteConversationForUser, cancelAgentRun } = vi.hoisted(() => ({
  deleteConversationForUser: vi.fn(),
  cancelAgentRun: vi.fn(),
}));
vi.mock("../services/chat-persistence.service.js", () => ({
  ChatPersistenceService: vi.fn().mockImplementation(function () { return { deleteConversationForUser }; }),
}));
vi.mock("../services/agent-run-worker.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/agent-run-worker.service.js")>()),
  cancelAgentRun,
}));

import { createLlmRouter } from "../routes/llm.js";

const owner = { id: "owner-uuid", username: "romain", role: "owner" };

function buildApp(liveRuns: { id: string; title: string; status: string }[]) {
  const findMany = vi.fn().mockResolvedValue(liveRuns);
  const prisma = {
    agentRun: { findMany },
    businessProfile: { findUnique: vi.fn().mockResolvedValue(null) },
  };
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { user: typeof owner }).user = owner;
    next();
  });
  app.use("/api", createLlmRouter(prisma as unknown as import("@prisma/client").PrismaClient));
  return { app, findMany };
}

const live = [{ id: "run-1", title: "Supplier price check", status: "running" }];

beforeEach(() => {
  vi.clearAllMocks();
  deleteConversationForUser.mockResolvedValue(true);
  cancelAgentRun.mockResolvedValue(true);
});

describe("DELETE /api/llm/conversations/:id with live background runs (WARP-3299)", () => {
  it("a chat with no live run deletes as before", async () => {
    const { app, findMany } = buildApp([]);
    const res = await request(app).delete("/api/llm/conversations/conv-1");
    expect(res.status).toBe(200);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ sessionId: "conv-1", userId: "owner-uuid" }) }),
    );
    expect(deleteConversationForUser).toHaveBeenCalledWith("conv-1", "romain");
  });

  it("without cancelRuns, answers 409 with the live runs and deletes nothing", async () => {
    const { app } = buildApp(live);
    const res = await request(app).delete("/api/llm/conversations/conv-1");
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "conversation_has_live_runs", runs: live });
    expect(deleteConversationForUser).not.toHaveBeenCalled();
    expect(cancelAgentRun).not.toHaveBeenCalled();
  });

  it("cancelRuns=true stops the runs, then deletes", async () => {
    const { app } = buildApp(live);
    const res = await request(app).delete("/api/llm/conversations/conv-1").query({ cancelRuns: "true" });
    expect(res.status).toBe(200);
    expect(cancelAgentRun).toHaveBeenCalledWith(expect.anything(), "run-1");
    expect(deleteConversationForUser).toHaveBeenCalled();
  });

  it("cancelRuns=false keeps the runs and deletes the chat", async () => {
    const { app } = buildApp(live);
    const res = await request(app).delete("/api/llm/conversations/conv-1").query({ cancelRuns: "false" });
    expect(res.status).toBe(200);
    expect(cancelAgentRun).not.toHaveBeenCalled();
    expect(deleteConversationForUser).toHaveBeenCalled();
  });
});
