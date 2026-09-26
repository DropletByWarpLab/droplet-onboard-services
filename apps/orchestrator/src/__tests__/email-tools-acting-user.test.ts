/**
 * WARP-3102 — the six email LLM tools act for the same person on BOTH
 * mcp-server transports.
 *
 * `ctx.userId` is `User.username` on the stdio transport (chat, routes/llm.ts
 * `_meta.userId`) and `User.id` on the HTTP one (services/mcp-server/src/
 * context.ts: `claims.sub`). Until WARP-3102:
 *
 *   - `search_contacts` read `EmailAccount` through `ctx.prisma` by
 *     `userId: ctx.userId`. That column holds a `User.id`
 *     (provision.service.ts `connectMailbox`, `actorId = req.user.id`), so in
 *     CHAT every person was told no mailbox is connected — and it had no
 *     owner/admin see-all rule either;
 *   - the five route-backed tools forward `X-Droplet-User: ctx.userId`, and
 *     routes/email.ts resolved it by `username` only, so every HTTP-transport
 *     call answered 404.
 *
 * This file runs the REAL handlers, loaded from `@droplet/tools-core` the way
 * the mcp-server loads them, against the REAL email router, over in-memory
 * tables that evaluate their where-clauses. `ctx.http.orchestrator` reaches the
 * router in-process as `_service:mcp`, carrying the `X-Nextcloud-User` header
 * `withActingUser` stamps; each handler's own per-call headers win.
 *
 * Fixture rows carry a `User.id` DISTINCT from the username, as production rows
 * do: a fake that agrees with a UUID key cannot catch the defect.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Request, type Response as ExpressResponse, type NextFunction } from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { getTool, type ToolContext } from "@droplet/tools-core";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: true, agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));

const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn(async (_row: unknown) => null),
}));
vi.mock("../services/activity.singleton.js", () => ({ recordActivity: recordActivityMock }));

import { createEmailRouter, wireEmailAnalysis, type EmailGate } from "../routes/email.js";
import type { AuthUser } from "../middleware/auth.js";
import { userDirectory, type DirectoryUser } from "./helpers/user-directory.js";

const MCP: AuthUser = { id: "_service:mcp", username: "_service:mcp", displayName: "MCP Server", role: "service" };

// An SSO row: `nextcloudUsername` NULL, as every SSO / SCIM row has it.
const ALICE: DirectoryUser = { id: "3f1e9c2a-7b6d-4e5f-9a8b-1c2d3e4f5a6b", username: "alice", nextcloudUsername: null, role: "owner" };
// The admin who connected the company mailbox.
const OPS: DirectoryUser = { id: "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a", username: "ops", nextcloudUsername: "ops", role: "admin" };
const KIM: DirectoryUser = { id: "8a7b6c5d-4e3f-4a1b-9c8d-7e6f5a4b3c2d", username: "kim", nextcloudUsername: "kim", role: "family" };
const GUS: DirectoryUser = { id: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e", username: "gus", nextcloudUsername: null, role: "guest" };

/** Fixture times derive from the clock, an hour back (never "the future"). */
const HOUR_AGO = Date.now() - 60 * 60_000;
const ago = (min: number) => new Date(HOUR_AGO - min * 60_000);

interface AccountRow { id: string; userId: string | null; displayName: string; address: string }
interface MessageRow { id: string; accountId: string; threadId: string; fromAddr: string; fromName: string | null; receivedAt: Date; subject: string; bodyText: string | null }

const ACCOUNTS: AccountRow[] = [
  { id: "acct-alice", userId: ALICE.id, displayName: "Alice", address: "alice@acme.test" },
  { id: "acct-company", userId: OPS.id, displayName: "Acme sales", address: "sales@acme.test" },
  { id: "acct-kim", userId: KIM.id, displayName: "Kim", address: "kim@acme.test" },
];

const MESSAGES: MessageRow[] = [
  { id: "m1", accountId: "acct-alice", threadId: "t-alice", fromAddr: "bob@example.com", fromName: "Bob Lee", receivedAt: ago(10), subject: "Lunch", bodyText: "Friday?" },
  { id: "m2", accountId: "acct-alice", threadId: "t-alice", fromAddr: "bob@example.com", fromName: "Bob Lee", receivedAt: ago(20), subject: "Lunch", bodyText: "Thursday?" },
  { id: "m3", accountId: "acct-company", threadId: "t-company", fromAddr: "BOB@example.com", fromName: null, receivedAt: ago(5), subject: "Order", bodyText: "Order #12" },
  { id: "m4", accountId: "acct-company", threadId: "t-company", fromAddr: "bobbi@vendor.test", fromName: "Bobbi Sales", receivedAt: ago(30), subject: "Quote", bodyText: "Quote" },
  { id: "m5", accountId: "acct-kim", threadId: "t-kim", fromAddr: "bobby@school.test", fromName: "Bobby Tables", receivedAt: ago(40), subject: "Homework", bodyText: "Due Monday" },
];

const THREADS = [
  { id: "t-alice", accountId: "acct-alice", subject: "Lunch" },
  { id: "t-company", accountId: "acct-company", subject: "Order" },
  { id: "t-kim", accountId: "acct-kim", subject: "Homework" },
].map((t) => ({
  ...t,
  threadKey: `k-${t.id}`,
  lastSender: null,
  snippet: null,
  messageCount: MESSAGES.filter((m) => m.threadId === t.id).length,
  triageStatus: "inbox",
  draftedByDroplet: false,
  lastMessageAt: ago(1),
}));

type StrFilter = string | { in?: string[]; contains?: string; mode?: "insensitive" };

function fieldMatches(value: unknown, filter: StrFilter | undefined): boolean {
  if (filter === undefined) return true;
  if (typeof filter === "string") return value === filter;
  if (filter.in) return filter.in.includes(value as string);
  if (filter.contains !== undefined) {
    if (typeof value !== "string") return false;
    return filter.mode === "insensitive"
      ? value.toLowerCase().includes(filter.contains.toLowerCase())
      : value.includes(filter.contains);
  }
  return false;
}

function pick<T extends object>(row: T, select?: Record<string, boolean>): Partial<T> {
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k as keyof T]])) as Partial<T>;
}

function fakePrisma(users: DirectoryUser[]) {
  const drafts = new Map<string, Record<string, unknown>>();
  drafts.set("d-alice", {
    id: "d-alice",
    accountId: "acct-alice",
    threadId: "t-alice",
    toAddrs: ["bob@example.com"],
    ccAddrs: null,
    bccAddrs: null,
    subject: "Re: Lunch",
    body: "Friday works",
    draftedByDroplet: true,
    status: "draft",
    sentAt: null,
    claimedAt: null,
    error: null,
    createdAt: ago(2),
    updatedAt: ago(2),
  });
  const prisma = {
    user: userDirectory(users),
    emailAccount: {
      findMany: vi.fn(async ({ where, select }: { where?: { userId?: string }; select?: Record<string, boolean> } = {}) =>
        ACCOUNTS.filter((a) => fieldMatches(a.userId, where?.userId)).map((a) => pick(a, select)),
      ),
      findUnique: vi.fn(async ({ where, select }: { where: { id: string }; select?: Record<string, boolean> }) => {
        const a = ACCOUNTS.find((x) => x.id === where.id);
        return a ? pick(a, select) : null;
      }),
    },
    emailMessage: {
      findMany: vi.fn(
        async ({
          where,
          select,
          orderBy,
          take,
        }: {
          where: { accountId?: StrFilter; OR?: Array<Record<string, StrFilter>> };
          select?: Record<string, boolean>;
          orderBy?: { receivedAt: "asc" | "desc" };
          take?: number;
        }) => {
          let rows = MESSAGES.filter(
            (m) =>
              fieldMatches(m.accountId, where.accountId) &&
              (!where.OR ||
                where.OR.some((arm) =>
                  Object.entries(arm).every(([k, f]) => fieldMatches(m[k as keyof MessageRow], f)),
                )),
          );
          if (orderBy) {
            const dir = orderBy.receivedAt === "desc" ? -1 : 1;
            rows = [...rows].sort((a, b) => dir * (a.receivedAt.getTime() - b.receivedAt.getTime()));
          }
          if (take !== undefined) rows = rows.slice(0, take);
          return rows.map((m) => pick(m, select));
        },
      ),
    },
    emailThread: {
      findMany: vi.fn(async ({ where }: { where: { accountId: string } }) =>
        THREADS.filter((t) => t.accountId === where.accountId),
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const t = THREADS.find((x) => x.id === where.id);
        return t ? { ...t, messages: MESSAGES.filter((m) => m.threadId === t.id) } : null;
      }),
    },
    emailDraft: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { ...data, id: "d-new", status: "draft", createdAt: ago(0), updatedAt: ago(0) };
        drafts.set("d-new", row);
        return row;
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => drafts.get(where.id) ?? null),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
        const d = drafts.get(where.id);
        if (!d) throw new Error("not found");
        return d;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { id: string; status: string }; data: Record<string, unknown> }) => {
        const d = drafts.get(where.id);
        if (!d || d.status !== where.status) return { count: 0 };
        drafts.set(where.id, { ...d, ...data });
        return { count: 1 };
      }),
    },
  };
  return prisma;
}

type FakePrisma = ReturnType<typeof fakePrisma>;

const ALLOW_GATE: EmailGate = { outboundEmailEnabled: async () => true };

function appAs(principal: AuthUser, prisma: FakePrisma): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: ExpressResponse, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = principal;
    next();
  });
  app.use("/api", createEmailRouter(prisma as unknown as PrismaClient, ALLOW_GATE));
  return app;
}

/**
 * `ctx.http.orchestrator` as the mcp-server builds it: every call goes out as
 * `_service:mcp` (the shim above) with `X-Nextcloud-User: <acting user>`, and a
 * per-call header still wins — exactly `withActingUser`'s merge.
 */
function orchestratorClient(app: express.Express, actingUser: string): ToolContext["http"]["orchestrator"] {
  async function send(
    method: "get" | "post" | "patch" | "delete",
    path: string,
    body: unknown,
    opts?: { headers?: Record<string, string> },
  ): Promise<Response> {
    let req = request(app)[method](path);
    for (const [k, v] of Object.entries({ "X-Nextcloud-User": actingUser, ...(opts?.headers ?? {}) })) req = req.set(k, v);
    const res = body === undefined ? await req : await req.send(body as object);
    return new Response(JSON.stringify(res.body), { status: res.status, headers: { "content-type": "application/json" } });
  }
  return {
    get: (p, o) => send("get", p, undefined, o),
    post: (p, b, o) => send("post", p, b, o),
    patch: (p, b, o) => send("patch", p, b, o),
    delete: (p, o) => send("delete", p, undefined, o),
  };
}

function toolCtx(
  routerPrisma: FakePrisma,
  actingUser: string,
  role: string,
  handlerPrisma: unknown = routerPrisma,
): ToolContext {
  return {
    prisma: handlerPrisma as PrismaClient,
    http: { orchestrator: orchestratorClient(appAs(MCP, routerPrisma), actingUser) } as unknown as ToolContext["http"],
    matter: {} as ToolContext["matter"],
    userId: actingUser,
    role,
    signal: new AbortController().signal,
  } as ToolContext;
}

type Contacts = { type: string; count: number; query: string; note?: string; contacts: Array<{ address: string; name: string | null; lastSeenAt: string; messageCount: number }> };

const searchContacts = getTool("search_contacts")!;
const addresses = (r: Awaited<ReturnType<typeof searchContacts.handler>>) =>
  (r as { data: Contacts }).data.contacts.map((c) => c.address);

const ANALYSIS = { summary: "s", callouts: [], suggestedActions: [], related: { files: [], threads: [], cameras: [], tools: [] } };

beforeEach(() => {
  vi.clearAllMocks();
  wireEmailAnalysis(async () => ANALYSIS);
});

afterEach(() => {
  wireEmailAnalysis(null);
});

describe("🔴 WARP-3102 search_contacts reads the mailboxes of the person it acts for, on both transports", () => {
  // A family member sees their own mailbox only: the route's rule for anyone
  // below owner/admin, the same one assertAccountAccessible applies.
  it.each([
    ["stdio (username)", KIM.username],
    ["HTTP (User.id)", KIM.id],
  ])("%s: a family member finds the senders of their own mailbox", async (_transport, asserted) => {
    const prisma = fakePrisma([ALICE, OPS, KIM]);
    const r = await searchContacts.handler({ query: "bob" }, toolCtx(prisma, asserted, "family"));

    expect(r.ok).toBe(true);
    expect(addresses(r)).toEqual(["bobby@school.test"]);
    expect((r as { data: Contacts }).data.contacts[0]).toEqual({
      address: "bobby@school.test",
      name: "Bobby Tables",
      lastSeenAt: ago(40).toISOString(),
      messageCount: 1,
    });
  });

  // Owner/admin read every mailbox through email_search / email_read and
  // GET /api/email/accounts; search_contacts derives from the same set.
  it.each([
    ["stdio (username)", ALICE.username],
    ["HTTP (User.id)", ALICE.id],
  ])("%s: an owner finds senders across every mailbox, folded by address and ranked", async (_transport, asserted) => {
    const prisma = fakePrisma([ALICE, OPS, KIM]);
    const r = await searchContacts.handler({ query: "bob" }, toolCtx(prisma, asserted, "owner"));

    expect(r.ok).toBe(true);
    const data = (r as { data: Contacts }).data;
    expect(data.contacts.map((c) => [c.address, c.messageCount])).toEqual([
      ["bob@example.com", 3], // two in Alice's mailbox, one in the company one
      ["bobbi@vendor.test", 1], // the company mailbox an admin connected
      ["bobby@school.test", 1],
    ]);
    // The newest sighting has no display name; the newest non-empty one wins.
    expect(data.contacts[0]).toMatchObject({ name: "Bob Lee", lastSeenAt: ago(5).toISOString() });
    expect(data.count).toBe(3);
    expect(data.query).toBe("bob");
  });

  it("`limit` bounds the list", async () => {
    const prisma = fakePrisma([ALICE, OPS, KIM]);
    const r = await searchContacts.handler({ query: "bob", limit: 1 }, toolCtx(prisma, ALICE.id, "owner"));
    expect(addresses(r)).toEqual(["bob@example.com"]);
  });

  it("the tool reads through the orchestrator, never EmailAccount or EmailMessage directly", async () => {
    const prisma = fakePrisma([ALICE, OPS, KIM]);
    const refuse = vi.fn(async () => {
      throw new Error("search_contacts read email tables through ctx.prisma");
    });
    const handlerPrisma = { emailAccount: { findMany: refuse }, emailMessage: { findMany: refuse } };

    const r = await searchContacts.handler({ query: "bob" }, toolCtx(prisma, KIM.id, "family", handlerPrisma));

    expect(refuse).not.toHaveBeenCalled();
    expect(addresses(r)).toEqual(["bobby@school.test"]);
  });

  it("a person with no mailbox gets an empty list and the note, not an error", async () => {
    const lee: DirectoryUser = { id: "4c5d6e7f-8a9b-4c0d-9e1f-2a3b4c5d6e7f", username: "lee", nextcloudUsername: null, role: "family" };
    const prisma = fakePrisma([ALICE, OPS, KIM, lee]);
    const r = await searchContacts.handler({ query: "bob" }, toolCtx(prisma, lee.id, "family"));

    expect(r.ok).toBe(true);
    const data = (r as { data: Contacts }).data;
    expect(data.contacts).toEqual([]);
    expect(data.note).toMatch(/No email accounts are connected/);
    expect(prisma.emailMessage.findMany).not.toHaveBeenCalled();
  });

  it.each([
    ["nobody by that name", [ALICE, OPS, KIM], "mallory"],
    ["a deactivated person", [ALICE, OPS, { ...KIM, directoryStatus: "DEACTIVATED" as const }], KIM.id],
    // One person's username is another's id: which of them is asking is unknowable.
    ["an ambiguous name", [ALICE, OPS, KIM, { id: "u-lookalike", username: KIM.id, nextcloudUsername: null, role: "owner" }], KIM.id],
    ["a guest", [ALICE, OPS, KIM, GUS], GUS.id],
  ] as const)("%s → a legible refusal, and no mail is read", async (_label, users, asserted) => {
    const prisma = fakePrisma([...users]);
    const r = await searchContacts.handler({ query: "bob" }, toolCtx(prisma, asserted, "owner"));

    expect(r).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(prisma.emailAccount.findMany).not.toHaveBeenCalled();
    expect(prisma.emailMessage.findMany).not.toHaveBeenCalled();
    // The refusal leaves a policy-violation row, as a registration-time guard would.
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        what: "Access denied",
        refs: expect.objectContaining({ reason: "email-contacts-acting-user-unresolved" }),
      }),
    );
  });
});

describe("🔴 WARP-3102 the five route-backed email tools resolve the acting user on the HTTP transport too", () => {
  const TRANSPORTS = [
    ["stdio (username)", (u: DirectoryUser) => u.username],
    ["HTTP (User.id)", (u: DirectoryUser) => u.id],
  ] as const;

  it.each(TRANSPORTS)("%s: email_search lists the threads of the person's own mailbox", async (_t, as) => {
    const prisma = fakePrisma([ALICE, OPS, KIM]);
    const r = await getTool("email_search")!.handler({ accountId: "acct-kim" }, toolCtx(prisma, as(KIM), "family"));

    expect(r.ok).toBe(true);
    expect((r as { data: { threads: Array<{ id: string }> } }).data.threads.map((t) => t.id)).toEqual(["t-kim"]);
  });

  it.each(TRANSPORTS)("%s: email_read opens the thread", async (_t, as) => {
    const prisma = fakePrisma([ALICE, OPS, KIM]);
    const r = await getTool("email_read")!.handler(
      { accountId: "acct-kim", threadId: "t-kim" },
      toolCtx(prisma, as(KIM), "family"),
    );

    expect(r.ok).toBe(true);
    expect((r as { data: { id: string; messages: unknown[] } }).data).toMatchObject({ id: "t-kim" });
  });

  it.each(TRANSPORTS)("%s: email_summarize_thread reaches the analysis", async (_t, as) => {
    const prisma = fakePrisma([ALICE, OPS, KIM]);
    const r = await getTool("email_summarize_thread")!.handler(
      { accountId: "acct-kim", threadId: "t-kim" },
      toolCtx(prisma, as(KIM), "family"),
    );

    expect(r.ok).toBe(true);
    expect((r as { data: { summary: string } }).data.summary).toBe("s");
  });

  it.each(TRANSPORTS)("%s: email_draft_reply saves the draft", async (_t, as) => {
    const prisma = fakePrisma([ALICE, OPS, KIM]);
    const r = await getTool("email_draft_reply")!.handler(
      { accountId: "acct-kim", toAddrs: ["bobby@school.test"], subject: "Re: Homework", body: "Done" },
      toolCtx(prisma, as(KIM), "family"),
    );

    expect(r.ok).toBe(true);
    expect(prisma.emailDraft.create).toHaveBeenCalledTimes(1);
  });

  it.each(TRANSPORTS)("%s: email_send queues the draft and audits the person by username", async (_t, as) => {
    const prisma = fakePrisma([ALICE, OPS, KIM]);
    const r = await getTool("email_send")!.handler({ draftId: "d-alice" }, toolCtx(prisma, as(ALICE), "owner"));

    expect(r.ok).toBe(true);
    const enqueue = recordActivityMock.mock.calls.find(
      ([row]) => (row as { what?: string }).what === "Email draft queued for send",
    );
    // The username on both transports — never the raw header, never the id.
    expect((enqueue?.[0] as { refs: { actor: string } }).refs.actor).toBe("alice");
  });

  it("ownership still holds after resolution: a family member cannot read another person's mailbox by id", async () => {
    const prisma = fakePrisma([ALICE, OPS, KIM]);
    const r = await getTool("email_search")!.handler({ accountId: "acct-alice" }, toolCtx(prisma, KIM.id, "family"));

    expect(r.ok).toBe(false);
    expect(prisma.emailThread.findMany).not.toHaveBeenCalled();
  });

  it("an owner reads a mailbox an admin connected, by id", async () => {
    const prisma = fakePrisma([ALICE, OPS, KIM]);
    const r = await getTool("email_search")!.handler({ accountId: "acct-company" }, toolCtx(prisma, ALICE.id, "owner"));

    expect(r.ok).toBe(true);
    expect((r as { data: { threads: Array<{ id: string }> } }).data.threads.map((t) => t.id)).toEqual(["t-company"]);
  });

  it("a forwarded family member still cannot send, named by id (the owner/admin mirror holds)", async () => {
    const prisma = fakePrisma([ALICE, OPS, KIM]);
    // The handler gates on ctx.role first; the route must refuse on its own.
    const r = await getTool("email_send")!.handler({ draftId: "d-alice" }, toolCtx(prisma, KIM.id, "owner"));

    expect(r.ok).toBe(false);
    expect(prisma.emailDraft.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ["a deactivated person", [ALICE, OPS, { ...KIM, directoryStatus: "DEACTIVATED" as const }]],
    ["an ambiguous name", [ALICE, OPS, KIM, { id: "u-lookalike", username: KIM.id, nextcloudUsername: null, role: "owner" }]],
  ] as const)("%s named by id reads nothing", async (_label, users) => {
    const prisma = fakePrisma([...users]);
    const r = await getTool("email_search")!.handler({ accountId: "acct-kim" }, toolCtx(prisma, KIM.id, "family"));

    expect(r.ok).toBe(false);
    expect(prisma.emailThread.findMany).not.toHaveBeenCalled();
  });
});

describe("GET /api/email/contacts (WARP-3102)", () => {
  const contacts = (app: express.Express, query: Record<string, string>, droplet?: string) => {
    const req = request(app).get("/api/email/contacts").query(query);
    return droplet ? req.set("X-Droplet-User", droplet) : req;
  };
  const human = (u: DirectoryUser): AuthUser => ({ id: u.id, username: u.username, displayName: u.username, role: u.role as AuthUser["role"] });

  it("as the MCP principal: the same answer by User.id and by username", async () => {
    const prisma = fakePrisma([ALICE, OPS, KIM]);
    const app = appAs(MCP, prisma);
    for (const asserted of [KIM.id, KIM.username]) {
      const res = await contacts(app, { query: "bob" }, asserted);
      expect(res.status, asserted).toBe(200);
      expect(res.body.accountCount, asserted).toBe(1);
      expect(res.body.contacts.map((c: { address: string }) => c.address), asserted).toEqual(["bobby@school.test"]);
    }
  });

  it("as the MCP principal without X-Droplet-User → 401, nothing read", async () => {
    const prisma = fakePrisma([ALICE, OPS, KIM]);
    const res = await contacts(appAs(MCP, prisma), { query: "bob" });

    expect(res.status).toBe(401);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(prisma.emailAccount.findMany).not.toHaveBeenCalled();
  });

  it("a person in the browser reads their own mailboxes, and the header means nothing from them", async () => {
    const prisma = fakePrisma([ALICE, OPS, KIM]);
    const res = await contacts(appAs(human(KIM), prisma), { query: "bob" }, ALICE.username);

    expect(res.status).toBe(200);
    expect(res.body.contacts.map((c: { address: string }) => c.address)).toEqual(["bobby@school.test"]);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it("an owner in the browser reads every mailbox", async () => {
    const prisma = fakePrisma([ALICE, OPS, KIM]);
    const res = await contacts(appAs(human(ALICE), prisma), { query: "bob" });

    expect(res.status).toBe(200);
    expect(res.body.accountCount).toBe(3);
  });

  it("a guest in the browser → 403 (human role set)", async () => {
    const prisma = fakePrisma([ALICE, OPS, KIM, GUS]);
    const res = await contacts(appAs(human(GUS), prisma), { query: "bob" });

    expect(res.status).toBe(403);
    expect(prisma.emailAccount.findMany).not.toHaveBeenCalled();
  });

  it.each([
    [{}],
    [{ query: "" }],
    [{ query: "x".repeat(121) }],
    [{ query: "bob", limit: "0" }],
    [{ query: "bob", limit: "26" }],
    [{ query: "bob", limit: "1.5" }],
  ])("an invalid query %j → 400, nothing read", async (query) => {
    const prisma = fakePrisma([ALICE, OPS, KIM]);
    const res = await contacts(appAs(MCP, prisma), query as Record<string, string>, KIM.id);

    expect(res.status).toBe(400);
    expect(prisma.emailAccount.findMany).not.toHaveBeenCalled();
  });
});
