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

// WARP-631 — deterministic, per-key in-memory cache so the progressive-backoff
// rate limiter is testable end-to-end. The route keys two values per IP:
//   ratelimit:setup-claim:fails:<ip>  — running wrong-code count
//   ratelimit:setup-claim:lock:<ip>   — locked-until epoch ms
// A real store (not a single fixed return) lets a sequence of wrong codes
// actually accumulate, so we can assert the 4th wrong code locks (AC#1) and the
// lock escalates (AC#2). `__store` / `__failNext` are test hooks.
vi.mock("../services/cache.service.js", () => {
  const store = new Map<string, unknown>();
  let failNext = false;
  return {
    __store: store,
    /** Force the NEXT cache op to throw, to exercise the fail-OPEN paths. */
    __failNext: () => {
      failNext = true;
    },
    cacheGet: vi.fn(async (key: string) => {
      if (failNext) {
        failNext = false;
        throw new Error("redis down");
      }
      return store.has(key) ? store.get(key) : null;
    }),
    cacheSet: vi.fn(async (key: string, value: unknown) => {
      if (failNext) {
        failNext = false;
        throw new Error("redis down");
      }
      store.set(key, value);
    }),
    cacheDel: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
});

// The appliance contract best-effort enriches `network` from the routing
// service. In a unit test there's no router, and the real client would retry +
// time out — simulate the single-box "router offline" path so the contract
// falls back to its placeholder network spec deterministically.
vi.mock("../services/openwrt.client.js", () => ({
  fetchNetworkSummary: vi.fn().mockRejectedValue(new Error("router offline")),
}));

import * as cacheService from "../services/cache.service.js";
import { createSetupRouter } from "./setup.js";
import { hashClaimCode } from "../services/setup-claim.service.js";

// The per-key store + fail hook installed by the mock factory above.
const cacheStore = (cacheService as unknown as { __store: Map<string, unknown> })
  .__store;
const failNextCacheOp = (cacheService as unknown as { __failNext: () => void })
  .__failNext;
const FAILS_KEY = (ip: string) => `ratelimit:setup-claim:fails:${ip}`;
const LOCK_KEY = (ip: string) => `ratelimit:setup-claim:lock:${ip}`;

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
    cacheStore.clear();
  });
  afterEach(() => {
    delete process.env.DEVICE_SECRET;
    cacheStore.clear();
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
    cacheStore.clear(); // no failures / no lock to start
  });
  afterEach(() => {
    delete process.env.DEVICE_SECRET;
    cacheStore.clear();
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

  it("returns 429 while an active lock holds, without touching the DB (WARP-631)", async () => {
    // Simulate an active lock: locked-until 20s in the future.
    cacheStore.set(LOCK_KEY("::ffff:127.0.0.1"), Date.now() + 20_000);
    cacheStore.set(LOCK_KEY("127.0.0.1"), Date.now() + 20_000);
    const prisma = createPrismaMock();
    prisma.claimCode._seed({ codeHash: hashClaimCode("DRPL-7K2Q-9F4M") });
    const findSpy = vi.spyOn(prisma.claimCode, "findFirst");

    const res = await request(buildApp(prisma))
      .post("/api/setup/claim")
      .send({ code: "DRPL-7K2Q-9F4M" }); // even a CORRECT code is held off

    expect(res.status).toBe(429);
    expect(res.body.code).toBe("CLAIM_RATE_LIMITED");
    expect(res.body.retryAfterSeconds).toBeGreaterThan(0);
    expect(res.body.retryAfterSeconds).toBeLessThanOrEqual(20);
    expect(res.headers["retry-after"]).toBeDefined();
    // The lock is enforced BEFORE any DB read.
    expect(findSpy).not.toHaveBeenCalled();
  });

  it("rejects a missing/empty code with a 400 validation error", async () => {
    const res = await request(buildApp(createPrismaMock()))
      .post("/api/setup/claim")
      .send({});
    expect(res.status).toBe(400);
  });

  // ── WARP-631 — progressive backoff ───────────────────────────────

  it("forgives 3 wrong codes (400) then locks the 4th with 429 + Retry-After≈15 (AC#1)", async () => {
    const prisma = createPrismaMock();
    prisma.claimCode._seed({ codeHash: hashClaimCode("DRPL-7K2Q-9F4M") });
    const app = buildApp(prisma);
    const wrong = () =>
      request(app).post("/api/setup/claim").send({ code: "WRON-GGGG-GGGG" });

    // First three wrong codes → inline 400 CLAIM_CODE_INVALID, no lock.
    for (let i = 1; i <= 3; i += 1) {
      const r = await wrong();
      expect(r.status, `attempt ${i}`).toBe(400);
      expect(r.body.code).toBe("CLAIM_CODE_INVALID");
    }

    // The 4th wrong code → 429 with retryAfterSeconds ≈ 15 + a Retry-After header.
    const fourth = await wrong();
    expect(fourth.status).toBe(429);
    expect(fourth.body.code).toBe("CLAIM_RATE_LIMITED");
    expect(fourth.body.retryAfterSeconds).toBeGreaterThan(0);
    expect(fourth.body.retryAfterSeconds).toBeLessThanOrEqual(15);
    expect(fourth.headers["retry-after"]).toBe(String(fourth.body.retryAfterSeconds));
    // The real code is still untouched — it was never consumed.
    expect(prisma.claimCode._rows()[0].state).toBe("available");
  });

  it("escalates the lock 15 → 30 on successive lockouts (AC#2)", async () => {
    const prisma = createPrismaMock();
    prisma.claimCode._seed({ codeHash: hashClaimCode("DRPL-7K2Q-9F4M") });
    const app = buildApp(prisma);
    // supertest connects over loopback, so the route sees this as req.ip.
    const ip = "::ffff:127.0.0.1";

    // Drive failures by writing the counter directly, then asserting the lock
    // duration the NEXT wrong code applies (so we don't have to wait out a real
    // lock between assertions). After 4 fails → 15s; after 5 fails → 30s.
    const wrong = () =>
      request(app).post("/api/setup/claim").send({ code: "WRON-GGGG-GGGG" });

    // Seed the counter at 3 so the next wrong code is the 4th (first lock=15s),
    // and clear any lock so the request isn't held off first.
    cacheStore.set(FAILS_KEY(ip), 3);
    cacheStore.delete(LOCK_KEY(ip));
    let r = await wrong();
    expect(r.status).toBe(429);
    expect(r.body.retryAfterSeconds).toBeLessThanOrEqual(15);
    expect(r.body.retryAfterSeconds).toBeGreaterThan(10);

    // Now seed at 4 and clear the lock → next wrong code is the 5th (30s).
    cacheStore.set(FAILS_KEY(ip), 4);
    cacheStore.delete(LOCK_KEY(ip));
    r = await wrong();
    expect(r.status).toBe(429);
    expect(r.body.retryAfterSeconds).toBeLessThanOrEqual(30);
    expect(r.body.retryAfterSeconds).toBeGreaterThan(15);
  });

  it("a correct code while unlocked clears the failure + lock counters (AC#3)", async () => {
    const prisma = createPrismaMock();
    prisma.claimCode._seed({ codeHash: hashClaimCode("DRPL-7K2Q-9F4M") });
    const app = buildApp(prisma);

    // Two wrong codes accrue a non-zero counter (still within the free tier).
    await request(app).post("/api/setup/claim").send({ code: "WRON-GGGG-GGGG" });
    await request(app).post("/api/setup/claim").send({ code: "WRON-GGGG-GGGG" });
    // Some fails key now exists.
    expect([...cacheStore.keys()].some((k) => k.includes(":fails:"))).toBe(true);

    // Correct code → 200 and the rate state is wiped.
    const ok = await request(app)
      .post("/api/setup/claim")
      .send({ code: "DRPL-7K2Q-9F4M" });
    expect(ok.status).toBe(200);
    expect(ok.body.claimed).toBe(true);
    expect([...cacheStore.keys()].some((k) => k.includes(":fails:"))).toBe(false);
    expect([...cacheStore.keys()].some((k) => k.includes(":lock:"))).toBe(false);
  });

  it("an already-claimed re-run also clears the rate state (WARP-631)", async () => {
    const prisma = createPrismaMock();
    prisma.claimCode._seed({
      codeHash: hashClaimCode("DRPL-7K2Q-9F4M"),
      state: "consumed",
      usedAt: new Date(),
    });
    const app = buildApp(prisma);
    // Pre-seed a stale failure counter (e.g. earlier fat-fingering).
    await request(app).post("/api/setup/claim").send({ code: "WRON-GGGG-GGGG" });

    const ok = await request(app)
      .post("/api/setup/claim")
      .send({ code: "DRPL-7K2Q-9F4M" });
    expect(ok.status).toBe(200);
    expect(ok.body.already_claimed).toBe(true);
    expect([...cacheStore.keys()].some((k) => k.includes(":fails:"))).toBe(false);
  });

  it("fails OPEN — a wrong code is NOT locked when the cache read throws (AC#4)", async () => {
    const prisma = createPrismaMock();
    prisma.claimCode._seed({ codeHash: hashClaimCode("DRPL-7K2Q-9F4M") });
    const app = buildApp(prisma);

    // Force the lock-check cacheGet to throw → checkClaimLock must fail OPEN
    // (treat as not-locked) and the request proceeds to the DB, returning the
    // ordinary inline 400 for a wrong code rather than a false 429.
    failNextCacheOp();
    const r = await request(app)
      .post("/api/setup/claim")
      .send({ code: "WRON-GGGG-GGGG" });

    // Not a 429 — fail-open means no false lockout.
    expect(r.status).not.toBe(429);
    expect([400, 200]).toContain(r.status);
  });

  it("fails OPEN — a correct code still binds when the cache read throws (AC#4)", async () => {
    const prisma = createPrismaMock();
    prisma.claimCode._seed({ codeHash: hashClaimCode("DRPL-7K2Q-9F4M") });
    const app = buildApp(prisma);

    // A down cache on the lock-check path must never block a legitimate claim.
    failNextCacheOp();
    const r = await request(app)
      .post("/api/setup/claim")
      .send({ code: "DRPL-7K2Q-9F4M" });

    expect(r.status).toBe(200);
    expect(r.body.claimed).toBe(true);
  });
});

/**
 * WARP-867 — the resume pointer across claim re-runs. A wizard that cold
 * started from welcome (reboot raced the state probe) replays the claim step
 * on an already-claimed box; reconciling the pointer there must use FLOOR
 * semantics: heal a stranded early pointer forward, never drag a
 * further-along one back onto the unsatisfiable account step.
 */
describe("POST /api/setup/claim — resume-pointer floor on re-claim (WARP-867)", () => {
  beforeEach(() => {
    process.env.DEVICE_SECRET = "test-device-secret";
    cacheStore.clear();
  });
  afterEach(() => {
    delete process.env.DEVICE_SECRET;
    cacheStore.clear();
    vi.clearAllMocks();
  });

  it("does NOT regress a further-along pointer on an already-claimed re-run", async () => {
    const prisma = createPrismaMock();
    prisma.claimCode._seed({
      codeHash: hashClaimCode("DRPL-7K2Q-9F4M"),
      state: "consumed",
      usedAt: new Date(),
    });
    // The interrupted run got the customer to the internet step before the
    // reboot — that pointer is the only way back to where they were.
    await prisma.applianceSetup.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", setupStep: "internet" },
      update: { setupStep: "internet" },
    });

    const res = await request(buildApp(prisma))
      .post("/api/setup/claim")
      .send({ code: "DRPL-7K2Q-9F4M" });

    expect(res.status).toBe(200);
    expect(res.body.already_claimed).toBe(true);
    // The persisted pointer survives the replayed claim untouched.
    expect(
      (prisma._appliance() as { setupStep?: string } | null)?.setupStep,
    ).toBe("internet");
  });

  it("heals a pointer stranded BEFORE account on an already-claimed re-run", async () => {
    const prisma = createPrismaMock();
    prisma.claimCode._seed({
      codeHash: hashClaimCode("DRPL-7K2Q-9F4M"),
      state: "consumed",
      usedAt: new Date(),
    });
    // E.g. the original claim's best-effort step persist failed, leaving the
    // pointer at welcome on a claimed box.
    await prisma.applianceSetup.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", setupStep: "welcome" },
      update: { setupStep: "welcome" },
    });

    const res = await request(buildApp(prisma))
      .post("/api/setup/claim")
      .send({ code: "DRPL-7K2Q-9F4M" });

    expect(res.status).toBe(200);
    expect(res.body.already_claimed).toBe(true);
    // The pointer moved FORWARD onto the post-claim step.
    expect(
      (prisma._appliance() as { setupStep?: string } | null)?.setupStep,
    ).toBe("account");
  });
});
