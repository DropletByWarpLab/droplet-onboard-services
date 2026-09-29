/**
 * WARP-3196 — the team-chat tools drop the sender from `recipients` by the
 * sender's User.id, which the roster route now names as `me`.
 *
 * `team_chat_send_message` and `team_chat_send_meeting_invite` take recipient
 * USERNAMES. They used to drop the sender with `r !== ctx.userId`, and
 * `ctx.userId` is `User.username` on stdio but `User.id` over HTTP
 * (`claims.sub`, services/mcp-server/src/context.ts), so over HTTP the sender
 * stayed in: "[bob, me]" became a two-person group that POST /team-chat/threads
 * refuses (400 group_requires_two_participants, it drops me.id), and "[me]"
 * skipped the "someone other than yourself" guard.
 *
 * The person `resolveCaller` resolves is the only party that knows the
 * sender's id on both transports, so GET /team-chat/contacts returns it as
 * `me: { id }` and the handlers drop that id. This file pins both halves:
 *
 *   - the route: `me` is the resolved person's User.id, never the header
 *     value, for a browser session and for `_service:mcp`;
 *   - the contract: the REAL tools-core handlers, loaded the way the
 *     mcp-server loads them, run against the REAL router, so the field the
 *     route writes is the field the handlers read.
 *
 * The tools-core handler lanes cover both namings of the sender (username and
 * User.id). Every User.id here differs from the username, as on a real box.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";
import { getTool, type ToolContext } from "@droplet/tools-core";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: true, agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));

import { createTeamChatRouter } from "../routes/team-chat.js";
import { MCP_PRINCIPAL_ID } from "../middleware/mcp-acting-user-gate.js";
import type { AuthUser } from "../middleware/auth.js";
import { userDirectory, type DirectoryUser } from "./helpers/user-directory.js";

type Person = DirectoryUser & { displayName: string };

const ALICE: Person = {
  id: "5b0d6c1e-0000-4000-8000-0000000000a1",
  username: "alice",
  nextcloudUsername: null,
  displayName: "Alice",
  role: "family",
};
const BOB: Person = {
  id: "5b0d6c1e-0000-4000-8000-0000000000b2",
  username: "bob",
  nextcloudUsername: "bob",
  displayName: "Bob",
  role: "family",
};
const CAROL: Person = {
  id: "5b0d6c1e-0000-4000-8000-0000000000c3",
  username: "carol",
  nextcloudUsername: null,
  displayName: "Carol",
  role: "guest",
};
const PEOPLE: Person[] = [ALICE, BOB, CAROL];

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
  const participants: Array<{ threadId: string; userId: string }> = [];
  const threads: Array<{ id: string; kind: string; participantIds: string[] }> = [];

  const teamChatThread = {
    findFirst: vi.fn(async () => null),
    create: vi.fn(
      async ({
        data,
      }: {
        data: { kind: string; title: string | null; createdById: string; participants: { create: Array<{ userId: string }> } };
      }) => {
        const id = `th-${threads.length + 1}`;
        const ids = data.participants.create.map((p) => p.userId);
        threads.push({ id, kind: data.kind, participantIds: ids });
        for (const userId of ids) participants.push({ threadId: id, userId });
        return {
          id,
          kind: data.kind,
          title: data.title,
          createdById: data.createdById,
          createdAt: now,
          updatedAt: now,
          lastMessageAt: now,
          participants: ids.map((userId) => ({ userId, lastReadAt: now, joinedAt: now })),
        };
      },
    ),
    update: vi.fn(async () => ({})),
  };
  const teamChatMessage = {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
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
    })),
  };
  let meeting: Record<string, unknown> = {};
  const teamChatMeeting = {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      meeting = {
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
      };
      return meeting;
    }),
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      meeting = { ...meeting, ...data };
      return meeting;
    }),
  };
  const $transaction = vi.fn(async (arg: unknown) =>
    typeof arg === "function"
      ? (arg as (tx: unknown) => unknown)({ teamChatMeeting, teamChatMessage, teamChatThread })
      : Promise.all(arg as unknown[]),
  );
  return {
    threads,
    user: {
      // resolveCaller's acting-user lookup, both shapes it has had: the
      // username `findFirst` and resolveAssertedUser's `findMany({ OR })`.
      findFirst: vi.fn(async ({ where, select }: { where: Where; select?: Record<string, unknown> }) => {
        const row = rows().find((r) => rowMatches(r, where));
        return row ? pick(row, select) : null;
      }),
      findMany: vi.fn(async (args: { where: Where & { OR?: unknown }; select?: Record<string, unknown> }) =>
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
        return participants.some((p) => p.threadId === threadId && p.userId === userId)
          ? { threadId, userId, lastReadAt: now }
          : null;
      }),
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
const asSession = (p: Person): AuthUser => ({
  id: p.id,
  username: p.username,
  displayName: p.displayName,
  role: p.role as AuthUser["role"],
});

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

/**
 * `ctx.http.orchestrator` as the mcp-server builds it: every call goes out as
 * `_service:mcp` with `X-Nextcloud-User: <acting user>` (withActingUser), and
 * the handler's own per-call headers (X-Droplet-User) win.
 */
function orchestratorClient(app: Express, actingUser: string): ToolContext["http"]["orchestrator"] {
  async function send(
    method: "get" | "post" | "patch" | "delete",
    path: string,
    body: unknown,
    opts?: { headers?: Record<string, string> },
  ): Promise<globalThis.Response> {
    let req = request(app)[method](path);
    for (const [k, v] of Object.entries({ "X-Nextcloud-User": actingUser, ...(opts?.headers ?? {}) })) req = req.set(k, v);
    const res = body === undefined ? await req : await req.send(body as object);
    return new globalThis.Response(JSON.stringify(res.body), {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  }
  return {
    get: (p, o) => send("get", p, undefined, o),
    post: (p, b, o) => send("post", p, b, o),
    patch: (p, b, o) => send("patch", p, b, o),
    delete: (p, o) => send("delete", p, undefined, o),
  };
}

/** A tool call on the stdio transport: ctx.userId is the sender's username. */
function toolCtx(prisma: PrismaDouble, sender: Person): ToolContext {
  return {
    prisma: {} as PrismaClient,
    http: { orchestrator: orchestratorClient(appAs(MCP, prisma), sender.username) } as unknown as ToolContext["http"],
    matter: {} as ToolContext["matter"],
    userId: sender.username,
    role: sender.role,
    signal: new AbortController().signal,
  } as ToolContext;
}

const sendMessage = getTool("team_chat_send_message")!;
const sendMeetingInvite = getTool("team_chat_send_meeting_invite")!;
const IN_AN_HOUR = () => new Date(Date.now() + 3_600_000).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /team-chat/contacts names the person asking as `me`, by User.id", () => {
  it("a browser session: `me` is the session's own User.id", async () => {
    const res = await request(appAs(asSession(ALICE), prismaDouble())).get("/api/team-chat/contacts");
    expect(res.status).toBe(200);
    expect(res.body.me).toEqual({ id: ALICE.id });
  });

  it("_service:mcp: `me` is the RESOLVED person's User.id, not the X-Droplet-User value", async () => {
    const res = await request(appAs(MCP, prismaDouble()))
      .get("/api/team-chat/contacts")
      .set("X-Nextcloud-User", ALICE.username)
      .set("X-Droplet-User", ALICE.username);
    expect(res.status).toBe(200);
    expect(res.body.me).toEqual({ id: ALICE.id });
  });

  it("the roster itself is unchanged: every ACTIVE human, the caller included", async () => {
    const res = await request(appAs(asSession(BOB), prismaDouble())).get("/api/team-chat/contacts");
    expect(res.body.contacts.map((c: { id: string }) => c.id).sort()).toEqual(
      [ALICE.id, BOB.id, CAROL.id].sort(),
    );
    expect(res.body.me).toEqual({ id: BOB.id });
  });
});

describe("the real team-chat tools against the real router drop the sender by id", () => {
  it("team_chat_send_message [bob, me] → a direct thread of Alice and Bob, sent by Alice", async () => {
    const prisma = prismaDouble();
    const r = await sendMessage.handler(
      { recipients: ["bob", "alice"], body: "Lunch?", confirmed: true },
      toolCtx(prisma, ALICE),
    );
    if (!r.ok) throw new Error(`expected a successful ToolResult, got ${JSON.stringify(r)}`);
    expect(prisma.threads).toEqual([{ id: "th-1", kind: "direct", participantIds: [ALICE.id, BOB.id] }]);
    expect(prisma.teamChatMessage.create).toHaveBeenCalledWith({
      data: { threadId: "th-1", senderId: ALICE.id, kind: "text", body: "Lunch?" },
    });
    expect(r.data).toMatchObject({ recipients: ["bob"] });
  });

  it("team_chat_send_message [bob, carol, me] → a group of the three", async () => {
    const prisma = prismaDouble();
    const r = await sendMessage.handler(
      { recipients: ["alice", "bob", "carol"], body: "Standup?", confirmed: true },
      toolCtx(prisma, ALICE),
    );
    expect(r.ok).toBe(true);
    expect(prisma.threads).toEqual([
      { id: "th-1", kind: "group", participantIds: [ALICE.id, BOB.id, CAROL.id] },
    ]);
  });

  it("team_chat_send_message [me] → refused, no thread, no message", async () => {
    const prisma = prismaDouble();
    const r = await sendMessage.handler(
      { recipients: ["alice"], body: "note to self", confirmed: true },
      toolCtx(prisma, ALICE),
    );
    if (r.ok) throw new Error(`expected a failed ToolResult, got ${JSON.stringify(r)}`);
    expect(r.error?.code).toBe("INVALID_ARGS");
    expect(prisma.teamChatThread.create).not.toHaveBeenCalled();
    expect(prisma.teamChatMessage.create).not.toHaveBeenCalled();
  });

  it("team_chat_send_meeting_invite [bob, me] → a direct thread, the meeting organized by Alice", async () => {
    const prisma = prismaDouble();
    const r = await sendMeetingInvite.handler(
      { recipients: ["bob", "alice"], title: "Standup", starts_at: IN_AN_HOUR(), confirmed: true },
      toolCtx(prisma, ALICE),
    );
    if (!r.ok) throw new Error(`expected a successful ToolResult, got ${JSON.stringify(r)}`);
    expect(prisma.threads).toEqual([{ id: "th-1", kind: "direct", participantIds: [ALICE.id, BOB.id] }]);
    expect(prisma.teamChatMeeting.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ threadId: "th-1", createdById: ALICE.id, title: "Standup" }),
    });
    expect(r.data).toMatchObject({ recipients: ["bob"] });
  });

  it("team_chat_send_meeting_invite [me] → refused, no thread, no meeting", async () => {
    const prisma = prismaDouble();
    const r = await sendMeetingInvite.handler(
      { recipients: ["alice"], title: "Focus time", starts_at: IN_AN_HOUR(), confirmed: true },
      toolCtx(prisma, ALICE),
    );
    if (r.ok) throw new Error(`expected a failed ToolResult, got ${JSON.stringify(r)}`);
    expect(r.error?.code).toBe("INVALID_ARGS");
    expect(prisma.teamChatThread.create).not.toHaveBeenCalled();
    expect(prisma.teamChatMeeting.create).not.toHaveBeenCalled();
  });
});
