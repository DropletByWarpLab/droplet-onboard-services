/**
 * WARP-466 (D2) — email analysis endpoint + tool registry checks.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false },
}));

vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(null),
}));

import {
  createEmailRouter,
  wireEmailAnalysis,
  type EmailGate,
  type EmailAnalysisFn,
} from "../routes/email.js";
import type { AuthUser } from "../middleware/auth.js";

const ALLOW_GATE: EmailGate = {
  outboundEmailEnabled: vi.fn().mockResolvedValue(true),
};

interface ThreadRow {
  id: string;
  accountId: string;
  threadKey: string;
  subject: string;
  lastSender: string | null;
  snippet: string | null;
  messageCount: number;
  triageStatus: "inbox" | "triaged" | "archived";
  draftedByDroplet: boolean;
  lastMessageAt: Date;
  messages: Array<{
    id: string;
    fromAddr: string;
    fromName: string | null;
    bodyText: string | null;
    bodyHtml: string | null;
    subject: string;
    receivedAt: Date;
    toAddrs: unknown;
    ccAddrs: unknown;
    messageId: string;
    threadId: string;
  }>;
}

function createPrismaMock(threads: ThreadRow[]) {
  const map = new Map(threads.map((t) => [t.id, t]));
  return {
    emailAccount: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
    },
    emailThread: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(
        async ({
          where,
          include,
        }: {
          where: { id: string };
          include?: { messages?: unknown };
        }) => {
          const t = map.get(where.id);
          if (!t) return null;
          if (include?.messages) return t;
          return t;
        },
      ),
    },
    emailDraft: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(),
      update: vi.fn(),
    },
  };
}

function mkUser(role: AuthUser["role"], username = "stefan"): AuthUser {
  return { id: `user-${role}`, username, displayName: username, role };
}

function buildApp(
  prismaMock: ReturnType<typeof createPrismaMock>,
  user: AuthUser,
) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = user;
    next();
  });
  app.use("/api", createEmailRouter(prismaMock as any, ALLOW_GATE));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  wireEmailAnalysis(null);
});

const sampleThread: ThreadRow = {
  id: "t1",
  accountId: "a1",
  threadKey: "k1",
  subject: "Carrier delay update",
  lastSender: "ops@carrier.com",
  snippet: "Your shipment is delayed by 2 days.",
  messageCount: 1,
  triageStatus: "inbox",
  draftedByDroplet: false,
  lastMessageAt: new Date("2026-05-27T10:00:00Z"),
  messages: [
    {
      id: "m1",
      threadId: "t1",
      messageId: "<id-1@carrier.com>",
      fromAddr: "ops@carrier.com",
      fromName: "Carrier Ops",
      subject: "Carrier delay update",
      toAddrs: ["stefan@example.com"],
      ccAddrs: null,
      bodyText: "Your shipment is delayed by 2 days due to weather.",
      bodyHtml: null,
      receivedAt: new Date("2026-05-27T10:00:00Z"),
    },
  ],
};

describe("WARP-466 — GET /:accountId/threads/:threadId/analysis", () => {
  it("calls the wired analysis fn with thread context and returns its result", async () => {
    const analysisFn: EmailAnalysisFn = vi.fn().mockResolvedValue({
      summary: "Shipment delayed 2 days; weather attributed.",
      callouts: [{ label: "2-day delay" }],
      suggestedActions: [
        { label: "Notify recipient", safety: "Write · confirm" },
      ],
      related: { files: [], threads: [], cameras: [], tools: [] },
    });
    wireEmailAnalysis(analysisFn);
    const prisma = createPrismaMock([sampleThread]);
    const res = await request(buildApp(prisma, mkUser("family"))).get(
      "/api/email/a1/threads/t1/analysis",
    );
    expect(res.status).toBe(200);
    expect(res.body.summary).toContain("Shipment delayed");
    expect(analysisFn).toHaveBeenCalledTimes(1);
    const call = (analysisFn as any).mock.calls[0][0];
    expect(call.subject).toBe("Carrier delay update");
    expect(call.messages).toHaveLength(1);
    expect(call.messages[0].from).toBe("Carrier Ops <ops@carrier.com>");
  });

  it("returns 404 when the thread belongs to a different account", async () => {
    const fn: EmailAnalysisFn = vi.fn();
    wireEmailAnalysis(fn);
    const prisma = createPrismaMock([sampleThread]);
    const res = await request(buildApp(prisma, mkUser("family"))).get(
      "/api/email/other-account/threads/t1/analysis",
    );
    expect(res.status).toBe(404);
    expect(fn).not.toHaveBeenCalled();
  });

  it("returns 503 when no analysis fn has been wired", async () => {
    wireEmailAnalysis(null);
    const prisma = createPrismaMock([sampleThread]);
    const res = await request(buildApp(prisma, mkUser("family"))).get(
      "/api/email/a1/threads/t1/analysis",
    );
    expect(res.status).toBe(503);
  });

  it("guest 403", async () => {
    const fn: EmailAnalysisFn = vi.fn();
    wireEmailAnalysis(fn);
    const prisma = createPrismaMock([sampleThread]);
    const res = await request(buildApp(prisma, mkUser("guest"))).get(
      "/api/email/a1/threads/t1/analysis",
    );
    expect(res.status).toBe(403);
  });

  it("caps message body size before passing to analysis fn", async () => {
    const big = "x".repeat(20_000);
    const thread = {
      ...sampleThread,
      messages: [
        { ...sampleThread.messages[0], bodyText: big },
      ],
    };
    const fn: EmailAnalysisFn = vi.fn().mockResolvedValue({
      summary: "ok",
      callouts: [],
      suggestedActions: [],
      related: { files: [], threads: [], cameras: [], tools: [] },
    });
    wireEmailAnalysis(fn);
    const prisma = createPrismaMock([thread]);
    await request(buildApp(prisma, mkUser("family"))).get(
      "/api/email/a1/threads/t1/analysis",
    );
    const call = (fn as any).mock.calls[0][0];
    expect(call.messages[0].bodyText.length).toBe(8_000);
  });
});
