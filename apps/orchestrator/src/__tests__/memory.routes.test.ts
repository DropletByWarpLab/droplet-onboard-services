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
import type { AuthUser } from "../middleware/auth.js";
import type { Role } from "../services/jwt.service.js";

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
  audience: "owner" | "admin" | "family" | "guest";
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
          where?: {
            category?: string;
            active?: boolean;
            audience?: { in: string[] };
          };
          orderBy?: unknown;
          take?: number;
        } = {}) => {
          let r = rows;
          if (where?.category) r = r.filter((x) => x.category === where.category);
          if (where?.active !== undefined) r = r.filter((x) => x.active === where.active);
          if (where?.audience) r = r.filter((x) => where.audience!.in.includes(x.audience));
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
          audience: data.audience ?? "family",
          addedAt: new Date(),
          updatedAt: new Date(),
        };
        rows.push(created);
        return created;
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; audience?: { in: string[] } };
          data: Partial<MockFact>;
        }) => {
          let count = 0;
          for (const r of rows) {
            if (
              r.id === where.id &&
              (!where.audience || where.audience.in.includes(r.audience))
            ) {
              Object.assign(r, data, { updatedAt: new Date() });
              count++;
            }
          }
          return { count };
        },
      ),
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
        return rows.find((x) => x.id === where.id) ?? null;
      }),
      deleteMany: vi.fn(
        async ({
          where,
        }: {
          where: { id: string; audience?: { in: string[] } };
        }) => {
          const before = rows.length;
          for (let i = rows.length - 1; i >= 0; i--) {
            if (
              rows[i]!.id === where.id &&
              (!where.audience || where.audience.in.includes(rows[i]!.audience))
            ) {
              rows.splice(i, 1);
            }
          }
          return { count: before - rows.length };
        },
      ),
    },
  };
}

function mkUser(role: Role, username?: string): AuthUser {
  const name = username ?? "stefan";
  return { id: "u-stefan", username: name, displayName: name, role };
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
    audience: over.audience ?? "family",
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
    const app = buildApp(prisma, mkUser("family"));
    const res = await request(app).get("/api/memory/facts");
    expect(res.status).toBe(200);
    expect(res.body.facts).toHaveLength(2);
  });

  it("GET filters by ?category=Tone", async () => {
    const prisma = createPrismaMock([
      seedFact({ id: "a", category: "Tone" }),
      seedFact({ id: "b", category: "Workflow" }),
    ]);
    const app = buildApp(prisma, mkUser("owner"));
    const res = await request(app).get("/api/memory/facts?category=Tone");
    expect(res.status).toBe(200);
    expect(res.body.facts).toHaveLength(1);
    expect(res.body.facts[0].category).toBe("Tone");
  });

  it("POST creates a fact with valid category", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, mkUser("owner"));
    const res = await request(app)
      .post("/api/memory/facts")
      .send({ category: "Workflow", fact: "You ship on Friday afternoons" });
    expect(res.status).toBe(201);
    expect(res.body.fact.category).toBe("Workflow");
    expect(res.body.fact.addedBy).toBe("stefan");
  });

  it("POST rejects invalid category with 400", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, mkUser("owner"));
    const res = await request(app)
      .post("/api/memory/facts")
      .send({ category: "MadeUp", fact: "x" });
    expect(res.status).toBe(400);
  });

  it("POST accepts the WARP-1120 Business category (D-9)", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, mkUser("owner"));
    const res = await request(app)
      .post("/api/memory/facts")
      .send({ category: "Business", fact: "We invoice clients on the 1st." });
    expect(res.status).toBe(201);
    expect(res.body.fact.category).toBe("Business");
  });

  it("PATCH updates the fact text + active flag", async () => {
    const prisma = createPrismaMock([seedFact({ id: "mf-x" })]);
    const app = buildApp(prisma, mkUser("owner"));
    const res = await request(app)
      .patch("/api/memory/facts/mf-x")
      .send({ fact: "Updated fact", active: false });
    expect(res.status).toBe(200);
    expect(res.body.fact.fact).toBe("Updated fact");
    expect(res.body.fact.active).toBe(false);
  });

  it("PATCH with empty body returns 400", async () => {
    const prisma = createPrismaMock([seedFact({ id: "mf-x" })]);
    const app = buildApp(prisma, mkUser("owner"));
    const res = await request(app).patch("/api/memory/facts/mf-x").send({});
    expect(res.status).toBe(400);
  });

  it("DELETE removes the fact (atomic deleteMany)", async () => {
    const prisma = createPrismaMock([seedFact({ id: "mf-x" })]);
    const app = buildApp(prisma, mkUser("owner"));
    const res = await request(app).delete("/api/memory/facts/mf-x");
    expect(res.status).toBe(204);
    expect(prisma.rows).toHaveLength(0);
  });

  it("DELETE on missing id returns 404", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, mkUser("owner"));
    const res = await request(app).delete("/api/memory/facts/nope");
    expect(res.status).toBe(404);
  });
});

describe("WARP-845 — role-scoped audiences", () => {
  const LADDER = [
    seedFact({ id: "f-owner", audience: "owner", fact: "owner-only" }),
    seedFact({ id: "f-admin", audience: "admin", fact: "admin-up" }),
    seedFact({ id: "f-family", audience: "family", fact: "household" }),
    seedFact({ id: "f-guest", audience: "guest", fact: "everyone" }),
  ];

  it("family GET sees family+guest audiences only", async () => {
    const prisma = createPrismaMock(LADDER.map((f) => ({ ...f })));
    const app = buildApp(prisma, mkUser("family", "kid"));
    const res = await request(app).get("/api/memory/facts");
    expect(res.status).toBe(200);
    expect(res.body.facts.map((f: MockFact) => f.id).sort()).toEqual([
      "f-family",
      "f-guest",
    ]);
  });

  it("guest GET sees guest-audience facts only", async () => {
    const prisma = createPrismaMock(LADDER.map((f) => ({ ...f })));
    const app = buildApp(prisma, mkUser("guest", "visitor"));
    const res = await request(app).get("/api/memory/facts");
    expect(res.body.facts.map((f: MockFact) => f.id)).toEqual(["f-guest"]);
  });

  it("admin GET sees everything (panel management)", async () => {
    const prisma = createPrismaMock(LADDER.map((f) => ({ ...f })));
    const app = buildApp(prisma, mkUser("admin", "boss"));
    const res = await request(app).get("/api/memory/facts");
    expect(res.body.facts).toHaveLength(4);
  });

  it("POST defaults the audience to family", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, mkUser("family"));
    const res = await request(app)
      .post("/api/memory/facts")
      .send({ category: "Tone", fact: "Be concise" });
    expect(res.status).toBe(201);
    expect(res.body.fact.audience).toBe("family");
  });

  it("family cannot mint an owner-audience fact", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, mkUser("family", "kid"));
    const res = await request(app)
      .post("/api/memory/facts")
      .send({ category: "Tone", fact: "secret", audience: "owner" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("audience_above_role");
    expect(prisma.rows).toHaveLength(0);
  });

  it("family can widen a fact to guest but not raise it to admin", async () => {
    const prisma = createPrismaMock([seedFact({ id: "f1", audience: "family" })]);
    const app = buildApp(prisma, mkUser("family", "kid"));

    const denied = await request(app)
      .patch("/api/memory/facts/f1")
      .send({ audience: "admin" });
    expect(denied.status).toBe(403);

    const ok = await request(app)
      .patch("/api/memory/facts/f1")
      .send({ audience: "guest" });
    expect(ok.status).toBe(200);
    expect(prisma.rows[0]!.audience).toBe("guest");
  });

  // Review fix — writes are audience-scoped like reads, so a family
  // caller can't touch (or read back via a no-op PATCH) an owner-only
  // fact whose id leaked. Indistinguishable from a missing row (404).
  it("family PATCH/DELETE on an out-of-rank fact 404 without leaking it", async () => {
    const prisma = createPrismaMock([
      seedFact({ id: "f-owner", audience: "owner", fact: "owner secret" }),
    ]);
    const app = buildApp(prisma, mkUser("family", "kid"));

    const patched = await request(app)
      .patch("/api/memory/facts/f-owner")
      .send({ active: false });
    expect(patched.status).toBe(404);
    expect(JSON.stringify(patched.body)).not.toContain("owner secret");
    expect(prisma.rows[0]!.active).toBe(true);

    const deleted = await request(app).delete("/api/memory/facts/f-owner");
    expect(deleted.status).toBe(404);
    expect(prisma.rows).toHaveLength(1);
  });

  it("admin PATCH on an owner fact still works (panel management scope)", async () => {
    const prisma = createPrismaMock([
      seedFact({ id: "f-owner", audience: "owner" }),
    ]);
    const app = buildApp(prisma, mkUser("admin", "boss"));
    const res = await request(app)
      .patch("/api/memory/facts/f-owner")
      .send({ active: false });
    expect(res.status).toBe(200);
    expect(prisma.rows[0]!.active).toBe(false);
  });
});
