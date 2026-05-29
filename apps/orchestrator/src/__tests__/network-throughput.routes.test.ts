/**
 * WARP-470 — /api/network/{summary, throughput, throughput-sample}
 * route coverage (Phase F2).
 *
 * Pattern mirrors hardware.routes.test.ts + home.routes.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false },
}));

import { createNetworkThroughputRouter } from "../routes/network-throughput.js";
import type { AuthUser } from "../middleware/auth.js";

interface MockSample {
  ts: Date;
  wanDownBps: bigint;
  wanUpBps: bigint;
}

function createPrismaMock(over: {
  samples?: MockSample[];
  clientCount?: number;
} = {}) {
  const samples = [...(over.samples ?? [])];
  return {
    samples,
    networkThroughputSample: {
      findFirst: vi.fn(async ({ orderBy }: { orderBy?: unknown }) => {
        void orderBy;
        if (samples.length === 0) return null;
        const sorted = [...samples].sort((a, b) => b.ts.getTime() - a.ts.getTime());
        return sorted[0];
      }),
      findMany: vi.fn(
        async ({
          where,
          orderBy,
          take,
        }: {
          where?: { ts?: { gte?: Date } };
          orderBy?: unknown;
          take?: number;
        }) => {
          void orderBy;
          const since = where?.ts?.gte;
          const filtered = since ? samples.filter((s) => s.ts >= since) : samples;
          const sorted = [...filtered].sort((a, b) => a.ts.getTime() - b.ts.getTime());
          return take ? sorted.slice(0, take) : sorted;
        },
      ),
      create: vi.fn(async ({ data }: { data: MockSample }) => {
        samples.push({
          ts: data.ts,
          wanDownBps: data.wanDownBps,
          wanUpBps: data.wanUpBps,
        });
        return data;
      }),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    networkDevice: {
      count: vi.fn(async () => over.clientCount ?? 0),
    },
  };
}

function mkUser(role: string, username = "stefan"): AuthUser {
  return {
    id: `user-${role}`,
    username,
    displayName: username,
    role: role as AuthUser["role"],
  };
}

function buildApp(
  prismaMock: ReturnType<typeof createPrismaMock>,
  asUser: AuthUser,
) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = asUser;
    next();
  });
  app.use("/api", createNetworkThroughputRouter(prismaMock as unknown as import("@prisma/client").PrismaClient));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("WARP-470 — /api/network/summary", () => {
  it("returns latest-sample bps + client count + placeholders", async () => {
    const prisma = createPrismaMock({
      samples: [
        { ts: new Date("2026-05-27T10:00:00Z"), wanDownBps: 50_000_000n, wanUpBps: 5_000_000n },
        { ts: new Date("2026-05-27T10:01:00Z"), wanDownBps: 80_000_000n, wanUpBps: 7_500_000n },
      ],
      clientCount: 18,
    });
    const app = buildApp(prisma, mkUser("family", "stefan"));
    const res = await request(app).get("/api/network/summary");
    expect(res.status).toBe(200);
    expect(res.body.wanDownBps).toBe(80_000_000);
    expect(res.body.wanUpBps).toBe(7_500_000);
    expect(res.body.clientCount).toBe(18);
    expect(res.body.dnsBlockedToday).toBe(0);
    expect(res.body.offLanBytesThisMonth).toBe(0);
    expect(res.body.lastSampleAt).toBe("2026-05-27T10:01:00.000Z");
  });

  it("returns 0 bps + null lastSampleAt when no samples exist", async () => {
    const prisma = createPrismaMock({ clientCount: 5 });
    const app = buildApp(prisma, mkUser("family", "stefan"));
    const res = await request(app).get("/api/network/summary");
    expect(res.status).toBe(200);
    expect(res.body.wanDownBps).toBe(0);
    expect(res.body.wanUpBps).toBe(0);
    expect(res.body.lastSampleAt).toBeNull();
    expect(res.body.clientCount).toBe(5);
  });
});

describe("WARP-470 — /api/network/throughput", () => {
  it("returns the 24h window by default", async () => {
    const now = Date.now();
    const prisma = createPrismaMock({
      samples: [
        { ts: new Date(now - 30 * 60 * 1000), wanDownBps: 10n, wanUpBps: 1n },
        { ts: new Date(now - 2 * 60 * 60 * 1000), wanDownBps: 20n, wanUpBps: 2n },
        { ts: new Date(now - 25 * 60 * 60 * 1000), wanDownBps: 30n, wanUpBps: 3n },
      ],
    });
    const app = buildApp(prisma, mkUser("family", "stefan"));
    const res = await request(app).get("/api/network/throughput");
    expect(res.status).toBe(200);
    expect(res.body.window).toBe("24h");
    expect(res.body.samples).toHaveLength(2);
    expect(res.body.samples[0]?.wanDownBps).toBe(20);
  });

  it("respects ?window=1h narrowing", async () => {
    const now = Date.now();
    const prisma = createPrismaMock({
      samples: [
        { ts: new Date(now - 30 * 60 * 1000), wanDownBps: 10n, wanUpBps: 1n },
        { ts: new Date(now - 2 * 60 * 60 * 1000), wanDownBps: 20n, wanUpBps: 2n },
      ],
    });
    const app = buildApp(prisma, mkUser("family", "stefan"));
    const res = await request(app).get("/api/network/throughput?window=1h");
    expect(res.status).toBe(200);
    expect(res.body.window).toBe("1h");
    expect(res.body.samples).toHaveLength(1);
  });

  it("rejects an unknown window value with 400", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, mkUser("family", "stefan"));
    const res = await request(app).get("/api/network/throughput?window=99h");
    expect(res.status).toBe(400);
  });
});

describe("WARP-470 — POST /api/network/throughput-sample", () => {
  it("service role can push a sample with numeric bps", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, mkUser("service", "_service"));
    const res = await request(app)
      .post("/api/network/throughput-sample")
      .send({ wanDownBps: 1_500_000, wanUpBps: 500_000 });
    expect(res.status).toBe(201);
    expect(prisma.samples).toHaveLength(1);
    expect(prisma.samples[0]?.wanDownBps).toBe(1_500_000n);
  });

  it("accepts string-typed bps for safe BigInt round-trip", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, mkUser("service", "_service"));
    const res = await request(app)
      .post("/api/network/throughput-sample")
      .send({ wanDownBps: "9999999999999", wanUpBps: "1234567890" });
    expect(res.status).toBe(201);
    expect(prisma.samples[0]?.wanDownBps).toBe(9999999999999n);
  });

  it("rejects non-service-role pushes with 403", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, mkUser("family", "stefan"));
    const res = await request(app)
      .post("/api/network/throughput-sample")
      .send({ wanDownBps: 0, wanUpBps: 0 });
    expect(res.status).toBe(403);
  });

  it("rejects malformed body with 400", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, mkUser("service", "_service"));
    const res = await request(app)
      .post("/api/network/throughput-sample")
      .send({ wanDownBps: -1, wanUpBps: 0 });
    expect(res.status).toBe(400);
  });

  it("honors explicit ts when caller provides one", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, mkUser("service", "_service"));
    const res = await request(app)
      .post("/api/network/throughput-sample")
      .send({ wanDownBps: 1000, wanUpBps: 500, ts: "2026-05-27T09:00:00.000Z" });
    expect(res.status).toBe(201);
    expect(res.body.ts).toBe("2026-05-27T09:00:00.000Z");
  });
});
