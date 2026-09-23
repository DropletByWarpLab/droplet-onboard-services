/**
 * WARP-2900 (ADR-056 slice H3) — an extension calling back into the box.
 *
 *   - a `dxt_` bearer resolves, by its sha256, to `_service:ext:<slug>` —
 *     only while the extension should be running; an unknown one is a 401
 *     and never reaches the Nextcloud fallback (MUTATION: let it fall
 *     through → fetch is called → red);
 *   - the global guard confines that principal to GET /api/extensions/self
 *     and POST /api/extensions/self/call: a route with no requireRole of its
 *     own (GET /api/storage) is a 403 for it, and the denial is audited
 *     (MUTATION: unmount the guard → 200 → red);
 *   - /self resolves the INSTALLING OWNER at call time: demoted, deactivated
 *     or deleted → 403, never an empty 200;
 *   - /self/call runs a static read tool AS THAT OWNER (MUTATION: dispatch
 *     as the principal → red) and refuses a write tool with a 403.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";

const recordActivityMock = vi.hoisted(() => vi.fn(async (_p: unknown) => null));

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    NEXTCLOUD_URL: "http://nextcloud",
    JWT_SECRET: "test-secret-at-least-32-chars-long-aaa",
    SANDBOX_URL: "http://sandbox:8030",
    SANDBOX_SERVICE_TOKEN: "sandbox-secret",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));
vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/jwt.service.js", () => ({
  verifyAccessToken: vi.fn().mockReturnValue(null),
  roleFromGroups: vi.fn().mockReturnValue("family"),
  resolveNcSessionRole: vi.fn().mockReturnValue("family"),
  ACCESS_TOKEN_TTL_SECONDS: 900,
  REFRESH_TOKEN_TTL_SECONDS: 60 * 60 * 24 * 30,
}));
vi.mock("../services/activity.singleton.js", () => ({ recordActivity: recordActivityMock }));

import { TOOL_CATALOG } from "@droplet/tools-core";
import { authMiddleware, validateTokenForWs } from "../middleware/auth.js";
import { bindExtensionPrincipalPrisma } from "../services/extension-principal.js";
import { extensionPrincipalGuard } from "../middleware/extension-principal-guard.js";
import { createExtensionsRouter } from "../routes/extensions.js";
import { mintExtensionToken } from "../services/extension-lifecycle.service.js";
import type { McpCallContext } from "../services/mcp-client.service.js";
import { extensionPrisma, fakeSandbox, fakeSidecar, type KitUser } from "./helpers/extension-test-kit.js";

const READ_TOOL = TOOL_CATALOG.find((t) => !t.requiresWrite && !t.requiresConfirmation)!.name;
const WRITE_TOOL = TOOL_CATALOG.find((t) => t.requiresWrite)!.name;

const OWNER: KitUser = { id: "u-owner", username: "romain", role: "owner" };

type CallTool = (name: string, args: Record<string, unknown>, context?: McpCallContext) => Promise<{
  isError: boolean;
  content: { type: string; text?: string }[];
}>;

function setup(opts: { owner?: KitUser | null; status?: string; selfCall?: boolean } = {}) {
  const users = opts.owner === null ? [] : [opts.owner ?? OWNER];
  const db = extensionPrisma({ users });
  const { token, hash } = mintExtensionToken();
  db.extensions.set("wc", {
    id: "wc",
    workspaceId: "wc",
    name: "Word counter",
    installedByUserId: "u-owner",
    status: opts.status ?? "live",
    operatorDomain: null,
    currentVersionId: "v-wc",
    serviceTokenHash: hash,
    failureReason: null,
  });
  db.versions.set("v-wc", { id: "v-wc", extensionId: "wc", version: "0.1.0" });
  bindExtensionPrincipalPrisma(db.prisma);

  const callTool = vi.fn<CallTool>(async () => ({ isError: false, content: [{ type: "text", text: "{\"ok\":true}" }] }));
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(authMiddleware);
  app.use(extensionPrincipalGuard);
  // A stand-in for the many authenticated routes with no requireRole.
  app.get("/api/storage", (_req, res) => {
    res.json({ total: 1 });
  });
  app.use(
    "/api",
    createExtensionsRouter(db.prisma, {
      sandbox: fakeSandbox().client,
      identity: fakeSidecar(),
      mcp: { isStarted: true, callTool },
      selfCallEnabled: opts.selfCall ?? true,
    }),
  );
  return { app, db, token, callTool };
}

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  recordActivityMock.mockClear();
  fetchSpy = vi.fn(async (..._a: unknown[]) => {
    throw new Error("no network in this test");
  });
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
  bindExtensionPrincipalPrisma(null);
});

const deniedRows = () =>
  recordActivityMock.mock.calls
    .map((c) => c[0] as { kind: string; refs: { reason?: string; path?: string } })
    .filter((r) => r.kind === "auth");

describe("the dxt_ bearer", () => {
  it("resolves to the extension's principal and reaches /self", async () => {
    const k = setup();
    const res = await request(k.app).get("/api/extensions/self").set(bearer(k.token));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      extension: { id: "wc", version: "0.1.0", status: "live" },
      actingFor: { id: "u-owner", username: "romain", displayName: "romain" },
    });
  });

  it("an unknown dxt_ bearer is a 401 here and is never sent to Nextcloud", async () => {
    const k = setup();
    const res = await request(k.app).get("/api/extensions/self").set(bearer(`${k.token}x`));
    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is honoured only while the extension should be running", async () => {
    // MUTATION: accept any status in resolveExtensionPrincipal → a failed
    // extension's leftover bearer authenticates → red.
    for (const status of ["failed", "disabled", "uninstalled", "signed"]) {
      const k = setup({ status });
      const res = await request(k.app).get("/api/extensions/self").set(bearer(k.token));
      expect(res.status).toBe(401);
    }
  });

  it("in a cookie it is refused outright, and never sent to Nextcloud", async () => {
    const k = setup();
    const res = await request(k.app).get("/api/storage").set("Cookie", `droplet_session=${k.token}`);
    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never opens a WebSocket", async () => {
    const k = setup();
    expect(await validateTokenForWs(k.token)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("the principal guard", () => {
  it("refuses the extension on a route that has no role check of its own, and audits it", async () => {
    const k = setup();
    const res = await request(k.app).get("/api/storage").set(bearer(k.token));
    expect(res.status).toBe(403);
    expect(deniedRows().at(-1)?.refs).toMatchObject({ reason: "extension-principal-route", path: "/api/storage" });
  });

  it("refuses every owner route too, and any spelling of its own routes but the exact one", async () => {
    const k = setup();
    const cases: Array<[string, string]> = [
      ["post", "/api/extensions/wc/disable"],
      ["get", "/api/extensions"],
      ["get", "/api/Extensions/self"],
      ["get", "/api/extensions/self/"],
      ["post", "/api/extensions/self"],
      ["get", "/api/extensions/self/call"],
    ];
    for (const [method, path] of cases) {
      const res = await (method === "post" ? request(k.app).post(path).send({}) : request(k.app).get(path)).set(bearer(k.token));
      expect([method, path, res.status]).toEqual([method, path, 403]);
    }
  });
});

describe("/self acts for the owner who installed it, as they are now", () => {
  it("a demoted, deactivated or deleted owner is a 403, never an empty 200", async () => {
    const cases: Array<KitUser | null> = [
      { ...OWNER, role: "admin" },
      { ...OWNER, directoryStatus: "DEACTIVATED" },
      null,
    ];
    for (const owner of cases) {
      const k = setup({ owner });
      for (const res of [
        await request(k.app).get("/api/extensions/self").set(bearer(k.token)),
        await request(k.app).post("/api/extensions/self/call").set(bearer(k.token)).send({ tool: READ_TOOL }),
      ]) {
        expect(res.status).toBe(403);
        expect(res.body.error).toBe("owner_unresolved");
      }
      expect(k.callTool).not.toHaveBeenCalled();
    }
  });

  it("a person is not an extension: /self is 403 for a human session", async () => {
    const db = extensionPrisma({ users: [OWNER] });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: "u-owner", username: "romain", displayName: "Romain", role: "owner" };
      next();
    });
    app.use(extensionPrincipalGuard);
    app.use("/api", createExtensionsRouter(db.prisma, { sandbox: fakeSandbox().client, identity: fakeSidecar() }));
    const res = await request(app).get("/api/extensions/self");
    expect(res.status).toBe(403);
    // …and the guard leaves a person's own routes alone.
    const storage = express();
    storage.use((req, _res, next) => {
      req.user = { id: "u-owner", username: "romain", displayName: "Romain", role: "owner" };
      next();
    });
    storage.use(extensionPrincipalGuard);
    storage.get("/api/storage", (_req, r) => {
      r.json({ ok: true });
    });
    expect((await request(storage).get("/api/storage")).status).toBe(200);
  });
});

describe("/self/call", () => {
  it("ships off: with the flag unset it is a 503 and nothing is dispatched; /self still answers", async () => {
    // MUTATION: drop the selfCallEnabled check → the read tool runs → red.
    const k = setup({ selfCall: false });
    const res = await request(k.app).post("/api/extensions/self/call").set(bearer(k.token)).send({ tool: READ_TOOL });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("self_call_disabled");
    expect(k.callTool).not.toHaveBeenCalled();
    expect((await request(k.app).get("/api/extensions/self").set(bearer(k.token))).status).toBe(200);
  });

  it("runs a static read tool as the installing owner, naming the extension", async () => {
    const k = setup();
    const res = await request(k.app)
      .post("/api/extensions/self/call")
      .set(bearer(k.token))
      .send({ tool: READ_TOOL, arguments: { q: 1 } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ isError: false, content: [{ type: "text", text: "{\"ok\":true}" }] });
    expect(k.callTool).toHaveBeenCalledWith(READ_TOOL, { q: 1 }, { userId: "romain", userRole: "owner", extensionId: "wc" });
  });

  it("refuses a write tool with a 403 and dispatches nothing", async () => {
    const k = setup();
    const res = await request(k.app).post("/api/extensions/self/call").set(bearer(k.token)).send({ tool: WRITE_TOOL });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("write_tool_refused");
    expect(k.callTool).not.toHaveBeenCalled();
  });

  it("knows only the static catalog: a runtime or another extension's tool is not callable", async () => {
    const k = setup();
    for (const tool of ["ext-other__word_count", "atlassian__getJiraIssue", "not_a_tool"]) {
      const res = await request(k.app).post("/api/extensions/self/call").set(bearer(k.token)).send({ tool });
      expect(res.status).toBe(404);
    }
    const bad = await request(k.app).post("/api/extensions/self/call").set(bearer(k.token)).send({ tool: READ_TOOL, as: "admin" });
    expect(bad.status).toBe(400);
    expect(k.callTool).not.toHaveBeenCalled();
  });
});
