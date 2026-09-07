/**
 * WARP-2749 / WARP-2752 (ADR-051) — the brain REST surface.
 *
 *   - owner/admin read; `family` and `guest` get 403 on every route;
 *   - `impactMinor` leaves as a STRING. BigInt is not JSON-serialisable and
 *     Express throws on it, so a finding with money would 500 the whole list —
 *     the failure would be total rather than partial, and only on boxes that
 *     actually have money in them;
 *   - `/coverage` reports a DENOMINATOR. A digested count with no total reads
 *     as completeness, which is the exact misunderstanding the number exists
 *     to prevent;
 *   - a dismissal with no reason is a 400, not a 500 — the service's stable
 *     error codes map to status here rather than falling through to the
 *     error handler.
 */
import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

vi.mock("../middleware/space.js", () => ({
  readableDepartmentIdsFor: vi.fn(async () => new Set<string>()),
}));
vi.mock("../middleware/space", () => ({
  readableDepartmentIdsFor: vi.fn(async () => new Set<string>()),
}));

import { createBrainRouter } from "../routes/brain.js";
import type { AuthUser } from "../middleware/auth.js";

const owner: AuthUser = { id: "u-owner", username: "stefan", displayName: "s", role: "owner" };
const admin: AuthUser = { id: "u-admin", username: "romain", displayName: "r", role: "admin" };
const family: AuthUser = { id: "u-family", username: "kid", displayName: "k", role: "family" };
const guest: AuthUser = { id: "u-guest", username: "g", displayName: "g", role: "guest" };

function db(over: Record<string, unknown> = {}) {
  return {
    brainFinding: {
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
      findFirst: vi.fn(async () => ({ id: "f1" })),
      update: vi.fn(async () => ({})),
    },
    brainDigest: {
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
    brainPass: { findMany: vi.fn(async () => []) },
    fileIndexStatus: { count: vi.fn(async () => 0) },
    // The directory the mcp principal's asserted username is resolved against
    // (WARP-2810). `stefan` is the owner; anyone else does not exist.
    user: {
      findUnique: vi.fn(async ({ where }: { where: { username: string } }) =>
        where.username === "stefan" ? { id: "u-owner", role: "owner" } : null,
      ),
    },
    ...over,
  } as never;
}

function buildApp(user: AuthUser, prisma = db()) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = user;
    next();
  });
  app.use("/api", createBrainRouter(prisma));
  return app;
}

describe("brain routes — roles (WARP-2752)", () => {
  it.each([
    ["family", family],
    ["guest", guest],
  ])("%s gets 403 on every route", async (_label, user) => {
    const app = buildApp(user);
    expect((await request(app).get("/api/brain/findings")).status).toBe(403);
    expect((await request(app).get("/api/brain/digests")).status).toBe(403);
    expect((await request(app).get("/api/brain/coverage")).status).toBe(403);
    expect(
      (await request(app).patch("/api/brain/findings/f1").send({ status: "acknowledged" })).status,
    ).toBe(403);
  });

  it.each([
    ["owner", owner],
    ["admin", admin],
  ])("%s can read findings", async (_label, user) => {
    const res = await request(buildApp(user)).get("/api/brain/findings");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("findings");
    expect(res.body).toHaveProperty("total");
  });
});

describe("brain routes — serialisation (WARP-2752)", () => {
  it("sends impactMinor as a string, not a BigInt", async () => {
    // A raw BigInt makes Express throw on serialisation, so ONE finding with
    // money would 500 the entire list — and only on boxes that have money.
    const prisma = db({
      brainFinding: {
        findMany: vi.fn(async () => [
          { id: "f1", title: "t", impactMinor: 4000000n, currency: "USD" },
        ]),
        count: vi.fn(async () => 1),
        findFirst: vi.fn(async () => ({ id: "f1" })),
        update: vi.fn(async () => ({})),
      },
    });
    const res = await request(buildApp(owner, prisma)).get("/api/brain/findings");
    expect(res.status).toBe(200);
    expect(res.body.findings[0].impactMinor).toBe("4000000");
  });

  it("keeps a null impact null rather than stringifying it", async () => {
    const prisma = db({
      brainFinding: {
        findMany: vi.fn(async () => [{ id: "f1", title: "t", impactMinor: null, currency: null }]),
        count: vi.fn(async () => 1),
        findFirst: vi.fn(async () => ({ id: "f1" })),
        update: vi.fn(async () => ({})),
      },
    });
    const res = await request(buildApp(owner, prisma)).get("/api/brain/findings");
    expect(res.body.findings[0].impactMinor).toBeNull();
  });
});

describe("brain routes — coverage (WARP-2749)", () => {
  it("reports a denominator, not just a digested count", async () => {
    const prisma = db({
      brainPass: {
        findMany: vi.fn(async () => [
          {
            passKey: "corpus.documents",
            enabled: true,
            lastRunAt: null,
            lastSucceededAt: null,
            lastError: null,
            unitsSeen: 240,
            unitsDigested: 240,
            rowsWritten: 900,
          },
        ]),
      },
      fileIndexStatus: { count: vi.fn(async () => 5000) },
    });
    const res = await request(buildApp(owner, prisma)).get("/api/brain/coverage");
    expect(res.status).toBe(200);
    // 240 of 5000 — the number that stops an operator assuming completeness.
    expect(res.body.corpus).toEqual({ documentsReady: 5000, documentsDigested: 240 });
    expect(res.body.passes[0].enabled).toBe(true);
  });
});

describe("brain routes — status moves (WARP-2752)", () => {
  it("rejects a dismissal with no reason as 400, not 500", async () => {
    const res = await request(buildApp(owner))
      .patch("/api/brain/findings/f1")
      .send({ status: "dismissed" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("dismissal_needs_reason");
  });

  it("404s a finding the caller cannot see", async () => {
    // Guessing an id must not be a way to move a company-scope finding.
    const prisma = db({
      brainFinding: {
        findMany: vi.fn(async () => []),
        count: vi.fn(async () => 0),
        findFirst: vi.fn(async () => null),
        update: vi.fn(async () => ({})),
      },
    });
    const res = await request(buildApp(owner, prisma))
      .patch("/api/brain/findings/nope")
      .send({ status: "acknowledged" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("finding_not_found");
  });

  it("rejects an unknown status with 400", async () => {
    const res = await request(buildApp(owner))
      .patch("/api/brain/findings/f1")
      .send({ status: "banana" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("accepts a valid acknowledgement", async () => {
    const res = await request(buildApp(owner))
      .patch("/api/brain/findings/f1")
      .send({ status: "acknowledged" });
    expect(res.status).toBe(204);
  });
});

/**
 * WARP-2810 — the mcp principal is not a person.
 *
 * `requireRoleOrMcpService` admits `_service:mcp` untouched; it does not turn
 * it into a human. Until this was fixed nothing else did either, so the
 * principal reached `visibleScopeFilter` verbatim: role `service` is not
 * privileged, so the `{ scope: "company" }` arm — the scope every shipped
 * detector writes — was never added, and the remaining arm was
 * `{ scope: "personal", ownerId: "_service:mcp" }`, false for every row that
 * can exist. `business_find` then answered an empty list on every box, which
 * reads exactly like a healthy brain with nothing to report.
 */
const mcp: AuthUser = {
  id: "_service:mcp",
  username: "_service:mcp",
  displayName: "mcp",
  role: "service" as AuthUser["role"],
};

describe("brain routes — the acting human behind the mcp principal (WARP-2810)", () => {
  it("scopes on the asserted USER, and never on the service principal", async () => {
    const prisma = db();
    const res = await request(buildApp(mcp, prisma))
      .get("/api/brain/findings")
      .set("X-Nextcloud-User", "stefan");
    expect(res.status).toBe(200);

    const where = (
      prisma as unknown as {
        brainFinding: { findMany: ReturnType<typeof vi.fn> };
      }
    ).brainFinding.findMany.mock.calls[0]![0]!.where as { OR: Record<string, unknown>[] };

    // The resolved owner is privileged, so company-scope rows are readable.
    expect(where.OR).toContainEqual({ scope: "company" });
    // And the personal arm names the human's id, not the principal string.
    expect(where.OR).toContainEqual({ scope: "personal", ownerId: "u-owner" });
    expect(JSON.stringify(where)).not.toContain("_service:mcp");
  });

  it("403s when the principal asserts nobody", async () => {
    // Fail closed. An empty 200 here is worse than an error: it is
    // indistinguishable from a brain that has nothing to say.
    const res = await request(buildApp(mcp)).get("/api/brain/findings");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("actor_unresolved");
  });

  it("403s when the asserted user does not exist", async () => {
    const res = await request(buildApp(mcp))
      .get("/api/brain/findings")
      .set("X-Nextcloud-User", "nobody");
    expect(res.status).toBe(403);
  });

  it("applies to digests and to the PATCH, not only to findings", async () => {
    expect((await request(buildApp(mcp)).get("/api/brain/digests")).status).toBe(403);
    expect(
      (await request(buildApp(mcp)).patch("/api/brain/findings/f1").send({ status: "acknowledged" }))
        .status,
    ).toBe(403);
  });

  it("leaves a browser caller alone", async () => {
    const prisma = db();
    // A header on a browser session must not re-point the scope at someone
    // else — only the service principal is allowed to assert an identity.
    const res = await request(buildApp(owner, prisma))
      .get("/api/brain/findings")
      .set("X-Nextcloud-User", "romain");
    expect(res.status).toBe(200);
    const where = (
      prisma as unknown as { brainFinding: { findMany: ReturnType<typeof vi.fn> } }
    ).brainFinding.findMany.mock.calls[0]![0]!.where as { OR: Record<string, unknown>[] };
    expect(where.OR).toContainEqual({ scope: "personal", ownerId: "u-owner" });
  });
});

describe("brain coverage — says whether the brain runs at all (WARP-2812)", () => {
  it("reports `enabled`, so the page need not infer it from a failed fetch", async () => {
    const res = await request(buildApp(owner)).get("/api/brain/coverage");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("enabled");
    expect(typeof res.body.enabled).toBe("boolean");
  });
});
