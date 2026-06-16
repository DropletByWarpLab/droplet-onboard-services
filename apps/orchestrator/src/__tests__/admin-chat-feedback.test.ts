/**
 * WARP-844 follow-up — admin chat-feedback surface. Rated assistant
 * turns (ChatMessage.feedback) paired with their turn's user prompt,
 * for the /admin/rag-eval loop. Owner/admin only.
 */
import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

vi.mock("../middleware/auth.js", () => ({
  requireRole:
    (...roles: string[]) =>
    (req: Request, res: Response, next: NextFunction) => {
      const role = (req as Request & { user?: { role?: string } }).user?.role;
      if (!role || !roles.includes(role)) {
        res.status(403).json({ error: "forbidden" });
        return;
      }
      next();
    },
}));

import { createAdminChatFeedbackRouter } from "../routes/admin-chat-feedback.js";

interface Row {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  turnId: string | null;
  feedback: "up" | "down" | null;
  createdAt: Date;
  session?: { id: string; title: string | null; model: string | null };
}

function buildApp(rows: Row[], role: string) {
  const prisma = {
    chatMessage: {
      findMany: vi.fn(
        async (args: {
          where: {
            feedback?: unknown;
            role: string;
            OR?: Array<{ sessionId: string; turnId: string }>;
          };
          take?: number;
        }) => {
          if (args.where.role === "assistant") {
            return rows
              .filter((r) => r.role === "assistant" && r.feedback !== null)
              .slice(0, args.take ?? 50);
          }
          // user-prompt lookup by (sessionId, turnId) pairs
          return rows.filter(
            (r) =>
              r.role === "user" &&
              (args.where.OR ?? []).some(
                (k) => k.sessionId === r.sessionId && k.turnId === r.turnId,
              ),
          );
        },
      ),
      count: vi.fn(async ({ where }: { where: { feedback: string } }) =>
        rows.filter(
          (r) => r.role === "assistant" && r.feedback === where.feedback,
        ).length,
      ),
    },
  };
  const app = express();
  app.use((req, _res, next) => {
    const asUser = { id: "u", username: "admin", role };
    (req as unknown as { user?: typeof asUser }).user = asUser;
    next();
  });
  app.use("/api", createAdminChatFeedbackRouter(prisma as never));
  return app;
}

const NOW = new Date("2026-06-10T10:00:00Z");
const ROWS: Row[] = [
  {
    id: "u1",
    sessionId: "s1",
    role: "user",
    content: "what ports does frigate need?",
    turnId: "t1",
    feedback: null,
    createdAt: NOW,
  },
  {
    id: "a1",
    sessionId: "s1",
    role: "assistant",
    content: "Frigate needs 5000 and 8554.",
    turnId: "t1",
    feedback: "down",
    createdAt: NOW,
    session: { id: "s1", title: "Frigate ports", model: "gpt-oss:20b" },
  },
  {
    id: "a2",
    sessionId: "s2",
    role: "assistant",
    content: "Sure — done.",
    turnId: "t2",
    feedback: "up",
    createdAt: NOW,
    session: { id: "s2", title: "Lights", model: "gpt-oss:20b" },
  },
];

describe("GET /api/admin/chat-feedback", () => {
  it("returns rated turns paired with their user prompts + counts", async () => {
    const res = await request(buildApp(ROWS, "admin")).get(
      "/api/admin/chat-feedback",
    );
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ up: 1, down: 1 });
    const down = res.body.items.find(
      (i: { feedback: string }) => i.feedback === "down",
    );
    expect(down).toMatchObject({
      messageId: "a1",
      conversationTitle: "Frigate ports",
      model: "gpt-oss:20b",
      userPrompt: "what ports does frigate need?",
      answer: "Frigate needs 5000 and 8554.",
    });
  });

  it("is closed to non-admin roles", async () => {
    const res = await request(buildApp(ROWS, "family")).get(
      "/api/admin/chat-feedback",
    );
    expect(res.status).toBe(403);
  });

  it("clamps a negative limit to 1 (review fix)", async () => {
    // A negative Prisma `take` reads from the END of the ordered set
    // (oldest turns) — the clamp keeps newest-first semantics.
    const res = await request(buildApp(ROWS, "admin")).get(
      "/api/admin/chat-feedback?limit=-5",
    );
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
  });
});
