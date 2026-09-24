/**
 * WARP-2981 (ADR-059 §4–§6.1, DS-003) — a person's active department against
 * REAL Postgres.
 *
 * WHY THESE CASES RUN HERE AND NOT IN THE MOCKED LANE
 *
 *   migration  The folder applies after every earlier one (the lane's own
 *              `migrate deploy`), and running it AGAIN is a no-op: the
 *              IF NOT EXISTS / duplicate_object guards are SQL, and only
 *              Postgres can say they hold. Run twice here inside a
 *              transaction that is rolled back.
 *   cascade    "The row never outlives the person or the department" is the
 *              two FKs' ON DELETE CASCADE. A fake cannot show it.
 *   one row    Two devices choosing at once must leave ONE row, the later
 *              write's. That rests on the userId primary key and Prisma's
 *              upsert against it, so it is raced for real.
 *   FK race    A department deleted between the choosability check and the
 *              write is the same 404 as any other refusal. The route test
 *              fakes Prisma's P2003; this proves Postgres + Prisma really
 *              raise P2003 for it, so the fake is honest.
 *   route      GET/PUT through the real router on real rows, including the
 *              read-time re-check after an archive (GET answers Whole
 *              business and leaves the row untouched).
 *
 * Gated on RUN_PG_INTEGRATION=1 + DATABASE_URL, like every *.pg.test.ts.
 * Local: scripts/test-orchestrator-pg.sh. CI: the `pg-integration` job.
 *
 * FIXTURE SCOPING — the DB is shared by the pg suites running in series.
 * Every User and Department this file writes is namespaced `warp2981-`, and
 * every cleanup is scoped to that prefix. Every User row is a plain `family`
 * row: the viewer's role comes from the request (as the JWT would carry it),
 * so no owner/admin operator row is ever added to the box-wide count the
 * RBAC guard-rails suite asserts on.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { MIGRATIONS_DIR } from "./helpers/test-paths.js";

vi.unmock("@prisma/client");

import { createMeDepartmentRouter } from "../routes/me-department.js";
import { chooseActiveDepartment, readActiveDepartment } from "../services/department-choice.js";

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

const PREFIX = "warp2981-";
const MIGRATION_SQL = readFileSync(
  join(MIGRATIONS_DIR, "20260925040000_warp_2981_active_department_choice", "migration.sql"),
  "utf8",
);

/** The migration's statements, split at top-level `;` (a `DO $$ … $$` body keeps its own). */
function statements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inDollar = false;
  for (const line of sql.replace(/\r\n/g, "\n").split("\n")) {
    if (line.trim().startsWith("--") && !inDollar) continue;
    cur += line + "\n";
    inDollar = (line.match(/\$\$/g)?.length ?? 0) % 2 === 1 ? !inDollar : inDollar;
    if (!inDollar && line.trimEnd().endsWith(";")) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

class Rollback extends Error {}

type Viewer = { id: string; username: string; role: string };

describe.skipIf(!RUN)("ActiveDepartmentChoice — real Postgres (WARP-2981)", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } =
      await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
  });

  // Choices and memberships cascade from both sides; departments first, then
  // users, so nothing is left pointing anywhere.
  const cleanup = async () => {
    await prisma.department.deleteMany({ where: { slug: { startsWith: PREFIX } } });
    await prisma.user.deleteMany({ where: { username: { startsWith: PREFIX } } });
  };

  beforeEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    if (prisma) {
      await cleanup();
      await prisma.$disconnect();
    }
  });

  async function person(name: string, role = "family"): Promise<Viewer> {
    const row = await prisma.user.create({
      data: { username: `${PREFIX}${name}`, displayName: name },
      select: { id: true, username: true },
    });
    return { ...row, role };
  }

  async function department(
    name: string,
    over: { kind?: "DEPARTMENT" | "TEAM" | "HOUSEHOLD"; state?: string; parentId?: string } = {},
  ) {
    return prisma.department.create({
      data: {
        name: `${PREFIX}${name}`,
        slug: `${PREFIX}${name}`,
        createdBy: "warp2981-test",
        kind: over.kind ?? "DEPARTMENT",
        state: (over.state ?? "active") as never,
        parentId: over.parentId ?? null,
      },
      select: { id: true, slug: true, name: true },
    });
  }

  async function join_(departmentId: string, userId: string) {
    await prisma.departmentMembership.create({ data: { departmentId, userId, grantedBy: "warp2981-test" } });
  }

  const choiceOf = (userId: string) => prisma.activeDepartmentChoice.findUnique({ where: { userId } });

  // ── the migration ──────────────────────────────────────────────────────────

  describe("the migration", () => {
    it("is applied: one pkey on userId, both FKs ON DELETE CASCADE, the departmentId index", async () => {
      const cons = await prisma.$queryRawUnsafe<{ conname: string; contype: string; confdeltype: string }[]>(
        `SELECT conname, contype, confdeltype FROM pg_constraint
          WHERE conrelid = '"ActiveDepartmentChoice"'::regclass ORDER BY conname`,
      );
      expect(cons).toEqual([
        { conname: "ActiveDepartmentChoice_departmentId_fkey", contype: "f", confdeltype: "c" },
        { conname: "ActiveDepartmentChoice_pkey", contype: "p", confdeltype: " " },
        { conname: "ActiveDepartmentChoice_userId_fkey", contype: "f", confdeltype: "c" },
      ]);
      const idx = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'ActiveDepartmentChoice' ORDER BY indexname`,
      );
      expect(idx.map((r) => r.indexname)).toEqual([
        "ActiveDepartmentChoice_departmentId_idx",
        "ActiveDepartmentChoice_pkey",
      ]);
    });

    it("running it again, twice, is a no-op — nothing duplicated, nothing fails", async () => {
      const stmts = statements(MIGRATION_SQL);
      expect(stmts.length).toBe(4);
      await expect(
        prisma.$transaction(async (tx) => {
          for (let pass = 0; pass < 2; pass += 1) {
            for (const s of stmts) await tx.$executeRawUnsafe(s);
          }
          const [{ n }] = await tx.$queryRawUnsafe<{ n: bigint }[]>(
            `SELECT count(*)::bigint AS n FROM pg_constraint WHERE conrelid = '"ActiveDepartmentChoice"'::regclass`,
          );
          expect(Number(n)).toBe(3);
          throw new Rollback();
        }),
      ).rejects.toBeInstanceOf(Rollback);
    });
  });

  // ── cascades ───────────────────────────────────────────────────────────────

  describe("the row never outlives the person or the department", () => {
    it("deleting the person deletes their choice", async () => {
      const maria = await person("maria");
      const sec = await department("security");
      await join_(sec.id, maria.id);
      expect((await chooseActiveDepartment(prisma, maria, sec.id)).ok).toBe(true);
      expect(await choiceOf(maria.id)).not.toBeNull();

      await prisma.user.delete({ where: { id: maria.id } });
      expect(await choiceOf(maria.id)).toBeNull();
    });

    it("deleting the department deletes every choice of it, and no one else's", async () => {
      const maria = await person("maria");
      const ana = await person("ana");
      const sec = await department("security");
      const sales = await department("sales");
      await join_(sec.id, maria.id);
      await join_(sales.id, ana.id);
      await chooseActiveDepartment(prisma, maria, sec.id);
      await chooseActiveDepartment(prisma, ana, sales.id);

      await prisma.department.delete({ where: { id: sec.id } });
      expect(await choiceOf(maria.id)).toBeNull();
      expect((await choiceOf(ana.id))?.departmentId).toBe(sales.id);
    });
  });

  // ── one row per person ─────────────────────────────────────────────────────

  describe("one row per person, last write wins", () => {
    it("twenty concurrent choices across two departments leave exactly ONE row", async () => {
      const maria = await person("maria");
      const sec = await department("security");
      const sales = await department("sales");
      await join_(sec.id, maria.id);
      await join_(sales.id, maria.id);

      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) => chooseActiveDepartment(prisma, maria, i % 2 ? sec.id : sales.id)),
      );
      expect(results.every((r) => r.ok)).toBe(true);
      const rows = await prisma.activeDepartmentChoice.findMany({ where: { userId: maria.id } });
      expect(rows).toHaveLength(1);
      expect([sec.id, sales.id]).toContain(rows[0]!.departmentId);
    });

    it("a later choice replaces the earlier one, and Whole business deletes it", async () => {
      const maria = await person("maria");
      const sec = await department("security");
      const sales = await department("sales");
      await join_(sec.id, maria.id);
      await join_(sales.id, maria.id);

      await chooseActiveDepartment(prisma, maria, sec.id);
      await chooseActiveDepartment(prisma, maria, sales.id);
      expect((await choiceOf(maria.id))?.departmentId).toBe(sales.id);
      expect(await prisma.activeDepartmentChoice.count({ where: { userId: maria.id } })).toBe(1);

      expect(await chooseActiveDepartment(prisma, maria, null)).toEqual({ ok: true, department: null });
      expect(await choiceOf(maria.id)).toBeNull();
    });
  });

  // ── the check-then-write race ──────────────────────────────────────────────

  it("a department deleted between the check and the write is `not_available` (Postgres raises P2003)", async () => {
    const maria = await person("maria");
    const sec = await department("security");
    await join_(sec.id, maria.id);

    // The real client, except that the upsert first deletes the department:
    // the check has passed, the write now points at nothing.
    const racing = new Proxy(prisma, {
      get(target, prop) {
        if (prop !== "activeDepartmentChoice") return Reflect.get(target, prop);
        const delegate = target.activeDepartmentChoice;
        return new Proxy(delegate, {
          get(d, p) {
            if (p !== "upsert") return Reflect.get(d, p);
            return async (args: Parameters<typeof delegate.upsert>[0]) => {
              await target.department.delete({ where: { id: sec.id } });
              return delegate.upsert(args);
            };
          },
        });
      },
    });

    expect(await chooseActiveDepartment(racing, maria, sec.id)).toEqual({ ok: false, reason: "not_available" });
    expect(await choiceOf(maria.id)).toBeNull();
  });

  // ── through the real router ────────────────────────────────────────────────

  describe("GET/PUT /api/me/active-department on real rows", () => {
    function app(as: () => Viewer) {
      const a = express();
      a.use(express.json());
      a.use((req, _res, next) => {
        (req as unknown as { user: Viewer }).user = as();
        next();
      });
      a.use("/api", createMeDepartmentRouter(prisma));
      return a;
    }
    const PATH = "/api/me/active-department";

    it("a member chooses, reads it back, is archived out of it (GET → null, row kept), then picks Whole business", async () => {
      const maria = await person("maria");
      const sec = await department("security");
      await join_(sec.id, maria.id);
      await prisma.departmentProfile.create({
        data: { departmentId: sec.id, template: "security", icon: "shield", navHrefs: ["/security"], homeWidgets: [], updatedBy: "warp2981-test" },
      });
      const a = app(() => maria);

      const put = await request(a).put(PATH).send({ departmentId: sec.id });
      expect(put.status).toBe(200);
      expect(put.body).toEqual({
        department: { id: sec.id, slug: sec.slug, name: sec.name, profile: { template: "security", icon: "shield" } },
      });
      expect((await request(a).get(PATH)).body).toEqual(put.body);

      const before = await choiceOf(maria.id);
      await prisma.department.update({ where: { id: sec.id }, data: { state: "archived" } });
      const got = await request(a).get(PATH);
      expect(got.status).toBe(200);
      expect(got.body).toEqual({ department: null });
      // GET never writes: the row and its updatedAt are exactly as they were.
      expect(await choiceOf(maria.id)).toEqual(before);

      const whole = await request(a).put(PATH).send({ departmentId: null });
      expect(whole.body).toEqual({ department: null });
      expect(await choiceOf(maria.id)).toBeNull();
    });

    it("a person removed from the department since reads Whole business", async () => {
      const maria = await person("maria");
      const sec = await department("security");
      await join_(sec.id, maria.id);
      await chooseActiveDepartment(prisma, maria, sec.id);

      await prisma.departmentMembership.deleteMany({ where: { departmentId: sec.id, userId: maria.id } });
      expect(await readActiveDepartment(prisma, maria)).toBeNull();
      expect((await choiceOf(maria.id))?.departmentId).toBe(sec.id);
    });

    it("every refusal is one identical 404, and nothing is written", async () => {
      const maria = await person("maria");
      const sec = await department("security");
      const sales = await department("sales");
      const archived = await department("old-records", { state: "archived" });
      const team = await department("night-shift", { kind: "TEAM", parentId: sec.id });
      const household = await department("household", { kind: "HOUSEHOLD" });
      for (const d of [sec, archived, team, household]) await join_(d.id, maria.id);
      const a = app(() => maria);

      const bodies = new Set<string>();
      for (const id of [sales.id, archived.id, team.id, household.id, "99999999-9999-4999-8999-999999999999"]) {
        const res = await request(a).put(PATH).send({ departmentId: id });
        expect(res.status).toBe(404);
        bodies.add(res.text);
      }
      expect(bodies.size).toBe(1);
      expect(JSON.parse([...bodies][0]!)).toEqual({
        error: { code: "DEPARTMENT_NOT_AVAILABLE", message: expect.any(String) },
      });
      expect(await choiceOf(maria.id)).toBeNull();
    });

    it("an owner may choose a department they are not in; the row is theirs alone", async () => {
      const owner = await person("owner", "owner");
      const maria = await person("maria");
      const sales = await department("sales");
      const res = await request(app(() => owner)).put(PATH).send({ departmentId: sales.id });
      expect(res.status).toBe(200);
      expect((await choiceOf(owner.id))?.departmentId).toBe(sales.id);
      expect((await request(app(() => maria)).get(PATH)).body).toEqual({ department: null });
    });
  });
});
