/**
 * WARP-2900 (ADR-056 slice H3) — the extension principal guard, where it is
 * actually mounted.
 *
 * extension-principal.test.ts proves the guard on a hand-built express app.
 * That leaves the one thing a merge of app.ts (a hot file) can silently undo:
 * that `createApp` mounts it at all, right after authMiddleware and before
 * every protected router. Delete the mount, or move it below the routers,
 * and a `dxt_` bearer reaches every authenticated route with no requireRole
 * of its own as a `service` principal — the WARP-2180 laundering path.
 *
 * So this suite builds the REAL app and sends a resolvable `dxt_` bearer at
 * routes mounted early, mid-way and late in app.ts.
 *
 * MUTATIONS (each red):
 *   - delete `app.use(extensionPrincipalGuard)` from app.ts;
 *   - move it below `createStorageRouter` (the mid-app route turns 2xx/5xx).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { PrismaClient } from "@prisma/client";

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, config: { ...actual.config, AUTH_ENABLED: true } };
});
vi.mock("../services/ai-gateway.client.js", () => ({
  healthCheck: vi.fn().mockResolvedValue(true),
  listModels: vi.fn().mockResolvedValue({ models: [] }),
  chat: vi.fn(),
  saveKey: vi.fn(),
  listKeys: vi.fn().mockResolvedValue([]),
  deleteKey: vi.fn(),
}));

import { createApp } from "../app.js";
import { bindExtensionPrincipalPrisma } from "../services/extension-principal.js";
import { mintExtensionToken } from "../services/extension-lifecycle.service.js";
import { extensionPrisma } from "./helpers/extension-test-kit.js";

const GUARD_BODY = { error: "Forbidden: an extension may call only its own routes" };

let app: ReturnType<typeof createApp>;
let token: string;

beforeAll(() => {
  app = createApp(new PrismaClient());
  // createApp binds its own Prisma to the bearer lookup; the extension row lives in the kit.
  const db = extensionPrisma({ users: [{ id: "u-owner", username: "romain", role: "owner" }] });
  const minted = mintExtensionToken();
  token = minted.token;
  db.extensions.set("wc", {
    id: "wc",
    workspaceId: "wc",
    name: "Word counter",
    installedByUserId: "u-owner",
    status: "live",
    operatorDomain: null,
    currentVersionId: "v-wc",
    serviceTokenHash: minted.hash,
    failureReason: null,
  });
  db.versions.set("v-wc", { id: "v-wc", extensionId: "wc", version: "0.1.0" });
  bindExtensionPrincipalPrisma(db.prisma);
});

afterAll(() => {
  bindExtensionPrincipalPrisma(null);
});

describe("createApp mounts the extension principal guard before every protected router", () => {
  // Early, mid-way and late in app.ts, all with no requireRole of their own
  // or one a `service` principal might satisfy.
  for (const [method, path] of [
    ["get", "/api/auth/me"],
    ["get", "/api/storage"],
    ["get", "/api/notifications"],
    ["get", "/api/admin/files"],
  ] as const) {
    it(`${method.toUpperCase()} ${path} is the guard's 403 for a dxt_ bearer`, async () => {
      const res = await request(app)[method](path).set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body).toEqual(GUARD_BODY);
    });
  }

  it("the bearer does resolve: its own route is not the guard's 403", async () => {
    // Otherwise every case above could be a 401 in disguise.
    const res = await request(app).get("/api/extensions/self").set("Authorization", `Bearer ${token}`);
    expect(res.status).not.toBe(401);
    expect(res.body).not.toEqual(GUARD_BODY);
  });

  it("an unknown dxt_ bearer is a 401, never the guard", async () => {
    const res = await request(app).get("/api/storage").set("Authorization", "Bearer dxt_unknown");
    expect(res.status).toBe(401);
  });
});
