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

interface DnsBlockRow {
  ts: Date;
  blockedCount: number;
}

function createPrismaMock(over: {
  samples?: MockSample[];
  clientCount?: number;
  offLanBytesSum?: bigint | null;
  dnsBlockedSum?: number | null;
} = {}) {
  const samples = [...(over.samples ?? [])];
  const dnsBlockSamples: DnsBlockRow[] = [];
  return {
    samples,
    dnsBlockSamples,
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
    offLanEgressSample: {
      aggregate: vi.fn(async () => ({
        _sum: { bytes: over.offLanBytesSum ?? null },
      })),
    },
    dnsBlockSample: {
      aggregate: vi.fn(async () => ({
        _sum: { blockedCount: over.dnsBlockedSum ?? null },
      })),
      create: vi.fn(async ({ data }: { data: DnsBlockRow }) => {
        dnsBlockSamples.push({
          ts: data.ts,
          blockedCount: data.blockedCount,
        });
        return data;
      }),
      // Mirrors the production createMany({ skipDuplicates: true }) on the
      // `ts` PK: a row whose ts already exists is silently dropped, so a
      // replayed timestamp can't 500 or duplicate. Returns { count } of
      // rows actually inserted, matching Prisma's BatchPayload.
      createMany: vi.fn(
        async ({
          data,
          skipDuplicates,
        }: {
          data: DnsBlockRow[];
          skipDuplicates?: boolean;
        }) => {
          let inserted = 0;
          for (const row of data) {
            const dup = dnsBlockSamples.some(
              (s) => s.ts.getTime() === row.ts.getTime(),
            );
            if (dup && skipDuplicates) continue;
            dnsBlockSamples.push({ ts: row.ts, blockedCount: row.blockedCount });
            inserted += 1;
          }
          return { count: inserted };
        },
      ),
      deleteMany: vi.fn(async () => ({ count: 0 })),
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
  it("returns latest-sample bps + client count + real off-LAN + DNS-block totals", async () => {
    const prisma = createPrismaMock({
      samples: [
        { ts: new Date("2026-05-27T10:00:00Z"), wanDownBps: 50_000_000n, wanUpBps: 5_000_000n },
        { ts: new Date("2026-05-27T10:01:00Z"), wanDownBps: 80_000_000n, wanUpBps: 7_500_000n },
      ],
      clientCount: 18,
      offLanBytesSum: 987_654n,
      dnsBlockedSum: 73,
    });
    const app = buildApp(prisma, mkUser("family", "stefan"));
    const res = await request(app).get("/api/network/summary");
    expect(res.status).toBe(200);
    expect(res.body.wanDownBps).toBe(80_000_000);
    expect(res.body.wanUpBps).toBe(7_500_000);
    expect(res.body.clientCount).toBe(18);
    expect(res.body.dnsBlockedToday).toBe(73);
    expect(res.body.offLanBytesThisMonth).toBe(987_654);
    expect(res.body.lastSampleAt).toBe("2026-05-27T10:01:00.000Z");
  });

  it("sums offLanEgressSample bytes month-to-date", async () => {
    const prisma = createPrismaMock({ offLanBytesSum: 123_456n });
    const app = buildApp(prisma, mkUser("family", "stefan"));
    const res = await request(app).get("/api/network/summary");
    expect(res.status).toBe(200);
    expect(res.body.offLanBytesThisMonth).toBe(123_456);
    // Aggregate runs with a month-start lower bound, not the latest row.
    expect(prisma.offLanEgressSample.aggregate).toHaveBeenCalledTimes(1);
    // Guard the date-bound where clause: a regression that drops the
    // month-start filter (returning an all-time total) would otherwise be
    // invisible because the mock's return value is argument-independent.
    expect(prisma.offLanEgressSample.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          ts: expect.objectContaining({
            gte: expect.any(Date),
            lte: expect.any(Date),
          }),
        }),
      }),
    );
  });

  it("sums dnsBlockSample blockedCount day-to-date", async () => {
    const prisma = createPrismaMock({ dnsBlockedSum: 42 });
    const app = buildApp(prisma, mkUser("family", "stefan"));
    const res = await request(app).get("/api/network/summary");
    expect(res.status).toBe(200);
    expect(res.body.dnsBlockedToday).toBe(42);
    expect(prisma.dnsBlockSample.aggregate).toHaveBeenCalledTimes(1);
    // Guard the date-bound where clause: a regression that drops the
    // day-start filter (returning an all-time blocked count) would
    // otherwise be invisible because the mock's return value is
    // argument-independent.
    expect(prisma.dnsBlockSample.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          ts: expect.objectContaining({
            gte: expect.any(Date),
            lte: expect.any(Date),
          }),
        }),
      }),
    );
  });

  it("returns 0 dnsBlockedToday/offLanBytesThisMonth when aggregates are null", async () => {
    const prisma = createPrismaMock({
      samples: [
        { ts: new Date("2026-05-27T10:00:00Z"), wanDownBps: 1n, wanUpBps: 1n },
      ],
      offLanBytesSum: null,
      dnsBlockedSum: null,
    });
    const app = buildApp(prisma, mkUser("family", "stefan"));
    const res = await request(app).get("/api/network/summary");
    expect(res.status).toBe(200);
    expect(res.body.dnsBlockedToday).toBe(0);
    expect(res.body.offLanBytesThisMonth).toBe(0);
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

describe("WARP-468 — POST /api/network/dns-block-sample", () => {
  it("service role can push a numeric blockedCount", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, mkUser("service", "_service"));
    const res = await request(app)
      .post("/api/network/dns-block-sample")
      .send({ blockedCount: 17 });
    expect(res.status).toBe(201);
    expect(prisma.dnsBlockSamples).toHaveLength(1);
    expect(prisma.dnsBlockSamples[0]?.blockedCount).toBe(17);
  });

  it("rejects non-service-role pushes with 403", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, mkUser("family", "stefan"));
    const res = await request(app)
      .post("/api/network/dns-block-sample")
      .send({ blockedCount: 0 });
    expect(res.status).toBe(403);
  });

  it("rejects a negative blockedCount with 400", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, mkUser("service", "_service"));
    const res = await request(app)
      .post("/api/network/dns-block-sample")
      .send({ blockedCount: -1 });
    expect(res.status).toBe(400);
  });

  it("is idempotent on a replayed ts — no 500, no duplicate row", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, mkUser("service", "_service"));
    const ts = "2026-05-27T10:00:00.000Z";
    const first = await request(app)
      .post("/api/network/dns-block-sample")
      .send({ blockedCount: 9, ts });
    expect(first.status).toBe(201);
    // Same ts replayed (retry / restart race / deliberate replay): the
    // ts PK would collide with P2002 → 500 under a bare create(). With
    // createMany({ skipDuplicates: true }) the replay is a clean 201 and
    // the row count stays at 1.
    const second = await request(app)
      .post("/api/network/dns-block-sample")
      .send({ blockedCount: 9, ts });
    expect(second.status).toBe(201);
    expect(prisma.dnsBlockSamples).toHaveLength(1);
  });
});
