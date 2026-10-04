/**
 * WARP-3610 -- the owner takes the backup repository key off the box, once.
 * Pins: the derivation matches the host script (known-answer, same vector as
 * tests/restic-backup.test.sh), owner-only, fresh step-up required, second
 * call 409, the key is never in the audit row, no key -> 503.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import { Prisma } from "@prisma/client";

const KAT_KEY = "kat-device-secret-key-DO-NOT-CHANGE";
const KAT_EXPECTED = "3fbbc2bb25b2e631aeac6c4dc360f27087096657d0525b29f2c01bd853b9dc49";

const { deviceKey } = vi.hoisted(() => ({ deviceKey: { value: "" } }));
vi.mock("../config.js", async (importActual) => {
  const actual: any = await importActual();
  return {
    ...actual,
    config: new Proxy(actual.config, {
      get: (t, k) => (k === "DEVICE_SECRET_KEY" ? deviceKey.value : t[k]),
    }),
  };
});

const recordActivity = vi.fn(async (_p: any) => null);
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: (p: any) => recordActivity(p),
}));

import { createBackupKeyRouter } from "../routes/backup-key.js";
import { deriveBackupKey } from "../services/backup-key-export.service.js";

function prismaStub() {
  const rows = new Set<string>();
  return {
    systemFlag: {
      create: vi.fn(async ({ data }: any) => {
        if (rows.has(data.key)) {
          throw new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "test" });
        }
        rows.add(data.key);
        return data;
      }),
    },
  } as any;
}

function appFor(user: Record<string, unknown> | null, prisma = prismaStub()) {
  const a = express();
  a.use((req, _res, next) => {
    (req as any).user = user;
    next();
  });
  a.use("/api", createBackupKeyRouter(prisma));
  return a;
}

const fresh = { id: "o", username: "owner1", role: "owner", lastMfaAt: new Date() };

beforeEach(() => {
  recordActivity.mockClear();
  deviceKey.value = KAT_KEY;
});

describe("deriveBackupKey", () => {
  it("matches the host script's HKDF known-answer vector", () => {
    expect(deriveBackupKey(KAT_KEY)).toBe(KAT_EXPECTED);
  });
});

describe("POST /api/backup/key/export", () => {
  it("returns the key once, audits without the key, then 409s", async () => {
    const app = appFor(fresh);
    const first = await request(app).post("/api/backup/key/export");
    expect(first.status).toBe(200);
    expect(first.body.key).toBe(KAT_EXPECTED);
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(recordActivity).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(recordActivity.mock.calls[0][0])).not.toContain(KAT_EXPECTED);

    const second = await request(app).post("/api/backup/key/export");
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("BACKUP_KEY_ALREADY_EXPORTED");
    expect(second.body.key).toBeUndefined();
  });

  it("is owner-only: an admin gets 403 and no flag is claimed", async () => {
    const prisma = prismaStub();
    const res = await request(appFor({ ...fresh, role: "admin" }, prisma)).post("/api/backup/key/export");
    expect(res.status).toBe(403);
    expect(prisma.systemFlag.create).not.toHaveBeenCalled();
  });

  it("needs a fresh step-up: no or stale lastMfaAt is 401 and claims nothing", async () => {
    const prisma = prismaStub();
    const none = await request(appFor({ ...fresh, lastMfaAt: null }, prisma)).post("/api/backup/key/export");
    expect(none.status).toBe(401);
    const stale = await request(
      appFor({ ...fresh, lastMfaAt: new Date(Date.now() - 10 * 60_000) }, prisma),
    ).post("/api/backup/key/export");
    expect(stale.status).toBe(401);
    expect(prisma.systemFlag.create).not.toHaveBeenCalled();
  });

  it("503 when the box has no device secret, and the one-shot is not spent", async () => {
    deviceKey.value = "";
    const prisma = prismaStub();
    const res = await request(appFor(fresh, prisma)).post("/api/backup/key/export");
    expect(res.status).toBe(503);
    expect(prisma.systemFlag.create).not.toHaveBeenCalled();
  });
});
