import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createStorageRouter } from "../routes/storage.js";
import type { StorageAllocationRow } from "../services/recordings-capacity.js";

vi.mock("../services/nextcloud-session.service.js", () => ({ resolveNcToken: vi.fn(async () => null) }));
vi.mock("../services/nextcloud.client.js", () => ({ ncGetUserQuota: vi.fn() }));

const FS_UUID = "1a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d";
const OTHER_UUID = "8a9b0c1d-2e3f-4a5b-9c6d-7e8f9a0b1c2d";

function drive(overrides: Record<string, unknown> = {}) {
  return {
    device: "/dev/mapper/droplet-bay-1a2b3c4d", parent_disk: "sdb",
    mount: "/mnt/droplet/drive-1a2b3c4d", label: "drive", uuid: FS_UUID,
    size_bytes: 20_000_000_000_000, used_bytes: 1_000_000_000_000,
    free_bytes: 19_000_000_000_000, mounted: true, fs: "ext4", encryption: "luks2",
    ...overrides,
  };
}

function allocation(overrides: Partial<StorageAllocationRow> = {}): StorageAllocationRow {
  return {
    id: "allocation-1", fsUuid: FS_UUID, mode: "AUTO_RESERVED", status: "ACTIVE",
    reservedBytes: 18_000_000_000_000n,
    createdAt: new Date("2026-10-01T00:00:00Z"), updatedAt: new Date("2026-10-02T00:00:00Z"),
    ...overrides,
  };
}

function appFor(rows: StorageAllocationRow[] = []) {
  const findMany = vi.fn(async () => rows);
  const app = express();
  app.use("/api", createStorageRouter({
    drive: { findMany: vi.fn(async () => []) }, storageAllocation: { findMany },
  } as never));
  return { app, findMany };
}

function bridge(drives: ReturnType<typeof drive>[], extra: Record<string, unknown> = {}) {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true, status: 200,
    json: async () => ({ drives, count: drives.length, os_disk: "nvme0n1", snapshot_at: "2026-10-08T00:00:00Z", ...extra }),
  })));
}

beforeEach(() => {
  vi.unstubAllGlobals();
  bridge([drive()]);
});

describe("GET /storage/drives — persisted recording assignments", () => {
  it("joins the allocated filesystem and converts a multi-TB BigInt reservation", async () => {
    bridge([drive(), drive({ uuid: OTHER_UUID, parent_disk: "sdc", mount: "/mnt/droplet/other" })]);
    const { app, findMany } = appFor([allocation()]);
    const res = await request(app).get("/api/storage/drives");
    expect(res.status).toBe(200);
    expect(res.body.drives[0].usage).toEqual({ role: "recordings", reservedBytes: 18_000_000_000_000 });
    expect(res.body.drives[1].usage).toEqual({ role: null, reservedBytes: null });
    expect(findMany).toHaveBeenCalledWith({ where: { role: "RECORDINGS" } });
  });

  it.each(["PENDING", "MIGRATING", "ACTIVE", "DEGRADED", "MISSING"] as const)(
    "keeps a present %s allocation assigned without claiming its lifecycle is active",
    async (status) => {
      const { app } = appFor([allocation({ status })]);
      const res = await request(app).get("/api/storage/drives");
      expect(res.status).toBe(200);
      expect(res.body.drives[0].usage).toEqual({ role: "recordings", reservedBytes: 18_000_000_000_000 });
    },
  );

  it("marks both source and pending target assigned during a drive switch", async () => {
    bridge([drive(), drive({ uuid: OTHER_UUID, parent_disk: "sdc", mount: "/mnt/droplet/other" })]);
    const { app } = appFor([allocation(), allocation({ id: "target", fsUuid: OTHER_UUID, status: "PENDING", reservedBytes: 50_000_000_000n })]);
    const res = await request(app).get("/api/storage/drives");
    expect(res.body.drives.map((d: { usage: unknown }) => d.usage)).toEqual([
      { role: "recordings", reservedBytes: 18_000_000_000_000 },
      { role: "recordings", reservedBytes: 50_000_000_000 },
    ]);
  });

  it("never invents disconnected allocated drives or offers a system drive", async () => {
    bridge([
      drive({ uuid: OTHER_UUID }),
      drive({ uuid: FS_UUID, mounted: false, mount: "/mnt/droplet/missing" }),
      drive({ uuid: "system-uuid", parent_disk: "nvme0n1", mount: "/mnt/droplet/install" }),
    ], { system_disk: { name: "nvme0n1", size_bytes: 1_000_000_000_000 } });
    const { app } = appFor([allocation({ status: "MISSING" }), allocation({ id: "bad-system", fsUuid: "system-uuid" })]);
    const res = await request(app).get("/api/storage/drives");
    expect(res.body.count).toBe(1);
    expect(res.body.drives.map((d: { uuid: string }) => d.uuid)).toEqual([OTHER_UUID]);
    expect(res.body.drives[0].usage).toEqual({ role: null, reservedBytes: null });
    expect(res.body.system_disk.name).toBe("nvme0n1");
    expect(res.body.system_disk).not.toHaveProperty("usage");
  });

  it("an exact filesystem UUID is required for the assignment join", async () => {
    const { app } = appFor([allocation({ fsUuid: `${FS_UUID}-other` })]);
    const res = await request(app).get("/api/storage/drives");
    expect(res.body.drives[0].usage).toEqual({ role: null, reservedBytes: null });
  });

  it("returns an empty honest inventory without querying assignments when no data drives exist", async () => {
    bridge([]);
    const { app, findMany } = appFor([allocation({ status: "MISSING" })]);
    const res = await request(app).get("/api/storage/drives");
    expect(res.status).toBe(200);
    expect(res.body.drives).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("refuses the actionable inventory when assignment lookup fails instead of claiming unassigned", async () => {
    const { app, findMany } = appFor();
    findMany.mockRejectedValueOnce(new Error("database connection details"));
    const res = await request(app).get("/api/storage/drives");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      drives: [], count: 0, totals: null, reason: "recordings_usage_unavailable",
      error: "Recording storage assignments are unavailable right now.",
    });
    expect(res.text).not.toContain("database connection details");
  });
});

describe("GET /storage/drives — SMART availability", () => {
  it.each(["disabled", "unsupported", "unavailable", "unknown"])(
    "an explicit %s status suppresses stale measurements",
    async (smart_status) => {
      bridge([drive({ smart_status, smart: "PASSED", temp_c: 38 })]);
      const res = await request(appFor().app).get("/api/storage/drives");
      expect(res.body.drives[0]).toMatchObject({ smart_status, smart: null, temp_c: null });
    },
  );

  it.each([null, "AVAILABLE", "bogus", 3, true, ["available"], { status: "available" }])(
    "normalizes malformed status %j to unknown, never trusting stale measurements",
    async (smart_status) => {
      bridge([drive({ smart_status, smart: "PASSED", temp_c: 38 })]);
      const res = await request(appFor().app).get("/api/storage/drives");
      expect(res.body.drives[0]).toMatchObject({ smart_status: "unknown", smart: null, temp_c: null });
    },
  );

  it.each(["PASSED", "FAILED"])("preserves an available %s verdict and temperature", async (smart) => {
    bridge([drive({ smart_status: "available", smart, temp_c: 38 })]);
    const res = await request(appFor().app).get("/api/storage/drives");
    expect(res.body.drives[0]).toMatchObject({ smart_status: "available", smart, temp_c: 38 });
  });

  it.each(["PASSED", "FAILED"])("a legacy affirmative %s verdict proves availability", async (smart) => {
    bridge([drive({ smart, temp_c: 38 })]);
    const res = await request(appFor().app).get("/api/storage/drives");
    expect(res.body.drives[0]).toMatchObject({ smart_status: "available", smart, temp_c: 38 });
  });

  it.each([undefined, null, "passed", "unknown", true])("a legacy verdict %j does not prove availability", async (smart) => {
    bridge([drive({ smart })]);
    const res = await request(appFor().app).get("/api/storage/drives");
    expect(res.body.drives[0]).toMatchObject({ smart_status: "unknown", smart: null, temp_c: null });
  });

  it("preserves a legacy temperature-only read without inventing a healthy verdict", async () => {
    bridge([drive({ smart: null, temp_c: 38 })]);
    const res = await request(appFor().app).get("/api/storage/drives");
    expect(res.body.drives[0]).toMatchObject({ smart_status: "available", smart: null, temp_c: 38 });
  });

  it.each(["38", NaN, Infinity, null])("legacy temperature %j does not prove a collector read", async (temp_c) => {
    bridge([drive({ temp_c })]);
    const res = await request(appFor().app).get("/api/storage/drives");
    expect(res.body.drives[0]).toMatchObject({ smart_status: "unknown", smart: null, temp_c: null });
  });

  it.each([undefined, null, "passed", "unknown", true])("does not fabricate a verdict from available with health %j", async (smart) => {
    bridge([drive({ smart_status: "available", smart, temp_c: 38 })]);
    const res = await request(appFor().app).get("/api/storage/drives");
    expect(res.body.drives[0]).toMatchObject({ smart_status: "available", smart: null, temp_c: 38 });
  });

  it.each(["38", NaN, Infinity, -Infinity, null])("rejects a non-finite/non-numeric temperature %j", async (temp_c) => {
    bridge([drive({ smart_status: "available", smart: "PASSED", temp_c })]);
    const res = await request(appFor().app).get("/api/storage/drives");
    expect(res.body.drives[0]).toMatchObject({ smart_status: "available", smart: "PASSED", temp_c: null });
  });
});
