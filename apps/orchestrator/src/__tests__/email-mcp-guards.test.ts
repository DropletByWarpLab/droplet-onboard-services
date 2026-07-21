/**
 * WARP-1453 — MCP-principal admission + identity forwarding on the five
 * /api/email routes the email LLM tools dispatch through.
 *
 * The five email tools (email_search / email_read / email_summarize_thread /
 * email_draft_reply / email_send) present the `_service:mcp` principal
 * (role "service"), which plain requireRole 403s — the dead-tool class
 * WARP-1439/1450 fixed for cameras/updates. And even past admission, the
 * routes scoped accounts by the principal itself ("_service:mcp"), so
 * every lookup missed. These tests pin:
 *
 *   • mcp + X-Droplet-User reaches each of the five tool routes, and the
 *     account scoping runs AS the forwarded username (resolved via the
 *     User directory), never as "_service:mcp";
 *   • mcp WITHOUT the header → 401 (fail closed, no fallback identity);
 *   • an unknown forwarded username → 404 (fail closed);
 *   • a human session with a spoofed X-Droplet-User header still scopes
 *     to its OWN session identity — the header is ignored;
 *   • human RBAC is byte-identical (family 403 on send, guest 403 on
 *     threads) and the non-tool surface (accounts list, draft patch)
 *     stays closed to the mcp principal.
 *
 * Scaffolding per updates-mcp-guards.test.ts: real auth guards, a
 * req.user shim, injected prisma/gate/analysis fakes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: true },
}));

const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));

import {
  createEmailRouter,
  wireEmailAnalysis,
  type EmailGate,
} from "../routes/email.js";
import type { AuthUser } from "../middleware/auth.js";

const mcpPrincipal: AuthUser = {
  id: "_service:mcp", username: "_service:mcp", displayName: "MCP Server", role: "service",
};
const familyUser: AuthUser = {
  id: "u-family", username: "fam", displayName: "fam", role: "family",
};
const guestUser: AuthUser = {
  id: "u-guest", username: "guest", displayName: "guest", role: "guest",
};

/** Directory rows the mcp path resolves X-Droplet-User against. */
const DIRECTORY: Record<string, { id: string; role: string }> = {
  romain: { id: "u-romain", role: "family" },
  boss: { id: "u-boss", role: "owner" },
  fam: { id: "u-family", role: "family" },
};

const ACCOUNT = {
  id: "a1",
  // Owned by romain (family tier) — the mcp-forwarded scoping must match
  // romain's directory id, and a family-tier human's own session id.
  userId: "u-romain",
  displayName: "Personal",
  address: "romain@example.com",
  imapStatus: "idle",
  lastIdleAt: null,
  lastErrorAt: null,
  lastError: null,
};

const THREAD = {
  id: "t1",
  accountId: "a1",
  threadKey: "k1",
  subject: "Hello",
  lastSender: "x@y.com",
  snippet: "hi",
  messageCount: 1,
  triageStatus: "inbox",
  draftedByDroplet: false,
  lastMessageAt: new Date("2026-07-20T10:00:00.000Z"),
  messages: [
    {
      id: "m1",
      threadId: "t1",
      messageId: "<m1@x>",
      fromAddr: "x@y.com",
      fromName: null,
      toAddrs: ["romain@example.com"],
      ccAddrs: null,
      subject: "Hello",
      bodyText: "hi",
      bodyHtml: null,
      receivedAt: new Date("2026-07-20T10:00:00.000Z"),
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
    subject: "Re: Hello",
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

function createPrismaShim(opts: { draftStatus?: string } = {}) {
  const draft = mkDraft(
    opts.draftStatus !== undefined ? { status: opts.draftStatus } : {},
  );
  return {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { username: string } }) =>
        DIRECTORY[where.username] ?? null,
      ),
    },
    emailAccount: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === ACCOUNT.id ? { id: ACCOUNT.id, userId: ACCOUNT.userId } : null,
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

const ALLOW_GATE: EmailGate = {
  outboundEmailEnabled: vi.fn().mockResolvedValue(true),
};

const ANALYSIS = {
  summary: "s",
  callouts: [],
  suggestedActions: [],
  related: { files: [], threads: [], cameras: [], tools: [] },
};

function buildApp(
  user: AuthUser,
  prisma: ReturnType<typeof createPrismaShim> = createPrismaShim(),
): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = user;
    next();
  });
  app.use("/api", createEmailRouter(prisma as unknown as PrismaClient, ALLOW_GATE));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  recordActivityMock.mockResolvedValue(null);
  wireEmailAnalysis(async () => ANALYSIS);
});

afterEach(() => {
  wireEmailAnalysis(null);
});

/** The five tool routes: [method, path, expected status for an admitted call]. */
const TOOL_ROUTES = [
  ["get", "/api/email/a1/threads?filter=inbox", 200],
  ["get", "/api/email/a1/threads/t1", 200],
  ["get", "/api/email/a1/threads/t1/analysis", 200],
  ["post", "/api/email/a1/drafts", 201],
  ["post", "/api/email/drafts/d1/send", 202],
] as const;

const DRAFT_BODY = { toAddrs: ["c@d.com"], subject: "Re: Hello", body: "ok" };

describe("email guards admit the MCP principal on the five tool routes (WARP-1453)", () => {
  it("GET threads — mcp + X-Droplet-User: romain lists threads, scoped as romain", async () => {
    const prisma = createPrismaShim();
    const res = await request(buildApp(mcpPrincipal, prisma))
      .get("/api/email/a1/threads?filter=inbox")
      .set("X-Droplet-User", "romain");

    expect(res.status).toBe(200);
    expect(res.body.threads).toHaveLength(1);
    // Scoping ran AS the forwarded human: the directory was resolved for
    // "romain" — never for the service principal id.
    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { username: "romain" } }),
    );
    expect(prisma.user.findUnique).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { username: "_service:mcp" } }),
    );
  });

  it("GET thread detail — mcp + X-Droplet-User: romain gets the full thread", async () => {
    const res = await request(buildApp(mcpPrincipal))
      .get("/api/email/a1/threads/t1")
      .set("X-Droplet-User", "romain");

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("t1");
    expect(res.body.messages).toHaveLength(1);
  });

  it("GET analysis — mcp + X-Droplet-User: romain gets the analysis card", async () => {
    const res = await request(buildApp(mcpPrincipal))
      .get("/api/email/a1/threads/t1/analysis")
      .set("X-Droplet-User", "romain");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(ANALYSIS);
  });

  it("POST drafts — mcp + X-Droplet-User: romain creates the draft", async () => {
    const prisma = createPrismaShim();
    const res = await request(buildApp(mcpPrincipal, prisma))
      .post("/api/email/a1/drafts")
      .set("X-Droplet-User", "romain")
      .send(DRAFT_BODY);

    expect(res.status).toBe(201);
    expect(prisma.emailDraft.create).toHaveBeenCalledTimes(1);
  });

  it("POST send — mcp + X-Droplet-User: boss (owner) queues the draft and audits the human actor", async () => {
    const prisma = createPrismaShim();
    const res = await request(buildApp(mcpPrincipal, prisma))
      .post("/api/email/drafts/d1/send")
      .set("X-Droplet-User", "boss");

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("queued");
    // The enqueue audit row attributes the EFFECTIVE human, not the
    // service principal.
    const enqueue = recordActivityMock.mock.calls.find(
      ([row]) => row?.what === "Email draft queued for send",
    );
    expect(enqueue?.[0]?.refs?.actor).toBe("boss");
  });

  it("POST send — a forwarded FAMILY identity cannot send (route human set mirrored)", async () => {
    // romain is family tier and owns a1 — ownership alone must NOT be
    // enough on the owner/admin-only send route.
    const prisma = createPrismaShim();
    const res = await request(buildApp(mcpPrincipal, prisma))
      .post("/api/email/drafts/d1/send")
      .set("X-Droplet-User", "romain");

    expect(res.status).toBe(404);
    expect(prisma.emailDraft.updateMany).not.toHaveBeenCalled();
  });

  it.each(TOOL_ROUTES)(
    "%s %s — mcp WITHOUT X-Droplet-User → 401 (fail closed, no fallback)",
    async (method, path) => {
      const prisma = createPrismaShim();
      const res = await (request(buildApp(mcpPrincipal, prisma)) as any)
        [method](path)
        .send(method === "post" ? DRAFT_BODY : undefined);

      expect(res.status).toBe(401);
      // No identity → no directory resolution, no draft mutation.
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(prisma.emailDraft.create).not.toHaveBeenCalled();
      expect(prisma.emailDraft.updateMany).not.toHaveBeenCalled();
    },
  );

  it("mcp + unknown forwarded username → 404 (fail closed)", async () => {
    const res = await request(buildApp(mcpPrincipal))
      .get("/api/email/a1/threads?filter=inbox")
      .set("X-Droplet-User", "nobody");

    expect(res.status).toBe(404);
  });

  it.each([
    ["get", "/api/email/accounts"],
    ["patch", "/api/email/drafts/d1"],
  ] as const)(
    "%s %s — mcp stays denied (403) on the non-tool human surface",
    async (method, path) => {
      const res = await (request(buildApp(mcpPrincipal)) as any)
        [method](path)
        .set("X-Droplet-User", "boss")
        .send({});

      expect(res.status).toBe(403);
    },
  );
});

describe("human sessions: spoofed headers ignored, RBAC unchanged (WARP-1453)", () => {
  it("family session with a spoofed X-Droplet-User still scopes to its OWN identity", async () => {
    // fam (u-family) does NOT own a1 (owned by u-romain). Spoofing the
    // owner's username in the header must not widen access: the header
    // is honored ONLY for the trusted mcp principal.
    const prisma = createPrismaShim();
    const res = await request(buildApp(familyUser, prisma))
      .get("/api/email/a1/threads?filter=inbox")
      .set("X-Droplet-User", "boss");

    expect(res.status).toBe(404);
    // The human path never consults the directory — session identity rules.
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("family session that owns the account passes with a spoofed header present (scoped to itself)", async () => {
    const prisma = createPrismaShim();
    // Re-own the account to the family session for this case.
    prisma.emailAccount.findUnique.mockResolvedValue({ id: "a1", userId: "u-family" });
    const res = await request(buildApp(familyUser, prisma))
      .get("/api/email/a1/threads?filter=inbox")
      .set("X-Droplet-User", "boss");

    expect(res.status).toBe(200);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("family still 403 on send (human set unchanged)", async () => {
    const prisma = createPrismaShim();
    const res = await request(buildApp(familyUser, prisma)).post(
      "/api/email/drafts/d1/send",
    );

    expect(res.status).toBe(403);
    expect(prisma.emailDraft.updateMany).not.toHaveBeenCalled();
  });

  it("guest still 403 on threads (human set unchanged)", async () => {
    const prisma = createPrismaShim();
    const res = await request(buildApp(guestUser, prisma)).get(
      "/api/email/a1/threads?filter=inbox",
    );

    expect(res.status).toBe(403);
    expect(prisma.emailThread.findMany).not.toHaveBeenCalled();
  });
});
