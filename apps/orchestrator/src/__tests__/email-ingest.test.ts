/**
 * WARP-465 D1 follow-up — service-principal ingest + draft status PATCH.
 *
 * Pure vitest harness against the new endpoints the email-indexer
 * uses to write inbound messages and flip queued drafts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false },
}));

const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));

import { createEmailRouter, type EmailGate } from "../routes/email.js";
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
}

interface MessageRow {
  id: string;
  accountId: string;
  threadId: string;
  messageId: string;
  inReplyTo: string | null;
  fromAddr: string;
  fromName: string | null;
  toAddrs: unknown;
  ccAddrs: unknown;
  subject: string;
  bodyText: string | null;
  bodyHtml: string | null;
  receivedAt: Date;
}

interface DraftRow {
  id: string;
  accountId: string;
  threadId: string | null;
  toAddrs: unknown;
  ccAddrs: unknown;
  bccAddrs: unknown;
  subject: string;
  body: string;
  draftedByDroplet: boolean;
  status: "draft" | "queued" | "sent" | "failed";
  sentAt: Date | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function createPrismaMock(opts: {
  accountExists?: boolean;
  threads?: ThreadRow[];
  messages?: MessageRow[];
  drafts?: DraftRow[];
} = {}) {
  const threads = new Map<string, ThreadRow>(
    (opts.threads ?? []).map((t) => [`${t.accountId}:${t.threadKey}`, t]),
  );
  const messages: MessageRow[] = [...(opts.messages ?? [])];
  const drafts = new Map<string, DraftRow>(
    (opts.drafts ?? []).map((d) => [d.id, d]),
  );
  let nextId = 1;
  const accountExists = opts.accountExists ?? true;

  return {
    threads,
    messages,
    drafts,
    emailAccount: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) => {
          void where;
          return accountExists ? { id: where.id } : null;
        },
      ),
      findMany: vi.fn(async () => []),
    },
    emailThread: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(
        async ({
          where,
          update,
          create,
        }: {
          where: { accountId_threadKey: { accountId: string; threadKey: string } };
          update: Partial<ThreadRow>;
          create: Partial<ThreadRow> & { accountId: string; threadKey: string };
        }) => {
          const key = `${where.accountId_threadKey.accountId}:${where.accountId_threadKey.threadKey}`;
          const existing = threads.get(key);
          if (existing) {
            Object.assign(existing, update);
            return existing;
          }
          const id = `t-${nextId++}`;
          const row: ThreadRow = {
            id,
            accountId: create.accountId,
            threadKey: create.threadKey,
            subject: create.subject ?? "",
            lastSender: create.lastSender ?? null,
            snippet: create.snippet ?? null,
            messageCount: create.messageCount ?? 0,
            triageStatus: "inbox",
            draftedByDroplet: false,
            lastMessageAt: create.lastMessageAt ?? new Date(),
          };
          threads.set(key, row);
          return row;
        },
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: { messageCount?: { increment: number } };
        }) => {
          for (const t of threads.values()) {
            if (t.id === where.id) {
              if (data.messageCount?.increment) {
                t.messageCount += data.messageCount.increment;
              }
              return t;
            }
          }
          throw new Error("not found");
        },
      ),
    },
    emailMessage: {
      create: vi.fn(
        async ({
          data,
        }: {
          data: Omit<MessageRow, "id"> & { messageId: string };
        }) => {
          // Simulate the unique-index on (accountId, messageId).
          if (
            messages.some(
              (m) =>
                m.accountId === data.accountId && m.messageId === data.messageId,
            )
          ) {
            const err = new Error("unique") as Error & { code: string };
            err.code = "P2002";
            throw err;
          }
          const row: MessageRow = { id: `m-${nextId++}`, ...data };
          messages.push(row);
          return row;
        },
      ),
    },
    emailDraft: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          drafts.get(where.id) ?? null,
      ),
      create: vi.fn(),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<DraftRow>;
        }) => {
          const existing = drafts.get(where.id);
          if (!existing) throw new Error("not found");
          const merged = { ...existing, ...data, updatedAt: new Date() };
          drafts.set(where.id, merged);
          return merged;
        },
      ),
    },
  };
}

function mkUser(role: AuthUser["role"], username = "indexer"): AuthUser {
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
  recordActivityMock.mockClear();
  vi.clearAllMocks();
});

describe("WARP-465 follow-up — POST /api/email/:accountId/messages-ingest", () => {
  function ingestBody() {
    return {
      messageId: "id-1@example.com",
      inReplyTo: null,
      fromAddr: "ops@carrier.com",
      fromName: "Carrier Ops",
      toAddrs: ["stefan@example.com"],
      subject: "Test",
      bodyText: "Body",
      receivedAt: "2026-05-27T10:00:00.000Z",
      threadKey: "id-1@example.com",
    };
  }

  it("creates a thread + message on first delivery", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma, mkUser("service")))
      .post("/api/email/a1/messages-ingest")
      .send(ingestBody());
    expect(res.status).toBe(201);
    expect(res.body.duplicate).toBe(false);
    expect(prisma.messages).toHaveLength(1);
    expect([...prisma.threads.values()][0].messageCount).toBe(1);
  });

  it("redelivery is idempotent (returns duplicate=true)", async () => {
    const prisma = createPrismaMock();
    await request(buildApp(prisma, mkUser("service"))).post(
      "/api/email/a1/messages-ingest",
    ).send(ingestBody());
    const second = await request(buildApp(prisma, mkUser("service"))).post(
      "/api/email/a1/messages-ingest",
    ).send(ingestBody());
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(prisma.messages).toHaveLength(1);
  });

  it("non-service-role POST is 403", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma, mkUser("family"))).post(
      "/api/email/a1/messages-ingest",
    ).send(ingestBody());
    expect(res.status).toBe(403);
  });

  it("404 when account missing", async () => {
    const prisma = createPrismaMock({ accountExists: false });
    const res = await request(buildApp(prisma, mkUser("service"))).post(
      "/api/email/nope/messages-ingest",
    ).send(ingestBody());
    expect(res.status).toBe(404);
  });

  it("400 on malformed body (missing messageId)", async () => {
    const prisma = createPrismaMock();
    const body = ingestBody();
    delete (body as { messageId?: string }).messageId;
    const res = await request(buildApp(prisma, mkUser("service"))).post(
      "/api/email/a1/messages-ingest",
    ).send(body);
    expect(res.status).toBe(400);
  });

  it("400 on invalid email in toAddrs", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma, mkUser("service"))).post(
      "/api/email/a1/messages-ingest",
    ).send({ ...ingestBody(), toAddrs: ["not-an-email"] });
    expect(res.status).toBe(400);
  });
});

describe("WARP-465 follow-up — PATCH /api/email/drafts/:id/status", () => {
  function withDraft(status: DraftRow["status"]) {
    return createPrismaMock({
      drafts: [
        {
          id: "d1",
          accountId: "a1",
          threadId: null,
          toAddrs: ["c@d.com"],
          ccAddrs: null,
          bccAddrs: null,
          subject: "Test",
          body: "Body",
          draftedByDroplet: false,
          status,
          sentAt: null,
          error: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });
  }

  it("flips queued → sent with sentAt populated", async () => {
    const prisma = withDraft("queued");
    const res = await request(buildApp(prisma, mkUser("service"))).patch(
      "/api/email/drafts/d1/status",
    ).send({ status: "sent" });
    expect(res.status).toBe(200);
    expect(prisma.drafts.get("d1")?.status).toBe("sent");
    expect(prisma.drafts.get("d1")?.sentAt).not.toBeNull();
  });

  it("flips queued → failed with error populated", async () => {
    const prisma = withDraft("queued");
    const res = await request(buildApp(prisma, mkUser("service"))).patch(
      "/api/email/drafts/d1/status",
    ).send({ status: "failed", error: "smtp 554 spam" });
    expect(res.status).toBe(200);
    expect(prisma.drafts.get("d1")?.status).toBe("failed");
    expect(prisma.drafts.get("d1")?.error).toBe("smtp 554 spam");
  });

  it("non-service role is 403", async () => {
    const prisma = withDraft("queued");
    const res = await request(buildApp(prisma, mkUser("family"))).patch(
      "/api/email/drafts/d1/status",
    ).send({ status: "sent" });
    expect(res.status).toBe(403);
  });

  it("404 missing draft", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma, mkUser("service"))).patch(
      "/api/email/drafts/nope/status",
    ).send({ status: "sent" });
    expect(res.status).toBe(404);
  });

  it("409 when draft not currently queued", async () => {
    const prisma = withDraft("draft");
    const res = await request(buildApp(prisma, mkUser("service"))).patch(
      "/api/email/drafts/d1/status",
    ).send({ status: "sent" });
    expect(res.status).toBe(409);
  });

  it("idempotent: re-asserting the same terminal status is 200", async () => {
    const prisma = withDraft("sent");
    const res = await request(buildApp(prisma, mkUser("service"))).patch(
      "/api/email/drafts/d1/status",
    ).send({ status: "sent" });
    expect(res.status).toBe(200);
  });

  it("400 on invalid status enum", async () => {
    const prisma = withDraft("queued");
    const res = await request(buildApp(prisma, mkUser("service"))).patch(
      "/api/email/drafts/d1/status",
    ).send({ status: "garbage" });
    expect(res.status).toBe(400);
  });
});
