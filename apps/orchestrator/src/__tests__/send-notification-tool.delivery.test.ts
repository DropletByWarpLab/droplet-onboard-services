/**
 * WARP-3060 — the LLM tool `send_notification` DELIVERS.
 *
 * Until WARP-3060 the tools-core handler inserted a NotificationLog row through
 * `ctx.prisma` (`channels: ""`, manifest route `none`) and answered "queued".
 * Nothing ever picked such a row up — no toast, no web push — while the model
 * told the person it had notified them. Since WARP-2804 each of those rows also
 * counts as unread.
 *
 * This file runs the REAL tool handler, loaded from `@droplet/tools-core` the
 * way the mcp-server loads it, against the REAL notifications router and the
 * REAL `sendNotification`. The two are joined by a `ctx.http.orchestrator` that
 * reaches the router in-process as the `_service:mcp` principal, carrying the
 * acting-user header mcp-server's `withActingUser` stamps on every call
 * (services/mcp-server/src/context.ts). Only the transports are mocked — the
 * MQTT publish (the toast) and `dispatchToUser` (web push) — and the assertions
 * are on THEM: a row alone is not a notification.
 *
 * Fakes return a DISTINCT `User.id` and `User.username`, as production rows do
 * (WARP-2911): a fake that agrees with a UUID recipient cannot catch one.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Request, type Response as ExpressResponse, type NextFunction } from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { getTool, type ToolContext } from "@droplet/tools-core";

const { mqttPublish, dispatchToUser, effectiveAccess } = vi.hoisted(() => ({
  mqttPublish: vi.fn((_topic: string, _payload: Record<string, unknown>) => undefined),
  dispatchToUser: vi.fn(async (_prisma: unknown, _username: string, _payload: Record<string, unknown>) => ({
    sent: 1,
    attempted: 1,
    refused: false,
  })),
  effectiveAccess: vi.fn(async (_userId: string): Promise<unknown> => null),
}));

vi.mock("../services/mqtt.service.js", () => ({
  publish: (topic: string, payload: Record<string, unknown>) => mqttPublish(topic, payload),
}));
vi.mock("../services/push-dispatch.service.js", () => ({
  ensurePushDispatch: vi.fn(async () => undefined),
  dispatchToUser: (prisma: unknown, username: string, payload: Record<string, unknown>) =>
    dispatchToUser(prisma, username, payload),
}));
// Axis B (the access role's tool grants) reads the effective-access resolver,
// which needs a bound Prisma + config. Its answer is the fixture here.
vi.mock("../services/effective-access.service.js", () => ({
  resolveEffectiveAccess: (userId: string) => effectiveAccess(userId),
}));

import { createNotificationsRouter } from "../routes/notifications.js";
import type { AuthUser } from "../middleware/auth.js";
import { userDirectory, type DirectoryUser } from "./helpers/user-directory.js";

const MCP: AuthUser = { id: "_service:mcp", username: "_service:mcp", displayName: "MCP Server", role: "service" };

interface FakeUser {
  id: string;
  username: string;
  /** Absent = NULL, as on every SSO / SCIM account. */
  nextcloudUsername?: string | null;
  role: string;
  directoryStatus?: string;
  accessRoleId?: string | null;
  accessRole?: { toolGrants: Array<{ domain: string; level: string }> } | null;
}

const ALICE: FakeUser = { id: "5b0c7a4e-1f2d-4c3b-9a8e-7d6f5e4c3b2a", username: "alice", role: "owner" };

function fakePrisma(users: FakeUser[]) {
  const rows: Array<Record<string, unknown>> = [];
  const prisma = {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string; username?: string } }) => {
        const u = users.find((x) => (where.id !== undefined ? x.id === where.id : x.username === where.username));
        return u ? { directoryStatus: "ACTIVE", accessRoleId: null, accessRole: null, ...u } : null;
      }),
      // WARP-3098 — resolveAssertedUser's `findMany OR [...] take 2`.
      findMany: userDirectory(() => users.map((u) => ({ nextcloudUsername: null, ...u }) as DirectoryUser)).findMany,
    },
    notificationLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `log-${rows.length + 1}`, createdAt: new Date(), ...data };
        rows.push(row);
        return row;
      }),
      // WARP-2804's record-then-deliver claim and stamp; unused before it lands.
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async () => ({})),
    },
  };
  return { prisma: prisma as unknown as PrismaClient, rows };
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

const tool = getTool("send_notification")!;

beforeEach(() => {
  vi.clearAllMocks();
  effectiveAccess.mockImplementation(async () => null);
});

describe("🔴 WARP-3060 send_notification reaches the person it acts for", () => {
  it("publishes the toast AND dispatches the push to the acting user — not just a row", async () => {
    const { prisma, rows } = fakePrisma([ALICE]);
    const app = appAs(MCP, prisma);

    const r = await tool.handler({ title: "Pop!", body: "The export finished." }, toolCtx(prisma, app, "alice"));

    expect(mqttPublish).toHaveBeenCalledTimes(1);
    expect(mqttPublish).toHaveBeenCalledWith(
      "droplet/notifications/alice",
      expect.objectContaining({ kind: "ai", title: "Pop!", body: "The export finished." }),
    );
    expect(dispatchToUser).toHaveBeenCalledTimes(1);
    expect(dispatchToUser).toHaveBeenCalledWith(
      prisma,
      "alice",
      expect.objectContaining({ title: "Pop!", body: "The export finished." }),
    );
    // One row, written by the orchestrator's sendNotification — never a second,
    // undelivered one from the tool.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ username: "alice", kind: "ai", title: "Pop!" });
    expect(r).toMatchObject({ ok: true, data: { delivered: true } });
  });

  it("over the HTTP transport the acting user arrives as a User.id — the recipient is still the username", async () => {
    const { prisma } = fakePrisma([ALICE]);
    const app = appAs(MCP, prisma);

    const r = await tool.handler({ title: "Done" }, toolCtx(prisma, app, ALICE.id));

    expect(r.ok).toBe(true);
    expect(mqttPublish.mock.calls.map((c) => c[0])).toEqual(["droplet/notifications/alice"]);
    expect(dispatchToUser.mock.calls.map((c) => c[1])).toEqual(["alice"]);
  });

  it("a person the tool may not act for gets a legible refusal, and nothing is sent", async () => {
    const { prisma, rows } = fakePrisma([{ id: "0e9d8c7b-6a5f-4e3d-8c2b-1a0f9e8d7c6b", username: "kid", role: "family" }]);
    const app = appAs(MCP, prisma);

    const r = await tool.handler({ title: "hi" }, toolCtx(prisma, app, "kid"));

    expect(r).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(mqttPublish).not.toHaveBeenCalled();
    expect(dispatchToUser).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
  });
});

describe("POST /api/notifications/send as the MCP principal (WARP-3060)", () => {
  function send(app: express.Express, body: object, actingUser?: string) {
    const req = request(app).post("/api/notifications/send");
    return (actingUser ? req.set("X-Nextcloud-User", actingUser) : req).send(body);
  }

  function expectNothingSent(rows: unknown[]) {
    expect(mqttPublish).not.toHaveBeenCalled();
    expect(dispatchToUser).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
  }

  it("no acting user → 403; the service principal is never a recipient", async () => {
    const { prisma, rows } = fakePrisma([ALICE]);
    const res = await send(appAs(MCP, prisma), { kind: "ai", title: "x" });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "acting_user_required" });
    expectNothingSent(rows);
  });

  it("an acting user who matches no account → 403", async () => {
    const { prisma, rows } = fakePrisma([ALICE]);
    const res = await send(appAs(MCP, prisma), { kind: "ai", title: "x" }, "mallory");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "acting_user_required" });
    expectNothingSent(rows);
  });

  it("a deactivated account → 403", async () => {
    const { prisma, rows } = fakePrisma([{ ...ALICE, directoryStatus: "DEACTIVATED" }]);
    const res = await send(appAs(MCP, prisma), { kind: "ai", title: "x" }, "alice");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "acting_user_required" });
    expectNothingSent(rows);
  });

  it("WARP-3098: an SSO row (nextcloudUsername NULL) resolves by username", async () => {
    const { prisma } = fakePrisma([{ ...ALICE, nextcloudUsername: null }]);
    const res = await send(appAs(MCP, prisma), { kind: "ai", title: "x" }, "alice");
    expect(res.status).toBe(202);
    expect(mqttPublish.mock.calls.map((c) => c[0])).toEqual(["droplet/notifications/alice"]);
  });

  it("WARP-3098: a value that is one person's User.id AND another's username → 403, nobody is notified", async () => {
    // The old lookup tried username first, so this value resolved to the
    // look-alike (an owner) and made THEM the recipient.
    const lookalike: FakeUser = { id: "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a", username: ALICE.id, role: "owner" };
    const { prisma, rows } = fakePrisma([ALICE, lookalike]);
    const res = await send(appAs(MCP, prisma), { kind: "ai", title: "x" }, ALICE.id);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "acting_user_required" });
    expectNothingSent(rows);
  });

  it("a family member → 403 forbidden_tool_for_role: the write tier chat's dispatch gate applies", async () => {
    const { prisma, rows } = fakePrisma([{ id: "0e9d8c7b-6a5f-4e3d-8c2b-1a0f9e8d7c6b", username: "kid", role: "family" }]);
    const res = await send(appAs(MCP, prisma), { kind: "ai", title: "x" }, "kid");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "forbidden_tool_for_role", tool: "send_notification" });
    expectNothingSent(rows);
  });

  it("an admin whose access role does not reach notifications → 403 (axis B)", async () => {
    const admin: FakeUser = {
      id: "7c6b5a49-3827-4165-9f4e-3d2c1b0a9f8e",
      username: "ops",
      role: "admin",
      accessRoleId: "role-files-only",
      accessRole: { toolGrants: [{ domain: "files", level: "use" }] },
    };
    effectiveAccess.mockImplementation(async () => ({ tier: "admin", toolDomains: ["files"], locks: false }));
    const { prisma, rows } = fakePrisma([admin]);
    const res = await send(appAs(MCP, prisma), { kind: "ai", title: "x" }, "ops");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "forbidden_tool_for_role", tool: "send_notification" });
    expectNothingSent(rows);
  });

  it("an admin whose access role grants notifications → delivered to them", async () => {
    const admin: FakeUser = {
      id: "7c6b5a49-3827-4165-9f4e-3d2c1b0a9f8e",
      username: "ops",
      role: "admin",
      accessRoleId: "role-notify",
      accessRole: { toolGrants: [{ domain: "notifications", level: "use" }] },
    };
    effectiveAccess.mockImplementation(async () => ({ tier: "admin", toolDomains: ["notifications"], locks: false }));
    const { prisma } = fakePrisma([admin]);
    const res = await send(appAs(MCP, prisma), { kind: "ai", title: "x" }, "ops");
    expect(res.status).toBe(202);
    expect(mqttPublish.mock.calls.map((c) => c[0])).toEqual(["droplet/notifications/ops"]);
  });

  it("the tool's notifications are `ai`: another kind is refused, an omitted one is `ai`", async () => {
    const { prisma, rows } = fakePrisma([ALICE]);
    const app = appAs(MCP, prisma);

    const spoof = await send(app, { kind: "system", title: "Your box needs attention" }, "alice");
    expect(spoof.status).toBe(400);
    expect(spoof.body).toEqual({ error: "kind_not_allowed" });
    expectNothingSent(rows);

    const plain = await send(app, { title: "x" }, "alice");
    expect(plain.status).toBe(202);
    expect(rows[0]).toMatchObject({ kind: "ai", username: "alice" });
  });

  it("a recipient in the body is ignored — the tool only ever notifies the person it acts for", async () => {
    const bob: FakeUser = { id: "1d2c3b4a-5968-4776-8a5b-4c3d2e1f0a9b", username: "bob", role: "owner" };
    const { prisma } = fakePrisma([ALICE, bob]);
    const res = await send(appAs(MCP, prisma), { kind: "ai", title: "x", username: "bob" }, "alice");
    expect(res.status).toBe(202);
    expect(mqttPublish.mock.calls.map((c) => c[0])).toEqual(["droplet/notifications/alice"]);
  });

  it("a person in the browser still notifies themselves, and the header means nothing from them", async () => {
    const { prisma } = fakePrisma([ALICE]);
    const romain: AuthUser = { id: "u-romain", username: "romain", displayName: "Romain", role: "owner" };
    const res = await send(appAs(romain, prisma), { title: "x" }, "alice");
    expect(res.status).toBe(202);
    expect(mqttPublish.mock.calls.map((c) => c[0])).toEqual(["droplet/notifications/romain"]);
  });
});
