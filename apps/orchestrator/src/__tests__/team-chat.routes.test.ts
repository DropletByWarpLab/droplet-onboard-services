/**
 * WARP-1683 — Team chat v1 routes (mocked-Prisma lane).
 *
 * Covered here:
 *   - zod validation BEFORE any prisma call (invalid bodies/queries → 400,
 *     prisma untouched)
 *   - role gating: humans (owner/admin/family/guest) pass, service 403s
 *   - contacts roster: ACTIVE non-service users only, minimal fields
 *   - direct-thread rules: exactly one other participant; dedupe returns
 *     the existing pair thread; group needs ≥2 others
 *   - participant-only access: non-participants get 404 (never 403 — no
 *     existence leak) on messages list, message send, read, transcript
 *   - file_share: sender's space access is checked via
 *     resolveFileDepartment + checkSpaceAccess; denial blocks the send
 *   - ai_chat_share: sender must own the ChatSession — ownership compares
 *     ChatSession.userId against req.user.USERNAME (the llm.ts persistence
 *     semantics; pinned here so a future id/username mixup fails loudly),
 *     and the snapshot skips tool-call internals
 *   - unread lifecycle: send → unread-count 1 → read → 0 (mock-level;
 *     the real-DB proof lives in team-chat.pg.test.ts)
 *
 * The IDOR/guard-rail invariants that only a real Postgres can prove run in
 * src/__tests__/team-chat.pg.test.ts (rbac-v2-guard-rails.pg.test.ts lane).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";

// Functional requireRole stand-in — mimics the real allowed-set check so the
// router's role list (humans only, no service principals) is actually pinned,
// without pulling auth.ts's full dependency graph into the unit lane.
// WARP-1685: the router now also imports requireRoleOrMcpService for the
// tool-reachable routes; this lane never presents the mcp principal, so the
// stand-in defers straight to the role check (service-path behavior is
// pinned in team-chat-meetings.routes.test.ts + the pg lane).
vi.mock("../middleware/auth.js", () => {
  const roleCheck =
    (...allowed: string[]) =>
    (req: Request, res: Response, next: NextFunction) => {
      const role = (req as { user?: { role?: string } }).user?.role;
      if (typeof role !== "string" || !allowed.includes(role)) {
        res.status(403).json({ error: "Forbidden: role not permitted" });
        return;
      }
      next();
    };
  return {
    requireRole: roleCheck,
    requireRoleOrMcpService:
      (...allowed: string[]) =>
      (req: Request, res: Response, next: NextFunction) => {
        const u = (req as { user?: { id?: string; role?: string } }).user;
        if (u?.id === "_service:mcp" && u.role === "service") {
          next();
          return;
        }
        roleCheck(...allowed)(req, res, next);
      },
  };
});

const { checkSpaceAccessMock, resolveFileDepartmentMock } = vi.hoisted(() => ({
  checkSpaceAccessMock: vi.fn(),
  resolveFileDepartmentMock: vi.fn(),
}));

vi.mock("../middleware/space.js", () => ({
  checkSpaceAccess: checkSpaceAccessMock,
}));
vi.mock("../services/file-registry.service.js", () => ({
  resolveFileDepartment: resolveFileDepartmentMock,
}));

import { createTeamChatRouter } from "../routes/team-chat.js";

// ── In-memory prisma stub ───────────────────────────────────────────

interface UserRow {
  id: string;
  username: string;
  displayName: string;
  role: string;
  directoryStatus: "ACTIVE" | "DEACTIVATED";
}
interface ThreadRow {
  id: string;
  kind: "direct" | "group";
  title: string | null;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
  lastMessageAt: Date;
}
interface ParticipantRow {
  id: string;
  threadId: string;
  userId: string;
  joinedAt: Date;
  lastReadAt: Date;
}
interface MessageRow {
  id: string;
  threadId: string;
  senderId: string;
  kind: "text" | "file_share" | "ai_chat_share";
  body: string | null;
  sharedNcFileId: number | null;
  sharedFileName: string | null;
  sharedFilePath: string | null;
  sharedFileSpace: string | null;
  sharedChatSessionId: string | null;
  sharedChatSnapshot: unknown;
  createdAt: Date;
}
/**
 * WARP-1898 — only `kind` matters here: `departmentSpaceId()` reads it to
 * decide whether a resolved department is the seeded HOUSEHOLD one (the
 * dashboard addresses that as the legacy `"shared"` space id) or an
 * ordinary library (`dept:<uuid>`).
 */
interface DepartmentRow {
  id: string;
  kind: string;
}
interface SessionRow {
  id: string;
  userId: string; // llm.ts stores the USERNAME here (WARP-304 semantics)
  title: string | null;
}
interface ChatMessageRow {
  sessionId: string;
  role: string;
  content: string;
  toolCallId: string | null;
  createdAt: Date;
}

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}`;

function createTeamChatPrisma(seed: {
  users?: UserRow[];
  threads?: ThreadRow[];
  participants?: ParticipantRow[];
  messages?: MessageRow[];
  sessions?: SessionRow[];
  chatMessages?: ChatMessageRow[];
  departments?: DepartmentRow[];
}) {
  const users = [...(seed.users ?? [])];
  const threads = [...(seed.threads ?? [])];
  const participants = [...(seed.participants ?? [])];
  const messages = [...(seed.messages ?? [])];
  const sessions = [...(seed.sessions ?? [])];
  const chatMessages = [...(seed.chatMessages ?? [])];
  const departments = [...(seed.departments ?? [])];

  const matchesMessageWhere = (
    m: MessageRow,
    where: {
      threadId?: string;
      senderId?: { not: string };
      createdAt?: { gt: Date };
      OR?: Array<{ threadId: string; createdAt: { gt: Date } }>;
    },
  ): boolean => {
    if (where.threadId !== undefined && m.threadId !== where.threadId) return false;
    if (where.senderId?.not !== undefined && m.senderId === where.senderId.not)
      return false;
    if (where.createdAt?.gt !== undefined && m.createdAt <= where.createdAt.gt)
      return false;
    if (where.OR !== undefined) {
      const hit = where.OR.some(
        (o) => m.threadId === o.threadId && m.createdAt > o.createdAt.gt,
      );
      if (!hit) return false;
    }
    return true;
  };

  const prisma = {
    users,
    threads,
    participants,
    messages,
    user: {
      findMany: vi.fn(
        async (args: {
          where: {
            id?: { in: string[] };
            directoryStatus?: string;
            role?: { in: string[] };
          };
          select?: Record<string, true>;
        }) => {
          const rows = users.filter((u) => {
            const w = args.where;
            if (w.id?.in !== undefined && !w.id.in.includes(u.id)) return false;
            if (
              w.directoryStatus !== undefined &&
              u.directoryStatus !== w.directoryStatus
            )
              return false;
            if (w.role?.in !== undefined && !w.role.in.includes(u.role))
              return false;
            return true;
          });
          // Honor `select` like real Prisma — the minimal-projection
          // assertion depends on it.
          if (!args.select) return rows;
          const keys = Object.keys(args.select);
          return rows.map((r) =>
            Object.fromEntries(keys.map((k) => [k, r[k as keyof UserRow]])),
          );
        },
      ),
    },
    teamChatThread: {
      findMany: vi.fn(async (args: { where?: { id?: { in: string[] } } }) => {
        let rows = threads.filter(
          (t) => args.where?.id?.in === undefined || args.where.id.in.includes(t.id),
        );
        rows = [...rows].sort(
          (a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime(),
        );
        return rows.map((t) => ({
          ...t,
          participants: participants.filter((p) => p.threadId === t.id),
          messages: messages
            .filter((m) => m.threadId === t.id)
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
            .slice(0, 1),
        }));
      }),
      findFirst: vi.fn(
        async (args: {
          where: {
            kind: string;
            AND: Array<{ participants: { some: { userId: string } } }>;
          };
        }) => {
          const need = args.where.AND.map((c) => c.participants.some.userId);
          const t = threads.find(
            (row) =>
              row.kind === args.where.kind &&
              need.every((uid) =>
                participants.some((p) => p.threadId === row.id && p.userId === uid),
              ),
          );
          if (!t) return null;
          return {
            ...t,
            participants: participants.filter((p) => p.threadId === t.id),
          };
        },
      ),
      create: vi.fn(
        async (args: {
          data: {
            kind: "direct" | "group";
            title?: string | null;
            createdById: string;
            participants: { create: Array<{ userId: string }> };
          };
        }) => {
          const t: ThreadRow = {
            id: nextId("thread"),
            kind: args.data.kind,
            title: args.data.title ?? null,
            createdById: args.data.createdById,
            createdAt: new Date(),
            updatedAt: new Date(),
            lastMessageAt: new Date(),
          };
          threads.push(t);
          const created = args.data.participants.create.map((p) => {
            const row: ParticipantRow = {
              id: nextId("part"),
              threadId: t.id,
              userId: p.userId,
              joinedAt: new Date(),
              lastReadAt: new Date(),
            };
            participants.push(row);
            return row;
          });
          return { ...t, participants: created };
        },
      ),
      update: vi.fn(
        async (args: { where: { id: string }; data: { lastMessageAt: Date } }) => {
          const t = threads.find((x) => x.id === args.where.id);
          if (!t) throw new Error("thread not found");
          t.lastMessageAt = args.data.lastMessageAt;
          return t;
        },
      ),
    },
    teamChatParticipant: {
      findUnique: vi.fn(
        async (args: {
          where: { threadId_userId: { threadId: string; userId: string } };
        }) =>
          participants.find(
            (p) =>
              p.threadId === args.where.threadId_userId.threadId &&
              p.userId === args.where.threadId_userId.userId,
          ) ?? null,
      ),
      findMany: vi.fn(async (args: { where: { userId: string } }) =>
        participants.filter((p) => p.userId === args.where.userId),
      ),
      updateMany: vi.fn(
        async (args: {
          where: { threadId: string; userId: string };
          data: { lastReadAt: Date };
        }) => {
          let count = 0;
          for (const p of participants) {
            if (
              p.threadId === args.where.threadId &&
              p.userId === args.where.userId
            ) {
              p.lastReadAt = args.data.lastReadAt;
              count++;
            }
          }
          return { count };
        },
      ),
    },
    teamChatMessage: {
      findMany: vi.fn(
        async (args: {
          where: Parameters<typeof matchesMessageWhere>[1];
          orderBy?:
            | { createdAt?: "desc" | "asc"; id?: "desc" | "asc" }
            | Array<{ createdAt?: "desc" | "asc"; id?: "desc" | "asc" }>;
          take?: number;
          cursor?: { id: string };
          skip?: number;
        }) => {
          let rows = messages.filter((m) => matchesMessageWhere(m, args.where));
          // Honor single-object AND array orderBy like real Prisma — the
          // route's total sort is [{createdAt desc}, {id desc}].
          const orderings = Array.isArray(args.orderBy)
            ? args.orderBy
            : args.orderBy
              ? [args.orderBy]
              : [];
          rows = [...rows].sort((a, b) => {
            for (const o of orderings) {
              if (o.createdAt) {
                const d = a.createdAt.getTime() - b.createdAt.getTime();
                if (d !== 0) return o.createdAt === "desc" ? -d : d;
              }
              if (o.id) {
                const d = a.id.localeCompare(b.id);
                if (d !== 0) return o.id === "desc" ? -d : d;
              }
            }
            return 0;
          });
          if (args.cursor) {
            const at = rows.findIndex((m) => m.id === args.cursor!.id);
            rows = at === -1 ? [] : rows.slice(at + (args.skip ?? 0));
          }
          if (args.take !== undefined) rows = rows.slice(0, args.take);
          return rows;
        },
      ),
      findUnique: vi.fn(
        async (args: { where: { id: string } }) =>
          messages.find((m) => m.id === args.where.id) ?? null,
      ),
      findFirst: vi.fn(
        async (args: { where: { id: string; threadId: string } }) =>
          messages.find(
            (m) => m.id === args.where.id && m.threadId === args.where.threadId,
          ) ?? null,
      ),
      count: vi.fn(
        async (args: { where: Parameters<typeof matchesMessageWhere>[1] }) =>
          messages.filter((m) => matchesMessageWhere(m, args.where)).length,
      ),
      create: vi.fn(
        async (args: {
          data: Omit<MessageRow, "id" | "createdAt"> & { createdAt?: Date };
        }) => {
          const m: MessageRow = {
            id: nextId("msg"),
            createdAt: new Date(),
            ...args.data,
          };
          messages.push(m);
          return m;
        },
      ),
    },
    chatSession: {
      findUnique: vi.fn(
        async (args: { where: { id: string } }) =>
          sessions.find((s) => s.id === args.where.id) ?? null,
      ),
    },
    // WARP-1898 — read by departmentSpaceId() when a file_share resolves to
    // a department, to pick the wire space id the recipient's link carries.
    department: {
      findUnique: vi.fn(
        async (args: { where: { id: string } }) =>
          departments.find((d) => d.id === args.where.id) ?? null,
      ),
    },
    chatMessage: {
      findMany: vi.fn(async (args: { where: { sessionId: string } }) =>
        chatMessages
          .filter((m) => m.sessionId === args.where.sessionId)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
      ),
    },
    $transaction: vi.fn(async (ops: Array<Promise<unknown>>) => Promise.all(ops)),
  };
  return prisma;
}

type StubPrisma = ReturnType<typeof createTeamChatPrisma>;

function buildApp(
  prisma: StubPrisma,
  user: { id: string; username: string; role: string },
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user?: typeof user }).user = user;
    next();
  });
  app.use("/api", createTeamChatRouter(prisma as never));
  return app;
}

const alice: UserRow = {
  id: "uuid-alice",
  username: "alice",
  displayName: "Alice A",
  role: "family",
  directoryStatus: "ACTIVE",
};
const bob: UserRow = {
  id: "uuid-bob",
  username: "bob",
  displayName: "Bob B",
  role: "family",
  directoryStatus: "ACTIVE",
};
const carol: UserRow = {
  id: "uuid-carol",
  username: "carol",
  displayName: "Carol C",
  role: "guest",
  directoryStatus: "ACTIVE",
};
const deactivated: UserRow = {
  id: "uuid-dead",
  username: "dave",
  displayName: "Dave D",
  role: "family",
  directoryStatus: "DEACTIVATED",
};
const service: UserRow = {
  id: "_service:voice",
  username: "_service:voice",
  displayName: "Voice",
  role: "service",
  directoryStatus: "ACTIVE",
};

const asAlice = { id: alice.id, username: alice.username, role: alice.role };
const asBob = { id: bob.id, username: bob.username, role: bob.role };

function seedThread(over: Partial<ThreadRow> = {}): ThreadRow {
  return {
    id: over.id ?? "thread-ab",
    kind: over.kind ?? "direct",
    title: over.title ?? null,
    createdById: over.createdById ?? alice.id,
    createdAt: over.createdAt ?? new Date("2026-08-01T10:00:00Z"),
    updatedAt: over.updatedAt ?? new Date("2026-08-01T10:00:00Z"),
    lastMessageAt: over.lastMessageAt ?? new Date("2026-08-01T10:00:00Z"),
  };
}

function seedParticipant(
  threadId: string,
  userId: string,
  over: Partial<ParticipantRow> = {},
): ParticipantRow {
  return {
    id: over.id ?? nextId("part"),
    threadId,
    userId,
    joinedAt: over.joinedAt ?? new Date("2026-08-01T10:00:00Z"),
    lastReadAt: over.lastReadAt ?? new Date("2026-08-01T10:00:00Z"),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: file unregistered (personal-space fallback) + space allowed.
  resolveFileDepartmentMock.mockResolvedValue(null);
  checkSpaceAccessMock.mockResolvedValue({ allowed: true, departmentId: "dep-1" });
});

// ── Role gating ─────────────────────────────────────────────────────

describe("team-chat — role gating", () => {
  it("service principals are refused (403) on every surface", async () => {
    const prisma = createTeamChatPrisma({ users: [alice] });
    const app = buildApp(prisma, {
      id: service.id,
      username: service.username,
      role: "service",
    });
    for (const [method, path] of [
      ["get", "/api/team-chat/contacts"],
      ["get", "/api/team-chat/threads"],
      ["post", "/api/team-chat/threads"],
      ["get", "/api/team-chat/unread-count"],
    ] as const) {
      const res = await request(app)[method](path);
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });

  it("guests may use team chat (roster read)", async () => {
    const prisma = createTeamChatPrisma({ users: [alice, carol] });
    const app = buildApp(prisma, {
      id: carol.id,
      username: carol.username,
      role: carol.role,
    });
    const res = await request(app).get("/api/team-chat/contacts");
    expect(res.status).toBe(200);
  });
});

// ── Contacts ────────────────────────────────────────────────────────

describe("GET /api/team-chat/contacts", () => {
  it("returns ACTIVE non-service users with minimal fields only", async () => {
    const prisma = createTeamChatPrisma({
      users: [alice, bob, carol, deactivated, service],
    });
    const app = buildApp(prisma, asAlice);
    const res = await request(app).get("/api/team-chat/contacts");
    expect(res.status).toBe(200);
    const ids = res.body.contacts.map((c: { id: string }) => c.id).sort();
    expect(ids).toEqual([alice.id, bob.id, carol.id].sort());
    // Minimal projection — no directoryStatus / email / hashes on the wire.
    expect(Object.keys(res.body.contacts[0]).sort()).toEqual(
      ["displayName", "id", "role", "username"].sort(),
    );
  });
});

// ── Thread creation ─────────────────────────────────────────────────

describe("POST /api/team-chat/threads", () => {
  it("rejects an invalid body before any prisma call", async () => {
    const prisma = createTeamChatPrisma({ users: [alice, bob] });
    const app = buildApp(prisma, asAlice);
    const res = await request(app)
      .post("/api/team-chat/threads")
      .send({ kind: "broadcast", participantIds: [] });
    expect(res.status).toBe(400);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(prisma.teamChatThread.create).not.toHaveBeenCalled();
  });

  it("direct requires exactly one other participant", async () => {
    const prisma = createTeamChatPrisma({ users: [alice, bob, carol] });
    const app = buildApp(prisma, asAlice);
    const res = await request(app)
      .post("/api/team-chat/threads")
      .send({ kind: "direct", participantIds: [bob.id, carol.id] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("direct_requires_one_participant");
  });

  it("group requires at least two other participants", async () => {
    const prisma = createTeamChatPrisma({ users: [alice, bob, carol] });
    const app = buildApp(prisma, asAlice);
    const res = await request(app)
      .post("/api/team-chat/threads")
      .send({ kind: "group", participantIds: [bob.id] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("group_requires_two_participants");
  });

  it("refuses participants that are deactivated, service, or unknown", async () => {
    const prisma = createTeamChatPrisma({
      users: [alice, bob, deactivated, service],
    });
    const app = buildApp(prisma, asAlice);
    for (const badId of [deactivated.id, service.id, "uuid-nobody"]) {
      const res = await request(app)
        .post("/api/team-chat/threads")
        .send({ kind: "direct", participantIds: [badId] });
      expect(res.status, badId).toBe(400);
      expect(res.body.error).toBe("invalid_participants");
    }
  });

  it("creates a direct thread with both participants", async () => {
    const prisma = createTeamChatPrisma({ users: [alice, bob] });
    const app = buildApp(prisma, asAlice);
    const res = await request(app)
      .post("/api/team-chat/threads")
      .send({ kind: "direct", participantIds: [bob.id] });
    expect(res.status).toBe(201);
    expect(res.body.thread.kind).toBe("direct");
    const uids = res.body.thread.participants
      .map((p: { userId: string }) => p.userId)
      .sort();
    expect(uids).toEqual([alice.id, bob.id].sort());
  });

  it("creates a group thread — title persisted, one participant row per member", async () => {
    const prisma = createTeamChatPrisma({ users: [alice, bob, carol] });
    const app = buildApp(prisma, asAlice);
    const res = await request(app)
      .post("/api/team-chat/threads")
      .send({
        kind: "group",
        participantIds: [bob.id, carol.id],
        title: "Ops crew",
      });
    expect(res.status).toBe(201);
    expect(res.body.thread.kind).toBe("group");
    expect(res.body.thread.title).toBe("Ops crew");
    const uids = res.body.thread.participants
      .map((p: { userId: string }) => p.userId)
      .sort();
    expect(uids).toEqual([alice.id, bob.id, carol.id].sort());
    // The rows really landed — caller + both others, exactly once each.
    const stored = prisma.participants.filter(
      (p) => p.threadId === res.body.thread.id,
    );
    expect(stored).toHaveLength(3);
  });

  it("dedupes an existing direct pair — returns the existing thread, creates nothing", async () => {
    const t = seedThread();
    const prisma = createTeamChatPrisma({
      users: [alice, bob],
      threads: [t],
      participants: [seedParticipant(t.id, alice.id), seedParticipant(t.id, bob.id)],
    });
    const app = buildApp(prisma, asAlice);
    const res = await request(app)
      .post("/api/team-chat/threads")
      .send({ kind: "direct", participantIds: [bob.id] });
    expect(res.status).toBe(200);
    expect(res.body.thread.id).toBe(t.id);
    expect(prisma.teamChatThread.create).not.toHaveBeenCalled();
  });
});

// ── Participant-only access (404, never 403) ────────────────────────

describe("participant-only access", () => {
  function abWorld() {
    const t = seedThread();
    return createTeamChatPrisma({
      users: [alice, bob, carol],
      threads: [t],
      participants: [seedParticipant(t.id, alice.id), seedParticipant(t.id, bob.id)],
      messages: [
        {
          id: "msg-existing",
          threadId: t.id,
          senderId: alice.id,
          kind: "ai_chat_share",
          body: null,
          sharedNcFileId: null,
          sharedFileName: null,
          sharedFilePath: null,
          sharedFileSpace: null,
          sharedChatSessionId: "sess-1",
          sharedChatSnapshot: { title: "T", messages: [] },
          createdAt: new Date("2026-08-01T11:00:00Z"),
        },
      ],
    });
  }

  it("non-participant gets 404 on messages list, send, read, transcript", async () => {
    const prisma = abWorld();
    const app = buildApp(prisma, {
      id: carol.id,
      username: carol.username,
      role: carol.role,
    });
    const list = await request(app).get("/api/team-chat/threads/thread-ab/messages");
    expect(list.status).toBe(404);
    const send = await request(app)
      .post("/api/team-chat/threads/thread-ab/messages")
      .send({ kind: "text", body: "hi" });
    expect(send.status).toBe(404);
    const read = await request(app).post("/api/team-chat/threads/thread-ab/read");
    expect(read.status).toBe(404);
    const transcript = await request(app).get(
      "/api/team-chat/messages/msg-existing/transcript",
    );
    expect(transcript.status).toBe(404);
  });

  it("participant reads messages newest-first with cursor pagination", async () => {
    const prisma = abWorld();
    const app = buildApp(prisma, asAlice);
    // Two more messages, later than msg-existing.
    for (const [id, at] of [
      ["msg-2", "2026-08-01T12:00:00Z"],
      ["msg-3", "2026-08-01T13:00:00Z"],
    ] as const) {
      prisma.messages.push({
        id,
        threadId: "thread-ab",
        senderId: bob.id,
        kind: "text",
        body: `hello ${id}`,
        sharedNcFileId: null,
        sharedFileName: null,
        sharedFilePath: null,
        sharedFileSpace: null,
        sharedChatSessionId: null,
        sharedChatSnapshot: null,
        createdAt: new Date(at),
      });
    }
    const page1 = await request(app).get(
      "/api/team-chat/threads/thread-ab/messages?limit=2",
    );
    expect(page1.status).toBe(200);
    expect(page1.body.messages.map((m: { id: string }) => m.id)).toEqual([
      "msg-3",
      "msg-2",
    ]);
    expect(page1.body.nextCursor).toBe("msg-2");
    const page2 = await request(app).get(
      `/api/team-chat/threads/thread-ab/messages?limit=2&cursor=${page1.body.nextCursor}`,
    );
    expect(page2.status).toBe(200);
    expect(page2.body.messages.map((m: { id: string }) => m.id)).toEqual([
      "msg-existing",
    ]);
    expect(page2.body.nextCursor).toBeNull();
  });

  it("same-millisecond messages page without skips or duplicates (id tiebreak)", async () => {
    const prisma = abWorld();
    const app = buildApp(prisma, asAlice);
    // Three messages sharing ONE timestamp — only a total order pages them.
    const at = new Date("2026-08-01T12:00:00.000Z");
    for (const id of ["msg-tie-a", "msg-tie-b", "msg-tie-c"]) {
      prisma.messages.push({
        id,
        threadId: "thread-ab",
        senderId: bob.id,
        kind: "text",
        body: id,
        sharedNcFileId: null,
        sharedFileName: null,
        sharedFilePath: null,
        sharedFileSpace: null,
        sharedChatSessionId: null,
        sharedChatSnapshot: null,
        createdAt: at,
      });
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const url: string = `/api/team-chat/threads/thread-ab/messages?limit=2${
        cursor ? `&cursor=${cursor}` : ""
      }`;
      const page = await request(app).get(url);
      expect(page.status).toBe(200);
      seen.push(...page.body.messages.map((m: { id: string }) => m.id));
      cursor = page.body.nextCursor;
    } while (cursor !== null);
    // Every message exactly once — the tied trio included.
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(
      expect.arrayContaining(["msg-tie-a", "msg-tie-b", "msg-tie-c", "msg-existing"]),
    );
    expect(seen).toHaveLength(4);
  });

  it("rejects a bad limit before touching prisma", async () => {
    const prisma = abWorld();
    const app = buildApp(prisma, asAlice);
    const res = await request(app).get(
      "/api/team-chat/threads/thread-ab/messages?limit=0",
    );
    expect(res.status).toBe(400);
    expect(prisma.teamChatMessage.findMany).not.toHaveBeenCalled();
  });

  it("400s a cursor that isn't a message of THIS thread (no cross-thread anchor, no 500)", async () => {
    const prisma = abWorld();
    const app = buildApp(prisma, asAlice);
    const res = await request(app).get(
      "/api/team-chat/threads/thread-ab/messages?cursor=msg-from-elsewhere",
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_cursor");
    expect(prisma.teamChatMessage.findMany).not.toHaveBeenCalled();
  });
});

// ── Sending: text + forwards ────────────────────────────────────────

describe("POST /api/team-chat/threads/:id/messages", () => {
  function abWorld(departments: DepartmentRow[] = []) {
    const t = seedThread();
    return createTeamChatPrisma({
      users: [alice, bob],
      threads: [t],
      participants: [seedParticipant(t.id, alice.id), seedParticipant(t.id, bob.id)],
      departments,
      sessions: [
        { id: "sess-alice", userId: alice.username, title: "Quarterly plan" },
        { id: "sess-bob", userId: bob.username, title: "Bob's chat" },
      ],
      chatMessages: [
        {
          sessionId: "sess-alice",
          role: "user",
          content: "What's our plan?",
          toolCallId: null,
          createdAt: new Date("2026-08-01T09:00:00Z"),
        },
        {
          sessionId: "sess-alice",
          role: "assistant",
          content: "",
          toolCallId: null,
          createdAt: new Date("2026-08-01T09:00:10Z"),
        },
        {
          sessionId: "sess-alice",
          role: "tool",
          content: "{\"result\":42}",
          toolCallId: "call-1",
          createdAt: new Date("2026-08-01T09:00:20Z"),
        },
        {
          sessionId: "sess-alice",
          role: "assistant",
          content: "Here is the plan.",
          toolCallId: null,
          createdAt: new Date("2026-08-01T09:00:30Z"),
        },
      ],
    });
  }

  it("rejects an empty text body before prisma", async () => {
    const prisma = abWorld();
    const app = buildApp(prisma, asAlice);
    const res = await request(app)
      .post("/api/team-chat/threads/thread-ab/messages")
      .send({ kind: "text", body: "   " });
    expect(res.status).toBe(400);
    expect(prisma.teamChatMessage.create).not.toHaveBeenCalled();
  });

  it("sends text and bumps thread.lastMessageAt", async () => {
    const prisma = abWorld();
    const app = buildApp(prisma, asAlice);
    const before = prisma.threads[0].lastMessageAt.getTime();
    const res = await request(app)
      .post("/api/team-chat/threads/thread-ab/messages")
      .send({ kind: "text", body: "hello bob" });
    expect(res.status).toBe(201);
    expect(res.body.message.kind).toBe("text");
    expect(res.body.message.body).toBe("hello bob");
    expect(prisma.threads[0].lastMessageAt.getTime()).toBeGreaterThan(before);
  });

  it("file_share checks the sender's space access and caches name/path", async () => {
    const prisma = abWorld();
    resolveFileDepartmentMock.mockResolvedValue("dep-1");
    checkSpaceAccessMock.mockResolvedValue({ allowed: true, departmentId: "dep-1" });
    const app = buildApp(prisma, asAlice);
    const res = await request(app)
      .post("/api/team-chat/threads/thread-ab/messages")
      .send({
        kind: "file_share",
        ncFileId: 4711,
        fileName: "q3.docx",
        filePath: "/Sales/q3.docx",
        caption: "latest numbers",
      });
    expect(res.status).toBe(201);
    expect(res.body.message.sharedNcFileId).toBe(4711);
    expect(res.body.message.sharedFileName).toBe("q3.docx");
    expect(res.body.message.sharedFilePath).toBe("/Sales/q3.docx");
    expect(res.body.message.body).toBe("latest numbers");
    // The gate ran with the SENDER's identity (User.id UUID, not username).
    expect(resolveFileDepartmentMock).toHaveBeenCalledWith(expect.anything(), 4711);
    expect(checkSpaceAccessMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ id: alice.id, role: alice.role }),
      "dep-1",
      "reader",
    );
  });

  it("file_share is blocked when the sender lacks access to the file's space", async () => {
    const prisma = abWorld();
    resolveFileDepartmentMock.mockResolvedValue("dep-secret");
    checkSpaceAccessMock.mockResolvedValue({
      allowed: false,
      status: 403,
      error: "Forbidden: not a member of this space",
    });
    const app = buildApp(prisma, asAlice);
    const res = await request(app)
      .post("/api/team-chat/threads/thread-ab/messages")
      .send({
        kind: "file_share",
        ncFileId: 999,
        fileName: "secret.xlsx",
        filePath: "/Finance/secret.xlsx",
      });
    expect(res.status).toBe(403);
    expect(prisma.teamChatMessage.create).not.toHaveBeenCalled();
  });

  // ── WARP-1898: which SPACE a shared file belongs to ──
  //
  // `sharedFilePath` is HOME-relative — the picker stores a listing row's
  // `path` verbatim, and listing entries carry the mount segment
  // (WARP-1140) — but the SPACE was never stored, so the recipient's link
  // carried none, and /files applied the sender's path inside the
  // RECIPIENT's personal space. These pin the resolution order: registry
  // first, sender's claim only as a fallback.

  it("takes the space from the file REGISTRY, overriding the sender's claim", async () => {
    const prisma = abWorld();
    resolveFileDepartmentMock.mockResolvedValue("dep-1");
    checkSpaceAccessMock.mockResolvedValue({ allowed: true, departmentId: "dep-1" });
    const app = buildApp(prisma, asAlice);
    const res = await request(app)
      .post("/api/team-chat/threads/thread-ab/messages")
      .send({
        kind: "file_share",
        ncFileId: 4711,
        fileName: "q3.docx",
        filePath: "/Sales/q3.docx",
        // A pick from the picker's SEARCH tab can carry the wrong space —
        // the registry is what the access check itself keyed on, so it wins.
        space: "personal",
      });
    expect(res.status).toBe(201);
    expect(res.body.message.sharedFileSpace).toBe("dept:dep-1");
  });

  it("addresses the household department as the wire 'shared' space id", async () => {
    const prisma = abWorld([{ id: "dep-house", kind: "HOUSEHOLD" }]);
    resolveFileDepartmentMock.mockResolvedValue("dep-house");
    checkSpaceAccessMock.mockResolvedValue({
      allowed: true,
      departmentId: "dep-house",
    });
    const app = buildApp(prisma, asAlice);
    const res = await request(app)
      .post("/api/team-chat/threads/thread-ab/messages")
      .send({
        kind: "file_share",
        ncFileId: 88,
        fileName: "menu.pdf",
        filePath: "/Household/menu.pdf",
      });
    expect(res.status).toBe(201);
    // NOT "dept:dep-house": /api/files/spaces reports the household space
    // under the legacy "shared" id, and that is what /files?space= matches.
    expect(res.body.message.sharedFileSpace).toBe("shared");
  });

  it("falls back to the sender's claim for a file with no registry row", async () => {
    const prisma = abWorld();
    resolveFileDepartmentMock.mockResolvedValue(null);
    const app = buildApp(prisma, asAlice);
    const res = await request(app)
      .post("/api/team-chat/threads/thread-ab/messages")
      .send({
        kind: "file_share",
        ncFileId: 12,
        fileName: "notes.txt",
        filePath: "/notes.txt",
        space: "personal",
      });
    expect(res.status).toBe(201);
    expect(res.body.message.sharedFileSpace).toBe("personal");
  });

  it("stores null when nothing can determine the space (never guesses personal)", async () => {
    const prisma = abWorld();
    resolveFileDepartmentMock.mockResolvedValue(null);
    const app = buildApp(prisma, asAlice);
    const res = await request(app)
      .post("/api/team-chat/threads/thread-ab/messages")
      .send({
        kind: "file_share",
        ncFileId: 12,
        fileName: "notes.txt",
        filePath: "/notes.txt",
        // No `space` — an older client, or a searched pick that genuinely
        // doesn't know. Guessing "personal" here is the original defect.
      });
    expect(res.status).toBe(201);
    expect(res.body.message.sharedFileSpace).toBeNull();
  });

  it("400s a malformed space instead of writing it into a link", async () => {
    const prisma = abWorld();
    resolveFileDepartmentMock.mockResolvedValue(null);
    const app = buildApp(prisma, asAlice);
    const res = await request(app)
      .post("/api/team-chat/threads/thread-ab/messages")
      .send({
        kind: "file_share",
        ncFileId: 12,
        fileName: "notes.txt",
        filePath: "/notes.txt",
        space: "dept:not-a-uuid",
      });
    expect(res.status).toBe(400);
    expect(prisma.teamChatMessage.create).not.toHaveBeenCalled();
  });

  it("ai_chat_share 404s an unknown session id (no existence leak)", async () => {
    const prisma = abWorld();
    const app = buildApp(prisma, asAlice);
    const res = await request(app)
      .post("/api/team-chat/threads/thread-ab/messages")
      .send({
        kind: "ai_chat_share",
        chatSessionId: "11111111-1111-4111-8111-111111111111",
      });
    expect(res.status).toBe(404);
    expect(prisma.teamChatMessage.create).not.toHaveBeenCalled();
  });

  it("ai_chat_share succeeds for the owner and stores an immutable snapshot", async () => {
    const prisma = abWorld();
    // Re-key the session to a syntactically valid uuid (zod requires uuid).
    const sessId = "22222222-2222-4222-8222-222222222222";
    const sessions = (
      prisma as unknown as {
        chatSession: { findUnique: ReturnType<typeof vi.fn> };
      }
    ).chatSession;
    sessions.findUnique.mockImplementation(
      async (args: { where: { id: string } }) =>
        args.where.id === sessId
          ? { id: sessId, userId: alice.username, title: "Quarterly plan" }
          : null,
    );
    (
      prisma as unknown as { chatMessage: { findMany: ReturnType<typeof vi.fn> } }
    ).chatMessage.findMany.mockImplementation(async () => [
      {
        sessionId: sessId,
        role: "user",
        content: "What's our plan?",
        toolCallId: null,
        createdAt: new Date("2026-08-01T09:00:00Z"),
      },
      {
        sessionId: sessId,
        role: "tool",
        content: "{\"result\":42}",
        toolCallId: "call-1",
        createdAt: new Date("2026-08-01T09:00:20Z"),
      },
      {
        sessionId: sessId,
        role: "assistant",
        content: "Here is the plan.",
        toolCallId: null,
        createdAt: new Date("2026-08-01T09:00:30Z"),
      },
    ]);
    const app = buildApp(prisma, asAlice);
    const res = await request(app)
      .post("/api/team-chat/threads/thread-ab/messages")
      .send({ kind: "ai_chat_share", chatSessionId: sessId, caption: "fyi" });
    expect(res.status).toBe(201);
    const stored = prisma.messages.find((m) => m.kind === "ai_chat_share");
    expect(stored?.sharedChatSnapshot).toEqual({
      title: "Quarterly plan",
      messages: [
        {
          role: "user",
          content: "What's our plan?",
          createdAt: "2026-08-01T09:00:00.000Z",
        },
        {
          role: "assistant",
          content: "Here is the plan.",
          createdAt: "2026-08-01T09:00:30.000Z",
        },
      ],
    });
  });

  it("ai_chat_share 404s when the session belongs to someone else — ownership compares ChatSession.userId to the USERNAME", async () => {
    const prisma = abWorld();
    const sessId = "33333333-3333-4333-8333-333333333333";
    (
      prisma as unknown as { chatSession: { findUnique: ReturnType<typeof vi.fn> } }
    ).chatSession.findUnique.mockImplementation(async () => ({
      id: sessId,
      // Owned by bob (username semantics) — alice's USER ID as owner value
      // must ALSO fail, pinning that we compare against username, not id.
      userId: bob.username,
      title: "Bob's chat",
    }));
    const app = buildApp(prisma, asAlice);
    const res = await request(app)
      .post("/api/team-chat/threads/thread-ab/messages")
      .send({ kind: "ai_chat_share", chatSessionId: sessId });
    expect(res.status).toBe(404);
    expect(prisma.teamChatMessage.create).not.toHaveBeenCalled();
  });
});

// ── Transcript + unread ─────────────────────────────────────────────

describe("transcript + unread count", () => {
  it("transcript 404s for non-ai_chat_share kinds", async () => {
    const t = seedThread();
    const prisma = createTeamChatPrisma({
      users: [alice, bob],
      threads: [t],
      participants: [seedParticipant(t.id, alice.id), seedParticipant(t.id, bob.id)],
      messages: [
        {
          id: "msg-text",
          threadId: t.id,
          senderId: bob.id,
          kind: "text",
          body: "plain",
          sharedNcFileId: null,
          sharedFileName: null,
          sharedFilePath: null,
          sharedFileSpace: null,
          sharedChatSessionId: null,
          sharedChatSnapshot: null,
          createdAt: new Date(),
        },
      ],
    });
    const app = buildApp(prisma, asAlice);
    const res = await request(app).get("/api/team-chat/messages/msg-text/transcript");
    expect(res.status).toBe(404);
  });

  it("unread lifecycle: bob sends → alice count 1 → alice reads → 0", async () => {
    const t = seedThread();
    const prisma = createTeamChatPrisma({
      users: [alice, bob],
      threads: [t],
      participants: [
        seedParticipant(t.id, alice.id, {
          lastReadAt: new Date("2026-08-01T10:00:00Z"),
        }),
        seedParticipant(t.id, bob.id),
      ],
    });
    const bobApp = buildApp(prisma, asBob);
    const aliceApp = buildApp(prisma, asAlice);

    await request(bobApp)
      .post("/api/team-chat/threads/thread-ab/messages")
      .send({ kind: "text", body: "ping" });

    const unread1 = await request(aliceApp).get("/api/team-chat/unread-count");
    expect(unread1.status).toBe(200);
    expect(unread1.body.total).toBe(1);
    // Bob's own unread stays 0 (own messages never count).
    const bobUnread = await request(bobApp).get("/api/team-chat/unread-count");
    expect(bobUnread.body.total).toBe(0);

    const read = await request(aliceApp).post("/api/team-chat/threads/thread-ab/read");
    expect(read.status).toBe(204);

    const unread2 = await request(aliceApp).get("/api/team-chat/unread-count");
    expect(unread2.body.total).toBe(0);

    // Thread list carries the per-thread unreadCount too.
    const threads = await request(aliceApp).get("/api/team-chat/threads");
    expect(threads.status).toBe(200);
    expect(threads.body.threads[0].unreadCount).toBe(0);
    expect(threads.body.threads[0].lastMessage.body).toBe("ping");
  });
});
