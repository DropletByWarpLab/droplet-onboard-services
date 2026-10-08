import express, { type Request } from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createHostedService, hostedJwtKey, HOSTED_SESSION_SECONDS, isHostedGatewayRequest } from "./hosted.service.js";
import { encryptColumn, deriveHostedAppRelayKey } from "./column-crypto.service.js";
import { createHostedManagementRouter, createHostedRelayRouter } from "../routes/hosted.js";
import { hostedOriginGuard } from "../middleware/hosted-origin.js";

vi.mock("../config.js", () => ({ config: {
  JWT_SECRET: "dashboard-secret-with-at-least-32-bytes", DEVICE_SECRET_KEY: Buffer.alloc(32, 7).toString("base64"),
  SANDBOX_PROCESS_SUPERVISION: true, SANDBOX_URL: "http://sandbox:8030", SANDBOX_SERVICE_TOKEN: "sandbox-bearer",
  corsAllowedOrigins: ["https://droplet-ai.lan"], DROPLET_LAN_HOSTNAME: "droplet-ai.lan",
} }));
vi.mock("./activity.singleton.js", () => ({ recordActivity: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "10.0.0.2", family: 4 }]) }));

const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, id: "shop", name: "Shop", version: "1.0.0",
  kind: "app", runtime: "static", http: { health: "/", dir: "." },
  provides: { tools: [], routineDrafts: [], proposedGrants: [{ role: "family", domain: "app:shop", level: "use" }] },
  resources: { memoryMb: 64, processes: 1 }, egress: "none" }));

function fixture() {
  const user = { id: "user-id", username: "alice", displayName: "Alice", role: "owner", directoryStatus: "ACTIVE" };
  const row = { id: "shop", workspaceId: "shop-workspace", name: "Shop", kind: "app", status: "live",
    appRelayKeyEnc: encryptColumn(deriveHostedAppRelayKey(), "internal-app-key", "hosted-app:shop"), lastHealthAt: new Date(),
    currentVersion: { version: "1.0.0", manifestBytes: manifest }, hostedAppGrants: [] as { role: string }[] };
  const codes = new Map<string, { codeHash: string; extensionId: string; userId: string; expiresAt: Date }>();
  const db = {
    user: { findUnique: vi.fn(async () => user), findMany: vi.fn(async () => [user]) },
    extension: { findUnique: vi.fn(async () => row), findMany: vi.fn(async () => [row]) },
    hostedAppSessionCode: {
      create: vi.fn(async ({ data }) => { codes.set(data.codeHash, data); return data; }),
      findUnique: vi.fn(async ({ where }) => codes.get(where.codeHash) ?? null),
      deleteMany: vi.fn(async ({ where }) => {
        if (!where.codeHash) return { count: 0 };
        const found = codes.get(where.codeHash);
        if (found && found.extensionId === where.extensionId && found.expiresAt > where.expiresAt.gt) {
          codes.delete(where.codeHash); return { count: 1 };
        }
        return { count: 0 };
      }),
    },
    hostedAppGrant: {
      findMany: vi.fn(async () => row.hostedAppGrants),
      deleteMany: vi.fn(async () => { row.hostedAppGrants = []; return { count: 1 }; }),
      createMany: vi.fn(async ({ data }) => { row.hostedAppGrants = data; return { count: data.length }; }),
    },
    $transaction: vi.fn(async (callback) => callback(db)),
  };
  const audit = vi.fn(async () => undefined);
  const sandbox = { logs: vi.fn(async () => ({ output: "safe bounded log", truncated: false })) };
  const deps = { audit, sandbox: sandbox as never, enabled: () => true,
    gatewayPeer: async (req: Request) => req.header("x-forwarded-port") === "8443" && req.header("x-droplet-hosted-ingress") === "8443" };
  return { db, prisma: db as unknown as PrismaClient, row, user, codes, audit, sandbox, deps };
}
const req = () => ({ user: { id: "user-id", role: "owner" }, query: {}, headers: {}, header: () => undefined }) as unknown as Request;
const token = () => jwt.sign({ role: "owner" }, hostedJwtKey(), { subject: "user-id", audience: "app:shop", issuer: "droplet-hosted", expiresIn: HOSTED_SESSION_SECONDS });

describe("hosted app sessions and grants", () => {
  beforeEach(() => vi.clearAllMocks());
  it("stores only a hash and atomically redeems across concurrent workers", async () => {
    const f = fixture(); const service = createHostedService(f.prisma, f.deps);
    const minted = await service.mint(req(), "shop");
    const code = new URL(minted.url).searchParams.get("code")!;
    expect([...f.codes.keys()][0]).not.toContain(code);
    const secondWorker = createHostedService(f.prisma, f.deps);
    const results = await Promise.allSettled([service.redeem("shop", code), secondWorker.redeem("shop", code)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(f.codes.size).toBe(0);
    const appToken = results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<string>;
    expect(jwt.verify(appToken.value, hostedJwtKey(), { audience: "app:shop" })).toMatchObject({ sub: "user-id", aud: "app:shop" });
    expect(() => jwt.verify(appToken.value, "dashboard-secret-with-at-least-32-bytes")).toThrow();
    expect(() => jwt.verify(appToken.value, hostedJwtKey(), { audience: "app:other" })).toThrow();
  });
  it("refuses expired or wrong-app codes", async () => {
    const f = fixture(); const service = createHostedService(f.prisma, f.deps);
    const code = new URL((await service.mint(req(), "shop")).url).searchParams.get("code")!;
    await expect(service.redeem("other", code)).rejects.toMatchObject({ status: 401 });
    for (const value of f.codes.values()) value.expiresAt = new Date(0);
    await expect(service.redeem("shop", code)).rejects.toMatchObject({ status: 401 });
  });
  it("checks current role, grants and deactivation on every app request", async () => {
    const f = fixture(); const service = createHostedService(f.prisma, f.deps);
    const cookieReq = { ...req(), headers: { cookie: `droplet_app_shop=${token()}; droplet_session=dashboard` } } as Request;
    expect((await service.session(cookieReq, "shop")).user.role).toBe("owner");
    f.user.role = "family";
    await expect(service.session(cookieReq, "shop")).rejects.toMatchObject({ status: 403 });
    f.row.hostedAppGrants = [{ role: "family" }];
    expect((await service.session(cookieReq, "shop")).user.role).toBe("family");
    f.user.directoryStatus = "DEACTIVATED";
    await expect(service.session(cookieReq, "shop")).rejects.toMatchObject({ status: 403 });
  });
  it("allows only explicit family grants from an owner", async () => {
    const f = fixture(); const service = createHostedService(f.prisma, f.deps);
    await expect(service.grants("shop", ["guest"], f.user)).rejects.toMatchObject({ status: 403 });
    f.user.role = "admin";
    await expect(service.grants("shop", ["family"], f.user)).rejects.toMatchObject({ status: 403 });
    f.user.role = "owner";
    expect(await service.grants("shop", ["family"], f.user)).toEqual({ roles: ["family"] });
  });
  it("requires a resolved acting owner/admin for MCP logs", async () => {
    const f = fixture(); const service = createHostedService(f.prisma, f.deps);
    const mcp = { ...req(), user: { id: "_service:mcp", role: "service" }, query: { onBehalfOf: "alice" } } as unknown as Request;
    expect(await service.logs(mcp, "shop", 200)).toMatchObject({ output: "safe bounded log" });
    f.user.role = "family";
    await expect(service.logs(mcp, "shop", 200)).rejects.toMatchObject({ status: 403 });
    mcp.query = {};
    await expect(service.logs(mcp, "shop", 200)).rejects.toMatchObject({ status: 403 });
  });
  it("bounds list pagination and refuses guests even with a grant row", async () => {
    const f = fixture(); const service = createHostedService(f.prisma, f.deps);
    const listing = await service.list(req());
    expect(listing.apps[0]).toMatchObject({ workspaceId: "shop-workspace", memoryMb: 0 });
    await expect(service.list({ ...req(), query: { limit: "51" } } as unknown as Request)).rejects.toMatchObject({ status: 400 });
    f.user.role = "guest"; f.row.hostedAppGrants = [{ role: "guest" }];
    await expect(service.list(req())).rejects.toMatchObject({ status: 403 });
  });
  it("paginates only visible live family apps and supports workspace matching", async () => {
    const f = fixture(); f.user.role = "family"; f.row.hostedAppGrants = [{ role: "family" }];
    f.db.extension.findMany.mockResolvedValueOnce([f.row, { ...f.row, id: "z-app" }]);
    const service = createHostedService(f.prisma, f.deps);
    const page = await service.list({ ...req(), query: { limit: "1", cursor: "absent-slug", workspaceId: "shop-workspace" } } as unknown as Request);
    expect(page.apps).toHaveLength(1); expect(page.nextCursor).toBe("shop");
    expect(f.db.extension.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { kind: "app", id: { gt: "absent-slug" }, workspaceId: "shop-workspace", status: "live", hostedAppGrants: { some: { role: "family" } } },
      take: 2, orderBy: { id: "asc" },
    }));
    await expect(service.list({ ...req(), query: { limit: ["2"] } } as unknown as Request)).rejects.toMatchObject({ status: 400 });
    await expect(service.list({ ...req(), query: { workspaceId: "../shop" } } as unknown as Request)).rejects.toMatchObject({ status: 400 });
    f.db.extension.findMany.mockClear();
    expect((await createHostedService(f.prisma, { ...f.deps, enabled: () => false }).list(req())).apps).toEqual([]);
    expect(f.db.extension.findMany).not.toHaveBeenCalled();
  });
  it("fails closed when supervision or code storage is unavailable", async () => {
    const f = fixture();
    await expect(createHostedService(f.prisma, { ...f.deps, enabled: () => false }).mint(req(), "shop")).rejects.toMatchObject({ status: 503 });
    f.db.hostedAppSessionCode.create.mockRejectedValueOnce(new Error("db down"));
    await expect(createHostedService(f.prisma, f.deps).mint(req(), "shop")).rejects.toThrow("db down");
  });
});

describe("hosted routers and Origin isolation", () => {
  it("streams a real POST before JSON parsing and strips browser credentials", async () => {
    const f = fixture(); let sent = ""; let sentHeaders: Record<string, string> = {};
    const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit) => {
      sentHeaders = init.headers as Record<string, string>;
      for await (const chunk of init.body as unknown as AsyncIterable<Buffer>) sent += chunk;
      return new Response("app answer", { status: 201, headers: { "content-type": "text/plain", "set-cookie": "forged=1", "access-control-allow-origin": "*" } });
    }) as unknown as typeof fetch;
    const app = express(); app.use("/api", hostedOriginGuard);
    app.use("/api/hosted/relay", createHostedRelayRouter(f.prisma, { ...f.deps, fetchImpl }));
    app.use(express.json());
    const response = await request(app).post("/api/hosted/relay/shop/echo?x=1")
      .set("X-Forwarded-Port", "8443").set("X-Droplet-Hosted-Ingress", "8443")
      .set("Origin", "https://droplet-ai.lan:8443").set("Authorization", "Bearer dashboard-token")
      .set("Cookie", `droplet_session=private; droplet_app_shop=${token()}`)
      .set("X-Droplet-User-Id", "forged").send({ hello: "world" });
    expect(response.status).toBe(201); expect(response.text).toBe("app answer");
    expect(sent).toBe('{"hello":"world"}');
    expect(sentHeaders).toMatchObject({ Authorization: "Bearer sandbox-bearer", "X-Droplet-User-Id": "user-id", "X-Droplet-User-Name": "alice", "X-Droplet-App": "shop" });
    expect(Object.keys(sentHeaders).some((h) => h.toLowerCase() === "cookie")).toBe(false);
    expect(response.headers["set-cookie"]).toBeUndefined(); expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledWith("http://sandbox:8030/extensions/shop/http/echo?x=1", expect.objectContaining({ redirect: "manual" }));
  });
  it("refuses dashboard/direct ingress, wrong audience and foreign app POST", async () => {
    const f = fixture(); const app = express();
    app.use("/api/hosted/relay", createHostedRelayRouter(f.prisma, f.deps));
    expect((await request(app).get("/api/hosted/relay/shop/")).status).toBe(404);
    expect((await request(app).get("/api/hosted/relay/shop/").set("X-Forwarded-Port", "443").set("X-Droplet-Hosted-Ingress", "8443")).status).toBe(404);
    expect((await request(app).post("/api/hosted/relay/shop/").set("X-Forwarded-Port", "8443").set("X-Droplet-Hosted-Ingress", "8443").set("Origin", "https://evil.invalid")).status).toBe(403);
    const wrong = jwt.sign({}, hostedJwtKey(), { subject: "user-id", audience: "app:other", issuer: "droplet-hosted" });
    expect((await request(app).get("/api/hosted/relay/shop/").set("X-Forwarded-Port", "8443").set("X-Droplet-Hosted-Ingress", "8443").set("Cookie", `droplet_app_shop=${wrong}`)).status).toBe(401);
    expect(await isHostedGatewayRequest({ header: (h: string) => ({ "x-forwarded-port": "8443", "x-forwarded-proto": "https", "x-droplet-hosted-ingress": "8443" })[h], socket: { remoteAddress: "127.0.0.1" } } as unknown as Request)).toBe(false);
  });
  it("never sends internal bearer credentials outside the app HTTP namespace after URL normalization", async () => {
    for (const path of ["/%2e%2e/budget", "/../rpc", "/foo/../../rpc", "/..\\rpc", "/%2e%2e%2fbudget", "/%2f..%2frpc", "/%5c..%5crpc", "/%2e%2e%5crpc", "/ok#fragment"]) {
      const f = fixture(); const fetchImpl = vi.fn() as unknown as typeof fetch; const app = express();
      // Inject the raw upstream path a proxy could pass after one decoding.
      // HTTP clients normalize dot segments before sending a normal URL.
      app.use((req, _res, next) => { req.url = `/api/hosted/relay/shop${path}`; next(); });
      app.use("/api/hosted/relay", createHostedRelayRouter(f.prisma, { ...f.deps, fetchImpl }));
      const response = await request(app).get("/").set("X-Forwarded-Port", "8443").set("X-Droplet-Hosted-Ingress", "8443").set("Cookie", `droplet_app_shop=${token()}`);
      expect(response.status).toBe(400); expect(fetchImpl).not.toHaveBeenCalled();
    }
  });
  it("keeps arbitrary query values out of path confinement checks", async () => {
    const f = fixture(); const fetchImpl = vi.fn(async () => new Response("okay")) as unknown as typeof fetch;
    const app = express(); app.use("/api/hosted/relay", createHostedRelayRouter(f.prisma, { ...f.deps, fetchImpl }));
    const query = "next=../rpc%23fragment%5c&path=%2e%2e%2f";
    const response = await request(app).get(`/api/hosted/relay/shop/okay?${query}`).set("X-Forwarded-Port", "8443").set("X-Droplet-Hosted-Ingress", "8443").set("Cookie", `droplet_app_shop=${token()}`);
    expect(response.status).toBe(200); expect(fetchImpl).toHaveBeenCalledWith(`http://sandbox:8030/extensions/shop/http/okay?${query}`, expect.anything());
  });
  it("reserves encoded _droplet paths and exchanges secure path-scoped cookies", async () => {
    const f = fixture(); const service = createHostedService(f.prisma, f.deps);
    const code = new URL((await service.mint(req(), "shop")).url).searchParams.get("code")!;
    const app = express(); app.use("/api/hosted/relay", createHostedRelayRouter(f.prisma, f.deps));
    const exchange = await request(app).get(`/api/hosted/relay/shop/_droplet/session?code=${code}`).set("X-Forwarded-Port", "8443").set("X-Droplet-Hosted-Ingress", "8443");
    expect(exchange.status).toBe(303); expect(exchange.headers.location).toBe("/shop/");
    expect(exchange.headers["set-cookie"][0]).toMatch(/Path=\/shop\/.*HttpOnly; Secure; SameSite=Lax/);
    expect(exchange.headers["cache-control"]).toBe("no-store");
    expect((await request(app).get("/api/hosted/relay/shop/_droplet%2Funknown").set("X-Forwarded-Port", "8443").set("X-Droplet-Hosted-Ingress", "8443").set("Cookie", `droplet_app_shop=${token()}`)).status).toBe(404);
  });
  it("rejects foreign cookie writes when mounted on /api, with Bearer exemption", async () => {
    const app = express(); app.use("/api", hostedOriginGuard); app.post("/api/workspace", (_req, res) => res.status(204).end());
    expect((await request(app).post("/api/workspace").set("Origin", "https://droplet-ai.lan:8443")).status).toBe(403);
    expect((await request(app).post("/api/workspace").set("Origin", "https://droplet-ai.lan")).status).toBe(204);
    expect((await request(app).post("/api/workspace").set("Origin", "https://evil.invalid").set("Authorization", "Bearer native-token")).status).toBe(204);
    for (const malformed of ["bearer junk", "Bearer\tjunk"]) {
      expect((await request(app).post("/api/workspace").set("Origin", "https://droplet-ai.lan:8443").set("Authorization", malformed).set("Cookie", "droplet_session=ambient-dashboard-session")).status).toBe(403);
    }
  });
  it("management mint never accepts an MCP service as a dashboard user", async () => {
    const f = fixture(); const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.user = { id: "_service:mcp", role: "service", username: "service", displayName: "service" }; next(); });
    app.use("/api/hosted", createHostedManagementRouter(f.prisma, f.deps));
    expect((await request(app).post("/api/hosted/shop/session").send({})).status).toBe(403);
  });
});
