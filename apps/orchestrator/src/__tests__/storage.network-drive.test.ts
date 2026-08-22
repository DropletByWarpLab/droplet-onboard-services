/**
 * GET /api/storage/network-drive — connection info for the SMB "Droplet"
 * share (the compose `samba` service that puts the Droplet folder in
 * Windows Explorer / macOS Finder).
 *
 * The route is config-driven (SMB_ENABLED / SMB_PASSWORD / the two hostname
 * keys), and config.js snapshots process.env at import — so each case
 * resets the module registry and re-imports the router under the env it
 * wants. Same mock surface as storage.test.ts: Nextcloud session/quota and
 * the activity singleton are stubbed; no bridge or Prisma calls are made by
 * this route.
 */
import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../services/nextcloud-session.service.js", () => ({
  resolveNcToken: vi.fn(async () => null),
}));
vi.mock("../services/nextcloud.client.js", () => ({
  ncGetUserQuota: vi.fn(),
}));

// requireRole denials emit the WARP-237 policy-violation activity row —
// stub the singleton so the 403 path never touches a real recorder.
const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));

const SMB_ENV_KEYS = [
  "SMB_ENABLED",
  "SMB_PASSWORD",
  "DROPLET_MDNS_HOSTNAME",
  "DROPLET_LAN_HOSTNAME",
] as const;

async function buildApp(env: Record<string, string>, role = "owner") {
  vi.resetModules();
  for (const key of SMB_ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);
  const { createStorageRouter } = await import("../routes/storage.js");
  const app = express();
  app.use(express.json());
  // Stand-in for authMiddleware — the route only reads req.user.role.
  app.use((req, _res, next) => {
    (
      req as unknown as {
        user: { id: string; username: string; displayName: string; role: string };
      }
    ).user = { id: "u1", username: "owner", displayName: "Owner", role };
    next();
  });
  // Prisma is unused by this route; an empty stand-in keeps the factory happy.
  app.use("/api", createStorageRouter({} as never));
  return app;
}

describe("GET /api/storage/network-drive", () => {
  it("returns the full connect payload when enabled with a credential", async () => {
    const app = await buildApp({ SMB_ENABLED: "1", SMB_PASSWORD: "s3cretpass" });
    const res = await request(app).get("/api/storage/network-drive");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      enabled: true,
      share: "Droplet",
      username: "droplet",
      password: "s3cretpass",
      hosts: { mdns: "droplet-ai.local", lan: "droplet-ai.lan" },
      windowsPath: "\\\\droplet-ai.lan\\Droplet",
      macosUrl: "smb://droplet-ai.local/Droplet",
    });
  });

  it("renders operator-overridden hostnames into both connect paths", async () => {
    const app = await buildApp({
      SMB_ENABLED: "1",
      SMB_PASSWORD: "pw",
      DROPLET_MDNS_HOSTNAME: "my-box",
      DROPLET_LAN_HOSTNAME: "my-box.lan",
    });
    const res = await request(app).get("/api/storage/network-drive");
    expect(res.status).toBe(200);
    expect(res.body.windowsPath).toBe("\\\\my-box.lan\\Droplet");
    expect(res.body.macosUrl).toBe("smb://my-box.local/Droplet");
  });

  it("withholds the password when the share is disabled", async () => {
    // SMB_ENABLED=0 is what setup.sh writes on macOS dev hosts — the samba
    // service isn't running there, so the dialog must not hand out a
    // credential for a share that can't be reached.
    const app = await buildApp({ SMB_ENABLED: "0", SMB_PASSWORD: "pw" });
    const res = await request(app).get("/api/storage/network-drive");
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.password).toBeNull();
  });

  it("returns password null when the credential was never generated", async () => {
    // Enabled but empty SMB_PASSWORD (a .env predating the feature, before
    // migrate_env backfills): null, never an empty string that renders as a
    // blank-but-real-looking password.
    const app = await buildApp({ SMB_ENABLED: "1" });
    const res = await request(app).get("/api/storage/network-drive");
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.password).toBeNull();
  });

  it("403s family sessions — the credential is device-wide", async () => {
    const app = await buildApp(
      { SMB_ENABLED: "1", SMB_PASSWORD: "pw" },
      "family",
    );
    const res = await request(app).get("/api/storage/network-drive");
    expect(res.status).toBe(403);
    expect(res.body.password).toBeUndefined();
  });
});
