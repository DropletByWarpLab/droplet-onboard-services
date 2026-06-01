/**
 * Route tests for the PR #373 onboarding CLAIM step endpoints.
 *
 *   GET  /api/setup/appliance → the hardware contract
 *        { appliance_id, compute, storage, network, display, supply_chain }
 *        (a DOCUMENTED STUB — no orchestrator facility produces this shape;
 *        the routing /system/info is router-only and only best-effort enriches
 *        `network`).
 *
 *   POST /api/setup/claim { code } → bind the appliance to the workspace.
 *        Atomic, single-use, rate-limited; the code is hashed at rest and
 *        compared in constant time. Wrong code → 400 inline error + budget
 *        decrement, never revealing the real code. Already-claimed re-run →
 *        200 short-circuit to the next step. Rate-limit exhausted → 429.
 *
 * Both are PUBLIC (mounted before the auth middleware): claiming happens
 * BEFORE any account exists (welcome → claim → account, #371 handoff §1).
 *
 * Strategy mirrors setup.test.ts + the WARP-564 device-clients route test:
 * a minimal Express app + supertest, an in-memory Prisma stand-in (claimCode +
 * $transaction + applianceSetup), and a mocked cache.service so the rate-limit
 * budget is deterministic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import cookieParser from "cookie-parser";

vi.unmock("@prisma/client");

// Deterministic rate-limit budget: drive cacheGet to simulate "budget left"
// (low/zero count → allowed) vs "budget exhausted" (>= max → 429).
vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
}));

// The appliance contract best-effort enriches `network` from the routing
// service. In a unit test there's no router, and the real client would retry +
// time out — simulate the single-box "router offline" path so the contract
// falls back to its placeholder network spec deterministically.
vi.mock("../services/openwrt.client.js", () => ({
  fetchNetworkSummary: vi.fn().mockRejectedValue(new Error("router offline")),
}));

import { cacheGet } from "../services/cache.service.js";
import { createSetupRouter } from "./setup.js";
import { hashClaimCode } from "../services/setup-claim.service.js";

const mockCacheGet = vi.mocked(cacheGet);

const DAY_MS = 24 * 60 * 60 * 1000;

function createPrismaMock() {
  type ClaimRow = {
    id: string;
    codeHash: string;
    state: "available" | "consumed";
    expiresAt: Date;
    usedAt: Date | null;
    attempts: number;
  };
  const claimRows: ClaimRow[] = [];
  let appliance: Record<string, unknown> | null = null;

  const claimCode = {
    _seed: (row: Partial<ClaimRow> & { codeHash: string }) => {
      claimRows.push({
        id: row.id ?? `cc-${claimRows.length + 1}`,
        codeHash: row.codeHash,
        state: row.state ?? "available",
        expiresAt: row.expiresAt ?? new Date(Date.now() + DAY_MS),
        usedAt: row.usedAt ?? null,
        attempts: row.attempts ?? 0,
      });
    },
    _rows: () => claimRows,
    findFirst: async ({ where }: { where: { codeHash: string } }) => {
      const f = claimRows.find((r) => r.codeHash === where.codeHash);
      return f ? { ...f } : null;
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: { id: string; state?: string; expiresAt?: { gt: Date } };
      data: Partial<ClaimRow>;
    }) => {
      let count = 0;
      for (const r of claimRows) {
        if (r.id !== where.id) continue;
        if (where.state !== undefined && r.state !== where.state) continue;
        if (where.expiresAt?.gt && !(r.expiresAt > where.expiresAt.gt)) continue;
        Object.assign(r, data);
        count += 1;
      }
      return { count };
    },
  };

  return {
    _appliance: () => appliance,
    user: { count: async () => 0 },
    claimCode,
    applianceSetup: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        appliance && appliance.id === where.id ? { ...appliance } : null,
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { id: string };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        if (appliance && appliance.id === where.id) {
          appliance = { ...appliance, ...update, updatedAt: new Date() };
        } else {
          appliance = {
            state: "unclaimed",
            setupStep: "welcome",
            userTourCompleted: false,
            ...create,
          };
        }
        return { ...appliance };
      },
    },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
      fn({ claimCode }),
  };
}

function buildApp(prisma: ReturnType<typeof createPrismaMock>) {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use("/api", createSetupRouter(prisma as never));
  return app;
}

describe("GET /api/setup/appliance (PR #373 — documented stub)", () => {
  beforeEach(() => {
    process.env.DEVICE_SECRET = "test-device-secret";
    mockCacheGet.mockResolvedValue(null);
  });
  afterEach(() => {
    delete process.env.DEVICE_SECRET;
    vi.clearAllMocks();
  });

  it("returns the full hardware contract shape", async () => {
    const res = await request(buildApp(createPrismaMock())).get(
      "/api/setup/appliance",
    );
    expect(res.status).toBe(200);
    // Every key of the #371 §2 / FEATURES.md §9 contract must be present.
    for (const key of [
      "appliance_id",
      "compute",
      "storage",
      "network",
      "display",
      "supply_chain",
    ]) {
      expect(res.body).toHaveProperty(key);
    }
  });

  it("reports supply-chain compliance flags the UI renders as a chip", async () => {
    const res = await request(buildApp(createPrismaMock())).get(
      "/api/setup/appliance",
    );
    expect(res.body.supply_chain).toMatchObject({
      taa_compliant: true,
      ndaa_889_clear: true,
    });
  });
});

describe("POST /api/setup/claim (PR #373)", () => {
  beforeEach(() => {
    process.env.DEVICE_SECRET = "test-device-secret";
    mockCacheGet.mockResolvedValue(null); // budget available
  });
  afterEach(() => {
    delete process.env.DEVICE_SECRET;
    vi.clearAllMocks();
  });

  it("binds the appliance on the correct code and advances to account", async () => {
    const prisma = createPrismaMock();
    prisma.claimCode._seed({ codeHash: hashClaimCode("DRPL-7K2Q-9F4M") });

    const res = await request(buildApp(prisma))
      .post("/api/setup/claim")
      .send({ code: "DRPL · 7K2Q · 9F4M" });

    expect(res.status).toBe(200);
    expect(res.body.claimed).toBe(true);
    expect(res.body.next_step).toBe("account");
    // Claim consumes the code (explicit state) but must NOT flip the appliance
    // to "ready" — that's the wizard-FINISH transition (#372). Claim is FIRST.
    expect(prisma.claimCode._rows()[0].state).toBe("consumed");
    expect(prisma._appliance()?.state).not.toBe("ready");
    // Wizard step persisted so a refresh resumes at account.
    expect(prisma._appliance()?.setupStep).toBe("account");
  });

  it("rejects a wrong code with a 400 inline error and never reveals the real code", async () => {
    const prisma = createPrismaMock();
    prisma.claimCode._seed({ codeHash: hashClaimCode("DRPL-7K2Q-9F4M") });

    const res = await request(buildApp(prisma))
      .post("/api/setup/claim")
      .send({ code: "WRON-GGGG-GGGG" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("CLAIM_CODE_INVALID");
    // The real code (and its hash) never leak in the response.
    expect(JSON.stringify(res.body)).not.toContain("7K2Q");
    expect(JSON.stringify(res.body)).not.toContain(
      hashClaimCode("DRPL-7K2Q-9F4M"),
    );
    // The real code is untouched.
    expect(prisma.claimCode._rows()[0].state).toBe("available");
  });

  it("short-circuits an already-claimed re-run to the next step (200)", async () => {
    const prisma = createPrismaMock();
    prisma.claimCode._seed({
      codeHash: hashClaimCode("DRPL-7K2Q-9F4M"),
      state: "consumed",
      usedAt: new Date(),
    });

    const res = await request(buildApp(prisma))
      .post("/api/setup/claim")
      .send({ code: "DRPL-7K2Q-9F4M" });

    expect(res.status).toBe(200);
    expect(res.body.claimed).toBe(true);
    expect(res.body.already_claimed).toBe(true);
    expect(res.body.next_step).toBe("account");
  });

  it("returns 429 when the rate-limit budget is exhausted, without touching the DB", async () => {
    mockCacheGet.mockResolvedValue(999); // way over budget
    const prisma = createPrismaMock();
    prisma.claimCode._seed({ codeHash: hashClaimCode("DRPL-7K2Q-9F4M") });
    const findSpy = vi.spyOn(prisma.claimCode, "findFirst");

    const res = await request(buildApp(prisma))
      .post("/api/setup/claim")
      .send({ code: "DRPL-7K2Q-9F4M" });

    expect(res.status).toBe(429);
    expect(findSpy).not.toHaveBeenCalled();
  });

  it("rejects a missing/empty code with a 400 validation error", async () => {
    const res = await request(buildApp(createPrismaMock()))
      .post("/api/setup/claim")
      .send({});
    expect(res.status).toBe(400);
  });
});
