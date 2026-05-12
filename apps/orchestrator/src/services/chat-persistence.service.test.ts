/**
 * WARP-304 — unit tests for ChatPersistenceService. The Prisma client is
 * mocked so these tests run without a Postgres process; the integration
 * test `__tests__/llm-chat-persistence.test.ts` exercises the live wire
 * via supertest.
 */
import { describe, it, expect, vi } from "vitest";
import { ChatPersistenceService } from "./chat-persistence.service.js";

interface MockSession {
  id: string;
  userId: string;
  title: string | null;
  model: string | null;
  provider: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface MockMessage {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  toolCalls: unknown;
  toolCallId: string | null;
  turnId: string | null;
  status: string;
  completedAt: Date | null;
  createdAt: Date;
}

function makePrismaMock() {
  const sessions: MockSession[] = [];
  const messages: MockMessage[] = [];

  const chatSession = {
    findFirst: vi.fn(async (args: { where: { id: string; userId: string }; include?: unknown }) => {
      const row = sessions.find(
        (s) => s.id === args.where.id && s.userId === args.where.userId,
      );
      if (!row) return null;
      if (args.include) {
        return { ...row, messages: messages.filter((m) => m.sessionId === row.id) };
      }
      return row;
    }),
    findMany: vi.fn(async (args: { where: { userId: string }; take: number; skip: number }) => {
      return sessions
        .filter((s) => s.userId === args.where.userId)
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
        .slice(args.skip, args.skip + args.take);
    }),
    create: vi.fn(async (args: { data: Omit<MockSession, "id" | "createdAt" | "updatedAt"> }) => {
      const row: MockSession = {
        id: `sess-${sessions.length + 1}`,
        title: args.data.title ?? null,
        model: args.data.model ?? null,
        provider: args.data.provider ?? null,
        userId: args.data.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      sessions.push(row);
      return row;
    }),
    update: vi.fn(async (args: { where: { id: string }; data: { updatedAt: Date } }) => {
      const row = sessions.find((s) => s.id === args.where.id);
      if (row) row.updatedAt = args.data.updatedAt;
      return row;
    }),
    deleteMany: vi.fn(async (args: { where: { id: string; userId: string } }) => {
      const idx = sessions.findIndex(
        (s) => s.id === args.where.id && s.userId === args.where.userId,
      );
      if (idx === -1) return { count: 0 };
      sessions.splice(idx, 1);
      return { count: 1 };
    }),
  };

  const chatMessage = {
    findFirst: vi.fn(async (args: { where: { sessionId: string; turnId: string; role: string } }) => {
      return (
        messages.find(
          (m) =>
            m.sessionId === args.where.sessionId &&
            m.turnId === args.where.turnId &&
            m.role === args.where.role,
        ) ?? null
      );
    }),
    create: vi.fn(async (args: {
      data: Omit<MockMessage, "id" | "createdAt" | "status" | "completedAt"> & {
        status?: string;
        completedAt?: Date | null;
      };
    }) => {
      const row: MockMessage = {
        id: `msg-${messages.length + 1}`,
        sessionId: args.data.sessionId,
        role: args.data.role,
        content: args.data.content,
        toolCalls: args.data.toolCalls,
        toolCallId: args.data.toolCallId ?? null,
        turnId: args.data.turnId ?? null,
        status: args.data.status ?? "completed",
        completedAt: args.data.completedAt ?? null,
        createdAt: new Date(),
      };
      messages.push(row);
      return row;
    }),
    update: vi.fn(async (args: {
      where: { id: string };
      data: Partial<MockMessage>;
    }) => {
      const row = messages.find((m) => m.id === args.where.id);
      if (!row) throw new Error(`message ${args.where.id} not found`);
      Object.assign(row, args.data);
      return row;
    }),
  };

  const prisma = {
    chatSession,
    chatMessage,
    $transaction: async (
      fn: (tx: { chatSession: typeof chatSession; chatMessage: typeof chatMessage }) => Promise<void>,
    ) => fn({ chatSession, chatMessage }),
  };

  return { prisma, sessions, messages };
}

describe("ChatPersistenceService (WARP-304)", () => {
  it("ensureConversation creates a fresh session keyed to the user", async () => {
    const { prisma, sessions } = makePrismaMock();
    // The mock is shaped like PrismaClient at the surface we use; cast
    // through `unknown` so the test doesn't need a full PrismaClient stub.
    const svc = new ChatPersistenceService(prisma as never);
    const { id, created } = await svc.ensureConversation({
      conversationId: undefined,
      userId: "alice",
      model: "llama3",
      firstUserContent: "Help me plan dinner",
    });
    expect(created).toBe(true);
    expect(id).toBe("sess-1");
    expect(sessions[0].userId).toBe("alice");
    expect(sessions[0].title).toBe("Help me plan dinner");
  });

  it("ensureConversation reuses an existing session owned by the user", async () => {
    const { prisma, sessions } = makePrismaMock();
    sessions.push({
      id: "sess-existing",
      userId: "alice",
      title: "Old chat",
      model: "llama3",
      provider: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const svc = new ChatPersistenceService(prisma as never);
    const { id, created } = await svc.ensureConversation({
      conversationId: "sess-existing",
      userId: "alice",
      model: "llama3",
      firstUserContent: null,
    });
    expect(id).toBe("sess-existing");
    expect(created).toBe(false);
    expect(sessions.length).toBe(1); // no new row
  });

  it("ensureConversation silently mints a new session when the id belongs to another user", async () => {
    const { prisma, sessions } = makePrismaMock();
    sessions.push({
      id: "sess-bob",
      userId: "bob",
      title: null,
      model: "llama3",
      provider: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const svc = new ChatPersistenceService(prisma as never);
    const { id, created } = await svc.ensureConversation({
      conversationId: "sess-bob",
      userId: "alice",
      model: "llama3",
      firstUserContent: "What's the weather?",
    });
    expect(created).toBe(true);
    // The new row is alice's, not bob's.
    expect(id).not.toBe("sess-bob");
    expect(sessions.find((s) => s.id === id)?.userId).toBe("alice");
  });

  it("appendMessages persists user + assistant turn and bumps updatedAt", async () => {
    const { prisma, messages, sessions } = makePrismaMock();
    sessions.push({
      id: "s1",
      userId: "alice",
      title: null,
      model: null,
      provider: null,
      createdAt: new Date(2026, 0, 1),
      updatedAt: new Date(2026, 0, 1),
    });
    const svc = new ChatPersistenceService(prisma as never);

    await svc.appendMessages("s1", [
      { role: "user", content: "ping", turnId: "t1" },
      {
        role: "assistant",
        content: "pong",
        turnId: "t1",
        toolCalls: [{ id: "c1", name: "get_time", args: {} }],
      },
    ]);

    expect(messages.length).toBe(2);
    expect(messages[0]).toMatchObject({ role: "user", content: "ping", turnId: "t1" });
    expect(messages[1]).toMatchObject({ role: "assistant", content: "pong", turnId: "t1" });
    expect(sessions[0].updatedAt.getTime()).toBeGreaterThan(
      new Date(2026, 0, 1).getTime(),
    );
  });

  it("appendMessages dedupes when the same (sessionId, turnId, role) is replayed", async () => {
    const { prisma, messages, sessions } = makePrismaMock();
    sessions.push({
      id: "s1",
      userId: "alice",
      title: null,
      model: null,
      provider: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const svc = new ChatPersistenceService(prisma as never);

    await svc.appendMessages("s1", [
      { role: "user", content: "ping", turnId: "t1" },
      { role: "assistant", content: "pong", turnId: "t1" },
    ]);
    await svc.appendMessages("s1", [
      { role: "user", content: "ping", turnId: "t1" },
      { role: "assistant", content: "pong", turnId: "t1" },
    ]);

    // Both calls inserted two rows the first time; the second call's
    // (turnId, role) pairs already existed so nothing new was added.
    expect(messages.length).toBe(2);
  });

  it("getConversationForUser refuses cross-user reads", async () => {
    const { prisma, sessions } = makePrismaMock();
    sessions.push({
      id: "s-bob",
      userId: "bob",
      title: "secret",
      model: null,
      provider: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const svc = new ChatPersistenceService(prisma as never);
    const detail = await svc.getConversationForUser("s-bob", "alice");
    expect(detail).toBeNull();
  });

  it("deleteConversationForUser refuses cross-user deletes", async () => {
    const { prisma, sessions } = makePrismaMock();
    sessions.push({
      id: "s-bob",
      userId: "bob",
      title: null,
      model: null,
      provider: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const svc = new ChatPersistenceService(prisma as never);
    const ok = await svc.deleteConversationForUser("s-bob", "alice");
    expect(ok).toBe(false);
    expect(sessions.length).toBe(1);
  });

  // ── WARP-329: save-on-send + finalize ──

  it("createTurnRows persists user as completed and assistant as streaming", async () => {
    const { prisma, sessions, messages } = makePrismaMock();
    sessions.push({
      id: "s1",
      userId: "alice",
      title: null,
      model: null,
      provider: null,
      createdAt: new Date(2026, 0, 1),
      updatedAt: new Date(2026, 0, 1),
    });
    const svc = new ChatPersistenceService(prisma as never);

    const { userMessageId, assistantMessageId, assistantAlreadyFinal } =
      await svc.createTurnRows({
        conversationId: "s1",
        userContent: "hello",
        turnId: "t1",
      });

    expect(userMessageId).toBeTruthy();
    expect(assistantMessageId).toBeTruthy();
    expect(assistantAlreadyFinal).toBe(false);
    expect(messages).toHaveLength(2);

    const userRow = messages.find((m) => m.id === userMessageId);
    const assistantRow = messages.find((m) => m.id === assistantMessageId);
    expect(userRow).toMatchObject({
      role: "user",
      content: "hello",
      status: "completed",
    });
    expect(userRow?.completedAt).toBeInstanceOf(Date);
    expect(assistantRow).toMatchObject({
      role: "assistant",
      content: "",
      status: "streaming",
      completedAt: null,
    });
    expect(sessions[0].updatedAt.getTime()).toBeGreaterThan(
      new Date(2026, 0, 1).getTime(),
    );
  });

  it("createTurnRows is idempotent on the same (sessionId, turnId)", async () => {
    const { prisma, sessions, messages } = makePrismaMock();
    sessions.push({
      id: "s1",
      userId: "alice",
      title: null,
      model: null,
      provider: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const svc = new ChatPersistenceService(prisma as never);

    const first = await svc.createTurnRows({
      conversationId: "s1",
      userContent: "ping",
      turnId: "t1",
    });
    const second = await svc.createTurnRows({
      conversationId: "s1",
      userContent: "ping",
      turnId: "t1",
    });

    expect(first.assistantMessageId).toBe(second.assistantMessageId);
    expect(first.userMessageId).toBe(second.userMessageId);
    expect(messages).toHaveLength(2); // no duplicates
  });

  it("createTurnRows flags assistantAlreadyFinal when a prior turn already finished", async () => {
    const { prisma, sessions, messages } = makePrismaMock();
    sessions.push({
      id: "s1",
      userId: "alice",
      title: null,
      model: null,
      provider: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // Pre-seed a completed pair for turnId t1 — simulates a duplicate
    // re-submit AFTER the original turn already finished.
    messages.push(
      {
        id: "u-old",
        sessionId: "s1",
        role: "user",
        content: "ping",
        toolCalls: null,
        toolCallId: null,
        turnId: "t1",
        status: "completed",
        completedAt: new Date(),
        createdAt: new Date(),
      },
      {
        id: "a-old",
        sessionId: "s1",
        role: "assistant",
        content: "pong",
        toolCalls: null,
        toolCallId: null,
        turnId: "t1",
        status: "completed",
        completedAt: new Date(),
        createdAt: new Date(),
      },
    );
    const svc = new ChatPersistenceService(prisma as never);

    const { assistantAlreadyFinal, assistantMessageId } =
      await svc.createTurnRows({
        conversationId: "s1",
        userContent: "ping",
        turnId: "t1",
      });

    expect(assistantAlreadyFinal).toBe(true);
    expect(assistantMessageId).toBe("a-old");
  });

  it("finalizeAssistantMessage flips status + sets completedAt", async () => {
    const { prisma, sessions, messages } = makePrismaMock();
    sessions.push({
      id: "s1",
      userId: "alice",
      title: null,
      model: null,
      provider: null,
      createdAt: new Date(2026, 0, 1),
      updatedAt: new Date(2026, 0, 1),
    });
    const svc = new ChatPersistenceService(prisma as never);

    const { assistantMessageId } = await svc.createTurnRows({
      conversationId: "s1",
      userContent: "ping",
      turnId: "t1",
    });

    await svc.finalizeAssistantMessage({
      conversationId: "s1",
      messageId: assistantMessageId,
      content: "pong",
      toolCalls: [{ id: "c1", name: "get_time", args: {} }],
      status: "completed",
    });

    const row = messages.find((m) => m.id === assistantMessageId);
    expect(row).toMatchObject({
      content: "pong",
      status: "completed",
    });
    expect(row?.completedAt).toBeInstanceOf(Date);
    expect(sessions[0].updatedAt.getTime()).toBeGreaterThan(
      new Date(2026, 0, 1).getTime(),
    );
  });

  it("finalizeAssistantMessage propagates failed/aborted status", async () => {
    const { prisma, sessions, messages } = makePrismaMock();
    sessions.push({
      id: "s1",
      userId: "alice",
      title: null,
      model: null,
      provider: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const svc = new ChatPersistenceService(prisma as never);

    const { assistantMessageId } = await svc.createTurnRows({
      conversationId: "s1",
      userContent: "ping",
      turnId: "t-fail",
    });
    await svc.finalizeAssistantMessage({
      conversationId: "s1",
      messageId: assistantMessageId,
      content: "partial",
      toolCalls: [],
      status: "aborted",
    });
    const row = messages.find((m) => m.id === assistantMessageId);
    expect(row?.status).toBe("aborted");
    expect(row?.content).toBe("partial");
  });

  it("updateAssistantStreaming flushes content without touching status", async () => {
    const { prisma, sessions, messages } = makePrismaMock();
    sessions.push({
      id: "s1",
      userId: "alice",
      title: null,
      model: null,
      provider: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const svc = new ChatPersistenceService(prisma as never);

    const { assistantMessageId } = await svc.createTurnRows({
      conversationId: "s1",
      userContent: "hi",
      turnId: "t-stream",
    });
    await svc.updateAssistantStreaming(assistantMessageId, "Hel");
    await svc.updateAssistantStreaming(assistantMessageId, "Hello");

    const row = messages.find((m) => m.id === assistantMessageId);
    expect(row?.content).toBe("Hello");
    expect(row?.status).toBe("streaming");
    expect(row?.completedAt).toBeNull();
  });
});
