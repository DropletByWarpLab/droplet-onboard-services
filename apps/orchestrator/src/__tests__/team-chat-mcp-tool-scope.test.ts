/**
 * WARP-3162 — the team-chat tool routes ask the ADR-032 §3 tool-scope question
 * of the person the assistant acts for, whichever MCP transport carried the
 * call.
 *
 * `team_chat_send_message` and `team_chat_send_meeting_invite` reach
 * routes/team-chat.ts as `_service:mcp`. Chat, the agent-run worker and the
 * ToolSpec runner check the acting person's tool scope before they dispatch.
 * The mcp-server HTTP transport does not (WARP-2989): it runs only the
 * write-tier RBAC. routes/team-chat.ts resolves the acting person and applies
 * the thread-membership checks a browser call gets, and nothing else. So a
 * person whose custom role leaves `team_chat` out could message and invite
 * members in their own name through that transport — as soon as the route
 * resolves a `User.id`, which today it does not (`resolveCaller` looks the
 * header up by username only, so an HTTP call answers 401 before any of this
 * matters).
 *
 * The composition is app.ts's own: `mountMcpActingUserGates` (registry-driven,
 * WARP-2988), then `createTeamChatRouter`. The acting-user resolver is the real
 * one (`actingUserAccessResolver` → `resolveAttributedToolAccess`) over an
 * in-memory User table. Only `resolveEffectiveAccess`, a bound singleton, is
 * stubbed with the tool domains each person's role resolves to.
 *
 * Every tool call carries the acting person twice, exactly as the mcp-server
 * sends it: `X-Nextcloud-User` (stamped on every orchestrator call by
 * services/mcp-server/src/context.ts `withActingUser`) and `X-Droplet-User`
 * (set by the team-chat handlers' `actingHeaders`; the header
 * routes/team-chat.ts acts on). Both carry `ctx.userId`: `User.username` on
 * stdio, `User.id` over HTTP.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import request from "supertest";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: true, agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));

const { effectiveAccessMock } = vi.hoisted(() => ({ effectiveAccessMock: vi.fn() }));
vi.mock("../services/effective-access.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/effective-access.service.js")>()),
  resolveEffectiveAccess: effectiveAccessMock,
}));

import { createTeamChatRouter } from "../routes/team-chat.js";
import { mountMcpActingUserGates } from "../modules/module-mounts.js";
import { actingUserAccessResolver, MCP_PRINCIPAL_ID } from "../middleware/mcp-acting-user-gate.js";
import type { AuthUser } from "../middleware/auth.js";
import { userDirectory, type DirectoryUser } from "./helpers/user-directory.js";

type Person = DirectoryUser & {
  displayName: string;
  accessRoleId: string | null;
  accessRole: { toolGrants: Array<{ domain: string; level: "view" | "use" }> } | null;
};

// `User.id` is a UUID distinct from the username, as on a real box: the HTTP
// transport names the person by the first, stdio by the second.
const OWEN: Person = {
  id: "0a8e5f4c-0000-4000-8000-0000000000a1",
  username: "owen",
  nextcloudUsername: "owen",
  displayName: "Owen",
  role: "owner",
  accessRoleId: null,
  accessRole: null,
};
/** An admin whose custom role grants Files and nothing else. */
const FRAN: Person = {
  id: "0a8e5f4c-0000-4000-8000-0000000000f2",
  username: "fran",
  nextcloudUsername: null,
  displayName: "Fran",
  role: "admin",
  accessRoleId: "role-files-only",
  accessRole: { toolGrants: [{ domain: "files", level: "use" }] },
};
/** An admin whose custom role grants the Messages tools with `use`. */
const TESS: Person = {
  id: "0a8e5f4c-0000-4000-8000-0000000000c3",
  username: "tess",
  nextcloudUsername: null,
  displayName: "Tess",
  role: "admin",
  accessRoleId: "role-team-chat",
  accessRole: { toolGrants: [{ domain: "team_chat", level: "use" }] },
};
/** An admin whose custom role grants the Messages tools with `view` only. */
const VERA: Person = {
  id: "0a8e5f4c-0000-4000-8000-0000000000b4",
  username: "vera",
  nextcloudUsername: null,
  displayName: "Vera",
  role: "admin",
  accessRoleId: "role-team-chat-view",
  accessRole: { toolGrants: [{ domain: "team_chat", level: "view" }] },
};
/** The member the tools message. No custom role; never the acting person here. */
const BOB: Person = {
  id: "0a8e5f4c-0000-4000-8000-0000000000d5",
  username: "bob",
  nextcloudUsername: "bob",
  displayName: "Bob",
  role: "family",
  accessRoleId: null,
  accessRole: null,
};
const PEOPLE: Person[] = [OWEN, FRAN, TESS, VERA, BOB];

/** What `resolveEffectiveAccess` derives from each custom role (the owner never asks). */
const TOOL_DOMAINS: Record<string, string[]> = {
  [FRAN.id]: ["files"],
  [TESS.id]: ["team_chat"],
  [VERA.id]: ["team_chat"],
};

// One thread every acting person belongs to, so a refusal below is the gate's
// and never the route's own membership 404.
const THREAD_ID = "th1";
const MEMBERS = new Set([OWEN.id, FRAN.id, TESS.id, VERA.id, BOB.id]);

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
  const now = new Date("2026-09-25T12:00:00.000Z");
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
  const teamChatMeeting = {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => meeting(data)),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
      meeting({ id: where.id, threadId: THREAD_ID, title: "Standup", startsAt: now, createdById: OWEN.id, ...data }),
    ),
  };
  const teamChatMessage = {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => message(data)),
  };
  const teamChatThread = {
    findFirst: vi.fn(async () => null),
    create: vi.fn(async ({ data }: { data: { kind: string; title: string | null; createdById: string; participants: { create: Array<{ userId: string }> } } }) => ({
      id: "th-new",
      kind: data.kind,
      title: data.title,
      createdById: data.createdById,
      createdAt: now,
      updatedAt: now,
      lastMessageAt: now,
      participants: data.participants.create.map((p) => ({ userId: p.userId, lastReadAt: now, joinedAt: now })),
    })),
    update: vi.fn(async () => ({})),
  };
  const $transaction = vi.fn(async (arg: unknown) =>
    typeof arg === "function"
      ? (arg as (tx: unknown) => unknown)({ teamChatMeeting, teamChatMessage, teamChatThread })
      : Promise.all(arg as unknown[]),
  );
  return {
    user: {
      // The acting-user resolver's lookups (by username, then id; or the
      // WARP-3061 `findMany({ OR })`) run against the shared directory helper.
      findUnique: directory.findUnique,
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
    teamChatThread,
    teamChatMessage,
    teamChatMeeting,
    calendarEvent: { create: vi.fn(async () => ({ id: "cal-new" })) },
    $transaction,
  };
}
type PrismaDouble = ReturnType<typeof prismaDouble>;

const MCP: AuthUser = { id: MCP_PRINCIPAL_ID, username: MCP_PRINCIPAL_ID, displayName: "MCP Server", role: "service" };

/** app.ts's order: the acting-user gates, then the team-chat router. */
function appAs(user: AuthUser, prisma: PrismaDouble): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = user;
    next();
  });
  mountMcpActingUserGates(app, actingUserAccessResolver(prisma as unknown as PrismaClient));
  app.use("/api", createTeamChatRouter(prisma as unknown as PrismaClient));
  return app;
}

type Method = "get" | "post";
const IN_AN_HOUR = new Date(Date.now() + 3_600_000).toISOString();
/**
 * Every route a team-chat tool dispatches to (tools-core TOOL_ROUTES), the
 * body the handler sends, and the route's success status. Both tools read the
 * roster and open the thread; then one posts a message, the other a meeting.
 */
const TOOL_CALLS: ReadonlyArray<readonly [hop: string, method: Method, path: string, body: object | null, ok: number]> = [
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

const DISABLED = { error: "module_disabled", module: "team_chat" };

/** The route never ran: no roster read, no membership probe, nothing written. */
function expectNothingTouched(prisma: PrismaDouble): void {
  expect(prisma.user.findFirst).not.toHaveBeenCalled();
  const rosterReads = prisma.user.findMany.mock.calls.filter(([args]) => !args.where.OR);
  expect(rosterReads).toEqual([]);
  expect(prisma.teamChatParticipant.findUnique).not.toHaveBeenCalled();
  expect(prisma.teamChatThread.findFirst).not.toHaveBeenCalled();
  expect(prisma.teamChatThread.create).not.toHaveBeenCalled();
  expect(prisma.teamChatMessage.create).not.toHaveBeenCalled();
  expect(prisma.teamChatMeeting.create).not.toHaveBeenCalled();
  expect(prisma.$transaction).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  effectiveAccessMock.mockImplementation(async (userId: string) =>
    TOOL_DOMAINS[userId]
      ? { tier: "admin", features: [], toolDomains: TOOL_DOMAINS[userId], locks: false, cloud: false, connectors: {} }
      : null,
  );
});

describe("team-chat tools: a person whose role leaves `team_chat` out is refused on both transports", () => {
  for (const [transport, nameOf] of NAMINGS) {
    it.each(TOOL_CALLS)(`%s (%s %s) — named over ${transport} → 404 module_disabled`, async (_hop, method, path, body) => {
      const prisma = prismaDouble();
      const res = await call(appAs(MCP, prisma), method, path, body, actingFor(nameOf(FRAN)));
      expect(res.status).toBe(404);
      expect(res.body).toEqual(DISABLED);
      expectNothingTouched(prisma);
    });
  }

  it("an unknown acting person is refused before the route reads anything", async () => {
    const prisma = prismaDouble();
    const res = await call(appAs(MCP, prisma), "get", "/api/team-chat/contacts", null, actingFor("ghost"));
    expect(res.status).toBe(404);
    expect(res.body).toEqual(DISABLED);
    expectNothingTouched(prisma);
  });
});

// Both team-chat tools send (tools-core `requiresWrite`), so a `view` grant
// reaches neither of them: chat withholds both, and access-catalog.ts
// `tierReachableDomains` drops the domain for family and guest for the same
// reason. Every hop here is one of those two tools', the roster GET included,
// so the gate asks for `use` on every method in this domain.
describe("team-chat tools: a `view` grant reaches no team-chat tool", () => {
  for (const [transport, nameOf] of NAMINGS) {
    it.each(TOOL_CALLS)(`%s (%s %s) — Messages \`view\`, named over ${transport} → 404 module_disabled`, async (_hop, method, path, body) => {
      const prisma = prismaDouble();
      const res = await call(appAs(MCP, prisma), method, path, body, actingFor(nameOf(VERA)));
      expect(res.status).toBe(404);
      expect(res.body).toEqual(DISABLED);
      expectNothingTouched(prisma);
    });
  }
});

// Named by username: routes/team-chat.ts `resolveCaller` still looks the
// header up by username only, so a `User.id` answers 401 there whatever the
// gate decides. That is the route's own HTTP-transport bug, not this one.
describe("team-chat tools: `team_chat` in reach — the gate lets the route decide", () => {
  it.each(TOOL_CALLS)("%s (%s %s) — an admin granted Messages `use` gets the route's answer", async (_hop, method, path, body, ok) => {
    const res = await call(appAs(MCP, prismaDouble()), method, path, body, actingFor(TESS.username));
    expect(res.status).toBe(ok);
  });

  it.each(TOOL_CALLS)("%s (%s %s) — the owner (no custom role) gets the route's answer", async (_hop, method, path, body, ok) => {
    const res = await call(appAs(MCP, prismaDouble()), method, path, body, actingFor(OWEN.username));
    expect(res.status).toBe(ok);
  });
});

// routes/team-chat.ts acts on X-Droplet-User; the gate asks about
// X-Nextcloud-User. The mcp-server sets both from ctx.userId, so on a real call
// they agree. When they do not, the gate cannot know it cleared the person the
// route will act for, so it refuses.
describe("team-chat tools: the gate clears the same person the route acts for", () => {
  it("X-Droplet-User naming a narrowed person behind a Messages-scoped X-Nextcloud-User → refused", async () => {
    const prisma = prismaDouble();
    const res = await call(appAs(MCP, prisma), "post", `/api/team-chat/threads/${THREAD_ID}/messages`, { kind: "text", body: "hi" }, {
      "X-Nextcloud-User": TESS.username,
      "X-Droplet-User": FRAN.username,
    });
    expect(res.status).toBe(404);
    expect(res.body).toEqual(DISABLED);
    expectNothingTouched(prisma);
  });

  it("X-Droplet-User with no X-Nextcloud-User → refused (the gate would otherwise ask about nobody)", async () => {
    const prisma = prismaDouble();
    const res = await call(appAs(MCP, prisma), "post", `/api/team-chat/threads/${THREAD_ID}/meetings`, { title: "Standup", startsAt: IN_AN_HOUR }, {
      "X-Droplet-User": FRAN.username,
    });
    expect(res.status).toBe(404);
    expect(res.body).toEqual(DISABLED);
    expectNothingTouched(prisma);
  });

  it("the same person named by username on one header and User.id on the other is still refused", async () => {
    // Both transports name ONE way per call; a mix is not something the
    // mcp-server sends, and comparing resolved rows would widen the gate for
    // no caller that exists.
    const res = await call(appAs(MCP, prismaDouble()), "get", "/api/team-chat/contacts", null, {
      "X-Nextcloud-User": TESS.id,
      "X-Droplet-User": TESS.username,
    });
    expect(res.status).toBe(404);
    expect(res.body).toEqual(DISABLED);
  });
});

describe("team-chat routes: browser sessions are untouched", () => {
  it.each(TOOL_CALLS)("%s (%s %s) — Fran in her own session gets the route's answer", async (_hop, method, path, body, ok) => {
    const fran: AuthUser = { id: FRAN.id, username: FRAN.username, displayName: "Fran", role: "admin" };
    // Whatever tool headers a browser request carries, the gate is not asked.
    const res = await call(appAs(fran, prismaDouble()), method, path, body, actingFor(FRAN.username));
    expect(res.status).toBe(ok);
    expect(effectiveAccessMock).not.toHaveBeenCalled();
  });
});

describe("team-chat routes: app.ts wiring", () => {
  it("mounts the acting-user gates after the module gates and before the team-chat router", () => {
    const src = readFileSync(join(__dirname, "..", "app.ts"), "utf8");
    const moduleGates = src.indexOf("mountModuleGates(app, moduleGate)");
    const acting = src.indexOf("mountMcpActingUserGates(app, actingUserAccessResolver(prisma))");
    const router = src.indexOf('app.use("/api", createTeamChatRouter(prisma))');
    expect(moduleGates).toBeGreaterThan(-1);
    expect(acting).toBeGreaterThan(moduleGates);
    expect(router).toBeGreaterThan(acting);
  });
});
