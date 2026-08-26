/**
 * WARP-1683 — Team chat v1: the invariants only a REAL Postgres can prove,
 * driven end-to-end through the real router (rbac-v2-guard-rails.pg.test.ts
 * lane and rules).
 *
 * WHY THESE CASES RUN HERE
 *
 * The mocked lane (team-chat.routes.test.ts) proves the router calls the
 * right things; a hand-written stub then answers the way the test author
 * expects. Everything access-shaped therefore re-runs against real rows:
 *
 *   AC5 / IDOR   — a non-participant gets 404 (never 403, no existence
 *                  leak) on a thread's messages AND on a forwarded
 *                  transcript, with the real unique-index membership probe;
 *   dedupe       — a second direct-thread create for the same pair returns
 *                  the SAME row (the both-`some` participant query, real);
 *   unread       — send → count 1 → read → 0, as real COUNTs against the
 *                  real lastReadAt cursor + senderId exclusion;
 *   file_share   — blocked when the sender lacks membership in the file's
 *                  department (real File registry row + real
 *                  checkSpaceAccess truth table), allowed for a member;
 *   ai_chat_share— blocked (404) when the ChatSession belongs to someone
 *                  else — pinning the USERNAME ownership semantics against
 *                  a real row — and the stored snapshot survives the source
 *                  session's deletion (FK SET NULL + immutable Json).
 *
 * Gated on RUN_PG_INTEGRATION=1 + DATABASE_URL, exactly like
 * access-role.pg.test.ts. Local: scripts/test-orchestrator-pg.sh. CI: the
 * `pg-integration` job in .github/workflows/orchestrator-tests.yml.
 *
 * FIXTURE SCOPING — this DB is shared by the pg suites running in parallel.
 * Every row this file mints is namespaced `warp1683-` (usernames, dept
 * name/slug, file paths; ncFileIds sit in a reserved 1683xx range) and every
 * cleanup is scoped to that prefix — never an unscoped deleteMany, never a
 * TRUNCATE (the access-role.pg.test.ts rule).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";

// The DB-less lane's global setup mocks @prisma/client; this file needs the
// real driver (access-role.pg.test.ts precedent).
vi.unmock("@prisma/client");

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    NEXTCLOUD_URL: "http://nextcloud.test",
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
}));

// Leaf EFFECTS are mocked; every DECISION is real. Keeps the suite off
// Redis/Nextcloud without touching the access rails (rbac lane idiom).
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/session.service.js", () => ({
  createSession: vi.fn(async () => ({ sid: "sid-test", evictedSids: [] })),
  checkSession: vi.fn(async () => ({ kind: "ok", record: {} })),
  deleteSession: vi.fn(async () => undefined),
  revokeAllSessions: vi.fn(async () => 1),
}));
vi.mock("../services/nextcloud-session.service.js", () => ({
  storeNcToken: vi.fn().mockResolvedValue(undefined),
  getNcToken: vi.fn().mockResolvedValue(null),
  deleteNcToken: vi.fn().mockResolvedValue(undefined),
  touchNcToken: vi.fn().mockResolvedValue(undefined),
  resolveNcToken: vi.fn().mockResolvedValue("test-nc-token"),
}));
vi.mock("../services/auth-denylist.service.js", () => ({
  denylistUser: vi.fn().mockResolvedValue(undefined),
  isUserDenied: vi.fn().mockResolvedValue(false),
}));

import { createTeamChatRouter } from "../routes/team-chat.js";

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

describe.skipIf(!RUN)("team chat — real Postgres (WARP-1683)", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } =
      await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
  });

  const PREFIX = "warp1683-";
  const OURS = { startsWith: PREFIX } as const;
  /** Reserved ncFileId range for this suite's registry fixtures. */
  const NC_FILE_DEPT = 168_301;
  const NC_FILE_DEPT_2 = 168_302;

  // FK-ordered, prefix-scoped cleanup. Threads are addressed through our
  // users' participant rows (participants/messages cascade with the thread);
  // sessions are username-keyed so the prefix scopes them. Never an unscoped
  // deleteMany, never a TRUNCATE (the access-role.pg.test.ts rule).
  async function cleanupOurRows() {
    const ourUsers = await prisma.user.findMany({
      where: { username: OURS },
      select: { id: true },
    });
    const ourIds = ourUsers.map((u) => u.id);
    if (ourIds.length > 0) {
      await prisma.teamChatThread.deleteMany({
        where: { participants: { some: { userId: { in: ourIds } } } },
      });
    }
    await prisma.chatSession.deleteMany({ where: { userId: OURS } });
    await prisma.file.deleteMany({
      where: { ncFileId: { in: [NC_FILE_DEPT, NC_FILE_DEPT_2] } },
    });
    await prisma.departmentMembership.deleteMany({
      where: { department: { slug: OURS } },
    });
    await prisma.department.deleteMany({ where: { slug: OURS } });
    await prisma.user.deleteMany({ where: { username: OURS } });
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    await cleanupOurRows();
  });

  // Clean at end-of-suite too, not just before each test. rail 5 in
  // rbac-v2-guard-rails.pg.test.ts counts operators BOX-WIDE, so an ACTIVE
  // admin/owner this suite leaves on the shared DB (mallory, owner) reads as a
  // foreign operator there and fails its last-operator premise. beforeEach
  // alone leaves the final test's rows behind; the pg lane also runs
  // --no-file-parallelism so no two suites' operators are ever live at once.
  afterAll(async () => {
    await cleanupOurRows();
    await prisma.$disconnect();
  });

  // ── fixtures ─────────────────────────────────────────────────────

  async function mkUser(suffix: string, role: "owner" | "admin" | "family" | "guest") {
    const username = `${PREFIX}${suffix}`;
    return prisma.user.create({
      data: {
        username,
        displayName: username,
        nextcloudUsername: username,
        role,
        directoryStatus: "ACTIVE",
      },
    });
  }

  function buildApp(actor: { id: string; username: string; role: string }) {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as unknown as { user: typeof actor & { displayName: string } }).user = {
        ...actor,
        displayName: actor.username,
      };
      next();
    });
    app.use("/api", createTeamChatRouter(prisma));
    return app;
  }

  const asActor = (u: { id: string; username: string; role: string }) => ({
    id: u.id,
    username: u.username,
    role: u.role,
  });

  async function mkDirectThread(
    a: { id: string; username: string; role: string },
    b: { id: string },
  ): Promise<string> {
    const res = await request(buildApp(asActor(a)))
      .post("/api/team-chat/threads")
      .send({ kind: "direct", participantIds: [b.id] });
    expect(res.status).toBe(201);
    return res.body.thread.id as string;
  }

  // ── AC5 / IDOR — participant-only, 404 not 403 ──────────────────

  it("a non-participant gets 404 (not 403) on thread messages and on a forwarded transcript", async () => {
    const alice = await mkUser("alice", "family");
    const bob = await mkUser("bob", "family");
    const mallory = await mkUser("mallory", "admin"); // even admins: not a participant → invisible

    const threadId = await mkDirectThread(alice, bob);

    // Alice forwards a chat of hers into the thread.
    const session = await prisma.chatSession.create({
      data: { userId: alice.username, title: `${PREFIX}plan` },
    });
    await prisma.chatMessage.create({
      data: { sessionId: session.id, role: "user", content: "hello plan" },
    });
    const sent = await request(buildApp(asActor(alice)))
      .post(`/api/team-chat/threads/${threadId}/messages`)
      .send({ kind: "ai_chat_share", chatSessionId: session.id });
    expect(sent.status).toBe(201);
    const messageId = sent.body.message.id as string;

    const malloryApp = buildApp(asActor(mallory));
    const list = await request(malloryApp).get(
      `/api/team-chat/threads/${threadId}/messages`,
    );
    expect(list.status).toBe(404);
    const send = await request(malloryApp)
      .post(`/api/team-chat/threads/${threadId}/messages`)
      .send({ kind: "text", body: "let me in" });
    expect(send.status).toBe(404);
    const transcript = await request(malloryApp).get(
      `/api/team-chat/messages/${messageId}/transcript`,
    );
    expect(transcript.status).toBe(404);

    // The participant DOES see both.
    const bobApp = buildApp(asActor(bob));
    const bobList = await request(bobApp).get(
      `/api/team-chat/threads/${threadId}/messages`,
    );
    expect(bobList.status).toBe(200);
    const bobTranscript = await request(bobApp).get(
      `/api/team-chat/messages/${messageId}/transcript`,
    );
    expect(bobTranscript.status).toBe(200);
    expect(bobTranscript.body.messages).toEqual([
      expect.objectContaining({ role: "user", content: "hello plan" }),
    ]);
  });

  // ── direct-thread dedupe ────────────────────────────────────────

  it("a second direct create for the same pair returns the SAME thread row", async () => {
    const alice = await mkUser("alice", "family");
    const bob = await mkUser("bob", "family");

    const first = await mkDirectThread(alice, bob);

    // Same pair, initiated from the OTHER side — still the same thread.
    const again = await request(buildApp(asActor(bob)))
      .post("/api/team-chat/threads")
      .send({ kind: "direct", participantIds: [alice.id] });
    expect(again.status).toBe(200);
    expect(again.body.thread.id).toBe(first);

    const count = await prisma.teamChatThread.count({
      where: { participants: { some: { userId: alice.id } } },
    });
    expect(count).toBe(1);
  });

  // ── unread lifecycle ────────────────────────────────────────────

  it("unread: send → 1 → read → 0 (own messages never count)", async () => {
    const alice = await mkUser("alice", "family");
    const bob = await mkUser("bob", "family");
    const threadId = await mkDirectThread(alice, bob);

    const aliceApp = buildApp(asActor(alice));
    const bobApp = buildApp(asActor(bob));

    const sent = await request(bobApp)
      .post(`/api/team-chat/threads/${threadId}/messages`)
      .send({ kind: "text", body: "ping" });
    expect(sent.status).toBe(201);

    const unread1 = await request(aliceApp).get("/api/team-chat/unread-count");
    expect(unread1.body.total).toBe(1);
    // Sender's own unread is 0 — own messages are excluded.
    const bobUnread = await request(bobApp).get("/api/team-chat/unread-count");
    expect(bobUnread.body.total).toBe(0);
    // Per-thread count on the list agrees.
    const threads1 = await request(aliceApp).get("/api/team-chat/threads");
    expect(threads1.body.threads[0].unreadCount).toBe(1);

    const read = await request(aliceApp).post(`/api/team-chat/threads/${threadId}/read`);
    expect(read.status).toBe(204);

    const unread2 = await request(aliceApp).get("/api/team-chat/unread-count");
    expect(unread2.body.total).toBe(0);
    const threads2 = await request(aliceApp).get("/api/team-chat/threads");
    expect(threads2.body.threads[0].unreadCount).toBe(0);
  });

  // ── file_share space gate ───────────────────────────────────────

  it("file_share is blocked when the sender lacks the file's department, allowed for a member", async () => {
    const owner = await mkUser("owner", "owner");
    const alice = await mkUser("alice", "family"); // member
    const bob = await mkUser("bob", "family"); // NOT a member

    const dept = await prisma.department.create({
      data: {
        name: `${PREFIX}finance`,
        slug: `${PREFIX}finance`,
        kind: "DEPARTMENT",
        state: "active",
        createdBy: owner.id,
      },
    });
    await prisma.departmentMembership.create({
      data: {
        departmentId: dept.id,
        userId: alice.id,
        right: "reader",
        syncState: "synced",
        grantedBy: owner.id,
      },
    });
    await prisma.file.create({
      data: {
        ncFileId: NC_FILE_DEPT,
        ownerUserId: alice.id,
        departmentId: dept.id,
        path: `/${PREFIX}finance/numbers.xlsx`,
      },
    });

    const threadId = await mkDirectThread(alice, bob);
    const forward = {
      kind: "file_share",
      ncFileId: NC_FILE_DEPT,
      fileName: "numbers.xlsx",
      filePath: `/${PREFIX}finance/numbers.xlsx`,
    };

    // Bob (not a member) cannot forward the department file...
    const blocked = await request(buildApp(asActor(bob)))
      .post(`/api/team-chat/threads/${threadId}/messages`)
      .send(forward);
    expect(blocked.status).toBe(403);
    const stored = await prisma.teamChatMessage.count({
      where: { threadId, kind: "file_share" },
    });
    expect(stored).toBe(0);

    // ...Alice (reader member) can, and name/path are cached on the row.
    const allowed = await request(buildApp(asActor(alice)))
      .post(`/api/team-chat/threads/${threadId}/messages`)
      .send({ ...forward, caption: "the numbers" });
    expect(allowed.status).toBe(201);
    expect(allowed.body.message.sharedNcFileId).toBe(NC_FILE_DEPT);
    expect(allowed.body.message.sharedFileName).toBe("numbers.xlsx");
  });

  // ── ai_chat_share ownership + snapshot immutability ─────────────

  it("ai_chat_share 404s on a foreign session; a stored snapshot survives session deletion", async () => {
    const alice = await mkUser("alice", "family");
    const bob = await mkUser("bob", "family");
    const threadId = await mkDirectThread(alice, bob);

    // Bob's session — alice must NOT be able to forward it (404, no leak).
    const bobsSession = await prisma.chatSession.create({
      data: { userId: bob.username, title: `${PREFIX}bobs-chat` },
    });
    const foreign = await request(buildApp(asActor(alice)))
      .post(`/api/team-chat/threads/${threadId}/messages`)
      .send({ kind: "ai_chat_share", chatSessionId: bobsSession.id });
    expect(foreign.status).toBe(404);

    // Alice's own session forwards fine; tool internals are skipped.
    const mine = await prisma.chatSession.create({
      data: { userId: alice.username, title: `${PREFIX}my-chat` },
    });
    await prisma.chatMessage.createMany({
      data: [
        { sessionId: mine.id, role: "user", content: "question" },
        { sessionId: mine.id, role: "tool", content: "{}", toolCallId: "c1" },
        { sessionId: mine.id, role: "assistant", content: "answer" },
      ],
    });
    const sent = await request(buildApp(asActor(alice)))
      .post(`/api/team-chat/threads/${threadId}/messages`)
      .send({ kind: "ai_chat_share", chatSessionId: mine.id });
    expect(sent.status).toBe(201);
    const messageId = sent.body.message.id as string;

    // Delete the source conversation — the FK SetNulls, the snapshot stays.
    await prisma.chatSession.delete({ where: { id: mine.id } });
    const row = await prisma.teamChatMessage.findUnique({ where: { id: messageId } });
    expect(row?.sharedChatSessionId).toBeNull();

    const transcript = await request(buildApp(asActor(bob))).get(
      `/api/team-chat/messages/${messageId}/transcript`,
    );
    expect(transcript.status).toBe(200);
    expect(transcript.body.title).toBe(`${PREFIX}my-chat`);
    expect(transcript.body.messages.map((m: { role: string }) => m.role)).toEqual([
      "user",
      "assistant",
    ]);
  });
});
