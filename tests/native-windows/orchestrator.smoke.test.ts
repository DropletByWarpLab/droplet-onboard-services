/** Native C# client against real Express routes, auth middleware and JWTs over pinned TLS. */
import { describe, it, expect, vi } from "vitest";
import { spawn } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer as httpServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import { isAbsolute } from "node:path";
import type { Server } from "node:net";
import type { PrismaClient } from "@prisma/client";
import express from "express";
import cookieParser from "cookie-parser";
import forge from "node-forge";

const fixture = vi.hoisted(() => ({
  cache: new Map<string, unknown>(),
  sets: new Map<string, Set<string>>(),
  sessions: new Map<string, { userId: string; role: string; createdAt: number; lastSeenAt: number }>(),
  config: {
    AUTH_ENABLED: true, AUTH_MODE: "legacy", REQUIRE_ADMIN_TWO_STEP: false,
    JWT_SECRET: "native-smoke-only-secret-32-bytes-aaaaaaaa",
    DEVICE_SECRET_KEY: Buffer.alloc(32, 42).toString("base64"),
    SERVICE_TOKEN_VOICE: "", SERVICE_TOKEN_MCP: "", SERVICE_TOKEN_EMAIL: "",
    NEXTCLOUD_URL: "http://nextcloud.invalid", REDIS_URL: "redis://localhost:6379",
    DEVICE_BRIDGE_URL: "", AI_GATEWAY_URL: "", FILE_INDEXER_URL: "", FRIGATE_URL: "",
    DOCS_ENABLED: "", DOCS_INTERNAL_URL: "", DROPLET_MATTER_SERVICE_URL: "",
    ROUTING_SERVICE_URL: "", SWITCH_SERVICE_URL: "", ROUTING_MODE: "disabled",
    WIREGUARD_ENDPOINT_HOST: "", DROPLET_PUBLIC_FQDN: "", DROPLET_DEV_ENGINEERING_DASHBOARD: false,
    corsAllowedOrigins: [] as string[], agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

const orch = "../../apps/orchestrator/src/";
vi.mock("../../apps/orchestrator/src/config.js", () => ({ config: fixture.config }));
vi.mock("../../apps/orchestrator/src/services/cache.service.js", () => {
  const put = async (key: string, value: unknown) => { fixture.cache.set(key, value); };
  const del = async (key: string) => { fixture.cache.delete(key); fixture.sets.delete(key); };
  return {
    cacheGet: async (key: string) => fixture.cache.get(key) ?? null,
    cacheSet: put, cacheSetStrict: put, cacheDel: del, cacheDelStrict: del,
    cacheSetNx: async (key: string, value: unknown) => {
      if (fixture.cache.has(key)) return false;
      fixture.cache.set(key, value); return true;
    },
    cacheIncr: async (key: string) => {
      const value = Number(fixture.cache.get(key) ?? 0) + 1;
      fixture.cache.set(key, value); return value;
    },
    cacheSetAdd: async (key: string, value: string) => {
      const values = fixture.sets.get(key) ?? new Set<string>();
      values.add(value); fixture.sets.set(key, values);
    },
    cacheSetRemove: async (key: string, value: string) => { fixture.sets.get(key)?.delete(value); },
    cacheSetMembers: async (key: string) => [...(fixture.sets.get(key) ?? [])],
    isRedisHealthy: async () => true,
    getRedis: () => ({
      get: async (key: string) => fixture.cache.get(key) ?? null,
      set: async (key: string, value: unknown) => { await put(key, value); return "OK"; },
      del, expire: async () => 1,
    }),
  };
});
vi.mock("../../apps/orchestrator/src/services/session.service.js", () => ({
  createSession: async (user: { id: string; role: string }) => {
    const sid = `native-smoke-session-${fixture.sessions.size + 1}`;
    const now = Math.floor(Date.now() / 1000);
    fixture.sessions.set(sid, { userId: user.id, role: user.role, createdAt: now, lastSeenAt: now });
    return { sid, evictedSids: [] };
  },
  checkSession: async (sid: string) => {
    const record = fixture.sessions.get(sid);
    return record ? { kind: "ok", record } : { kind: "missing" };
  },
  readSessionDeadline: async (sid: string) => {
    const record = fixture.sessions.get(sid);
    return record ? { endsAt: new Date((record.createdAt + 43_200) * 1000) } : null;
  },
  deleteSession: async (sid: string) => { fixture.sessions.delete(sid); },
  revokeAllSessions: async () => 0,
}));
vi.mock("../../apps/orchestrator/src/services/password.service.js", () => ({
  hashPassword: async () => "$argon2id$native-smoke",
  verifyPassword: async (_hash: string, password: string) => password === "hunter22hunter22",
  verifyDummyPassword: async () => false,
}));
vi.mock("../../apps/orchestrator/src/services/nextcloud.client.js", async (original) => ({
  ...await original<typeof import("../../apps/orchestrator/src/services/nextcloud.client.js")>(),
  ncLoginWithCredentials: async () => ({ token: "native-smoke-nc-token", loginName: "alice" }),
  ncGenerateAppPassword: async () => "native-smoke-app-password",
  ncDeleteAppPassword: async () => undefined,
  ncGetUserQuota: async () => ({ total: 1000, used: 250, free: 750 }),
  ncDownloadFile: async () => {
    const { Readable } = await import("node:stream");
    return Readable.toWeb(Readable.from([Buffer.from("native smoke download")]));
  },
  ncPing: async () => true,
}));
vi.mock("../../apps/orchestrator/src/services/activity.singleton.js", () => ({ recordActivity: async () => undefined }));
vi.mock("../../apps/orchestrator/src/services/active-model.service.js", () => ({ warmActiveModel: async () => undefined }));
vi.mock("../../apps/orchestrator/src/services/ai-gateway.client.js", async (original) => ({
  ...await original<typeof import("../../apps/orchestrator/src/services/ai-gateway.client.js")>(), healthCheck: async () => true,
}));
vi.mock("../../apps/orchestrator/src/services/openwrt.client.js", async (original) => ({
  ...await original<typeof import("../../apps/orchestrator/src/services/openwrt.client.js")>(), healthCheck: async () => true,
}));
vi.mock("../../apps/orchestrator/src/services/display.client.js", async (original) => ({
  ...await original<typeof import("../../apps/orchestrator/src/services/display.client.js")>(), healthCheck: async () => true,
}));
vi.mock("../../apps/orchestrator/src/services/file-indexer.client.js", async (original) => ({
  ...await original<typeof import("../../apps/orchestrator/src/services/file-indexer.client.js")>(), healthCheck: async () => true,
}));
vi.mock("../../apps/orchestrator/src/services/mqtt-status.js", () => ({ mqttHealth: async () => true }));
vi.mock("../../apps/orchestrator/src/services/device-client-revoke.service.js", async (original) => ({
  ...await original<typeof import("../../apps/orchestrator/src/services/device-client-revoke.service.js")>(), safePublish: () => undefined,
}));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const DEPARTMENT_ID = "22222222-2222-4222-8222-222222222222";
const DEVICE_ID = "33333333-3333-4333-8333-333333333333";
const PAIR_CODE = "ABC234";

function database() {
  const now = new Date();
  const user = {
    id: USER_ID, username: "alice", displayName: "Alice", email: "alice@warp.test", emailLookupHash: null,
    nextcloudUsername: "alice", passwordHash: "$argon2id$native-smoke", role: "owner",
    isLocal: true, provisionSource: "LOCAL", directoryStatus: "ACTIVE", mustChangePassword: false,
    accessRoleId: null, accessRole: null, createdAt: now, updatedAt: now,
  };
  const profile = {
    departmentId: DEPARTMENT_ID, template: "operations", icon: "shield-check",
    navHrefs: ["/cameras", "/events", "/network"], homeWidgets: [{ widget: "cameras", size: "m" }],
    updatedBy: USER_ID, createdAt: now, updatedAt: now,
  };
  const department = {
    id: DEPARTMENT_ID, name: "Operations", slug: "operations", kind: "DEPARTMENT", state: "active",
    parentId: null, description: "Smoke-test department", ncGroupfolderId: null,
    quotaBytes: null, aclVersion: 1, createdAt: now, updatedAt: now, archivedAt: null,
    provisionError: null, profile, _count: { memberships: 0, teams: 0 },
  };
  let choice: { scope: string; departmentId: string | null } | null = null;
  const pair = { id: "smoke-pair", code: PAIR_CODE, userId: "alice", status: "active", expiresAt: new Date(Date.now() + 600_000), claimedBy: null as string | null };
  const clients: Record<string, unknown>[] = [];
  const prisma = {
    user: {
      findUnique: async ({ where }: { where: Record<string, unknown> }) => where.id === USER_ID ? user : null,
      findFirst: async ({ where }: { where: Record<string, unknown> }) => where.email === user.email ? user : null,
      update: async () => user,
    },
    totpCredential: { findUnique: async () => null }, recoveryCode: { findMany: async () => [] },
    webAuthnCredential: { count: async () => 0 },
    activityRow: { findMany: async () => [{ at: now, severity: "ok", sourceIcon: "file", what: "Smoke test ready", sub: null, kind: "file" }] },
    chatSession: { findMany: async () => [] }, brainMemoryItem: { count: async () => 5 },
    camera: { count: async () => 2 }, networkDevice: { count: async () => 3 },
    moduleSetting: { findMany: async () => [] }, workspace: { findUnique: async () => ({ id: 1, businessType: "custom" }) },
    userAccessException: { findMany: async () => [] }, offLanAllowlistChannel: { findUnique: async () => null },
    integrationConnection: { findMany: async () => [] }, userUsagePolicy: { findUnique: async () => null },
    departmentMembership: { findUnique: async () => null, findMany: async () => [] },
    department: {
      findUnique: async ({ where }: { where: { id: string } }) => where.id === DEPARTMENT_ID ? department : null,
      findMany: async () => [department],
    },
    departmentProfile: { findUnique: async () => profile },
    activeDepartmentChoice: {
      findUnique: async () => choice,
      upsert: async ({ create, update }: { create: typeof choice; update: typeof choice }) => { choice = choice ? update : create; return choice; },
    },
    pairingCode: {
      findUnique: async ({ where }: { where: { code: string } }) => where.code === PAIR_CODE ? pair : null,
      updateMany: async () => { if (pair.status !== "active") return { count: 0 }; pair.status = "claimed"; return { count: 1 }; },
      update: async ({ data }: { data: { claimedBy: string } }) => { pair.claimedBy = data.claimedBy; return pair; },
    },
    deviceClient: {
      count: async () => clients.length,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const client = { id: DEVICE_ID, ...data, lastSeen: now, createdAt: now }; clients.push(client); return client;
      },
      findMany: async () => clients,
    },
    $queryRaw: async () => { throw new Error("Synthetic postgres outage for public health 503"); },
    $transaction: undefined as unknown,
  };
  return { prisma, pair, clients };
}

function certificate() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey; cert.serialNumber = "01";
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 3_600_000);
  const attrs = [{ name: "commonName", value: "localhost" }];
  cert.setSubject(attrs); cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
    { name: "extKeyUsage", serverAuth: true },
    { name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }, { type: 7, ip: "127.0.0.1" }] },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const pem = forge.pki.certificateToPem(cert);
  const der = new X509Certificate(pem).publicKey.export({ type: "spki", format: "der" });
  return { cert: pem, key: forge.pki.privateKeyToPem(keys.privateKey), pin: createHash("sha256").update(der).digest("base64") };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return (server.address() as { port: number }).port;
}

async function close(server: Server & { closeAllConnections?: () => void }): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function runClient(dotnet: string, dll: string, baseUrl: string, pin: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(dotnet, [dll], {
      windowsHide: true,
      env: { ...process.env, DROPLET_SMOKE_BASE_URL: baseUrl, DROPLET_SMOKE_SPKI_PIN: pin, DROPLET_SMOKE_PAIR_CODE: PAIR_CODE },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 45_000);
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error("Native Windows smoke client timed out after 45 seconds"));
      else resolve({ code, output });
    });
  });
}

describe("native Windows → orchestrator over pinned HTTPS (opt-in)", () => {
  it("signs in, rotates, loads Home and gates, chooses a department and claims its device", async () => {
    const dll = process.env.DROPLET_WINDOWS_SMOKE_DLL;
    if (!dll || !isAbsolute(dll) || !existsSync(dll)) {
      throw new Error("Set DROPLET_WINDOWS_SMOKE_DLL to the absolute built tests/Droplet.OrchestratorSmoke/Droplet.OrchestratorSmoke.dll path; see tests/native-windows/README.md");
    }
    const bridge = httpServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/pools") return void res.end(JSON.stringify({ pools: [] }));
      if (req.url === "/drives") return void res.end(JSON.stringify({
        os_disk: "sda", drives: [{ device: "sdb1", parent_disk: "sdb", mount: "/mnt/smoke", uuid: "smoke", label: "Data", size_bytes: 1000, used_bytes: 250, free_bytes: 750, mounted: true }],
      }));
      res.statusCode = 404; res.end("{}");
    });
    fixture.config.DEVICE_BRIDGE_URL = `http://127.0.0.1:${await listen(bridge)}`;
    let server: ReturnType<typeof httpsServer> | undefined;
    let stopMonitor: (() => void) | undefined;
    let resetAccess: (() => void) | undefined;
    try {
      const [auth, home, health, modules, capabilities, admin, departments, choice, storage, devices, access, moduleGate, mounts, monitor, tx, files] = await Promise.all([
        import(`${orch}routes/auth.js`), import(`${orch}routes/home.js`), import(`${orch}routes/health.js`),
        import(`${orch}routes/modules.routes.js`), import(`${orch}routes/capabilities.js`), import(`${orch}routes/admin-capabilities.js`),
        import(`${orch}routes/departments.js`), import(`${orch}routes/me-department.js`), import(`${orch}routes/storage.js`),
        import(`${orch}routes/device-clients.js`), import(`${orch}services/effective-access.service.js`),
        import(`${orch}middleware/module-gate.js`), import(`${orch}modules/module-mounts.js`),
        import(`${orch}services/health-monitor.service.js`), import(`${orch}__tests__/helpers/prisma-tx-harness.js`),
        import(`${orch}routes/files.js`),
      ]);
      const middleware = await import(`${orch}middleware/auth.js`);
      const { requireAdminMfaEnrollmentGate } = await import(`${orch}middleware/admin-mfa-enrollment-gate.js`);
      const { verifyAccessToken } = await import(`${orch}services/jwt.service.js`);
      const db = database();
      db.prisma.$transaction = tx.createTransactionSeam({ client: () => db.prisma }).$transaction;
      const prisma = db.prisma as unknown as PrismaClient;
      access._setEffectiveAccessForTests(prisma, fixture.config);
      stopMonitor = monitor.stopHealthMonitor;
      resetAccess = () => access._setEffectiveAccessForTests(null, null);
      const traffic: Array<{ method: string; path: string; cookie: boolean; browser: boolean; bearer: boolean; valid: boolean; cookiesSet: boolean; status: number }> = [];
      await monitor.runAllProbes(prisma);
      const app = express();
      app.use(express.json()); app.use(cookieParser());
      app.use((req, res, next) => {
        const token = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : null;
        const entry = { method: req.method, path: req.path, cookie: !!req.headers.cookie,
          browser: Object.keys(req.headers).some((name) => name.startsWith("sec-fetch-") || name === "origin" || name === "referer" || name === "x-forwarded-host"),
          bearer: token !== null, valid: token !== null && verifyAccessToken(token) !== null, cookiesSet: false, status: 0 };
        traffic.push(entry);
        res.on("finish", () => { entry.cookiesSet = res.hasHeader("set-cookie"); entry.status = res.statusCode; }); next();
      });
      app.use("/api", auth.createPublicAuthRouter(prisma));
      app.use(middleware.authMiddleware);
      app.use(middleware.requirePasswordChangeGate(prisma));
      app.use(requireAdminMfaEnrollmentGate(prisma));
      app.use("/api", auth.createProtectedAuthRouter(prisma));
      const gate = moduleGate.createModuleGate(prisma, fixture.config);
      mounts.mountModuleGates(app, gate);
      app.use("/api", home.createHomeRouter(prisma));
      app.use("/api", health.createHealthRouter(prisma));
      app.use("/api", modules.createModulesRouter(prisma, fixture.config, gate));
      app.use("/api", capabilities.createCapabilitiesRouter(prisma, fixture.config));
      app.use("/api", admin.createAdminCapabilitiesRouter());
      app.use("/api", departments.createDepartmentsRouter(prisma));
      app.use("/api", choice.createMeDepartmentRouter(prisma));
      app.use("/api", storage.createStorageRouter(prisma));
      app.use("/api", devices.createDeviceClientsRouter(prisma));
      app.use("/api", files.createFilesRouter(prisma));
      app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        // Synthetic fixture failures are named, while response payloads are still emitted by real routes.
        res.status(500).json({ error: error instanceof Error ? error.message : "Smoke fixture failure" });
      });
      const tls = certificate();
      server = httpsServer(tls, app);
      const baseUrl = `https://localhost:${await listen(server)}/`;
      fixture.config.corsAllowedOrigins = [baseUrl.slice(0, -1)];
      const result = await runClient(process.env.DOTNET_EXE || "dotnet", dll, baseUrl, tls.pin);
      expect(result.code, result.output).toBe(0);
      expect(result.output).toContain("NATIVE_ORCHESTRATOR_SMOKE_OK");
      expect(traffic.length).toBeGreaterThan(10);
      for (const request of traffic) {
        expect(request.cookie, `${request.method} ${request.path}: cookie sent`).toBe(false);
        expect(request.browser, `${request.method} ${request.path}: browser marker sent`).toBe(false);
        if (["/api/auth/login", "/api/auth/refresh", "/api/orchestrator/health"].includes(request.path)) {
          expect(request.bearer, `${request.path}: must be anonymous`).toBe(false);
        } else if (request.path === "/api/home" && !request.bearer) {
          expect(request.status, "Anonymous Home must be rejected by real authMiddleware").toBe(401);
        } else if (request.path === "/api/auth/me" && request.bearer && !request.valid) {
          expect(request.status, "The deliberately tampered JWT must be rejected by real authMiddleware").toBe(401);
        } else {
          expect(request.valid, `${request.method} ${request.path}: real JWT required`).toBe(true);
        }
        if (["/api/auth/login", "/api/auth/refresh"].includes(request.path)) expect(request.cookiesSet).toBe(false);
      }
      expect(traffic.filter((request) => request.path === "/api/auth/refresh" && request.status === 200)).toHaveLength(1);
      expect(traffic.filter((request) => request.path === "/api/auth/me" && request.bearer && !request.valid && request.status === 401)).toHaveLength(1);
      expect(traffic.some((request) => request.path === "/api/auth/me" && request.valid && request.status === 200)).toBe(true);
      expect(traffic.some((request) => request.path === "/api/orchestrator/health" && request.status === 503)).toBe(true);
      expect(db.pair.status).toBe("claimed");
      expect(db.clients).toHaveLength(1);
      expect(fixture.sessions.size, "refresh must continue the original session").toBe(1);
      expect([...fixture.sets.values()].some((set) => set.size === 1), "one current refresh token must remain indexed").toBe(true);
      expect([...fixture.cache.keys()].some((key) => key.startsWith("jwt:deny:")), "real rotation must denylist the old refresh token").toBe(true);
      console.log("NATIVE_ORCHESTRATOR_SMOKE_OK — real routes, JWT rotation and pinned HTTPS verified");
    } finally {
      if (server?.listening) await close(server);
      if (bridge.listening) await close(bridge);
      stopMonitor?.(); resetAccess?.();
    }
  });
});
