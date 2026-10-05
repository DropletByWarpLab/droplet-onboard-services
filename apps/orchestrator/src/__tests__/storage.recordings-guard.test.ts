import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../services/nextcloud-session.service.js", () => ({ resolveNcToken: vi.fn(async () => null) }));
vi.mock("../services/nextcloud.client.js", () => ({ ncGetUserQuota: vi.fn() }));

import { createStorageRouter } from "../routes/storage.js";
import { setRecordingsAllocator } from "../services/recordings-allocator.singleton.js";
import { guardRecordingsDrive } from "../services/recordings-drive-guard.service.js";

const UUID = "1a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d";
const volume = { source: "nvrdata", kind: "volume", mounted: false, backingDevices: [] };
const bay = {
  source: "/mnt/droplet/bay/nvr", kind: "path", fsUuid: UUID,
  mountPath: "/mnt/droplet/bay", mounted: true, physicalDisk: "sdb,sdc", backingDevices: ["md0", "sdb", "sdc"],
};
const facts = (host: unknown = volume, extra = {}) => ({ host, allocations: [], drives: [], drivesError: null, ...extra });

function setFacts(value: unknown) {
  const getFacts = vi.fn(async () => value);
  setRecordingsAllocator({ getFacts } as never);
  return getFacts;
}

function appFor(role = "owner") {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: "user-1", role } as never; next(); });
  app.use("/api", createStorageRouter({ commandAuditLog: { create: vi.fn(async () => ({})) } } as never));
  return app;
}

function bridgeReply(status = 200, body: unknown = { ok: true }) {
  return vi.fn(async () => ({ ok: status < 400, status, json: async () => body })) as unknown as typeof fetch;
}

async function mintDestroy(app: express.Express) {
  const pending = await request(app).delete("/api/storage/pools/md0").send({ confirmPhrase: "ERASE md0" });
  expect(pending.status).toBe(202);
  return pending.body;
}

describe("ADR-070 storage guard through the real router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BRIDGE_AUTH_TOKEN = "test-bridge-token";
    setFacts(facts());
  });
  afterEach(() => { setRecordingsAllocator(null); vi.unstubAllGlobals(); });

  it("checks fresh facts on confirm and consumes the token without mutating an active drive", async () => {
    const getFacts = setFacts(facts());
    const fetch = bridgeReply();
    vi.stubGlobal("fetch", fetch);
    const app = appFor();
    const pending = await mintDestroy(app);
    expect(getFacts).not.toHaveBeenCalled();
    getFacts.mockResolvedValue(facts(bay));
    const refused = await request(app).post("/api/storage/command/confirm").send(pending);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("recordings_drive_active");
    expect(fetch).not.toHaveBeenCalled();
    expect(getFacts).toHaveBeenCalledTimes(1);
    expect((await request(app).post("/api/storage/command/confirm").send(pending)).body.code).toBe("TOKEN_MISSING");
  });

  it("refuses ejecting the allocated filesystem without a bridge write", async () => {
    setFacts(facts(bay));
    const fetch = bridgeReply();
    vi.stubGlobal("fetch", fetch);
    const res = await request(appFor("admin")).post(`/api/storage/drives/${UUID}/eject`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("recordings_drive_active");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([null, { ...bay, backingDevices: [] }, { ...bay, mounted: false }, { ...volume, kind: "unknown" }])(
    "refuses both mutation paths when recording topology is unavailable (%j)", async (host) => {
      setFacts(facts(host));
      const fetch = bridgeReply();
      vi.stubGlobal("fetch", fetch);
      const app = appFor();
      const pending = await mintDestroy(app);
      const confirm = await request(app).post("/api/storage/command/confirm").send(pending);
      expect(confirm.status).toBe(503);
      expect(confirm.body.code).toBe("recordings_status_unavailable");
      const eject = await request(app).post(`/api/storage/drives/${UUID}/eject`);
      expect(eject.status).toBe(503);
      expect(eject.body.code).toBe("recordings_status_unavailable");
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("refuses missing or failed allocator reads", async () => {
    setRecordingsAllocator(null);
    expect(await guardRecordingsDrive("pool", "md0")).toMatchObject({ status: 503 });
    setRecordingsAllocator({ getFacts: vi.fn().mockRejectedValue(new Error("unreadable")) } as never);
    expect(await guardRecordingsDrive("eject", UUID)).toMatchObject({ status: 503 });
  });

  it.each([
    { ...bay, source: "relative/nvr" }, { ...bay, source: null },
    { ...bay, mountPath: "/" }, { ...bay, mountPath: "/mnt/droplet/../bay" },
    { ...bay, source: "/somewhere/else/nvr" }, { ...bay, source: `${bay.source}/../escape` },
    { ...bay, fsUuid: "not-a-uuid" }, { ...bay, fsUuid: `${UUID}\n` },
    { ...bay, backingDevices: ["sdb;rm"] }, { ...bay, backingDevices: ["/dev/sdb"] },
    { ...bay, physicalDisk: "sdd" }, { ...bay, physicalDisk: "" },
    { ...volume, source: "named volume" },
  ])("refuses malformed canonical host topology on both paths (%j)", async (host) => {
    setFacts(facts(host));
    expect(await guardRecordingsDrive("pool", "md9")).toMatchObject({ status: 503, code: "recordings_status_unavailable" });
    expect(await guardRecordingsDrive("eject", UUID)).toMatchObject({ status: 503, code: "recordings_status_unavailable" });
  });

  it("accepts a normalized custom mount base and generic mapper names", async () => {
    setFacts(facts({ ...bay, source: "/srv/camera-storage/recordings", mountPath: "/srv/camera-storage",
      physicalDisk: "nvme2n1", backingDevices: ["nvme2n1", "crypt.data-1+mirror"] }));
    expect(await guardRecordingsDrive("pool", "md9")).toBeNull();
    expect(await guardRecordingsDrive("pool", "md9", { member: "/dev/mapper/crypt.data-1+mirror" })).toMatchObject({ status: 409 });
  });

  it("protects the migration target from the DB as well as the live host drive", async () => {
    setFacts(facts(bay, {
      allocations: [{ fsUuid: "deadbeef", status: "MIGRATING" }],
      drives: [{ fsUuid: "deadbeef", parentDisk: "sdd" }],
    }));
    expect(await guardRecordingsDrive("pool", "md9", { members: ["/dev/sdd"] })).toMatchObject({ status: 409 });
    expect(await guardRecordingsDrive("eject", "deadbeef")).toMatchObject({ status: 409 });
  });

  it.each(["pool", "eject"] as const)("preserves a bridge refusal during the %s path, including a status race", async (kind) => {
    const app = appFor();
    for (const [status, code] of [[409, "recordings_drive_active"], [503, "recordings_status_unavailable"], [409, "storage_busy"]] as const) {
      const fetch = bridgeReply(status, { ok: false, code, error: "internal mount details" });
      vi.stubGlobal("fetch", fetch);
      const res = kind === "pool"
        ? await request(app).post("/api/storage/command/confirm").send(await mintDestroy(app))
        : await request(app).post(`/api/storage/drives/${UUID}/eject`);
      expect(res.status).toBe(status);
      expect(res.body.code).toBe(code);
      expect(res.text).not.toContain("internal mount details");
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("allows unrelated storage writes after a verified named-volume status", async () => {
    const fetch = bridgeReply();
    vi.stubGlobal("fetch", fetch);
    const app = appFor("admin");
    expect((await request(app).post("/api/storage/command/confirm").send(await mintDestroy(app))).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("checks role and sealed token binding before reading facts or issuing a write", async () => {
    const getFacts = setFacts(facts());
    const fetch = bridgeReply();
    vi.stubGlobal("fetch", fetch);
    const app = appFor();
    const pending = await mintDestroy(app);
    const changed = await request(app).post("/api/storage/command/confirm").send({ ...pending, resourceId: "md1" });
    expect(changed.body.code).toBe("TOKEN_OPERATION_MISMATCH");
    expect((await request(appFor("family")).post(`/api/storage/drives/${UUID}/eject`)).status).toBe(403);
    expect(getFacts).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("leaves owner-only recovery custody available without a topology mutation", async () => {
    setRecordingsAllocator(null);
    const fetch = bridgeReply(200, { ok: true, operation: "recovery_key_reveal", status: "revealed", uuid: UUID, recovery_key: "fake-recovery-key-for-test" });
    vi.stubGlobal("fetch", fetch);
    const app = appFor();
    const pending = await request(app).post(`/api/storage/drives/${UUID}/recovery-key/reveal`);
    const confirmed = await request(app).post("/api/storage/command/confirm").send(pending.body);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.recoveryKey).toBe("fake-recovery-key-for-test");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
