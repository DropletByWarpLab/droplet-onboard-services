/**
 * WARP-2719 — `?department=` on the three PM readers, at the route layer.
 *
 * ── Why this is its own file ───────────────────────────────────────────────
 *
 * `native.test.ts` carries a 300-line in-memory Prisma fake shared by ~40
 * cases, and it has no `department` model at all. Teaching that fake a new
 * relation to serve four cases would put the burden on every case that does
 * not need it. This one states its own premise instead: a fake with exactly
 * the two department lookups the resolver makes, and nothing else.
 *
 * ── What the route layer alone can get wrong ───────────────────────────────
 *
 * Two things, and both of them look like success:
 *
 *   1. A department that does not exist. `GET /pm/projects` and
 *      `GET /pm/work-items` both caught with a bare `next(err)`, so a
 *      `department_not_found` thrown by the resolver would leave as a 500 —
 *      and `businessError` maps a 500 to BUSINESS_API_ERROR, which tells the
 *      model the box is broken rather than that the word was wrong.
 *   2. The three-way encoding. `?department=none` must mean "owned by nobody"
 *      and an absent parameter must mean "no filter"; conflating them returns
 *      only the unowned rows, which on most boxes is an empty list read as
 *      "there is nothing".
 */
import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { Request, Response, NextFunction } from "express";

import type { AuthUser } from "../../middleware/auth.js";
import { createPmNativeRouter } from "./native.js";

const DEPT = { id: "dept-front-desk", slug: "front-desk", name: "Front Desk" };
const TEAM = { id: "team-reception", parentId: DEPT.id };

interface Captured {
  projectWhere?: Record<string, unknown>;
  workItemWhere?: Record<string, unknown>;
}

function makeFake() {
  const captured: Captured = {};
  const prisma = {
    department: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === DEPT.id ? { id: DEPT.id } : null,
      findFirst: async ({
        where,
      }: {
        where: { OR: Array<Record<string, { equals: string }>> };
      }) => {
        const needle = where.OR[0].slug.equals.toLowerCase();
        return needle === DEPT.slug || needle === DEPT.name.toLowerCase()
          ? { id: DEPT.id }
          : null;
      },
      // The scope expansion: the target plus its child teams.
      findMany: async () => [{ id: DEPT.id }, { id: TEAM.id }],
    },
    pmProject: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        captured.projectWhere = args.where;
        return [];
      },
    },
    pmWorkItem: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        captured.workItemWhere = args.where;
        return [];
      },
      groupBy: async () => [],
    },
  };
  return { prisma, captured };
}

function makeApp(prisma: unknown) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: AuthUser }).user = {
      id: "user-owner",
      username: "user-owner",
      displayName: "user-owner",
      role: "owner" as AuthUser["role"],
    };
    next();
  });
  app.use("/api", createPmNativeRouter(prisma as never));
  return app;
}

let fake: ReturnType<typeof makeFake>;
beforeEach(() => {
  fake = makeFake();
});

// ── GET /pm/projects ────────────────────────────────────────────────────────

describe("GET /api/pm/projects?department=", () => {
  it("resolves a NAME and filters to the department and its teams", async () => {
    const res = await request(makeApp(fake.prisma)).get(
      "/api/pm/projects?department=Front%20Desk",
    );
    expect(res.status).toBe(200);
    expect(fake.captured.projectWhere?.departmentId).toEqual({
      in: [DEPT.id, TEAM.id],
    });
  });

  it("resolves a slug and an id to the same filter", async () => {
    await request(makeApp(fake.prisma)).get("/api/pm/projects?department=front-desk");
    expect(fake.captured.projectWhere?.departmentId).toEqual({ in: [DEPT.id, TEAM.id] });

    fake = makeFake();
    await request(makeApp(fake.prisma)).get(`/api/pm/projects?department=${DEPT.id}`);
    expect(fake.captured.projectWhere?.departmentId).toEqual({ in: [DEPT.id, TEAM.id] });
  });

  it("🔴 404s an unknown department instead of 500ing or returning an empty list", async () => {
    // This route caught with a bare `next(err)`. Without `mapServiceError` the
    // resolver's throw leaves as a 500, and `businessError` turns a 500 into
    // BUSINESS_API_ERROR — "the box is broken" for what is a typo.
    const res = await request(makeApp(fake.prisma)).get(
      "/api/pm/projects?department=Frnot%20Desk",
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("department_not_found");
    expect(fake.captured.projectWhere).toBeUndefined();
  });

  it("🔴 the refusal discloses EXISTENCE and nothing else (WARP-2719 review, finding 4)", async () => {
    // A 404 that depends on whether a name exists IS an existence oracle, and
    // it stays: `/api/pm/*` reads are household-shared, an unfiltered
    // `GET /pm/projects` already publishes every owning department's id and
    // name, and resolving only within the caller's memberships would kill the
    // feature for the assistant, whose principal holds none. The full argument
    // is in `pm-department.ts`, above `resolveDepartmentFilter`.
    //
    // What must NOT drift is the size of the disclosure. The body carries the
    // bare code — no id, no kind, no parent, and no echo of what the caller
    // guessed. An error message "improved" to `department "Front Desk" not
    // found` would confirm a guess in words instead of in a status code, and
    // an echo of the needle is a reflection sink besides. This is the
    // assertion that goes red for both.
    const res = await request(makeApp(fake.prisma)).get(
      "/api/pm/projects?department=Frnot%20Desk",
    );
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "department_not_found" });
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("Frnot");
    expect(body).not.toContain(DEPT.id);
    expect(body).not.toContain(DEPT.name);
    expect(body).not.toContain(TEAM.id);
  });

  it("a department that exists but owns nothing is an empty list, not a 404", async () => {
    // The other half of the same decision, and the reason the oracle cannot be
    // closed by collapsing the two answers: "there is no such department" and
    // "that department has no work" are different answers, and the second one
    // has to be reachable or the filter is back to the silent empty board.
    const res = await request(makeApp(fake.prisma)).get(
      "/api/pm/projects?department=Front%20Desk",
    );
    expect(res.status).toBe(200);
    expect(res.body.projects).toEqual([]);
    expect(fake.captured.projectWhere?.departmentId).toEqual({ in: [DEPT.id, TEAM.id] });
  });

  it("`none` and absent are different answers", async () => {
    await request(makeApp(fake.prisma)).get("/api/pm/projects?department=none");
    expect(fake.captured.projectWhere?.departmentId).toBeNull();

    fake = makeFake();
    await request(makeApp(fake.prisma)).get("/api/pm/projects");
    expect(fake.captured.projectWhere).not.toHaveProperty("departmentId");
  });
});

// ── GET /pm/work-items ──────────────────────────────────────────────────────

describe("GET /api/pm/work-items?department=", () => {
  it("🔴 answers with no ?q= at all — the AC's own question has no search term", async () => {
    const res = await request(makeApp(fake.prisma)).get(
      "/api/pm/work-items?department=Front%20Desk",
    );
    expect(res.status).toBe(200);
    expect(fake.captured.workItemWhere?.AND).toBeDefined();
    // And no free-text clause, so no `ILIKE '%%'` pair rides along.
    expect(fake.captured.workItemWhere).not.toHaveProperty("OR");
  });

  it("combines with ?q= rather than replacing it", async () => {
    await request(makeApp(fake.prisma)).get(
      "/api/pm/work-items?department=Front%20Desk&q=tiles",
    );
    expect(fake.captured.workItemWhere?.OR).toBeDefined();
    expect(fake.captured.workItemWhere?.AND).toBeDefined();
  });

  it("🔴 404s an unknown department here too", async () => {
    const res = await request(makeApp(fake.prisma)).get(
      "/api/pm/work-items?department=nope",
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("department_not_found");
  });

  it("is unchanged when no department is given", async () => {
    // The relaxed short-circuit must not have turned an empty search into a
    // full scan: no department and no q is still nothing to ask.
    const res = await request(makeApp(fake.prisma)).get("/api/pm/work-items");
    expect(res.status).toBe(200);
    expect(res.body.work_items).toEqual([]);
    expect(fake.captured.workItemWhere).toBeUndefined();
  });
});

// ── GET /pm/projects/:id/work-items ─────────────────────────────────────────

describe("GET /api/pm/projects/:id/work-items?department=", () => {
  it("takes a name now, not only an id", async () => {
    // WARP-2717 shipped this route taking a raw id. Leaving it id-only while
    // the other two accept a name would mean the same word works on two
    // readers and fails on the third.
    const prisma = {
      ...fake.prisma,
      pmProject: {
        ...fake.prisma.pmProject,
        findUnique: async () => ({ id: "p1", identifier: "PRJ", department: null }),
      },
    };
    const res = await request(makeApp(prisma)).get(
      "/api/pm/projects/p1/work-items?department=front-desk",
    );
    expect(res.status).toBe(200);
    expect(fake.captured.workItemWhere?.AND).toBeDefined();
  });

  it("still 404s an unknown one — it already had mapServiceError", async () => {
    const prisma = {
      ...fake.prisma,
      pmProject: {
        ...fake.prisma.pmProject,
        findUnique: async () => ({ id: "p1", identifier: "PRJ", department: null }),
      },
    };
    const res = await request(makeApp(prisma)).get(
      "/api/pm/projects/p1/work-items?department=nope",
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("department_not_found");
  });
});
