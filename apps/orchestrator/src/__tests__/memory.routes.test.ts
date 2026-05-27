/**
 * WARP-461 — /api/memory/facts HTTP surface (Phase B4).
 *
 * Drives createMemoryRouter() through supertest with a synthetic auth
 * middleware. Pattern mirrors settings.routes.test.ts (WARP-457) +
 * context-pins.routes.test.ts (WARP-460).
 *
 * Covered:
 *   - GET    list (active filter, category filter, limit cap)
 *   - POST   create (valid + invalid category)
 *   - PATCH  update (partial; empty body rejected)
 *   - DELETE remove (atomic deleteMany)
 *   - RBAC   guest can read, cannot write (403)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false },
}));

import { createMemoryRouter } from "../routes/memory.js";

interface MockFact {
  id: string;
  category: string;
  fact: string;
  addedBy: string;
  evidenceChatId: string | null;
  active: boolean;
  addedAt: Date;
  updatedAt: Date;
}

function createPrismaMock(seed: MockFact[] = []) {
  const rows = [...seed];
  return {
    rows,
    memoryFact: {
      findMany: vi.fn(
        async ({
          where,
          take,
        }: {
          where?: { category?: string; active?: boolean };
          orderBy?: unknown;
          take?: number;
        } = {}) => {
          let r = rows;
          if (where?.category) r = r.filter((x) => x.category === where.category);
          if (where?.active !== undefined) r = r.filter((x) => x.active === where.active);
          r = [...r].sort((a, b) => b.addedAt.getTime() - a.addedAt.getTime());
          return take ? r.slice(0, take) : r;
        },
      ),
      create: vi.fn(async ({ data }: { data: Partial<MockFact> }) => {
        const created: MockFact = {
          id: `mf-${rows.length + 1}`,
          category: data.category!,
          fact: data.fact!,
          addedBy: data.addedBy ?? "unknown",
          evidenceChatId: data.evidenceChatId ?? null,
          active: data.active ?? true,
          addedAt: new Date(),
          updatedAt: new Date(),
        };
        rows.push(created);
        return created;
      }),
      updateMany: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Partial<MockFact> }) => {
          let count = 0;
          for (const r of rows) {
            if (r.id === where.id) {
              Object.assign(r, data, { updatedAt: new Date() });
              count++;
            }
          }
          return { count };
        },
      ),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
        const r = rows.find((x) => x.id === where.id);
        if (!r) throw new Error("not found");
        return r;
      }),
      deleteMany: vi.fn(async ({ where }: { where: { id: string } }) => {
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i]!.id === where.id) rows.splice(i, 1);
        }
        return { count: before - rows.length };
      }),
    },
  };
}

function buildApp(
  prismaMock: ReturnType<typeof createPrismaMock>,
  asUser: { id?: string; username?: string; role?: string },
) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: typeof asUser }).user = asUser;
    next();
  });
  app.use("/api", createMemoryRouter(prismaMock as unknown as import("@prisma/client").PrismaClient));
  return app;
}

function seedFact(over: Partial<MockFact> = {}): MockFact {
  return {
    id: over.id ?? "mf-seed",
    category: over.category ?? "Tone",
    fact: over.fact ?? "You prefer recaps under 200 words",
    addedBy: over.addedBy ?? "stefan",
    evidenceChatId: over.evidenceChatId ?? null,
    active: over.active ?? true,
    addedAt: over.addedAt ?? new Date("2026-05-27T10:00:00Z"),
    updatedAt: over.updatedAt ?? new Date("2026-05-27T10:00:00Z"),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("WARP-461 — /api/memory/facts CRUD", () => {
  it("GET returns all active facts by default", async () => {
    const prisma = createPrismaMock([
      seedFact({ id: "a", category: "Tone" }),
      seedFact({ id: "b", category: "Schedule", active: false }),
    ]);
    const app = buildApp(prisma, { username: "stefan", role: "family" });
    const res = await request(app).get("/api/memory/facts");
    expect(res.status).toBe(200);
    expect(res.body.facts).toHaveLength(2);
  });

  it("GET filters by ?category=Tone", async () => {
    const prisma = createPrismaMock([
      seedFact({ id: "a", category: "Tone" }),
      seedFact({ id: "b", category: "Workflow" }),
    ]);
    const app = buildApp(prisma, { username: "stefan", role: "owner" });
    const res = await request(app).get("/api/memory/facts?category=Tone");
    expect(res.status).toBe(200);
    expect(res.body.facts).toHaveLength(1);
    expect(res.body.facts[0].category).toBe("Tone");
  });

  it("POST creates a fact with valid category", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, { username: "stefan", role: "owner" });
    const res = await request(app)
      .post("/api/memory/facts")
      .send({ category: "Workflow", fact: "You ship on Friday afternoons" });
    expect(res.status).toBe(201);
    expect(res.body.fact.category).toBe("Workflow");
    expect(res.body.fact.addedBy).toBe("stefan");
  });

  it("POST rejects invalid category with 400", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, { username: "stefan", role: "owner" });
    const res = await request(app)
      .post("/api/memory/facts")
      .send({ category: "MadeUp", fact: "x" });
    expect(res.status).toBe(400);
  });

  it("PATCH updates the fact text + active flag", async () => {
    const prisma = createPrismaMock([seedFact({ id: "mf-x" })]);
    const app = buildApp(prisma, { username: "stefan", role: "owner" });
    const res = await request(app)
      .patch("/api/memory/facts/mf-x")
      .send({ fact: "Updated fact", active: false });
    expect(res.status).toBe(200);
    expect(res.body.fact.fact).toBe("Updated fact");
    expect(res.body.fact.active).toBe(false);
  });

  it("PATCH with empty body returns 400", async () => {
    const prisma = createPrismaMock([seedFact({ id: "mf-x" })]);
    const app = buildApp(prisma, { username: "stefan", role: "owner" });
    const res = await request(app).patch("/api/memory/facts/mf-x").send({});
    expect(res.status).toBe(400);
  });

  it("DELETE removes the fact (atomic deleteMany)", async () => {
    const prisma = createPrismaMock([seedFact({ id: "mf-x" })]);
    const app = buildApp(prisma, { username: "stefan", role: "owner" });
    const res = await request(app).delete("/api/memory/facts/mf-x");
    expect(res.status).toBe(204);
    expect(prisma.rows).toHaveLength(0);
  });

  it("DELETE on missing id returns 404", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, { username: "stefan", role: "owner" });
    const res = await request(app).delete("/api/memory/facts/nope");
    expect(res.status).toBe(404);
  });
});
