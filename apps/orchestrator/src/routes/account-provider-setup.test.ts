import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
vi.mock("../config.js", () => ({ config: { AUTH_ENABLED: false, agentMaxIter: { defaultIter: 5, capIter: 10 }, corsAllowedOrigins: ["https://droplet-ai.local"] } }));
vi.mock("../lib/trusted-origin.js", () => ({ trustedOriginUrl: (_req: unknown, path: string) => Promise.resolve(`https://device.warp-lab.ai${path}`) }));
vi.mock("../services/activity.singleton.js", () => ({ recordActivity: vi.fn() }));
vi.mock("../middleware/rate-limit.js", () => ({ sensitiveRateLimit: (_req: unknown, _res: unknown, next: () => void) => next() }));
import { createAccountProviderSetupRouter } from "./account-provider-setup.js";
import { __setColumnCryptoKeyForTest, decryptColumn, deriveAccountProviderSetupKey } from "../services/column-crypto.service.js";
import { getGoogleApp, validateGoogleRedirectUri } from "../services/account-provider-setup.service.js";
import { recordActivity } from "../services/activity.singleton.js";

function fakeDb() {
  const rows = new Map<string, Record<string, any>>();
  const table = {
    findUnique: vi.fn(async ({ where }: any) => rows.get(where.provider) ?? null),
    deleteMany: vi.fn(async ({ where }: any) => ({ count: rows.delete(where.provider) ? 1 : 0 })),
    upsert: vi.fn(async ({ where, create, update }: any) => {
      const row = rows.has(where.provider) ? { ...rows.get(where.provider), ...update } : { ...create };
      rows.set(where.provider, row);
      return row;
    }),
  };
  const db = { cloudOAuthApp: table, $transaction: async (fn: (tx: any) => Promise<void>) => fn({ cloudOAuthApp: table }) };
  return { db, rows };
}
function app(db: any, role = "owner") {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => { req.user = { id: "owner-1", username: "owner", role } as any; next(); });
  server.use("/api", createAccountProviderSetupRouter(db));
  return server;
}
beforeEach(() => __setColumnCryptoKeyForTest(Buffer.alloc(32, 7).toString("base64")));
afterEach(() => __setColumnCryptoKeyForTest(null));

describe("one-time provider setup", () => {
  it("reports the committed setup correctly when the audit recorder is unavailable", async () => {
    const { db } = fakeDb();
    vi.mocked(recordActivity).mockRejectedValueOnce(new Error("recorder unavailable"));
    const result = await request(app(db)).put("/api/account-connections/setup").send({ google: { clientId: "one", clientSecret: "secret" } });
    expect(result.status).toBe(200);
    expect((await getGoogleApp(db as never))?.clientId).toBe("one");
  });
  it("encrypts a write-only secret and returns only setup facts", async () => {
    const { db, rows } = fakeDb();
    const server = app(db);
    const saved = await request(server).put("/api/account-connections/setup").send({ google: { clientId: "our-google-client", clientSecret: "secret-value" } });
    expect(saved.status).toBe(200);
    const enc = rows.get("GOOGLE")!.clientSecretEnc;
    expect(enc).toMatch(/^dcv1:/);
    expect(enc).not.toContain("secret-value");
    expect(() => decryptColumn(deriveAccountProviderSetupKey(), enc, "account-provider-setup:MICROSOFT")).toThrow();
    const read = await request(server).get("/api/account-connections/setup");
    expect(read.body.google).toEqual({ clientId: "our-google-client", hasClientSecret: true, configured: true, callbackSupported: true, redirectUri: "https://device.warp-lab.ai/api/google/callback" });
    expect(JSON.stringify(read.body)).not.toContain("secret-value");
    expect(JSON.stringify(read.body)).not.toContain(enc);
    expect(read.headers["cache-control"]).toBe("no-store");
  });
  it("retains an omitted secret for the same client, clears it explicitly, and never carries it into a changed client", async () => {
    const { db } = fakeDb();
    const server = app(db);
    const put = (google: Record<string, string>) => request(server).put("/api/account-connections/setup").send({ google });
    await put({ clientId: "one", clientSecret: "one-secret" });
    await put({ clientId: "one" });
    expect((await getGoogleApp(db as never))?.clientSecret).toBe("one-secret");
    await put({ clientId: "two" });
    expect(await getGoogleApp(db as never)).toBeUndefined();
    await put({ clientId: "two", clientSecret: "two-secret" });
    await put({ clientId: "two", clientSecret: "" });
    expect(await getGoogleApp(db as never)).toBeUndefined();
  });
  it("refuses normal users and unknown fields without writing credentials", async () => {
    const { db } = fakeDb();
    expect((await request(app(db, "family")).get("/api/account-connections/setup")).status).toBe(403);
    expect((await request(app(db, "family")).put("/api/account-connections/setup").send({ google: { clientId: "a", clientSecret: "b" } })).status).toBe(403);
    expect((await request(app(db)).put("/api/account-connections/setup").send({ google: { clientId: "a", password: "smuggled" } })).status).toBe(400);
    expect(db.cloudOAuthApp.upsert).not.toHaveBeenCalled();
  });
  it("requires the customer's own valid Microsoft app and never a fleet authority", async () => {
    const { db } = fakeDb();
    const result = await request(app(db)).put("/api/account-connections/setup").send({ microsoft: { clientId: "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0", tenantId: "common" } });
    expect(result.status).toBe(400);
    expect(db.cloudOAuthApp.upsert).not.toHaveBeenCalled();
  });
  it("requires setup again after credential encryption is lost", async () => {
    const { db } = fakeDb();
    await request(app(db)).put("/api/account-connections/setup").send({ google: { clientId: "one", clientSecret: "secret" } });
    __setColumnCryptoKeyForTest(Buffer.alloc(32, 8).toString("base64"));
    expect(await getGoogleApp(db as never)).toBeUndefined();
  });
});
describe("Google callback prerequisites", () => {
  it.each(["http://device.warp-lab.ai/api/google/callback", "https://droplet.local/api/google/callback", "https://192.168.1.10/api/google/callback", "https://[::1]/api/google/callback", "https://droplet/api/google/callback", "https://user:password@device.warp-lab.ai/api/google/callback", "https://device.warp-lab.ai/api/google/callback#fragment"])("refuses %s", (uri) => expect(validateGoogleRedirectUri(uri)).toBe(false));
  it("accepts the appliance's provisioned HTTPS domain", () => expect(validateGoogleRedirectUri("https://d-abcd.devices.warp-lab.ai/api/google/callback")).toBe(true));
});
