/**
 * WARP-3099 — the LLM tool `list_notifications` reads the list of the person it
 * acts for, on BOTH mcp-server transports.
 *
 * Until WARP-3099 the tools-core handler read `NotificationLog` through
 * `ctx.prisma` by `username: ctx.userId`. `ctx.userId` is `User.username` on the
 * stdio transport (routes/llm.ts `_meta.userId`) but `User.id` on the HTTP one
 * (services/mcp-server/src/context.ts: `claims.sub`), and the log is keyed on
 * the username (WARP-2911). So every HTTP-transport caller got an empty list,
 * silently — and chat excludes this tool (chat-tool-scope.ts), so the external
 * MCP clients on that transport are exactly who it is kept for.
 *
 * This file runs the REAL tool handler, loaded from `@droplet/tools-core` the way
 * the mcp-server loads it, against the REAL notifications router and the REAL
 * `listNotifications`, over an in-memory NotificationLog that evaluates its
 * where-clauses (helpers/fake-notification-log.ts). The two are joined by a
 * `ctx.http.orchestrator` that reaches the router in-process as `_service:mcp`,
 * carrying the acting-user header mcp-server's `withActingUser` stamps.
 *
 * Fakes return a DISTINCT `User.id` and `User.username`, as production rows do
 * (WARP-2911): a fake that agrees with a UUID key cannot catch one.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Request, type Response as ExpressResponse, type NextFunction } from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { getTool, type ToolContext } from "@droplet/tools-core";

const { effectiveAccess } = vi.hoisted(() => ({
  effectiveAccess: vi.fn(async (_userId: string): Promise<unknown> => null),
}));

vi.mock("../services/mqtt.service.js", () => ({ publish: vi.fn() }));
// Axis B (the access role's tool grants) reads the effective-access resolver,
// which needs a bound Prisma + config. Its answer is the fixture here.
vi.mock("../services/effective-access.service.js", () => ({
  resolveEffectiveAccess: (userId: string) => effectiveAccess(userId),
}));

import { createNotificationsRouter } from "../routes/notifications.js";
import type { AuthUser } from "../middleware/auth.js";
import { makeFakeNotificationLog, type FakeNotificationLog } from "./helpers/fake-notification-log.js";

const MCP: AuthUser = { id: "_service:mcp", username: "_service:mcp", displayName: "MCP Server", role: "service" };

interface FakeUser {
  id: string;
  username: string;
  role: string;
  directoryStatus?: string;
  accessRoleId?: string | null;
  accessRole?: { toolGrants: Array<{ domain: string; level: string }> } | null;
}

const ALICE: FakeUser = { id: "5b0c7a4e-1f2d-4c3b-9a8e-7d6f5e4c3b2a", username: "alice", role: "owner" };
const BOB: FakeUser = { id: "1d2c3b4a-5968-4776-8a5b-4c3d2e1f0a9b", username: "bob", role: "owner" };

/** Fixture times derive from the clock, an hour back (never "the future"). */
const HOUR_AGO = Date.now() - 60 * 60_000;
const ago = (min: number) => new Date(HOUR_AGO + min * 60_000);

function fakePrisma(users: FakeUser[]): { prisma: PrismaClient; log: FakeNotificationLog } {
  const log = makeFakeNotificationLog(ago(0));
  const prisma = {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string; username?: string } }) => {
        const u = users.find((x) => (where.id !== undefined ? x.id === where.id : x.username === where.username));
        return u ? { directoryStatus: "ACTIVE", accessRoleId: null, accessRole: null, ...u } : null;
      }),
    },
    notificationLog: log.delegate,
  };
  return { prisma: prisma as unknown as PrismaClient, log };
}

/** Alice's two rows and one of Bob's — the tool must never show his. */
function seed(log: FakeNotificationLog) {
  log.seed({
    id: "n-alice-1",
    username: "alice",
    kind: "reminder",
    title: "Standup",
    createdAt: ago(1),
    deliveredAt: ago(1),
    channels: "toast",
  });
  log.seed({
    id: "n-alice-2",
    username: "alice",
    kind: "ai",
    title: "Approval needed",
    url: "/workshop?run=r1",
    createdAt: ago(2),
    ackState: "acked",
  });
  log.seed({ id: "n-bob-1", username: "bob", kind: "system", title: "Not yours", createdAt: ago(3) });
}

function appAs(principal: AuthUser, prisma: PrismaClient): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: ExpressResponse, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = principal;
    next();
  });
  app.use("/api", createNotificationsRouter(prisma));
  return app;
}

/**
 * `ctx.http.orchestrator` as the mcp-server builds it: every call goes out as
 * `_service:mcp` (the shim above) with `X-Nextcloud-User: <acting user>`, and a
 * per-call header still wins — exactly `withActingUser`'s merge.
 */
function orchestratorClient(app: express.Express, actingUser: string | undefined): ToolContext["http"]["orchestrator"] {
  async function send(
    method: "get" | "post" | "patch" | "delete",
    path: string,
    body: unknown,
    opts?: { headers?: Record<string, string> },
  ): Promise<Response> {
    let req = request(app)[method](path);
    const headers = { ...(actingUser ? { "X-Nextcloud-User": actingUser } : {}), ...(opts?.headers ?? {}) };
    for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
    const res = body === undefined ? await req : await req.send(body as object);
    return new Response(JSON.stringify(res.body), {
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

function toolCtx(prisma: PrismaClient, app: express.Express, actingUser: string): ToolContext {
  return {
    prisma,
    http: { orchestrator: orchestratorClient(app, actingUser) } as unknown as ToolContext["http"],
    matter: {} as ToolContext["matter"],
    userId: actingUser,
    signal: new AbortController().signal,
  } as ToolContext;
}

type Listed = { count: number; notifications: Array<{ id: string; kind: string; title: string; url: string | null; delivered: boolean; at: string }> };

const tool = getTool("list_notifications")!;

beforeEach(() => {
  vi.clearAllMocks();
  effectiveAccess.mockImplementation(async () => null);
});

describe("🔴 WARP-3099 list_notifications reads the person it acts for, on both transports", () => {
  it("HTTP transport: the acting user arrives as a User.id — they still see their own notifications", async () => {
    const { prisma, log } = fakePrisma([ALICE, BOB]);
    seed(log);

    const r = await tool.handler({}, toolCtx(prisma, appAs(MCP, prisma), ALICE.id));

    expect(r.ok).toBe(true);
    const data = (r as { data: Listed }).data;
    expect(data.notifications.map((n) => n.id)).toEqual(["n-alice-2", "n-alice-1"]);
    expect(data.count).toBe(2);
  });

  it("stdio transport: the acting user arrives as the username — the same list", async () => {
    const { prisma, log } = fakePrisma([ALICE, BOB]);
    seed(log);

    const r = await tool.handler({}, toolCtx(prisma, appAs(MCP, prisma), "alice"));

    expect((r as { data: Listed }).data.notifications.map((n) => n.id)).toEqual(["n-alice-2", "n-alice-1"]);
  });

  it("each row keeps the tool's shape: kind, title, deep link, delivered, time — read AND acked rows alike", async () => {
    const { prisma, log } = fakePrisma([ALICE]);
    seed(log);

    const r = await tool.handler({}, toolCtx(prisma, appAs(MCP, prisma), ALICE.id));

    expect((r as { data: Listed }).data.notifications).toEqual([
      { id: "n-alice-2", kind: "ai", title: "Approval needed", body: null, url: "/workshop?run=r1", delivered: false, at: ago(2).toISOString() },
      { id: "n-alice-1", kind: "reminder", title: "Standup", body: null, url: null, delivered: true, at: ago(1).toISOString() },
    ]);
  });

  it("`limit` bounds the list, newest first", async () => {
    const { prisma, log } = fakePrisma([ALICE]);
    seed(log);

    const r = await tool.handler({ limit: 1 }, toolCtx(prisma, appAs(MCP, prisma), ALICE.id));

    expect((r as { data: Listed }).data.notifications.map((n) => n.id)).toEqual(["n-alice-2"]);
  });

  it("the tool reads through the orchestrator, never NotificationLog directly", async () => {
    const { prisma, log } = fakePrisma([ALICE]);
    seed(log);
    // The handler's own ctx.prisma refuses every NotificationLog read; only the
    // router's (the orchestrator's) can answer.
    const refuse = vi.fn(async () => {
      throw new Error("list_notifications read NotificationLog through ctx.prisma");
    });
    const handlerPrisma = { notificationLog: { findMany: refuse, count: refuse } } as unknown as PrismaClient;

    const r = await tool.handler({}, toolCtx(handlerPrisma, appAs(MCP, prisma), ALICE.id));

    expect(refuse).not.toHaveBeenCalled();
    expect((r as { data: Listed }).data.count).toBe(2);
  });

  it("a person the tool may not act for gets a legible refusal, and nothing is read", async () => {
    const { prisma, log } = fakePrisma([ALICE]);
    seed(log);

    const r = await tool.handler({}, toolCtx(prisma, appAs(MCP, prisma), "mallory"));

    expect(r).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(log.delegate.findMany).not.toHaveBeenCalled();
  });
});

describe("N1 GET /api/notifications as the MCP principal (WARP-3099)", () => {
  function list(app: express.Express, actingUser?: string) {
    const req = request(app).get("/api/notifications");
    return actingUser ? req.set("X-Nextcloud-User", actingUser) : req;
  }

  it("the acting user's list and unread count — by User.id and by username alike", async () => {
    const { prisma, log } = fakePrisma([ALICE, BOB]);
    seed(log);
    const app = appAs(MCP, prisma);

    for (const asserted of [ALICE.id, "alice"]) {
      const res = await list(app, asserted);
      expect(res.status, asserted).toBe(200);
      expect(res.body.notifications.map((n: { id: string }) => n.id), asserted).toEqual(["n-alice-2", "n-alice-1"]);
      expect(res.body.unread, asserted).toBe(1);
    }
  });

  it("no acting user → 403 ACTING_USER_REQUIRED; the service principal's own list is never read", async () => {
    const { prisma, log } = fakePrisma([ALICE]);
    log.seed({ username: "_service:mcp" });
    const res = await list(appAs(MCP, prisma));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ACTING_USER_REQUIRED");
    expect(log.delegate.findMany).not.toHaveBeenCalled();
    expect(log.delegate.count).not.toHaveBeenCalled();
  });

  it("an acting user who matches no account → 403 ACTING_USER_REQUIRED", async () => {
    const { prisma, log } = fakePrisma([ALICE]);
    const res = await list(appAs(MCP, prisma), "mallory");
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ACTING_USER_REQUIRED");
    expect(log.delegate.findMany).not.toHaveBeenCalled();
  });

  it("a deactivated account → 403 ACTING_USER_REQUIRED", async () => {
    const { prisma, log } = fakePrisma([{ ...ALICE, directoryStatus: "DEACTIVATED" }]);
    seed(log);
    const res = await list(appAs(MCP, prisma), ALICE.id);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ACTING_USER_REQUIRED");
    expect(log.delegate.findMany).not.toHaveBeenCalled();
  });

  it("an admin whose access role does not reach notifications → 403 FORBIDDEN_TOOL_FOR_ROLE (axis B)", async () => {
    const admin: FakeUser = {
      id: "7c6b5a49-3827-4165-9f4e-3d2c1b0a9f8e",
      username: "ops",
      role: "admin",
      accessRoleId: "role-files-only",
      accessRole: { toolGrants: [{ domain: "files", level: "use" }] },
    };
    effectiveAccess.mockImplementation(async () => ({ tier: "admin", toolDomains: ["files"], locks: false }));
    const { prisma, log } = fakePrisma([admin]);
    log.seed({ username: "ops" });
    const res = await list(appAs(MCP, prisma), admin.id);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN_TOOL_FOR_ROLE");
    expect(log.delegate.findMany).not.toHaveBeenCalled();
  });

  it("a family member reads their own list: list_notifications is a read, not a write", async () => {
    const kid: FakeUser = { id: "0e9d8c7b-6a5f-4e3d-8c2b-1a0f9e8d7c6b", username: "kid", role: "family" };
    const { prisma, log } = fakePrisma([kid, ALICE]);
    seed(log);
    log.seed({ id: "n-kid-1", username: "kid" });
    const res = await list(appAs(MCP, prisma), kid.id);
    expect(res.status).toBe(200);
    expect(res.body.notifications.map((n: { id: string }) => n.id)).toEqual(["n-kid-1"]);
  });

  it("a person in the browser still reads their own list, and the header means nothing from them", async () => {
    const { prisma, log } = fakePrisma([ALICE, BOB]);
    seed(log);
    const bob: AuthUser = { id: BOB.id, username: "bob", displayName: "Bob", role: "owner" };
    const res = await list(appAs(bob, prisma), "alice");
    expect(res.status).toBe(200);
    expect(res.body.notifications.map((n: { id: string }) => n.id)).toEqual(["n-bob-1"]);
  });
});
