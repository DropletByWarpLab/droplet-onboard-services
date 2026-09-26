/**
 * WARP-3145 — the email tool routes ask the ADR-032 §3 tool-scope question of
 * the person the assistant acts for, whichever MCP transport carried the call.
 *
 * The five email tools reach routes/email.ts as `_service:mcp`. Chat, the
 * agent-run worker and the ToolSpec runner check the acting person's tool
 * scope before they dispatch. The mcp-server HTTP transport does not
 * (WARP-2989): it runs only the write-tier RBAC. routes/email.ts mirrors the
 * human role set and mailbox ownership, and nothing else. So an admin whose
 * custom role leaves `email` out could read, draft and send household mail
 * through that transport — as soon as WARP-3102 made its `User.id` resolve.
 *
 * The composition is app.ts's own: `mountMcpActingUserGates` (registry-driven,
 * WARP-2988), then `createEmailRouter`. The acting-user resolver is the real one
 * (`actingUserAccessResolver` → `resolveAttributedToolAccess`) over an
 * in-memory User table. Only `resolveEffectiveAccess`, a bound singleton, is
 * stubbed with the tool domains each person's role resolves to.
 *
 * Every tool call carries the acting person twice, exactly as the mcp-server
 * sends it: `X-Nextcloud-User` (stamped on every orchestrator call by
 * services/mcp-server/src/context.ts `withActingUser`) and `X-Droplet-User`
 * (set by each tools-core email handler; the header routes/email.ts acts on).
 * Both carry `ctx.userId`: `User.username` on stdio, `User.id` over HTTP.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import request from "supertest";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: true, agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));

const { recordActivityMock, effectiveAccessMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
  effectiveAccessMock: vi.fn(),
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));
vi.mock("../services/effective-access.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/effective-access.service.js")>()),
  resolveEffectiveAccess: effectiveAccessMock,
}));

import { createEmailRouter, wireEmailAnalysis, type EmailGate } from "../routes/email.js";
import { mountMcpActingUserGates } from "../modules/module-mounts.js";
import { actingUserAccessResolver, MCP_PRINCIPAL_ID } from "../middleware/mcp-acting-user-gate.js";
import type { AuthUser } from "../middleware/auth.js";
import { userDirectory, type DirectoryUser } from "./helpers/user-directory.js";

type Person = DirectoryUser & {
  accessRoleId: string | null;
  accessRole: { toolGrants: Array<{ domain: string; level: "view" | "use" }> } | null;
};

// `User.id` is a UUID distinct from the username, as on a real box: the HTTP
// transport names the person by the first, stdio by the second.
const OWEN: Person = {
  id: "0a8e5f4c-0000-4000-8000-0000000000a1",
  username: "owen",
  nextcloudUsername: "owen",
  role: "owner",
  accessRoleId: null,
  accessRole: null,
};
/** An admin whose custom role grants Files and nothing else. */
const FRAN: Person = {
  id: "0a8e5f4c-0000-4000-8000-0000000000f2",
  username: "fran",
  nextcloudUsername: null,
  role: "admin",
  accessRoleId: "role-files-only",
  accessRole: { toolGrants: [{ domain: "files", level: "use" }] },
};
/** An admin whose custom role grants Email with `use`. */
const ERIN: Person = {
  id: "0a8e5f4c-0000-4000-8000-0000000000e3",
  username: "erin",
  nextcloudUsername: null,
  role: "admin",
  accessRoleId: "role-email",
  accessRole: { toolGrants: [{ domain: "email", level: "use" }] },
};
/** An admin whose custom role grants Email with `view` only. */
const VERA: Person = {
  id: "0a8e5f4c-0000-4000-8000-0000000000b4",
  username: "vera",
  nextcloudUsername: null,
  role: "admin",
  accessRoleId: "role-email-view",
  accessRole: { toolGrants: [{ domain: "email", level: "view" }] },
};
const PEOPLE: Person[] = [OWEN, FRAN, ERIN, VERA];

/** What `resolveEffectiveAccess` derives from each custom role (the owner never asks). */
const TOOL_DOMAINS: Record<string, string[]> = {
  [FRAN.id]: ["files"],
  [ERIN.id]: ["email"],
  [VERA.id]: ["email"],
};

// The household's mailbox belongs to the owner. Admins see every account on the
// browser path, so this is the mailbox a narrowed admin's tool call would open.
const ACCOUNT = { id: "a1", userId: OWEN.id };
const THREAD = {
  id: "t1",
  accountId: "a1",
  threadKey: "k1",
  subject: "Quarterly numbers",
  lastSender: "cfo@example.com",
  snippet: "attached",
  messageCount: 1,
  triageStatus: "inbox",
  draftedByDroplet: false,
  lastMessageAt: new Date("2026-09-20T10:00:00.000Z"),
  messages: [
    {
      id: "m1",
      threadId: "t1",
      messageId: "<m1@x>",
      fromAddr: "cfo@example.com",
      fromName: null,
      toAddrs: ["owen@example.com"],
      ccAddrs: null,
      subject: "Quarterly numbers",
      bodyText: "attached",
      bodyHtml: null,
      receivedAt: new Date("2026-09-20T10:00:00.000Z"),
    },
  ],
};

function mkDraft(overrides: Record<string, unknown> = {}) {
  return {
    id: "d1",
    accountId: "a1",
    threadId: null,
    toAddrs: ["c@d.com"],
    ccAddrs: null,
    bccAddrs: null,
    subject: "Re: Quarterly numbers",
    body: "ok",
    draftedByDroplet: true,
    status: "draft",
    sentAt: null,
    claimedAt: null,
    error: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function prismaDouble() {
  const draft = mkDraft();
  return {
    user: userDirectory(PEOPLE),
    emailAccount: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === ACCOUNT.id ? { ...ACCOUNT } : null,
      ),
      findMany: vi.fn(async () => [ACCOUNT]),
    },
    emailThread: {
      findMany: vi.fn(async () => [THREAD]),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === THREAD.id ? THREAD : null,
      ),
    },
    emailDraft: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) =>
        mkDraft({ ...data, id: "d-new" }),
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === draft.id ? draft : null,
      ),
      findUniqueOrThrow: vi.fn(async () => ({ ...draft, status: "queued" })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  };
}
type PrismaDouble = ReturnType<typeof prismaDouble>;

const ALLOW_OUTBOUND: EmailGate = { outboundEmailEnabled: vi.fn().mockResolvedValue(true) };
const ANALYSIS = {
  summary: "s",
  callouts: [],
  suggestedActions: [],
  related: { files: [], threads: [], cameras: [], tools: [] },
};
const DRAFT_BODY = { toAddrs: ["c@d.com"], subject: "Re: Quarterly numbers", body: "ok" };

const MCP: AuthUser = { id: MCP_PRINCIPAL_ID, username: MCP_PRINCIPAL_ID, displayName: "MCP Server", role: "service" };

/** app.ts's order: the acting-user gates, then the email router. */
function appAs(user: AuthUser, prisma: PrismaDouble): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = user;
    next();
  });
  mountMcpActingUserGates(app, actingUserAccessResolver(prisma as unknown as PrismaClient));
  app.use("/api", createEmailRouter(prisma as unknown as PrismaClient, ALLOW_OUTBOUND));
  return app;
}

type Method = "get" | "post";
/** Every route an email tool dispatches to (tools-core TOOL_ROUTES), and its success status. */
const TOOL_CALLS: ReadonlyArray<readonly [tool: string, method: Method, path: string, ok: number]> = [
  ["email_search", "get", "/api/email/a1/threads?filter=inbox", 200],
  ["email_read", "get", "/api/email/a1/threads/t1", 200],
  ["email_summarize_thread", "get", "/api/email/a1/threads/t1/analysis", 200],
  ["email_draft_reply", "post", "/api/email/a1/drafts", 201],
  ["email_send", "post", "/api/email/drafts/d1/send", 202],
];
const READS = TOOL_CALLS.filter(([, method]) => method === "get");
const WRITES = TOOL_CALLS.filter(([, method]) => method === "post");

function call(app: Express, method: Method, path: string, headers: Record<string, string>) {
  let req = method === "get" ? request(app).get(path) : request(app).post(path).send(DRAFT_BODY);
  for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
  return req;
}

/** The headers the mcp-server sends for a tool call acting for `name`. */
const actingFor = (name: string) => ({ "X-Nextcloud-User": name, "X-Droplet-User": name });

const NAMINGS = [
  ["stdio (User.username)", (p: Person) => p.username],
  ["HTTP (User.id)", (p: Person) => p.id],
] as const;

const DISABLED = { error: "module_disabled", module: "email" };

/** No mailbox row was read and no draft was written or queued. */
function expectNoMailTouched(prisma: PrismaDouble): void {
  expect(prisma.emailAccount.findUnique).not.toHaveBeenCalled();
  expect(prisma.emailThread.findMany).not.toHaveBeenCalled();
  expect(prisma.emailThread.findUnique).not.toHaveBeenCalled();
  expect(prisma.emailDraft.create).not.toHaveBeenCalled();
  expect(prisma.emailDraft.updateMany).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  recordActivityMock.mockResolvedValue(null);
  effectiveAccessMock.mockImplementation(async (userId: string) =>
    TOOL_DOMAINS[userId]
      ? { tier: "admin", features: [], toolDomains: TOOL_DOMAINS[userId], locks: false, cloud: false, connectors: {} }
      : null,
  );
  wireEmailAnalysis(async () => ANALYSIS);
});

afterEach(() => {
  wireEmailAnalysis(null);
});

describe("email tools: a person whose role leaves `email` out is refused on both transports", () => {
  for (const [transport, nameOf] of NAMINGS) {
    it.each(TOOL_CALLS)(`%s (%s %s) — named over ${transport} → 404 module_disabled`, async (_tool, method, path) => {
      const prisma = prismaDouble();
      const res = await call(appAs(MCP, prisma), method, path, actingFor(nameOf(FRAN)));
      expect(res.status).toBe(404);
      expect(res.body).toEqual(DISABLED);
      expectNoMailTouched(prisma);
    });
  }

  it("an unknown acting person is refused before the route reads anything", async () => {
    const prisma = prismaDouble();
    const res = await call(appAs(MCP, prisma), "get", "/api/email/a1/threads/t1", actingFor("ghost"));
    expect(res.status).toBe(404);
    expect(res.body).toEqual(DISABLED);
    expectNoMailTouched(prisma);
  });
});

describe("email tools: `email` in reach — the gate lets the route decide", () => {
  it.each(TOOL_CALLS)("%s (%s %s) — an admin granted Email `use` gets the route's answer", async (_tool, method, path, ok) => {
    const res = await call(appAs(MCP, prismaDouble()), method, path, actingFor(ERIN.username));
    expect(res.status).toBe(ok);
  });

  it.each(TOOL_CALLS)("%s (%s %s) — the owner (no custom role) gets the route's answer", async (_tool, method, path, ok) => {
    const res = await call(appAs(MCP, prismaDouble()), method, path, actingFor(OWEN.username));
    expect(res.status).toBe(ok);
  });

  it.each(READS)("%s (%s %s) — Email `view` reads", async (_tool, method, path, ok) => {
    const res = await call(appAs(MCP, prismaDouble()), method, path, actingFor(VERA.username));
    expect(res.status).toBe(ok);
  });

  // email_draft_reply and email_send are write-tier tools (tools-core
  // `requiresWrite`), so chat withholds them from a `view` grant; so does this.
  it.each(WRITES)("%s (%s %s) — Email `view` cannot write → 404 module_disabled", async (_tool, method, path) => {
    const prisma = prismaDouble();
    const res = await call(appAs(MCP, prisma), method, path, actingFor(VERA.username));
    expect(res.status).toBe(404);
    expect(res.body).toEqual(DISABLED);
    expectNoMailTouched(prisma);
  });
});

// routes/email.ts acts on X-Droplet-User; the gate asks about X-Nextcloud-User.
// The mcp-server sets both from ctx.userId, so on a real call they agree. When
// they do not, the gate cannot know it cleared the person the route will act
// for, so it refuses.
describe("email tools: the gate clears the same person the route acts for", () => {
  it("X-Droplet-User naming a narrowed person behind an Email-scoped X-Nextcloud-User → refused", async () => {
    const prisma = prismaDouble();
    const res = await call(appAs(MCP, prisma), "get", "/api/email/a1/threads/t1", {
      "X-Nextcloud-User": ERIN.username,
      "X-Droplet-User": FRAN.username,
    });
    expect(res.status).toBe(404);
    expect(res.body).toEqual(DISABLED);
    expectNoMailTouched(prisma);
  });

  it("X-Droplet-User with no X-Nextcloud-User → refused (the gate would otherwise ask about nobody)", async () => {
    const prisma = prismaDouble();
    const res = await call(appAs(MCP, prisma), "post", "/api/email/drafts/d1/send", {
      "X-Droplet-User": FRAN.username,
    });
    expect(res.status).toBe(404);
    expect(res.body).toEqual(DISABLED);
    expectNoMailTouched(prisma);
  });

  it("the same person named by username on one header and User.id on the other is still refused", async () => {
    // Both transports name ONE way per call; a mix is not something the
    // mcp-server sends, and comparing resolved rows would widen the gate for
    // no caller that exists.
    const res = await call(appAs(MCP, prismaDouble()), "get", "/api/email/a1/threads/t1", {
      "X-Nextcloud-User": ERIN.id,
      "X-Droplet-User": ERIN.username,
    });
    expect(res.status).toBe(404);
    expect(res.body).toEqual(DISABLED);
  });
});

describe("email routes: browser sessions are untouched", () => {
  it.each(TOOL_CALLS)("%s (%s %s) — Fran in her own session gets the route's answer", async (_tool, method, path, ok) => {
    const fran: AuthUser = { id: FRAN.id, username: FRAN.username, displayName: "Fran", role: "admin" };
    // Whatever tool headers a browser request carries, the gate is not asked.
    const res = await call(appAs(fran, prismaDouble()), method, path, actingFor(FRAN.username));
    expect(res.status).toBe(ok);
    expect(effectiveAccessMock).not.toHaveBeenCalled();
  });
});

describe("email routes: app.ts wiring", () => {
  it("mounts the acting-user gates after the module gates and before the email router", () => {
    const src = readFileSync(join(__dirname, "..", "app.ts"), "utf8");
    const moduleGates = src.indexOf("mountModuleGates(app, moduleGate)");
    const acting = src.indexOf("mountMcpActingUserGates(app, actingUserAccessResolver(prisma))");
    const router = src.indexOf("createEmailRouter(prisma, {");
    expect(moduleGates).toBeGreaterThan(-1);
    expect(acting).toBeGreaterThan(moduleGates);
    expect(router).toBeGreaterThan(acting);
  });
});
