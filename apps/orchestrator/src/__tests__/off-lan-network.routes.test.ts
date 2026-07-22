/**
 * WARP-468 — /api/network/off-lan{,-sample,-sample-batch}.
 *
 * Same harness pattern as network-throughput.routes.test.ts (WARP-470).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false, agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));

import { createOffLanNetworkRouter } from "../routes/off-lan-network.js";
import type { AuthUser } from "../middleware/auth.js";

interface MockSample {
  ts: Date;
  channel: string;
  bytes: bigint;
}

function createPrismaMock(initial: MockSample[] = []) {
  const samples = [...initial];
  return {
    samples,
    offLanEgressSample: {
      findMany: vi.fn(
        async ({
          where,
          orderBy,
        }: {
          where?: { ts?: { gte?: Date; lte?: Date }; channel?: string };
          orderBy?: unknown;
        }) => {
          void orderBy;
          const gte = where?.ts?.gte;
          const lte = where?.ts?.lte;
          const ch = where?.channel;
          return samples
            .filter((s) => (gte ? s.ts >= gte : true))
            .filter((s) => (lte ? s.ts <= lte : true))
            .filter((s) => (ch ? s.channel === ch : true))
            .sort((a, b) => a.ts.getTime() - b.ts.getTime());
        },
      ),
      create: vi.fn(async ({ data }: { data: MockSample }) => {
        samples.push({ ts: data.ts, channel: data.channel, bytes: data.bytes });
        return data;
      }),
      createMany: vi.fn(
        async ({
          data,
          skipDuplicates,
        }: {
          data: MockSample[];
          skipDuplicates?: boolean;
        }) => {
          void skipDuplicates;
          for (const d of data) {
            samples.push({ ts: d.ts, channel: d.channel, bytes: d.bytes });
          }
          return { count: data.length };
        },
      ),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
  };
}

function mkUser(role: AuthUser["role"], username = "stefan"): AuthUser {
  return { id: `user-${role}`, username, displayName: username, role };
}

function buildApp(
  prismaMock: ReturnType<typeof createPrismaMock>,
  user: AuthUser,
) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = user;
    next();
  });
  app.use("/api", createOffLanNetworkRouter(prismaMock as unknown as import("@prisma/client").PrismaClient));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("WARP-468 — GET /api/network/off-lan", () => {
  it("returns zero totals for every channel when no samples exist", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, mkUser("family"));
    const res = await request(app).get("/api/network/off-lan");
    expect(res.status).toBe(200);
    expect(res.body.totalsByChannel).toEqual({
      software_updates: 0,
      cloud_model_escape: 0,
      outbound_email: 0,
      telemetry: 0,
      web_fetch: 0,
      ambient_data: 0,
    });
    expect(res.body.sampleCount).toBe(0);
  });

  it("aggregates bytes per channel inside the from/to window", async () => {
    const ts1 = new Date("2026-05-27T10:00:00Z");
    const ts2 = new Date("2026-05-27T10:01:00Z");
    const tsBefore = new Date("2026-05-01T00:00:00Z");
    const prisma = createPrismaMock([
      { ts: ts1, channel: "cloud_model_escape", bytes: 1_000n },
      { ts: ts2, channel: "cloud_model_escape", bytes: 500n },
      { ts: ts1, channel: "outbound_email", bytes: 200n },
      { ts: tsBefore, channel: "outbound_email", bytes: 9_999_999n }, // out of window
    ]);
    const app = buildApp(prisma, mkUser("family"));
    const res = await request(app).get(
      `/api/network/off-lan?from=${encodeURIComponent("2026-05-27T00:00:00.000Z")}&to=${encodeURIComponent("2026-05-27T23:59:59.000Z")}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.totalsByChannel.cloud_model_escape).toBe(1500);
    expect(res.body.totalsByChannel.outbound_email).toBe(200);
    expect(res.body.totalsByChannel.web_fetch).toBe(0);
  });

  it("supports ?channel= filtering", async () => {
    const ts = new Date("2026-05-27T10:00:00Z");
    const prisma = createPrismaMock([
      { ts, channel: "cloud_model_escape", bytes: 1000n },
      { ts, channel: "outbound_email", bytes: 2000n },
    ]);
    const app = buildApp(prisma, mkUser("family"));
    // Pin the window to the seeded sample's day — the route's default
    // window is month-to-date off the REAL clock, so an unpinned query
    // breaks every calendar-month rollover after the fixture date.
    const res = await request(app).get(
      `/api/network/off-lan?channel=cloud_model_escape&from=${encodeURIComponent("2026-05-27T00:00:00.000Z")}&to=${encodeURIComponent("2026-05-27T23:59:59.000Z")}`,
    );
    expect(res.status).toBe(200);
    // Other channels still shown as 0 — the chart wants all 5 bars.
    expect(res.body.totalsByChannel.cloud_model_escape).toBe(1000);
    expect(res.body.totalsByChannel.outbound_email).toBe(0);
  });

  it("rejects an unknown ?channel= value with 400", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, mkUser("family"));
    const res = await request(app).get(
      "/api/network/off-lan?channel=quantum_teleport",
    );
    expect(res.status).toBe(400);
  });

  it("rejects to <= from with 400", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, mkUser("family"));
    const res = await request(app).get(
      `/api/network/off-lan?from=${encodeURIComponent("2026-05-27T00:00:00.000Z")}&to=${encodeURIComponent("2026-05-26T00:00:00.000Z")}`,
    );
    expect(res.status).toBe(400);
  });
});

describe("WARP-468 — POST /api/network/off-lan-sample", () => {
  it("service role can push a sample with numeric bytes", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, mkUser("service", "_service"));
    const res = await request(app)
      .post("/api/network/off-lan-sample")
      .send({ channel: "cloud_model_escape", bytes: 4096 });
    expect(res.status).toBe(201);
    expect(prisma.samples).toHaveLength(1);
    expect(prisma.samples[0]?.bytes).toBe(4096n);
  });

  it("accepts string-typed bytes for safe BigInt round-trip", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, mkUser("service", "_service"));
    const res = await request(app)
      .post("/api/network/off-lan-sample")
      .send({ channel: "telemetry", bytes: "9999999999999" });
    expect(res.status).toBe(201);
    expect(prisma.samples[0]?.bytes).toBe(9999999999999n);
  });

  it("rejects family role with 403", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, mkUser("family"));
    const res = await request(app)
      .post("/api/network/off-lan-sample")
      .send({ channel: "telemetry", bytes: 0 });
    expect(res.status).toBe(403);
  });

  it("rejects unknown channel with 400", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, mkUser("service", "_service"));
    const res = await request(app)
      .post("/api/network/off-lan-sample")
      .send({ channel: "quantum_teleport", bytes: 100 });
    expect(res.status).toBe(400);
  });

  it("rejects negative bytes with 400", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, mkUser("service", "_service"));
    const res = await request(app)
      .post("/api/network/off-lan-sample")
      .send({ channel: "telemetry", bytes: -1 });
    expect(res.status).toBe(400);
  });
});

describe("WARP-468 — POST /api/network/off-lan-sample-batch", () => {
  it("inserts all five channels atomically", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, mkUser("service", "_service"));
    const res = await request(app)
      .post("/api/network/off-lan-sample-batch")
      .send({
        samples: [
          { channel: "software_updates", bytes: 1 },
          { channel: "cloud_model_escape", bytes: 2 },
          { channel: "outbound_email", bytes: 3 },
          { channel: "telemetry", bytes: 4 },
          { channel: "web_fetch", bytes: 5 },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.count).toBe(5);
    expect(prisma.samples).toHaveLength(5);
  });

  it("rejects empty batch with 400", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, mkUser("service", "_service"));
    const res = await request(app)
      .post("/api/network/off-lan-sample-batch")
      .send({ samples: [] });
    expect(res.status).toBe(400);
  });

  it("rejects oversized batch (>64) with 400", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, mkUser("service", "_service"));
    const samples = Array.from({ length: 65 }, () => ({
      channel: "telemetry",
      bytes: 1,
    }));
    const res = await request(app)
      .post("/api/network/off-lan-sample-batch")
      .send({ samples });
    expect(res.status).toBe(400);
  });
});
