/**
 * SSH-access mint ↔ confirm round trip (WARP-1984 regression).
 *
 * The shipped build could mint a Tier-3 token for `set_ssh_access` and had
 * nowhere to redeem it: `POST /network/ssh` always returns 202 (Tier 3 never
 * takes the no-confirm branch, so its own `setSshAccess` call is unreachable),
 * and `POST /network/command/confirm` had no case for the operation, so the
 * dashboard toggle answered `400 Unknown operation: set_ssh_access`.
 *
 * The consequence was not cosmetic. `droplet-ssh-access-boot-reset` stops sshd
 * on every boot on purpose, and this toggle is the only thing meant to bring it
 * back — so a claimed appliance had no management shell and no remote way to
 * open one. Observed on 192.168.1.200 (origin/main 473d1eac): :22 refused while
 * :443 served happily.
 *
 * Per-route tests could not see this: each half was individually correct. Only
 * the pipeline — real safety service, mint route and confirm dispatcher sharing
 * one prisma — shows that the token has no consumer. Same shape as the
 * `buildFullApp` harness in network-guest-upnp.routes.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";

const { configMock } = vi.hoisted(() => ({
  configMock: {
    AUTH_ENABLED: true,
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));
vi.mock("../config.js", () => ({ config: configMock }));

// The service is the host boundary — it writes the intent file a root systemd
// path unit watches. Mocked so the assertion is "the dispatcher reached the
// boundary with the right value", which is exactly what was missing.
vi.mock("../services/ssh-access.service.js", () => ({
  readSshAccess: vi.fn().mockResolvedValue({
    enabled: false,
    status: "applied",
    changedAt: "2026-08-20T00:00:00Z",
  }),
  setSshAccess: vi.fn().mockResolvedValue({
    enabled: true,
    status: "pending",
    changedAt: null,
  }),
}));

import { registerSshRoutes } from "../routes/network-ssh.routes.js";
import { registerStatusRoutes } from "../routes/network-status.routes.js";
import { classifyNetworkCommand } from "../config/network-safety-rules.js";
import * as sshAccessService from "../services/ssh-access.service.js";
import type { AuthUser } from "../middleware/auth.js";

function createPrismaMock() {
  return {
    commandAuditLog: {
      create: vi.fn().mockResolvedValue({ id: "audit-1" }),
      findMany: vi.fn().mockResolvedValue([]),
    },
  } as unknown as PrismaClient;
}

const owner: AuthUser = {
  id: "u-owner",
  username: "stefan",
  displayName: "stefan",
  role: "owner",
};

/** Mint route + confirm dispatcher on ONE prisma, with the real safety service. */
function buildFullApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = owner;
    next();
  });
  const prisma = createPrismaMock();
  const router = express.Router();
  registerSshRoutes(router, { prisma });
  registerStatusRoutes(router, { prisma, networkDeviceService: {} as never });
  app.use("/api", router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("set_ssh_access tier contract", () => {
  it("is Tier 3 — confirmation required, never AI-triggerable", () => {
    const c = classifyNetworkCommand("set_ssh_access");
    expect(c.tier).toBe(3);
    expect(c.requiresConfirmation).toBe(true);
  });
});

describe("POST /api/network/ssh", () => {
  it("mints only: 202 + token, and no write reaches the host", async () => {
    const res = await request(buildFullApp())
      .post("/api/network/ssh")
      .send({ enabled: true });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      status: "confirmation_required",
      operation: "set_ssh_access",
      tier: 3,
    });
    expect(res.body.confirmationToken).toBeTruthy();
    expect(sshAccessService.setSshAccess).not.toHaveBeenCalled();
  });

  it("rejects a non-boolean `enabled` before any token exists", async () => {
    const res = await request(buildFullApp())
      .post("/api/network/ssh")
      .send({ enabled: "yes" });

    expect(res.status).toBe(400);
    expect(sshAccessService.setSshAccess).not.toHaveBeenCalled();
  });
});

describe("the minted token round-trips through /api/network/command/confirm", () => {
  it("turning SSH ON reaches the host with `true`", async () => {
    const app = buildFullApp();

    const mint = await request(app).post("/api/network/ssh").send({ enabled: true });
    expect(mint.status).toBe(202);

    const confirm = await request(app)
      .post("/api/network/command/confirm")
      .send({
        confirmationToken: mint.body.confirmationToken,
        operation: mint.body.operation,
      });

    // Pre-fix this was 400 {"error":"Unknown operation: set_ssh_access"}.
    expect(confirm.status).toBe(200);
    expect(confirm.body).toMatchObject({
      status: "ok",
      operation: "set_ssh_access",
      confirmed: true,
    });
    expect(sshAccessService.setSshAccess).toHaveBeenCalledTimes(1);
    expect(sshAccessService.setSshAccess).toHaveBeenCalledWith(true);
  });

  it("turning SSH OFF reaches the host with `false` — the direction is carried, not assumed", async () => {
    const app = buildFullApp();

    const mint = await request(app).post("/api/network/ssh").send({ enabled: false });
    const confirm = await request(app)
      .post("/api/network/command/confirm")
      .send({
        confirmationToken: mint.body.confirmationToken,
        operation: mint.body.operation,
      });

    expect(confirm.status).toBe(200);
    expect(sshAccessService.setSshAccess).toHaveBeenCalledWith(false);
  });

  it("a token echoed as the wrong operation still does not open a shell", async () => {
    const app = buildFullApp();

    const mint = await request(app).post("/api/network/ssh").send({ enabled: true });
    const confirm = await request(app)
      .post("/api/network/command/confirm")
      .send({
        confirmationToken: mint.body.confirmationToken,
        operation: "reboot",
      });

    expect(confirm.status).toBe(400);
    expect(sshAccessService.setSshAccess).not.toHaveBeenCalled();
  });
});
