/**
 * WARP-3187 — the team-chat tool routes act for the same person on both MCP
 * transports.
 *
 * `team_chat_send_message` and `team_chat_send_meeting_invite` reach
 * routes/team-chat.ts as `_service:mcp`, acting as the person their handlers
 * name in `X-Droplet-User` (tools-core handlers/team-chat/_roster.ts
 * `actingHeaders`). The value is `ctx.userId`, which is `User.username` on
 * stdio (chat, the agent-run worker, the ToolSpec runner) and `User.id` over
 * HTTP (`claims.sub`, services/mcp-server/src/context.ts). `resolveCaller`
 * looked it up by username only, so every HTTP-transport call answered 401 on
 * all four routes and both tools were dead there.
 *
 * Every person here has a `User.id` distinct from their username, as on a
 * real box, and every tool call carries both headers exactly as the mcp-server
 * sends them: `X-Nextcloud-User` (stamped by `withActingUser`) and
 * `X-Droplet-User` (set by `actingHeaders`), each holding the same
 * `ctx.userId`. The User table is the shared in-memory directory, so the
 * resolver's `findMany({ OR })` runs with Prisma's semantics.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: true, agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));

import { createTeamChatRouter } from "../routes/team-chat.js";
import { MCP_PRINCIPAL_ID } from "../middleware/mcp-acting-user-gate.js";
import type { AuthUser } from "../middleware/auth.js";
import { userDirectory, type DirectoryUser } from "./helpers/user-directory.js";

type Person = DirectoryUser & { displayName: string };

/** The acting person: an SSO row (no Nextcloud login), so only username and id name her. */
const ALICE: Person = {
  id: "7c1e2d3f-0000-4000-8000-0000000000a1",
  username: "alice",
  nextcloudUsername: null,
  displayName: "Alice",
  role: "family",
};
/** The member the tools message. */
const BOB: Person = {
  id: "7c1e2d3f-0000-4000-8000-0000000000b2",
  username: "bob",
  nextcloudUsername: "bob",
  displayName: "Bob",
  role: "family",
};
/** Deactivated by the directory; nothing may act as him. */
const DAVE: Person = {
  id: "7c1e2d3f-0000-4000-8000-0000000000d4",
  username: "dave",
  nextcloudUsername: "dave",
  displayName: "Dave",
  role: "family",
  directoryStatus: "DEACTIVATED",
};
/** An ACTIVE directory row outside the four human tiers; service rows never message. */
const ROBO: Person = {
  id: "7c1e2d3f-0000-4000-8000-0000000000e5",
  username: "robo",
  nextcloudUsername: null,
  displayName: "Robo",
  role: "service",
};
/**
 * `nina` is Nina's username AND Pete's (stale) Nextcloud login: the value names
 * two people, and nothing says which one is asking.
 */
const NINA: Person = {
  id: "7c1e2d3f-0000-4000-8000-0000000000f6",
  username: "nina",
  nextcloudUsername: null,
  displayName: "Nina",
  role: "admin",
};
const PETE: Person = {
  id: "7c1e2d3f-0000-4000-8000-000000000107",
  username: "pete",
  nextcloudUsername: "nina",
  displayName: "Pete",
  role: "family",
};
const PEOPLE: Person[] = [ALICE, BOB, DAVE, ROBO, NINA, PETE];

// One thread everybody belongs to, so a refusal below is the acting-user
// lookup's and never the route's own membership 404.
const THREAD_ID = "th1";
const MEMBERS = new Set(PEOPLE.map((p) => p.id));

/** ChatSession.userId holds the owner's USERNAME (routes/llm.ts, WARP-304). */
const ALICE_SESSION = "3f0c9a2e-0000-4000-8000-00000000c001";
const BOB_SESSION = "3f0c9a2e-0000-4000-8000-00000000c002";
const CHAT_SESSIONS = [
  { id: ALICE_SESSION, userId: ALICE.username, title: "Trip plan" },
  { id: BOB_SESSION, userId: BOB.username, title: "Bob's notes" },
];

type Where = Record<string, unknown>;

/** Prisma's `where` for the shapes routes/team-chat.ts sends: equality and `{ in: [...] }`. */
function rowMatches(row: Record<string, unknown>, where: Where): boolean {
  return Object.entries(where).every(([k, cond]) =>
    cond !== null && typeof cond === "object" && "in" in cond
      ? (cond as { in: unknown[] }).in.includes(row[k])
      : row[k] === cond,
  );
}

function prismaDouble() {
  const directory = userDirectory(PEOPLE);
  const rows = () => PEOPLE.map((p) => ({ directoryStatus: "ACTIVE", ...p }) as Record<string, unknown>);
  const pick = (row: Record<string, unknown>, select?: Record<string, unknown>) =>
    select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : row;
  const now = new Date("2026-09-26T12:00:00.000Z");
  const message = (data: Record<string, unknown>) => ({
    id: "msg-new",
    body: null,
    sharedNcFileId: null,
    sharedFileName: null,
    sharedFilePath: null,
    sharedFileSpace: null,
    sharedChatSessionId: null,
    meetingId: null,
    createdAt: now,
    ...data,
  });
  const meeting = (data: Record<string, unknown>) => ({
    id: "mtg-new",
    inviteMessageId: null,
    calendarEventId: null,
    durationMinutes: null,
    location: null,
    meetingUrl: null,
    note: null,
    status: "scheduled",
    reminderMinutesBefore: 15,
    reminderStatus: "pending",
    createdAt: now,
    ...data,
  });
  const created: { meeting: Record<string, unknown> | null } = { meeting: null };
  const teamChatMeeting = {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      created.meeting = meeting(data);
      return created.meeting;
    }),
    update: vi.fn(async ({ data }: { where: { id: string }; data: Record<string, unknown> }) => {
      created.meeting = { ...created.meeting, ...data };
      return created.meeting;
    }),
  };
  const teamChatMessage = {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => message(data)),
  };
  const teamChatThread = {
    findFirst: vi.fn(async () => null),
    create: vi.fn(
      async ({
        data,
      }: {
        data: { kind: string; title: string | null; createdById: string; participants: { create: Array<{ userId: string }> } };
      }) => ({
        id: "th-new",
        kind: data.kind,
        title: data.title,
        createdById: data.createdById,
        createdAt: now,
        updatedAt: now,
        lastMessageAt: now,
        participants: data.participants.create.map((p) => ({ userId: p.userId, lastReadAt: now, joinedAt: now })),
      }),
    ),
    update: vi.fn(async () => ({})),
  };
  const $transaction = vi.fn(async (arg: unknown) =>
    typeof arg === "function"
      ? (arg as (tx: unknown) => unknown)({ teamChatMeeting, teamChatMessage, teamChatThread })
      : Promise.all(arg as unknown[]),
  );
  return {
    user: {
      // The acting-user lookup: `findMany({ OR })` (resolveAssertedUser) goes
      // to the shared directory helper; the username-only `findFirst` it
      // replaces is modelled too, so this file runs red on the old code.
      findFirst: vi.fn(async ({ where, select }: { where: Where; select?: Record<string, unknown> }) => {
        const row = rows().find((r) => rowMatches(r, where));
        return row ? pick(row, select) : null;
      }),
      findMany: vi.fn(async (args: { where: Where & { OR?: unknown }; select?: Record<string, unknown>; take?: number }) =>
        args.where.OR
          ? directory.findMany(args as never)
          : rows()
              .filter((r) => rowMatches(r, args.where))
              .map((r) => pick(r, args.select)),
      ),
    },
    teamChatParticipant: {
      findUnique: vi.fn(async ({ where }: { where: { threadId_userId: { threadId: string; userId: string } } }) => {
        const { threadId, userId } = where.threadId_userId;
        return threadId === THREAD_ID && MEMBERS.has(userId) ? { threadId, userId, lastReadAt: now } : null;
      }),
    },
    chatSession: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => CHAT_SESSIONS.find((s) => s.id === where.id) ?? null),
    },
    chatMessage: {
      findMany: vi.fn(async () => [
        { role: "user", content: "Where should we go?", toolCallId: null, createdAt: now },
        { role: "assistant", content: "Lisbon.", toolCallId: null, createdAt: now },
      ]),
    },
    teamChatThread,
    teamChatMessage,
    teamChatMeeting,
    calendarEvent: { create: vi.fn(async () => ({ id: "cal-new" })) },
    $transaction,
  };
}
type PrismaDouble = ReturnType<typeof prismaDouble>;

const MCP: AuthUser = { id: MCP_PRINCIPAL_ID, username: MCP_PRINCIPAL_ID, displayName: "MCP Server", role: "service" };

function appAs(user: AuthUser, prisma: PrismaDouble): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = user;
    next();
  });
  app.use("/api", createTeamChatRouter(prisma as unknown as PrismaClient));
  return app;
}

type Method = "get" | "post";
const IN_AN_HOUR = new Date(Date.now() + 3_600_000).toISOString();

type Hop = readonly [hop: string, method: Method, path: string, body: object | null, ok: number];
/**
 * Every route a team-chat tool dispatches to (tools-core TOOL_ROUTES), the
 * body the handler sends, and the route's success status. Both tools read the
 * roster and open the thread; then one posts a message, the other a meeting.
 */
const TOOL_CALLS: ReadonlyArray<Hop> = [
  ["both tools: the roster", "get", "/api/team-chat/contacts", null, 200],
  ["both tools: open the thread", "post", "/api/team-chat/threads", { kind: "direct", participantIds: [BOB.id] }, 201],
  ["team_chat_send_message", "post", `/api/team-chat/threads/${THREAD_ID}/messages`, { kind: "text", body: "Lunch?" }, 201],
  [
    "team_chat_send_meeting_invite",
    "post",
    `/api/team-chat/threads/${THREAD_ID}/meetings`,
    { title: "Standup", startsAt: IN_AN_HOUR },
    201,
  ],
];

function call(app: Express, method: Method, path: string, body: object | null, headers: Record<string, string>) {
  let req = method === "get" ? request(app).get(path) : request(app).post(path).send(body ?? {});
  for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
  return req;
}

/** The headers the mcp-server sends for a tool call acting for `name`. */
const actingFor = (name: string) => ({ "X-Nextcloud-User": name, "X-Droplet-User": name });

const NAMINGS = [
  ["stdio (User.username)", (p: Person) => p.username],
  ["HTTP (User.id)", (p: Person) => p.id],
] as const;

/** The route refused before it read or wrote anything past the acting-user lookup. */
function expectNothingTouched(prisma: PrismaDouble): void {
  const rosterReads = prisma.user.findMany.mock.calls.filter(([args]) => !args.where.OR);
  expect(rosterReads).toEqual([]);
  expect(prisma.teamChatParticipant.findUnique).not.toHaveBeenCalled();
  expect(prisma.teamChatThread.findFirst).not.toHaveBeenCalled();
  expect(prisma.teamChatThread.create).not.toHaveBeenCalled();
  expect(prisma.teamChatMessage.create).not.toHaveBeenCalled();
  expect(prisma.teamChatMeeting.create).not.toHaveBeenCalled();
  expect(prisma.calendarEvent.create).not.toHaveBeenCalled();
  expect(prisma.$transaction).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("team-chat tools act for the person each transport names", () => {
  for (const [transport, nameOf] of NAMINGS) {
    it(`the roster — named over ${transport} → 200 with the ACTIVE humans`, async () => {
      const res = await call(appAs(MCP, prismaDouble()), "get", "/api/team-chat/contacts", null, actingFor(nameOf(ALICE)));
      expect(res.status).toBe(200);
      expect(res.body.contacts.map((c: { id: string }) => c.id).sort()).toEqual([ALICE.id, BOB.id, NINA.id, PETE.id].sort());
    });

    it(`open the thread — named over ${transport} → 201, created by and including the person`, async () => {
      const prisma = prismaDouble();
      const res = await call(appAs(MCP, prisma), "post", "/api/team-chat/threads", { kind: "direct", participantIds: [BOB.id] }, actingFor(nameOf(ALICE)));
      expect(res.status).toBe(201);
      expect(res.body.thread.createdById).toBe(ALICE.id);
      expect(res.body.thread.participants).toEqual([{ userId: ALICE.id }, { userId: BOB.id }]);
    });

    it(`team_chat_send_message — named over ${transport} → 201, sent by the person`, async () => {
      const prisma = prismaDouble();
      const res = await call(
        appAs(MCP, prisma),
        "post",
        `/api/team-chat/threads/${THREAD_ID}/messages`,
        { kind: "text", body: "Lunch?" },
        actingFor(nameOf(ALICE)),
      );
      expect(res.status).toBe(201);
      expect(res.body.message.senderId).toBe(ALICE.id);
      expect(prisma.teamChatParticipant.findUnique).toHaveBeenCalledWith({
        where: { threadId_userId: { threadId: THREAD_ID, userId: ALICE.id } },
      });
    });

    it(`team_chat_send_meeting_invite — named over ${transport} → 201, organized and invited by the person`, async () => {
      const prisma = prismaDouble();
      const res = await call(
        appAs(MCP, prisma),
        "post",
        `/api/team-chat/threads/${THREAD_ID}/meetings`,
        { title: "Standup", startsAt: IN_AN_HOUR },
        actingFor(nameOf(ALICE)),
      );
      expect(res.status).toBe(201);
      expect(res.body.meeting.createdById).toBe(ALICE.id);
      expect(res.body.message.senderId).toBe(ALICE.id);
    });
  }
});

// Two columns team-chat touches hold a USERNAME: CalendarEvent.userId (the
// meeting's calendar mirror; the create_event tool's semantics) and
// ChatSession.userId (the ai_chat_share ownership check). Over HTTP the header
// is a UUID, so the route must use the resolved person's username there.
describe("the username-keyed columns get the RESOLVED username, never the header value", () => {
  for (const [transport, nameOf] of NAMINGS) {
    it(`the meeting's calendar mirror is on the person's calendar — named over ${transport}`, async () => {
      const prisma = prismaDouble();
      const res = await call(
        appAs(MCP, prisma),
        "post",
        `/api/team-chat/threads/${THREAD_ID}/meetings`,
        { title: "Standup", startsAt: IN_AN_HOUR },
        actingFor(nameOf(ALICE)),
      );
      expect(res.status).toBe(201);
      expect(prisma.calendarEvent.create).toHaveBeenCalledTimes(1);
      const [{ data }] = prisma.calendarEvent.create.mock.calls[0] as unknown as [{ data: { userId: string } }];
      expect(data.userId).toBe(ALICE.username);
      expect(res.body.meeting.calendarEventId).toBe("cal-new");
    });

    it(`ai_chat_share of the person's own conversation → 201 — named over ${transport}`, async () => {
      const res = await call(
        appAs(MCP, prismaDouble()),
        "post",
        `/api/team-chat/threads/${THREAD_ID}/messages`,
        { kind: "ai_chat_share", chatSessionId: ALICE_SESSION },
        actingFor(nameOf(ALICE)),
      );
      expect(res.status).toBe(201);
      expect(res.body.message.senderId).toBe(ALICE.id);
    });

    it(`ai_chat_share of someone else's conversation → 404 — named over ${transport}`, async () => {
      const prisma = prismaDouble();
      const res = await call(
        appAs(MCP, prisma),
        "post",
        `/api/team-chat/threads/${THREAD_ID}/messages`,
        { kind: "ai_chat_share", chatSessionId: BOB_SESSION },
        actingFor(nameOf(ALICE)),
      );
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "chat_session_not_found" });
      expect(prisma.teamChatMessage.create).not.toHaveBeenCalled();
    });
  }
});

describe("fail closed: nobody, a deactivated person, a non-human row or an ambiguous name → 401", () => {
  for (const [transport, nameOf] of NAMINGS) {
    it.each(TOOL_CALLS)(`%s (%s %s) — a DEACTIVATED person named over ${transport} → 401`, async (_hop, method, path, body) => {
      const prisma = prismaDouble();
      const res = await call(appAs(MCP, prisma), method, path, body, actingFor(nameOf(DAVE)));
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "auth_required" });
      expectNothingTouched(prisma);
    });

    it.each(TOOL_CALLS)(`%s (%s %s) — an ACTIVE service-role row named over ${transport} → 401`, async (_hop, method, path, body) => {
      const prisma = prismaDouble();
      const res = await call(appAs(MCP, prisma), method, path, body, actingFor(nameOf(ROBO)));
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "auth_required" });
      expectNothingTouched(prisma);
    });
  }

  it.each(TOOL_CALLS)("%s (%s %s) — a User.id nobody has → 401", async (_hop, method, path, body) => {
    const prisma = prismaDouble();
    const res = await call(appAs(MCP, prisma), method, path, body, actingFor("7c1e2d3f-0000-4000-8000-00000000dead"));
    expect(res.status).toBe(401);
    expectNothingTouched(prisma);
  });

  it.each(TOOL_CALLS)("%s (%s %s) — no X-Droplet-User (X-Nextcloud-User alone is not read) → 401", async (_hop, method, path, body) => {
    const prisma = prismaDouble();
    const res = await call(appAs(MCP, prisma), method, path, body, { "X-Nextcloud-User": ALICE.id });
    expect(res.status).toBe(401);
    expectNothingTouched(prisma);
  });

  it.each(TOOL_CALLS)("%s (%s %s) — a name that is one person's username and another's Nextcloud login → 401", async (_hop, method, path, body) => {
    const prisma = prismaDouble();
    const res = await call(appAs(MCP, prisma), method, path, body, actingFor(NINA.username));
    expect(res.status).toBe(401);
    expectNothingTouched(prisma);
  });
});

describe("a browser session acts for itself whatever the header says", () => {
  it("Alice's own session naming Bob's User.id in X-Droplet-User still sends as Alice, with no directory lookup", async () => {
    const prisma = prismaDouble();
    const alice: AuthUser = { id: ALICE.id, username: ALICE.username, displayName: ALICE.displayName, role: "family" };
    const res = await call(
      appAs(alice, prisma),
      "post",
      `/api/team-chat/threads/${THREAD_ID}/messages`,
      { kind: "text", body: "hi" },
      actingFor(BOB.id),
    );
    expect(res.status).toBe(201);
    expect(res.body.message.senderId).toBe(ALICE.id);
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });
});
