import { beforeEach, describe, expect, it, vi } from "vitest";
import { extensionPrisma, fakeSandbox, fakeSidecar, signedVersionRow } from "../__tests__/helpers/extension-test-kit.js";
import { createExtensionLifecycle, installedExtensionIds, preflightExtension } from "./extension-lifecycle.service.js";
import { decryptColumn, deriveHostedAppRelayKey } from "./column-crypto.service.js";
import { parseExtensionManifest } from "./extension-manifest.js";

vi.mock("../config.js", () => ({ config: { SANDBOX_URL: "http://sandbox:8030", SANDBOX_SERVICE_TOKEN: "t", DEVICE_SECRET_KEY: Buffer.alloc(32, 8).toString("base64") } }));
vi.mock("./activity.singleton.js", () => ({ recordActivity: vi.fn(async () => null) }));

const owner = { type: "user" as const, id: "u-owner" };
const appManifest = (runtime: "static" | "node20" = "static") => Buffer.from(JSON.stringify({
  schemaVersion: 1, id: "shop", name: "Shop", version: "0.1.0", kind: "app", runtime,
  ...(runtime === "node20" ? { entrypoint: "server.js" } : {}),
  http: { health: "/", ...(runtime === "static" ? { dir: "." } : {}) },
  provides: { tools: [], routineDrafts: [], proposedGrants: [] }, resources: { memoryMb: 64, processes: 1 }, egress: "none",
}));

function kit(runtime: "static" | "node20" = "static") {
  const db = extensionPrisma({ workspaces: [{ id: "shop" }], users: [{ id: owner.id, username: "owner", role: "owner" }] }); const identity = fakeSidecar(); const sandbox = fakeSandbox({ availableMb: 0 });
  const bytes = appManifest(runtime); const signed = signedVersionRow(identity, { slug: "shop", version: "0.1.0", manifest: bytes });
  db.versions.set(String(signed.id), signed);
  db.extensions.set("shop", { id: "shop", workspaceId: "shop", kind: "app", name: "Shop", status: "signed", currentVersionId: signed.id, serviceTokenHash: null });
  let sequence = 0;
  const original = vi.mocked(sandbox.client.install).getMockImplementation()!;
  vi.mocked(sandbox.client.install).mockImplementation(async (slug, body) => {
    const status = await original(slug, body);
    const app = { ...status, kind: "app" as const, relayKey: `key-${++sequence}-${"k".repeat(40)}`, ...(runtime === "static" ? { process: null, memoryMb: 0, port: 0 } : {}) };
    sandbox.installed.set(slug, app); return app;
  });
  const attach = { attach: vi.fn(async () => {}), detach: vi.fn(async () => {}), isAttached: vi.fn(() => false) };
  const lifecycle = createExtensionLifecycle({ prisma: db.prisma, identity, sandbox: sandbox.client, attach, audit: vi.fn(async () => null), orchestratorUrl: "http://orchestrator:3000" });
  return { db, sandbox, identity, attach, lifecycle, bytes };
}

describe("hosted application lifecycle", () => {
  beforeEach(() => installedExtensionIds.clear());
  it("preflights a static app with zero RAM left", () => {
    const parsed = parseExtensionManifest(appManifest()); if (!parsed.ok) throw new Error(parsed.detail);
    expect(preflightExtension({ slug: "shop", manifest: parsed.manifest, budget: { ceilingMb: 512, source: "env", transformHeadroomMb: 256, installedMb: 256, availableMb: 0 }, currentMemoryMb: 0, otherExtensionTools: new Map(), catalogToolNames: [], runtimeToolNames: [] }).ok).toBe(true);
  });
  it("starts an app with no callback bearer or MCP attach and seals its relay key", async () => {
    const k = kit(); const row = await k.lifecycle.install("shop", owner);
    expect(row.status).toBe("live"); expect(k.attach.attach).not.toHaveBeenCalled(); expect(installedExtensionIds.size).toBe(0);
    expect(k.sandbox.installs[0].req).toMatchObject({ kind: "app", runtime: "static", http: { health: "/", dir: "." } });
    expect(k.sandbox.installs[0].req).not.toHaveProperty("token"); expect(k.sandbox.installs[0].req).not.toHaveProperty("orchestratorUrl");
    const stored = k.db.extensions.get("shop")!;
    expect(stored.serviceTokenHash).toBeNull(); expect(stored.appRelayKeyEnc).not.toContain("key-1");
    expect(decryptColumn(deriveHostedAppRelayKey(), String(stored.appRelayKeyEnc), "hosted-app:shop")).toBe(k.sandbox.installed.get("shop")?.relayKey);
    const restartedOrchestrator = createExtensionLifecycle({ prisma: k.db.prisma, identity: k.identity, sandbox: k.sandbox.client, attach: k.attach, audit: vi.fn(async () => null) });
    expect((await restartedOrchestrator.reconcile()).restarted).toEqual([]);
    expect(k.sandbox.installs).toHaveLength(1); expect(k.attach.attach).not.toHaveBeenCalled();
  });
  it("recovers an unreadable sealed key through re-verification and fresh install", async () => {
    const k = kit(); await k.lifecycle.install("shop", owner);
    k.db.extensions.get("shop")!.appRelayKeyEnc = "corrupt-ciphertext";
    expect((await k.lifecycle.reconcile()).restarted).toEqual(["shop"]);
    expect(k.sandbox.installs).toHaveLength(2); expect(k.attach.attach).not.toHaveBeenCalled(); expect(k.attach.detach).not.toHaveBeenCalled();
    const sealed = String(k.db.extensions.get("shop")!.appRelayKeyEnc);
    expect(decryptColumn(deriveHostedAppRelayKey(), sealed, "hosted-app:shop")).toBe(k.sandbox.installed.get("shop")?.relayKey);
  });
  it("refuses an unverified app before contacting the sandbox", async () => {
    const k = kit(); k.db.versions.get("v-shop-0.1.0")!.manifestBytes = Buffer.from("tampered");
    await expect(k.lifecycle.install("shop", owner)).rejects.toMatchObject({ code: "verify_failed" });
    expect(k.sandbox.installs).toHaveLength(0); expect(k.db.extensions.get("shop")!.status).toBe("failed");
  });
  it("revokes access before stop and supports separately confirmed retained-data removal", async () => {
    const k = kit(); await k.lifecycle.install("shop", owner);
    await k.lifecycle.disable("shop", owner);
    expect(k.db.extensions.get("shop")).toMatchObject({ status: "disabled", serviceTokenHash: null, appRelayKeyEnc: null });
    await k.lifecycle.uninstall("shop", owner);
    expect(k.sandbox.client.uninstall).toHaveBeenLastCalledWith("shop", false);
    await k.lifecycle.uninstall("shop", owner, true);
    expect(k.sandbox.client.uninstall).toHaveBeenLastCalledWith("shop", true);
  });
});
