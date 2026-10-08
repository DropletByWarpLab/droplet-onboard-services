import express, { type Request } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createExtensionsRouter } from "../routes/extensions.js";
import { extensionPrisma, fakeSandbox, fakeSidecar } from "../__tests__/helpers/extension-test-kit.js";
import type { AuthUser } from "../middleware/auth.js";
import { deriveHostedAppRelayKey, decryptColumn } from "./column-crypto.service.js";

vi.mock("../config.js", () => ({ config: { AUTH_ENABLED: true, SANDBOX_URL: "http://sandbox:8030", SANDBOX_SERVICE_TOKEN: "t", SANDBOX_PROCESS_SUPERVISION: true, DEVICE_SECRET_KEY: Buffer.alloc(32, 8).toString("base64") } }));
vi.mock("./activity.singleton.js", () => ({ recordActivity: vi.fn(async () => null) }));

const owner: AuthUser = { id: "owner-id", username: "owner", displayName: "Owner", role: "owner" };
const admin: AuthUser = { id: "admin-id", username: "admin", displayName: "Admin", role: "admin" };
const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, id: "shop", name: "Shop", version: "0.1.0", kind: "app", runtime: "static", http: { health: "/", dir: "." }, provides: { tools: [], routineDrafts: [], proposedGrants: [{ role: "family", domain: "app:shop", level: "use" }] }, resources: { memoryMb: 64, processes: 1 }, egress: "none" }));
function kit() {
  const db = extensionPrisma({ workspaces: [{ id: "shop", userId: owner.id }], users: [owner, admin] });
  let roles: { extensionId: string; role: string }[] = [];
  Object.assign(db.raw, { hostedAppGrant: {
    deleteMany: vi.fn(async () => { roles = []; return { count: 1 }; }),
    createMany: vi.fn(async ({ data }: { data: typeof roles }) => { roles = data; return { count: data.length }; }),
    findMany: vi.fn(async () => roles),
  } });
  const sandbox = fakeSandbox({ proposals: { shop: manifest }, availableMb: 0 });
  const original = vi.mocked(sandbox.client.install).getMockImplementation()!;
  vi.mocked(sandbox.client.install).mockImplementation(async (slug, body) => {
    const state = { ...await original(slug, body), process: null, relayKey: "k".repeat(43), memoryMb: 0, port: 0 };
    sandbox.installed.set(slug, state); return state;
  });
  const identity = fakeSidecar(); let user = owner;
  const app = express(); app.use(express.json()); app.use((req: Request, _res, next) => { req.user = user; next(); });
  app.use("/api", createExtensionsRouter(db.prisma, { sandbox: sandbox.client, identity }));
  return { app, db, sandbox, identity, roles: () => roles, as: (person: AuthUser) => { user = person; } };
}
async function promote(k: ReturnType<typeof kit>, hostedAppRoles: string[] = []) {
  const readback = await request(k.app).post("/api/extensions/shop/promote").send({ currentPassword: "step-up-input" });
  expect(readback.status).toBe(202); expect(readback.body.preflight.ok).toBe(true);
  return request(k.app).post("/api/extensions/shop/promote").send({ confirmationToken: readback.body.confirmationToken, manifestSha256: readback.body.manifestSha256, hostedAppRoles, currentPassword: "step-up-input" });
}

describe("owner hosted app promotion and saved data contracts", () => {
  it("signs a zero-process static app and stores only explicitly confirmed family grants", async () => {
    const k = kit(); const result = await promote(k, ["family"]);
    expect(result.status).toBe(201); expect(result.body.extension.status).toBe("live"); expect(result.body.extension).not.toHaveProperty("appRelayKeyEnc");
    expect(k.roles()).toEqual([{ extensionId: "shop", role: "family" }]);
    expect(k.sandbox.installs[0].req).not.toHaveProperty("token");
    expect(decryptColumn(deriveHostedAppRelayKey(), String(k.db.extensions.get("shop")!.appRelayKeyEnc), "hosted-app:shop")).toBe("k".repeat(43));
    const noGrants = kit(); expect((await promote(noGrants)).status).toBe(201); expect(noGrants.roles()).toEqual([]);
  });
  it("rejects guest grants before signing or installing", async () => {
    const k = kit(); const result = await promote(k, ["guest"]);
    expect(result.status).toBe(400); expect(k.identity.signExtensionManifest).not.toHaveBeenCalled(); expect(k.sandbox.installs).toHaveLength(0);
  });
  it("permits current-owner grant writes and owner/admin reads", async () => {
    const k = kit(); await promote(k);
    expect((await request(k.app).put("/api/extensions/shop/grants").send({ roles: ["family"], currentPassword: "step-up-input" })).body).toEqual({ roles: ["family"] });
    k.as(admin); expect((await request(k.app).get("/api/extensions/shop/grants")).body).toEqual({ roles: ["family"] });
    expect((await request(k.app).put("/api/extensions/shop/grants").send({ roles: [] })).status).toBe(403);
    k.as(owner); k.db.users.get(owner.id)!.role = "admin";
    expect((await request(k.app).put("/api/extensions/shop/grants").send({ roles: [] })).status).toBe(403);
    k.db.users.get(owner.id)!.role = "family";
    expect((await request(k.app).get("/api/extensions/shop/grants")).status).toBe(403);
  });
  it("requires typed slug confirmation and can remove retained data after uninstall", async () => {
    const k = kit(); await promote(k);
    expect((await request(k.app).delete("/api/extensions/shop").send({ deleteData: true, confirmSlug: "wrong" })).status).toBe(400);
    expect((await request(k.app).delete("/api/extensions/shop").send({})).status).toBe(200);
    expect(k.sandbox.client.uninstall).toHaveBeenLastCalledWith("shop", false);
    expect((await request(k.app).delete("/api/extensions/shop").send({ deleteData: true, confirmSlug: "shop", currentPassword: "step-up-input" })).status).toBe(200);
    expect(k.sandbox.client.uninstall).toHaveBeenLastCalledWith("shop", true);
  });
  it("refuses demoted owners on both promotion phases and every app lifecycle mutation", async () => {
    const first = kit(); first.db.users.get(owner.id)!.role = "family";
    expect((await request(first.app).post("/api/extensions/shop/promote").send({})).status).toBe(403);
    const second = kit(); const readback = await request(second.app).post("/api/extensions/shop/promote").send({});
    second.db.users.get(owner.id)!.directoryStatus = "DEACTIVATED";
    expect((await request(second.app).post("/api/extensions/shop/promote").send({ confirmationToken: readback.body.confirmationToken, manifestSha256: readback.body.manifestSha256 })).status).toBe(403);
    expect(second.identity.signExtensionManifest).not.toHaveBeenCalled();
    const k = kit(); await promote(k); k.db.users.get(owner.id)!.role = "family";
    for (const action of ["disable", "enable"]) expect((await request(k.app).post(`/api/extensions/shop/${action}`).send({})).status).toBe(403);
    expect((await request(k.app).delete("/api/extensions/shop").send({})).status).toBe(403);
    expect((await request(k.app).delete("/api/extensions/shop").send({ deleteData: true, confirmSlug: "shop" })).status).toBe(403);
    expect(k.db.extensions.get("shop")!.status).toBe("live"); expect(k.sandbox.client.stop).not.toHaveBeenCalled(); expect(k.sandbox.client.uninstall).not.toHaveBeenCalled();
  });
});
