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
  systemPrompt?: string | null;
  /** WARP-1917 — pin state. Optional so pre-existing fixtures stay valid
   *  (the schema default is false / null). */
  pinned?: boolean;
  pinnedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface MockMessage {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  // Optional to match the Prisma schema (`toolCalls Json?`, `toolCallId String?`).
  // Most test fixtures don't carry tool-call payloads, and prior to this
  // they were required-fields, which made the assistant-status tests
  // (lines ~285–348) fail the orchestrator's `tsc` step under the
  // workspace `include: ["src/**/*"]` (no test exclude). The mock's
  // `create()` already coalesces both fields to null when absent, so
  // there's no runtime behavior change — just a type that finally
  // matches the schema. See the chatMessage.create mock below.
  toolCalls?: unknown;
  toolCallId?: string | null;
  turnId: string | null;
  status: string;
  completedAt: Date | null;
  createdAt: Date;
  /** WARP-904 — per-message provider/model audit columns. Optional for
   *  the same back-compat reason as toolCalls/toolCallId above. */
  model?: string | null;
  provider?: string | null;
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
    findMany: vi.fn(
      async (args: {
        where: {
          userId: string;
          OR?: Array<{
            title?: { contains: string; mode: string };
            messages?: {
              some: { content: { contains: string; mode: string } };
            };
          }>;
        };
        orderBy?: Array<Record<string, "asc" | "desc">>;
        take: number;
        skip: number;
      }) => {
        // Honor the WARP-844 search predicate: title ILIKE OR any message
        // content ILIKE. Mirrors Prisma's `contains` + `mode:"insensitive"`.
        const matchesSearch = (s: MockSession): boolean => {
          if (!args.where.OR) return true;
          const titleNeedle = args.where.OR.find((c) => c.title)?.title
            ?.contains;
          const contentNeedle = args.where.OR.find((c) => c.messages)?.messages
            ?.some.content.contains;
          const t = (titleNeedle ?? contentNeedle ?? "").toLowerCase();
          if (!t) return true;
          if ((s.title ?? "").toLowerCase().includes(t)) return true;
          return messages.some(
            (m) =>
              m.sessionId === s.id && m.content.toLowerCase().includes(t),
          );
        };
        // WARP-1917 — honor the CALLER's orderBy rather than hardcoding
        // updatedAt desc, so a regression in the service's ordering (e.g.
        // dropping the pinned-first leg) actually fails these tests.
        const orderBy: Array<Record<string, "asc" | "desc">> = Array.isArray(
          args.orderBy,
        )
          ? args.orderBy
          : [{ updatedAt: "desc" }];
        const keyValue = (s: MockSession, field: string): number => {
          if (field === "pinned") return s.pinned ? 1 : 0;
          if (field === "updatedAt") return s.updatedAt.getTime();
          if (field === "createdAt") return s.createdAt.getTime();
          throw new Error(`mock findMany: unsupported orderBy field ${field}`);
        };
        const compare = (a: MockSession, b: MockSession): number => {
          for (const leg of orderBy) {
            const [field, dir] = Object.entries(leg)[0]!;
            const d = keyValue(a, field) - keyValue(b, field);
            if (d !== 0) return dir === "desc" ? -d : d;
          }
          return 0;
        };
        return sessions
          .filter((s) => s.userId === args.where.userId)
          .filter(matchesSearch)
          .sort(compare)
          .slice(args.skip, args.skip + args.take);
      },
    ),
    create: vi.fn(async (args: { data: Omit<MockSession, "id" | "createdAt" | "updatedAt"> }) => {
      const row: MockSession = {
        id: `sess-${sessions.length + 1}`,
        title: args.data.title ?? null,
        model: args.data.model ?? null,
        provider: args.data.provider ?? null,
        systemPrompt: args.data.systemPrompt ?? null,
        userId: args.data.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      sessions.push(row);
      return row;
    }),
    update: vi.fn(async (args: { where: { id: string }; data: Partial<MockSession> }) => {
      const row = sessions.find((s) => s.id === args.where.id);
      if (row) Object.assign(row, args.data);
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
    // Truncation support: ordered listing + bulk delete by id set.
    findMany: vi.fn(
      async (args: {
        where: { sessionId: string };
        orderBy?: unknown;
        select?: { id: boolean; turnId?: boolean; status?: boolean };
      }) => {
        return messages
          .filter((m) => m.sessionId === args.where.sessionId)
          .sort(
            (a, b) =>
              a.createdAt.getTime() - b.createdAt.getTime() ||
              a.id.localeCompare(b.id),
          )
          .map((m) => ({ id: m.id, turnId: m.turnId, status: m.status }));
      },
    ),
    updateMany: vi.fn(
      async (args: {
        where: { id: string; sessionId: string };
        data: { feedback?: string | null };
      }) => {
        let count = 0;
        for (const m of messages) {
          if (m.id === args.where.id && m.sessionId === args.where.sessionId) {
            Object.assign(m, args.data);
            count++;
          }
        }
        return { count };
      },
    ),
    deleteMany: vi.fn(
      async (args: { where: { id: { in: string[] }; sessionId: string } }) => {
        let count = 0;
        for (let i = messages.length - 1; i >= 0; i--) {
          if (
            args.where.id.in.includes(messages[i]!.id) &&
            messages[i]!.sessionId === args.where.sessionId
          ) {
            messages.splice(i, 1);
            count++;
          }
        }
        return { count };
      },
    ),
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
        model: args.data.model ?? null,
        provider: args.data.provider ?? null,
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
    $executeRaw: vi.fn(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join("?");
        // WARP-1917 — pin UPDATE shape: (pinned, pinned, id, userId).
        if (sql.includes('"pinnedAt"')) {
          const [pinned, , id, userId] = values as [
            boolean,
            boolean,
            string,
            string,
          ];
          const row = sessions.find(
            (s) => s.id === id && s.userId === userId,
          );
          if (!row) return 0;
          row.pinned = pinned;
          row.pinnedAt = pinned ? new Date() : null;
          return 1;
        }
        // Rename UPDATE shape: (title, id, userId).
        const [title, id, userId] = values as [string, string, string];
        const row = sessions.find((s) => s.id === id && s.userId === userId);
        if (!row) return 0;
        row.title = title;
        return 1;
      },
    ),
  };

  return { prisma, sessions, messages };
}

describe("ChatPersistenceService (WARP-304)", () => {
  it("ensureConversation persists + refreshes the system prompt (WARP-844)", async () => {
    const { prisma, sessions } = makePrismaMock();
    const svc = new ChatPersistenceService(prisma as never);

    // Create with a prompt.
    const created = await svc.ensureConversation({
      conversationId: null,
      userId: "alice",
      model: "m1",
      firstUserContent: "hi",
      systemPrompt: "You are a pirate.",
    });
    expect(sessions.find((s) => s.id === created.id)?.systemPrompt).toBe(
      "You are a pirate.",
    );

    // Later turn with a CHANGED prompt updates the row (latest wins).
    await svc.ensureConversation({
      conversationId: created.id,
      userId: "alice",
      model: "m1",
      firstUserContent: "again",
      systemPrompt: "You are a poet.",
    });
    expect(sessions.find((s) => s.id === created.id)?.systemPrompt).toBe(
      "You are a poet.",
    );

    // A turn with no prompt clears it (the user emptied the textarea).
    await svc.ensureConversation({
      conversationId: created.id,
      userId: "alice",
      model: "m1",
      firstUserContent: "third",
      systemPrompt: null,
    });
    expect(
      sessions.find((s) => s.id === created.id)?.systemPrompt,
    ).toBeNull();
  });

  it("setMessageFeedback rates an assistant row and clears on null (WARP-844)", async () => {
    const { prisma, sessions, messages } = makePrismaMock();
    const svc = new ChatPersistenceService(prisma as never);
    const now = new Date();
    sessions.push({
      id: "s1",
      userId: "alice",
      title: "t",
      model: null,
      provider: null,
      createdAt: now,
      updatedAt: now,
    });
    messages.push({
      id: "a1",
      sessionId: "s1",
      role: "assistant",
      content: "answer",
      turnId: null,
      status: "completed",
      completedAt: now,
      createdAt: now,
    });

    expect(await svc.setMessageFeedback("s1", "alice", "a1", "up")).toBe(true);
    expect(
      (messages[0] as { feedback?: string | null }).feedback,
    ).toBe("up");

    expect(await svc.setMessageFeedback("s1", "alice", "a1", null)).toBe(true);
    expect(
      (messages[0] as { feedback?: string | null }).feedback,
    ).toBeNull();

    // Cross-user and unknown ids refuse without writes.
    expect(await svc.setMessageFeedback("s1", "mallory", "a1", "down")).toBe(
      false,
    );
    expect(await svc.setMessageFeedback("s1", "alice", "nope", "down")).toBe(
      false,
    );
  });

  it("truncateConversationFromMessage deletes the target row and everything after it", async () => {
    const { prisma, sessions, messages } = makePrismaMock();
    const svc = new ChatPersistenceService(prisma as never);
    const base = Date.parse("2026-06-09T10:00:00Z");
    sessions.push({
      id: "s1",
      userId: "alice",
      title: "t",
      model: null,
      provider: null,
      createdAt: new Date(base),
      updatedAt: new Date(base),
    });
    const mk = (id: string, role: string, offsetMs: number) => ({
      id,
      sessionId: "s1",
      role,
      content: `${id} content`,
      turnId: null,
      status: "completed",
      completedAt: new Date(base + offsetMs),
      createdAt: new Date(base + offsetMs),
    });
    messages.push(
      mk("m1", "user", 0),
      mk("m2", "assistant", 1),
      mk("m3", "user", 2),
      mk("m4", "assistant", 3),
    );

    const deleted = await svc.truncateConversationFromMessage("s1", "alice", "m3");
    expect(deleted).toBe(2);
    expect(messages.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("truncateConversationFromMessage refuses cross-user and unknown targets", async () => {
    const { prisma, sessions, messages } = makePrismaMock();
    const svc = new ChatPersistenceService(prisma as never);
    const now = new Date();
    sessions.push({
      id: "s1",
      userId: "alice",
      title: "t",
      model: null,
      provider: null,
      createdAt: now,
      updatedAt: now,
    });
    messages.push({
      id: "m1",
      sessionId: "s1",
      role: "user",
      content: "hi",
      turnId: null,
      status: "completed",
      completedAt: now,
      createdAt: now,
    });

    // Wrong owner → refused, nothing deleted.
    expect(
      await svc.truncateConversationFromMessage("s1", "mallory", "m1"),
    ).toBe("not_found");
    expect(messages).toHaveLength(1);
    // Unknown message id → refused.
    expect(
      await svc.truncateConversationFromMessage("s1", "alice", "nope"),
    ).toBe("not_found");
    expect(messages).toHaveLength(1);
  });

  it("truncate includes the edited turn's assistant sibling even when it sorts before the user row", async () => {
    const { prisma, sessions, messages } = makePrismaMock();
    const svc = new ChatPersistenceService(prisma as never);
    const base = Date.parse("2026-06-09T10:00:00Z");
    sessions.push({
      id: "s1",
      userId: "alice",
      title: "t",
      model: null,
      provider: null,
      createdAt: new Date(base),
      updatedAt: new Date(base),
    });
    // Turn rows are written in one transaction and tie at ms precision;
    // uuid ids make intra-turn order a coin flip. Simulate the adverse
    // ordering: the assistant sibling's id sorts BEFORE the user row.
    const mk = (id: string, role: string, turnId: string | null, offsetMs: number) => ({
      id,
      sessionId: "s1",
      role,
      content: `${id} content`,
      turnId,
      status: "completed",
      completedAt: new Date(base + offsetMs),
      createdAt: new Date(base + offsetMs),
    });
    messages.push(
      mk("m1", "user", "t1", 0),
      mk("m2", "assistant", "t1", 1),
      mk("a-assistant", "assistant", "t2", 1000), // ties with b-user, sorts first
      mk("b-user", "user", "t2", 1000),
    );

    const deleted = await svc.truncateConversationFromMessage(
      "s1",
      "alice",
      "b-user",
    );
    // Both turn-2 rows die — the slice alone would have left a-assistant.
    expect(deleted).toBe(2);
    expect(messages.map((m) => m.id).sort()).toEqual(["m1", "m2"]);
  });

  it("truncate refuses with in_flight when a doomed row is still streaming", async () => {
    const { prisma, sessions, messages } = makePrismaMock();
    const svc = new ChatPersistenceService(prisma as never);
    const now = new Date();
    sessions.push({
      id: "s1",
      userId: "alice",
      title: "t",
      model: null,
      provider: null,
      createdAt: now,
      updatedAt: now,
    });
    messages.push(
      {
        id: "u1",
        sessionId: "s1",
        role: "user",
        content: "edit me",
        turnId: "t1",
        status: "completed",
        completedAt: now,
        createdAt: now,
      },
      {
        id: "a1",
        sessionId: "s1",
        role: "assistant",
        content: "",
        turnId: "t1",
        status: "streaming",
        completedAt: null,
        createdAt: new Date(now.getTime() + 1),
      },
    );

    expect(
      await svc.truncateConversationFromMessage("s1", "alice", "u1"),
    ).toBe("in_flight");
    expect(messages).toHaveLength(2);
  });

  it("listConversationsForUser filters by title OR message content when q is set", async () => {
    const { prisma, sessions, messages } = makePrismaMock();
    const svc = new ChatPersistenceService(prisma as never);
    const now = new Date();
    sessions.push(
      {
        id: "s1",
        userId: "alice",
        title: "Frigate camera ports",
        model: null,
        provider: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "s2",
        userId: "alice",
        title: "Dinner plans",
        model: null,
        provider: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "s3",
        userId: "bob",
        title: "Frigate on bob's account",
        model: null,
        provider: null,
        createdAt: now,
        updatedAt: now,
      },
    );
    messages.push({
      id: "m1",
      sessionId: "s2",
      role: "user",
      content: "what ports does frigate need?",
      turnId: null,
      status: "completed",
      completedAt: now,
      createdAt: now,
    });

    // Title hit (s1) + message-content hit (s2); bob's session never leaks.
    const hits = await svc.listConversationsForUser("alice", 20, 0, "frigate");
    expect(hits.map((h) => h.id).sort()).toEqual(["s1", "s2"]);

    // No needle → unfiltered list (back-compat).
    const all = await svc.listConversationsForUser("alice", 20, 0);
    expect(all).toHaveLength(2);

    // Whitespace-only needle behaves like no needle.
    const blank = await svc.listConversationsForUser("alice", 20, 0, "   ");
    expect(blank).toHaveLength(2);
  });

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

  it("getConversationForUser returns the status of each message", async () => {
    const { prisma } = makePrismaMock();
    const svc = new ChatPersistenceService(prisma as never);

    await prisma.chatSession.create({
      data: { userId: "alice", title: "T", model: "llama3", provider: "ollama" },
    });
    // Seed one message of each status so the mapping covers the enum.
    await prisma.chatMessage.create({
      data: {
        sessionId: "sess-1",
        role: "user",
        content: "hi",
        turnId: "t1",
        status: "completed",
        toolCalls: null,
        toolCallId: null,
      },
    });
    await prisma.chatMessage.create({
      data: {
        sessionId: "sess-1",
        role: "assistant",
        content: "hello",
        turnId: "t1",
        status: "completed",
        toolCalls: null,
        toolCallId: null,
      },
    });
    await prisma.chatMessage.create({
      data: {
        sessionId: "sess-1",
        role: "assistant",
        content: "",
        turnId: "t2",
        status: "failed",
        toolCalls: null,
        toolCallId: null,
      },
    });
    await prisma.chatMessage.create({
      data: {
        sessionId: "sess-1",
        role: "assistant",
        content: "partial",
        turnId: "t3",
        status: "aborted",
        toolCalls: null,
        toolCallId: null,
      },
    });
    await prisma.chatMessage.create({
      data: {
        sessionId: "sess-1",
        role: "assistant",
        content: "mid",
        turnId: "t4",
        status: "streaming",
        toolCalls: null,
        toolCallId: null,
      },
    });

    const detail = await svc.getConversationForUser("sess-1", "alice");
    expect(detail).not.toBeNull();
    expect(detail!.messages.map((m) => m.status)).toEqual([
      "completed",
      "completed",
      "failed",
      "aborted",
      "streaming",
    ]);
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

  // ── WARP-904: per-message provider/model audit trail ──

  it("createTurnRows stamps model/provider onto both the user and assistant rows", async () => {
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

    const { userMessageId, assistantMessageId } = await svc.createTurnRows({
      conversationId: "s1",
      userContent: "hello",
      turnId: "t1",
      model: "claude-sonnet-4-20250514",
      provider: "anthropic",
    });

    const userRow = messages.find((m) => m.id === userMessageId);
    const assistantRow = messages.find((m) => m.id === assistantMessageId);
    expect(userRow).toMatchObject({
      model: "claude-sonnet-4-20250514",
      provider: "anthropic",
    });
    expect(assistantRow).toMatchObject({
      model: "claude-sonnet-4-20250514",
      provider: "anthropic",
    });
  });

  it("createTurnRows leaves model/provider null when the caller omits them", async () => {
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

    const { userMessageId } = await svc.createTurnRows({
      conversationId: "s1",
      userContent: "hello",
      turnId: "t1",
    });

    const userRow = messages.find((m) => m.id === userMessageId);
    expect(userRow?.model).toBeNull();
    expect(userRow?.provider).toBeNull();
  });

  it("finalizeAssistantMessage overwrites the assistant row's model (vision auto-route case)", async () => {
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
      userContent: "describe this image",
      turnId: "t1",
      model: "mistral:7b-instruct",
      provider: "ollama",
    });

    // The vision auto-route swapped the model mid-turn — the assistant
    // row must reflect what actually ran, not the original selection.
    await svc.finalizeAssistantMessage({
      conversationId: "s1",
      messageId: assistantMessageId,
      content: "A cat.",
      toolCalls: [],
      status: "completed",
      model: "llava:7b",
      provider: "ollama",
    });

    const assistantRow = messages.find((m) => m.id === assistantMessageId);
    expect(assistantRow?.model).toBe("llava:7b");
    // The user row is untouched — it still reflects the original request.
    const userRow = messages.find(
      (m) => m.id !== assistantMessageId && m.turnId === "t1",
    );
    expect(userRow?.model).toBe("mistral:7b-instruct");
  });

  it("finalizeAssistantMessage leaves model/provider untouched when omitted", async () => {
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
      userContent: "hello",
      turnId: "t1",
      model: "gpt-4o",
      provider: "openai",
    });

    await svc.finalizeAssistantMessage({
      conversationId: "s1",
      messageId: assistantMessageId,
      content: "hi there",
      toolCalls: [],
      status: "completed",
      // model/provider intentionally omitted
    });

    const assistantRow = messages.find((m) => m.id === assistantMessageId);
    expect(assistantRow?.model).toBe("gpt-4o");
    expect(assistantRow?.provider).toBe("openai");
  });

  it("getConversationForUser surfaces per-message model/provider", async () => {
    const { prisma, sessions, messages } = makePrismaMock();
    sessions.push({
      id: "s1",
      userId: "alice",
      title: "T",
      model: "gpt-4o",
      provider: "openai",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    messages.push(
      {
        id: "m1",
        sessionId: "s1",
        role: "user",
        content: "hi",
        turnId: "t1",
        status: "completed",
        completedAt: new Date(),
        createdAt: new Date(),
        model: "gpt-4o",
        provider: "openai",
      },
      {
        id: "m2",
        sessionId: "s1",
        role: "assistant",
        content: "hello",
        turnId: "t1",
        status: "completed",
        completedAt: new Date(),
        createdAt: new Date(),
        // model/provider omitted — pre-WARP-904 row.
      },
    );
    const svc = new ChatPersistenceService(prisma as never);
    const detail = await svc.getConversationForUser("s1", "alice");
    expect(detail!.messages[0]).toMatchObject({
      model: "gpt-4o",
      provider: "openai",
    });
    expect(detail!.messages[1]).toMatchObject({
      model: null,
      provider: null,
    });
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

  // ── WARP-331: rename conversation ──

  it("renameConversationForUser updates a row owned by the user and returns the trimmed title", async () => {
    const { prisma, sessions } = makePrismaMock();
    sessions.push({
      id: "s1",
      userId: "alice",
      title: "Old",
      model: null,
      provider: null,
      createdAt: new Date(2026, 0, 1),
      updatedAt: new Date(2026, 0, 1),
    });
    const svc = new ChatPersistenceService(prisma as never);
    const result = await svc.renameConversationForUser("s1", "alice", "  Frigate ports  ");
    expect(result).toBe("Frigate ports");
    expect(sessions[0].title).toBe("Frigate ports");
    // updatedAt MUST NOT be bumped on rename.
    expect(sessions[0].updatedAt.getTime()).toBe(new Date(2026, 0, 1).getTime());
  });

  it("renameConversationForUser clamps to 64 chars", async () => {
    const { prisma, sessions } = makePrismaMock();
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
    const long = "x".repeat(200);
    const result = await svc.renameConversationForUser("s1", "alice", long);
    expect(result?.length).toBe(64);
    expect(sessions[0].title?.length).toBe(64);
  });

  it("renameConversationForUser rejects empty / whitespace-only titles", async () => {
    const { prisma, sessions } = makePrismaMock();
    sessions.push({
      id: "s1",
      userId: "alice",
      title: "Old",
      model: null,
      provider: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const svc = new ChatPersistenceService(prisma as never);
    await expect(svc.renameConversationForUser("s1", "alice", "   ")).rejects.toThrow(/title_required/);
    expect(sessions[0].title).toBe("Old"); // unchanged
  });

  it("renameConversationForUser returns null when row belongs to another user", async () => {
    const { prisma, sessions } = makePrismaMock();
    sessions.push({
      id: "s-bob",
      userId: "bob",
      title: "Bob's chat",
      model: null,
      provider: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const svc = new ChatPersistenceService(prisma as never);
    const result = await svc.renameConversationForUser("s-bob", "alice", "Hijack");
    expect(result).toBeNull();
    expect(sessions[0].title).toBe("Bob's chat");
  });

  it("renameConversationForUser never calls chatSession.update (avoids @updatedAt bump)", async () => {
    const { prisma, sessions } = makePrismaMock();
    sessions.push({
      id: "s1",
      userId: "alice",
      title: "Old",
      model: null,
      provider: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const svc = new ChatPersistenceService(prisma as never);
    await svc.renameConversationForUser("s1", "alice", "New");
    expect(prisma.chatSession.update).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).toHaveBeenCalled();
  });

  // ── WARP-1917: pin / unpin conversation ──

  it("setConversationPinned pins a row owned by the user (pinned + pinnedAt set)", async () => {
    const { prisma, sessions } = makePrismaMock();
    sessions.push({
      id: "s1",
      userId: "alice",
      title: "Frigate ports",
      model: null,
      provider: null,
      createdAt: new Date(2026, 0, 1),
      updatedAt: new Date(2026, 0, 1),
    });
    const svc = new ChatPersistenceService(prisma as never);
    const ok = await svc.setConversationPinned("s1", "alice", true);
    expect(ok).toBe(true);
    expect(sessions[0].pinned).toBe(true);
    expect(sessions[0].pinnedAt).toBeInstanceOf(Date);
    // Pinning is a metadata edit — updatedAt MUST NOT be bumped, or the
    // chat would jump to "Today" once unpinned instead of returning to
    // its chronological position (the WARP-1917 AC).
    expect(sessions[0].updatedAt.getTime()).toBe(new Date(2026, 0, 1).getTime());
  });

  it("setConversationPinned(false) clears pinned AND pinnedAt", async () => {
    const { prisma, sessions } = makePrismaMock();
    sessions.push({
      id: "s1",
      userId: "alice",
      title: "Frigate ports",
      model: null,
      provider: null,
      pinned: true,
      pinnedAt: new Date(2026, 0, 2),
      createdAt: new Date(2026, 0, 1),
      updatedAt: new Date(2026, 0, 1),
    });
    const svc = new ChatPersistenceService(prisma as never);
    const ok = await svc.setConversationPinned("s1", "alice", false);
    expect(ok).toBe(true);
    expect(sessions[0].pinned).toBe(false);
    expect(sessions[0].pinnedAt).toBeNull();
    expect(sessions[0].updatedAt.getTime()).toBe(new Date(2026, 0, 1).getTime());
  });

  it("setConversationPinned returns false for another user's row (no cross-user pin)", async () => {
    const { prisma, sessions } = makePrismaMock();
    sessions.push({
      id: "s-bob",
      userId: "bob",
      title: "Bob's chat",
      model: null,
      provider: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const svc = new ChatPersistenceService(prisma as never);
    const ok = await svc.setConversationPinned("s-bob", "alice", true);
    expect(ok).toBe(false);
    expect(sessions[0].pinned).toBeUndefined();
  });

  it("setConversationPinned never calls chatSession.update (avoids @updatedAt bump)", async () => {
    const { prisma, sessions } = makePrismaMock();
    sessions.push({
      id: "s1",
      userId: "alice",
      title: "Chat",
      model: null,
      provider: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const svc = new ChatPersistenceService(prisma as never);
    await svc.setConversationPinned("s1", "alice", true);
    expect(prisma.chatSession.update).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).toHaveBeenCalled();
  });

  it("listConversationsForUser returns pinned rows first and maps pinned/pinnedAt", async () => {
    const { prisma, sessions } = makePrismaMock();
    const day = (n: number) => new Date(2026, 0, n);
    sessions.push(
      // Oldest activity, but pinned — must surface FIRST despite the
      // paginated list otherwise being updatedAt desc.
      {
        id: "s-pinned-old",
        userId: "alice",
        title: "Pinned oldie",
        model: null,
        provider: null,
        pinned: true,
        pinnedAt: day(5),
        createdAt: day(1),
        updatedAt: day(1),
      },
      // pinned/pinnedAt mirror the schema's NOT NULL DEFAULT false / NULL —
      // Postgres never hands the service `undefined` here.
      {
        id: "s-new",
        userId: "alice",
        title: "Newest",
        model: null,
        provider: null,
        pinned: false,
        pinnedAt: null,
        createdAt: day(10),
        updatedAt: day(10),
      },
      {
        id: "s-mid",
        userId: "alice",
        title: "Middle",
        model: null,
        provider: null,
        pinned: false,
        pinnedAt: null,
        createdAt: day(7),
        updatedAt: day(7),
      },
    );
    const svc = new ChatPersistenceService(prisma as never);
    const rows = await svc.listConversationsForUser("alice", 20, 0);
    expect(rows.map((r) => r.id)).toEqual(["s-pinned-old", "s-new", "s-mid"]);
    expect(rows[0]).toMatchObject({
      pinned: true,
      pinnedAt: day(5).toISOString(),
    });
    expect(rows[1]).toMatchObject({ pinned: false, pinnedAt: null });
  });
});
