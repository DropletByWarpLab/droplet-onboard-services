/**
 * Matter Tier-2 confirm flow — entityId binding between mint and confirm.
 *
 * The command route mints pending confirmations with the device-category
 * domain prefix (e.g. "lock.12345") so safety rules classify correctly.
 * The confirm route must derive the SAME expected entityId or every
 * legitimate confirm dies with TOKEN_OPERATION_MISMATCH (the bug this
 * test pins). The WARP-41 echo protection must survive the fix: a caller
 * still can't confirm a different node or service than the one minted.
 *
 * matter.service is mocked at the module boundary; the real safety-tier
 * service runs (in-memory tokens) so this exercises the actual
 * route → evaluateCommand → confirmCommand wiring.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

// Keep the auth module's eager config reads from blowing up when env
// vars aren't set in the test runner (mirrors require-role.middleware.test.ts).
vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    NEXTCLOUD_URL: "http://nextcloud.test",
    SERVICE_TOKEN_VOICE: "",
    SERVICE_TOKEN_MCP: "",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/matter.service.js", () => ({
  isMatterInitialized: vi.fn(() => true),
  getDevice: vi.fn(),
  sendMatterCommand: vi.fn().mockResolvedValue({ status: "sent" }),
  getCommissionedDevices: vi.fn(),
  discoverDevices: vi.fn(),
  commissionDevice: vi.fn(),
  decommissionDevice: vi.fn(),
  subscribeStateChanges: vi.fn(() => () => {}),
  subscribeConnectionChanges: vi.fn(() => () => {}),
}));

import { createMatterRouter } from "../routes/matter.js";
import { getDevice, sendMatterCommand } from "../services/matter.service.js";

function createMockPrisma() {
  return {
    commandAuditLog: {
      create: vi.fn().mockResolvedValue({ id: "audit-1" }),
      findMany: vi.fn().mockResolvedValue([]),
    },
  } as never;
}

function buildApp(prisma = createMockPrisma()) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: unknown }).user = {
      id: "u-owner",
      username: "owner",
      displayName: "Owner",
      role: "owner",
    };
    next();
  });
  app.use("/api", createMatterRouter(prisma));
  return app;
}

/** Mint a Tier-2 lock command via the command route, return the token. */
async function mintLockCommand(app: express.Express, nodeId: string): Promise<string> {
  const res = await request(app)
    .post(`/api/matter/devices/${nodeId}/command`)
    .send({ command: "lock" });
  expect(res.status).toBe(202);
  expect(res.body.status).toBe("confirmation_required");
  expect(res.body.confirmationToken).toBeDefined();
  return res.body.confirmationToken as string;
}

describe("Matter Tier-2 mint → confirm entityId binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDevice).mockImplementation(async (nodeId: string) => ({
      nodeId,
      category: "lock",
    }) as never);
    vi.mocked(sendMatterCommand).mockResolvedValue({ status: "sent" } as never);
  });

  it("confirms a minted lock command on the same node (the broken happy path)", async () => {
    const app = buildApp();
    const token = await mintLockCommand(app, "12345");

    const confirm = await request(app)
      .post("/api/matter/devices/12345/confirm")
      .send({ confirmationToken: token, service: "lock" });

    expect(confirm.status).toBe(200);
    expect(confirm.body.confirmed).toBe(true);
    expect(sendMatterCommand).toHaveBeenCalledWith("12345", "lock", { type: "user", id: "u-owner" }, undefined);
  });

  it("rejects confirming on a different nodeId (WARP-41 echo protection)", async () => {
    const app = buildApp();
    const token = await mintLockCommand(app, "12345");

    const confirm = await request(app)
      .post("/api/matter/devices/99999/confirm")
      .send({ confirmationToken: token, service: "lock" });

    expect(confirm.status).toBe(400);
    expect(confirm.body.code).toBe("TOKEN_OPERATION_MISMATCH");
    expect(sendMatterCommand).not.toHaveBeenCalled();
  });

  it("rejects confirming a different service (WARP-41 echo protection)", async () => {
    const app = buildApp();
    const token = await mintLockCommand(app, "12345");

    const confirm = await request(app)
      .post("/api/matter/devices/12345/confirm")
      .send({ confirmationToken: token, service: "unlock" });

    expect(confirm.status).toBe(400);
    expect(confirm.body.code).toBe("TOKEN_OPERATION_MISMATCH");
    expect(sendMatterCommand).not.toHaveBeenCalled();
  });

  it("confirms a lock whose category degrades mid-window — no live state re-read on the confirm path", async () => {
    const app = buildApp();
    const token = await mintLockCommand(app, "54321");

    // The lock drops and re-establishes its fabric connection inside the
    // 60 s window: the controller cache only has endpoint 0, so a live
    // getDevice() would misreport the lock as the default "switch".
    vi.mocked(getDevice).mockResolvedValue({
      nodeId: "54321",
      category: "switch",
    } as never);
    vi.mocked(getDevice).mockClear();

    const confirm = await request(app)
      .post("/api/matter/devices/54321/confirm")
      .send({ confirmationToken: token, service: "lock" });

    expect(confirm.status).toBe(200);
    expect(confirm.body.confirmed).toBe(true);
    // The mint-time pending record is authoritative; confirming must not
    // depend on the device being reachable or fully re-enumerated.
    expect(getDevice).not.toHaveBeenCalled();
    expect(sendMatterCommand).toHaveBeenCalledWith("54321", "lock", { type: "user", id: "u-owner" }, undefined);
  });

  it("echoes `service` in the 202 confirmation body so clients can confirm without re-deriving it (KAN-5)", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/matter/devices/12345/command")
      .send({ command: "lock" });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("confirmation_required");
    // The bug: the 202 dropped `service`, but POST /confirm REQUIRES it.
    // The dashboard must be able to echo it straight back from this body.
    expect(res.body.service).toBe("lock");
    // Existing fields are preserved.
    expect(res.body.nodeId).toBe("12345");
    expect(res.body.command).toBe("lock");
    expect(res.body.tier).toBe(2);
    expect(res.body.confirmationToken).toBeDefined();
    expect(res.body.expiresIn).toBe(60);
  });

  it("echoes the MAPPED service (not the raw command) when they diverge — round-trips through /confirm (KAN-5)", async () => {
    const app = buildApp();
    // A climate setpoint >= 30C is the Tier-2 override path. The raw command
    // is `set_temperature`; the safety mapping keeps it `set_temperature`, but
    // the confirm route validates `service`, not `command`. Drive the value so
    // the 202's `service` is what /confirm actually accepts.
    vi.mocked(getDevice).mockResolvedValue({
      nodeId: "31000",
      category: "climate",
    } as never);

    const minted = await request(app)
      .post("/api/matter/devices/31000/command")
      .send({ command: "set_temperature", data: { temperature: 31 } });

    expect(minted.status).toBe(202);
    expect(minted.body.service).toBe("set_temperature");

    // Echo the body's `service` verbatim back to /confirm — it must be accepted.
    const confirm = await request(app)
      .post("/api/matter/devices/31000/confirm")
      .send({
        confirmationToken: minted.body.confirmationToken,
        service: minted.body.service,
      });

    expect(confirm.status).toBe(200);
    expect(confirm.body.confirmed).toBe(true);
    expect(sendMatterCommand).toHaveBeenCalledWith("31000", "set_temperature", { type: "user", id: "u-owner" }, {
      temperature: 31,
    });
  });

  it("set_hvac_mode off stages a Tier-2 confirm (climate.set_mode) and round-trips through /confirm (KAN-7)", async () => {
    const app = buildApp();
    vi.mocked(getDevice).mockResolvedValue({
      nodeId: "42",
      category: "climate",
    } as never);

    const minted = await request(app)
      .post("/api/matter/devices/42/command")
      .send({ command: "set_hvac_mode", data: { mode: "off" } });

    expect(minted.status).toBe(202);
    expect(minted.body.status).toBe("confirmation_required");
    expect(minted.body.tier).toBe(2);
    // The 202 echoes the MAPPED service the confirm route validates against.
    expect(minted.body.service).toBe("set_mode");
    expect(minted.body.command).toBe("set_hvac_mode");
    // The Tier-2 write must NOT have executed at mint time.
    expect(sendMatterCommand).not.toHaveBeenCalled();

    const confirm = await request(app)
      .post("/api/matter/devices/42/confirm")
      .send({
        confirmationToken: minted.body.confirmationToken,
        service: minted.body.service,
      });

    expect(confirm.status).toBe(200);
    expect(confirm.body.confirmed).toBe(true);
    // The original command + data is what gets sent on confirm.
    expect(sendMatterCommand).toHaveBeenCalledWith("42", "set_hvac_mode", { type: "user", id: "u-owner" }, {
      mode: "off",
    });
  });

  it.each(["heat", "cool", "auto"])(
    "set_hvac_mode %s is Tier-1 and executes directly (KAN-7)",
    async (mode) => {
      const app = buildApp();
      vi.mocked(getDevice).mockResolvedValue({
        nodeId: "42",
        category: "climate",
      } as never);

      const res = await request(app)
        .post("/api/matter/devices/42/command")
        .send({ command: "set_hvac_mode", data: { mode } });

      expect(res.status).toBe(200);
      expect(res.body.tier).toBe(1);
      expect(sendMatterCommand).toHaveBeenCalledWith("42", "set_hvac_mode", { type: "user", id: "u-owner" }, {
        mode,
      });
    },
  );

  it("mints binary_sensor entityIds under their own domain — no silent aliasing onto sensor.*", async () => {
    const prisma = createMockPrisma();
    const app = buildApp(prisma);
    vi.mocked(getDevice).mockResolvedValue({
      nodeId: "777",
      category: "binary_sensor",
    } as never);

    const res = await request(app)
      .post("/api/matter/devices/777/command")
      .send({ command: "turn_on" });

    expect(res.status).toBe(200);
    expect(
      (prisma as { commandAuditLog: { create: ReturnType<typeof vi.fn> } })
        .commandAuditLog.create,
    ).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityId: "binary_sensor.777",
        domain: "binary_sensor",
      }),
    });
  });
});
