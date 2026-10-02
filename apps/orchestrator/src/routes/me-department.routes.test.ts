/**
 * WARP-2981 (ADR-059 §6.1, §7.1 P6-1/P6-2) — GET/PUT /api/me/active-department
 * through the real router.
 *
 *   · a person reads and writes only their OWN choice (keyed by req.user.id;
 *     nothing in the request can name anyone else);
 *   · service principals are refused before anything is read (403 HUMAN_ONLY);
 *   · a department the person may not choose — missing, not theirs, archived,
 *     archiving, a TEAM, the HOUSEHOLD — is ONE 404 body, so the route never
 *     confirms that a department exists;
 *   · choosability is checked on write AND on read: a department archived (or
 *     a membership removed) since reads as Whole business, and GET never
 *     writes, so the row is left for the next PUT to replace;
 *   · the answer's `scope` is explicit: no row is `unset` (never chosen), and
 *     choosing Whole business WRITES a `whole_business` row, so the two are
 *     never the same answer (CLAUDE.md "No guessing, ever").
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";

import { createMeDepartmentRouter } from "./me-department.js";

// ── the people ───────────────────────────────────────────────────────────────

type Person = { id: string; username: string; role: string };
const PEOPLE: Record<string, Person> = {
  stefan: { id: "3b7d0195-6c1e-4f2a-9d8b-2a4c6e8f0a1b", username: "stefan", role: "owner" },
  ada: { id: "4c8e1206-7d2f-4a3b-8e9c-3b5d7f9a1b2c", username: "ada", role: "admin" },
  maria: { id: "7f6e5d4c-3b2a-4190-8f7e-6d5c4b3a2918", username: "maria", role: "family" },
  gil: { id: "8a7f6e5d-4c3b-4a21-9f8e-7d6c5b4a3920", username: "gil", role: "guest" },
  mcp: { id: "_service:mcp", username: "_service:mcp", role: "service" },
  display: { id: "_service:display", username: "_service:display", role: "service" },
};

// ── the departments ──────────────────────────────────────────────────────────

type Dept = {
  id: string;
  slug: string;
  name: string;
  kind: "DEPARTMENT" | "TEAM" | "HOUSEHOLD";
  state: string;
  profile: { template: string; icon: string } | null;
};
const D = {
  security: { id: "11111111-1111-4111-8111-111111111111", slug: "security", name: "Security", kind: "DEPARTMENT", state: "active", profile: { template: "security", icon: "shield" } },
  sales: { id: "22222222-2222-4222-8222-222222222222", slug: "sales", name: "Sales", kind: "DEPARTMENT", state: "active", profile: null },
  archived: { id: "33333333-3333-4333-8333-333333333333", slug: "old-records", name: "Old records", kind: "DEPARTMENT", state: "archived", profile: null },
  archiving: { id: "44444444-4444-4444-8444-444444444444", slug: "leaving", name: "Leaving soon", kind: "DEPARTMENT", state: "archiving", profile: null },
  team: { id: "55555555-5555-4555-8555-555555555555", slug: "night-shift", name: "Night shift", kind: "TEAM", state: "active", profile: null },
  household: { id: "66666666-6666-4666-8666-666666666666", slug: "household", name: "Household", kind: "HOUSEHOLD", state: "active", profile: null },
} satisfies Record<string, Dept>;
/** A well-formed id no department has. */
const UNKNOWN = "99999999-9999-4999-8999-999999999999";

// ── an in-memory Prisma: the three delegates the route touches ──────────────

type Choice = { userId: string; scope: "whole_business" | "department"; departmentId: string | null; updatedAt: Date };

/** ActiveDepartmentChoice_scope_shape, which Postgres enforces on the box. */
function assertShape(row: Choice): void {
  if ((row.scope === "department") !== (row.departmentId !== null)) {
    throw new Error('new row violates check constraint "ActiveDepartmentChoice_scope_shape"');
  }
}

function pick<T extends Record<string, unknown>>(row: T, select?: Record<string, unknown>): Partial<T> {
  if (!select) return { ...row };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(select)) {
    if (!v) continue;
    const value = row[k];
    out[k] =
      v !== true && value && typeof value === "object" && "select" in (v as object)
        ? pick(value as Record<string, unknown>, (v as { select: Record<string, unknown> }).select)
        : value;
  }
  return out as Partial<T>;
}

function makeDb() {
  const departments = new Map<string, Dept>(Object.values(D).map((d) => [d.id, { ...d }]));
  const memberships = new Set<string>(); // `${departmentId}:${userId}`
  const choices = new Map<string, Choice>();
  const writes = vi.fn();
  /** When set, the next upsert throws it (a Prisma error the fake stands in for). */
  const nextUpsertError: { current: unknown } = { current: null };

  const prisma = {
    activeDepartmentChoice: {
      findUnique: vi.fn(async ({ where, select }: { where: { userId: string }; select?: Record<string, unknown> }) => {
        const row = choices.get(where.userId);
        return row ? pick(row, select) : null;
      }),
      // Only so a mutation that stops keying by the caller can be caught:
      // it returns the first row matching `where`, as Prisma would.
      findFirst: vi.fn(async ({ where = {}, select }: { where?: Partial<Choice>; select?: Record<string, unknown> } = {}) => {
        const row = [...choices.values()].find((c) =>
          Object.entries(where).every(([k, v]) => (c as Record<string, unknown>)[k] === v),
        );
        return row ? pick(row, select) : null;
      }),
      upsert: vi.fn(async ({ where, create, update }: { where: { userId: string }; create: Choice; update: Partial<Choice> }) => {
        writes("upsert", where, create, update);
        if (nextUpsertError.current) {
          const err = nextUpsertError.current;
          nextUpsertError.current = null;
          throw err;
        }
        const prev = choices.get(where.userId);
        const row = (prev ? { ...prev, ...update, updatedAt: new Date() } : { ...create, updatedAt: new Date() }) as Choice;
        assertShape(row);
        choices.set(where.userId, row);
        return row;
      }),
      deleteMany: vi.fn(async ({ where = {} }: { where?: Partial<Choice> } = {}) => {
        writes("deleteMany", where);
        let count = 0;
        for (const [k, c] of choices) {
          if (Object.entries(where).every(([f, v]) => (c as Record<string, unknown>)[f] === v)) {
            choices.delete(k);
            count += 1;
          }
        }
        return { count };
      }),
      create: vi.fn(async () => writes("create")),
      update: vi.fn(async () => writes("update")),
      delete: vi.fn(async () => writes("delete")),
      updateMany: vi.fn(async () => writes("updateMany")),
    },
    department: {
      findUnique: vi.fn(async ({ where, select }: { where: { id: string }; select?: Record<string, unknown> }) => {
        const d = departments.get(where.id);
        return d ? pick(d, select) : null;
      }),
    },
    departmentMembership: {
      findUnique: vi.fn(
        async ({ where }: { where: { departmentId_userId: { departmentId: string; userId: string } } }) => {
          const { departmentId, userId } = where.departmentId_userId;
          return memberships.has(`${departmentId}:${userId}`) ? { id: `m-${departmentId}-${userId}` } : null;
        },
      ),
    },
  };

  return {
    prisma: prisma as unknown as PrismaClient,
    raw: prisma,
    departments,
    choices,
    writes,
    nextUpsertError,
    join: (dept: Dept, person: Person) => memberships.add(`${dept.id}:${person.id}`),
    leave: (dept: Dept, person: Person) => memberships.delete(`${dept.id}:${person.id}`),
    choose: (person: Person, dept: Dept | null) =>
      choices.set(
        person.id,
        dept
          ? { userId: person.id, scope: "department", departmentId: dept.id, updatedAt: new Date() }
          : { userId: person.id, scope: "whole_business", departmentId: null, updatedAt: new Date() },
      ),
  };
}

function makeApp(db: ReturnType<typeof makeDb>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // What authMiddleware would set; the acting person is picked per request.
    (req as unknown as { user: Person }).user = PEOPLE[String(req.headers["x-test-as"] ?? "maria")]!;
    next();
  });
  app.use("/api", createMeDepartmentRouter(db.prisma));
  return app;
}

const PATH = "/api/me/active-department";

let db: ReturnType<typeof makeDb>;
let app: express.Express;
beforeEach(() => {
  db = makeDb();
  app = makeApp(db);
  // Maria (family) is in Security, and — to prove membership is not the whole
  // test — in every row she must still not be able to choose.
  db.join(D.security, PEOPLE.maria!);
  db.join(D.archived, PEOPLE.maria!);
  db.join(D.archiving, PEOPLE.maria!);
  db.join(D.team, PEOPLE.maria!);
  db.join(D.household, PEOPLE.maria!);
});

const get = (as: string) => request(app).get(PATH).set("x-test-as", as);
const put = (as: string, body: unknown) => request(app).put(PATH).set("x-test-as", as).send(body as object);

// ── P6-1 GET ─────────────────────────────────────────────────────────────────

describe("GET /api/me/active-department", () => {
  it("no row is `unset` — never chosen, on any device — not Whole business", async () => {
    const res = await get("maria");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ scope: "unset", department: null });
  });

  it("a Whole business row reads back as `whole_business`, without looking up any department", async () => {
    db.choose(PEOPLE.maria!, null);
    const res = await get("maria");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ scope: "whole_business", department: null });
    expect(db.raw.department.findUnique).not.toHaveBeenCalled();
    expect(db.raw.departmentMembership.findUnique).not.toHaveBeenCalled();
  });

  it("a chosen department reads back as `department` with exactly {id, slug, name, profile}", async () => {
    db.choose(PEOPLE.maria!, D.security);
    const res = await get("maria");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      scope: "department",
      department: { id: D.security.id, slug: "security", name: "Security", profile: { template: "security", icon: "shield" } },
    });
  });

  it("a department that is not set up reads with profile: null (present, not absent)", async () => {
    db.choose(PEOPLE.stefan!, D.sales);
    const res = await get("stefan");
    expect(res.body.department).toEqual({ id: D.sales.id, slug: "sales", name: "Sales", profile: null });
    expect(Object.keys(res.body.department)).toEqual(["id", "slug", "name", "profile"]);
  });

  it("archived since it was chosen → whole_business, and the row is left untouched (GET never writes)", async () => {
    db.choose(PEOPLE.maria!, D.security);
    db.departments.get(D.security.id)!.state = "archived";
    const res = await get("maria");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ scope: "whole_business", department: null });
    expect(db.choices.get(PEOPLE.maria!.id)?.departmentId).toBe(D.security.id);
    expect(db.writes).not.toHaveBeenCalled();
  });

  it("archiving since it was chosen → whole_business", async () => {
    db.choose(PEOPLE.stefan!, D.sales);
    db.departments.get(D.sales.id)!.state = "archiving";
    expect((await get("stefan")).body).toEqual({ scope: "whole_business", department: null });
  });

  it("removed from the department since → whole_business, row untouched", async () => {
    db.choose(PEOPLE.maria!, D.security);
    db.leave(D.security, PEOPLE.maria!);
    expect((await get("maria")).body).toEqual({ scope: "whole_business", department: null });
    expect(db.choices.has(PEOPLE.maria!.id)).toBe(true);
    expect(db.writes).not.toHaveBeenCalled();
  });

  it("a row pointing at a department that no longer exists → whole_business", async () => {
    db.choices.set(PEOPLE.maria!.id, { userId: PEOPLE.maria!.id, scope: "department", departmentId: UNKNOWN, updatedAt: new Date() });
    expect((await get("maria")).body).toEqual({ scope: "whole_business", department: null });
  });

  it("reads only the caller's own row — someone else's choice is not theirs", async () => {
    db.choose(PEOPLE.stefan!, D.security);
    expect((await get("maria")).body).toEqual({ scope: "unset", department: null });
    expect((await get("stefan")).body.department.id).toBe(D.security.id);
  });
});

// ── P6-2 PUT ─────────────────────────────────────────────────────────────────

describe("PUT /api/me/active-department", () => {
  it("a member chooses their department → 200, the view, and the row", async () => {
    const res = await put("maria", { departmentId: D.security.id });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      scope: "department",
      department: { id: D.security.id, slug: "security", name: "Security", profile: { template: "security", icon: "shield" } },
    });
    expect(db.choices.get(PEOPLE.maria!.id)).toMatchObject({ scope: "department", departmentId: D.security.id });
    // …and it is what the next GET says.
    expect((await get("maria")).body).toEqual(res.body);
  });

  it("an owner and an admin may choose a department they are not in", async () => {
    const owner = await put("stefan", { departmentId: D.sales.id });
    expect(owner.status).toBe(200);
    expect(owner.body.department.slug).toBe("sales");
    const admin = await put("ada", { departmentId: D.security.id });
    expect(admin.status).toBe(200);
    expect(db.choices.get(PEOPLE.ada!.id)?.departmentId).toBe(D.security.id);
  });

  it("a second PUT replaces the first — one row per person, last write wins", async () => {
    db.join(D.sales, PEOPLE.maria!);
    await put("maria", { departmentId: D.security.id });
    const res = await put("maria", { departmentId: D.sales.id });
    expect(res.status).toBe(200);
    expect([...db.choices.values()].filter((c) => c.userId === PEOPLE.maria!.id)).toHaveLength(1);
    expect(db.choices.get(PEOPLE.maria!.id)?.departmentId).toBe(D.sales.id);
  });

  it("null chooses Whole business: the row records it, and GET says so — not `unset`", async () => {
    db.choose(PEOPLE.maria!, D.security);
    const res = await put("maria", { departmentId: null });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ scope: "whole_business", department: null });
    expect(db.choices.get(PEOPLE.maria!.id)).toMatchObject({ scope: "whole_business", departmentId: null });
    expect((await get("maria")).body).toEqual({ scope: "whole_business", department: null });
  });

  it("null with no row writes one: a first choice of Whole business is a choice", async () => {
    const res = await put("maria", { departmentId: null });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ scope: "whole_business", department: null });
    expect(db.choices.get(PEOPLE.maria!.id)).toMatchObject({ scope: "whole_business", departmentId: null });
    expect((await get("maria")).body.scope).toBe("whole_business");
  });

  it("a department after Whole business replaces it with a department row", async () => {
    db.choose(PEOPLE.maria!, null);
    const res = await put("maria", { departmentId: D.security.id });
    expect(res.status).toBe(200);
    expect(db.choices.get(PEOPLE.maria!.id)).toMatchObject({ scope: "department", departmentId: D.security.id });
    expect((await get("maria")).body.scope).toBe("department");
  });

  it("writes only the caller's own row — someone else's choice survives both a pick and Whole business", async () => {
    db.choose(PEOPLE.stefan!, D.security);
    db.join(D.sales, PEOPLE.maria!);
    await put("maria", { departmentId: D.sales.id });
    expect(db.choices.get(PEOPLE.stefan!.id)?.departmentId).toBe(D.security.id);
    await put("maria", { departmentId: null });
    expect(db.choices.get(PEOPLE.stefan!.id)).toMatchObject({ scope: "department", departmentId: D.security.id });
    expect(db.choices.get(PEOPLE.maria!.id)).toMatchObject({ scope: "whole_business", departmentId: null });
  });

  describe("a department the person may not choose is ONE 404 body, whatever the reason", () => {
    const cases: Array<[label: string, as: string, id: string]> = [
      ["not a member (family)", "maria", D.sales.id],
      ["not a member (guest)", "gil", D.security.id],
      ["archived (a member)", "maria", D.archived.id],
      ["archiving (a member)", "maria", D.archiving.id],
      ["a TEAM (a member)", "maria", D.team.id],
      ["the HOUSEHOLD (a member)", "maria", D.household.id],
      ["unknown uuid", "maria", UNKNOWN],
      ["archived (owner)", "stefan", D.archived.id],
      ["archiving (owner)", "stefan", D.archiving.id],
      ["a TEAM (owner)", "stefan", D.team.id],
      ["the HOUSEHOLD (owner)", "stefan", D.household.id],
      ["unknown uuid (owner)", "stefan", UNKNOWN],
    ];

    it.each(cases)("%s → 404 DEPARTMENT_NOT_AVAILABLE, nothing written", async (_label, as, id) => {
      const res = await put(as, { departmentId: id });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({
        error: { code: "DEPARTMENT_NOT_AVAILABLE", message: expect.any(String) },
      });
      expect(db.writes).not.toHaveBeenCalled();
    });

    it("every refusal is byte-identical — the route never confirms a department exists", async () => {
      const bodies = new Set<string>();
      for (const [, as, id] of cases) bodies.add((await put(as, { departmentId: id })).text);
      expect(bodies.size).toBe(1);
    });

    it("a refused PUT leaves the existing choice alone", async () => {
      db.choose(PEOPLE.maria!, D.security);
      await put("maria", { departmentId: D.sales.id });
      expect(db.choices.get(PEOPLE.maria!.id)?.departmentId).toBe(D.security.id);
    });
  });

  it("the department vanishing between the check and the write (FK violation) is the same 404", async () => {
    db.nextUpsertError.current = Object.assign(new Error("Foreign key constraint failed"), { code: "P2003" });
    const res = await put("maria", { departmentId: D.security.id });
    expect(res.status).toBe(404);
    expect(res.text).toBe((await put("maria", { departmentId: UNKNOWN })).text);
  });

  it("any other write failure is a 500, never a false 404", async () => {
    db.nextUpsertError.current = new Error("connection reset");
    const res = await put("maria", { departmentId: D.security.id });
    expect(res.status).toBe(500);
  });

  describe("the body is {departmentId: uuid | null}, strict", () => {
    it.each<[string, unknown]>([
      ["an extra key", { departmentId: D.security.id, userId: PEOPLE.stefan!.id }],
      ["no departmentId", {}],
      ["a non-uuid id", { departmentId: "security" }],
      ["a number", { departmentId: 42 }],
      ["an empty string", { departmentId: "" }],
      ["an array body", [D.security.id]],
    ])("%s → 400 VALIDATION_ERROR, nothing read or written", async (_label, body) => {
      const res = await put("maria", body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      expect(db.raw.department.findUnique).not.toHaveBeenCalled();
      expect(db.writes).not.toHaveBeenCalled();
    });
  });
});

// ── service principals ───────────────────────────────────────────────────────

describe("service principals are refused — the choice is a person's", () => {
  it.each(["mcp", "display"])("_service:%s → 403 HUMAN_ONLY on GET and PUT, before anything is read", async (who) => {
    const g = await get(who);
    expect(g.status).toBe(403);
    expect(g.body).toEqual({ error: { code: "HUMAN_ONLY", message: expect.any(String) } });
    const p = await put(who, { departmentId: D.security.id });
    expect(p.status).toBe(403);
    expect(p.body.error.code).toBe("HUMAN_ONLY");
    const w = await put(who, { departmentId: null });
    expect(w.status).toBe(403);
    expect(db.raw.activeDepartmentChoice.findUnique).not.toHaveBeenCalled();
    expect(db.raw.department.findUnique).not.toHaveBeenCalled();
    expect(db.writes).not.toHaveBeenCalled();
  });
});
