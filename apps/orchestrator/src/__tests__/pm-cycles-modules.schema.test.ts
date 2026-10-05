/**
 * WARP-3521 — schema + migration assertions for cycles and modules, in the
 * DB-less lane.
 *
 * Vitest mocks `@prisma/client` (see ./setup.ts), so these guard the migration
 * SQL and schema.prisma TEXT directly — the pm-schema-hardening.schema.test.ts
 * pattern, and this repo's way of covering "prisma db push bypasses
 * migration-only partial indexes, CHECKs and triggers" without a live Postgres.
 * The behaviour of each of these against a real database is
 * pm-cycles-modules.pg.test.ts's job; this file only makes sure the statements
 * cannot be quietly dropped from the migration or un-documented in the schema.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PRISMA_DIR } from "./helpers/test-paths.js";

const MIGRATIONS_DIR = join(PRISMA_DIR, "migrations");
const SCHEMA = readFileSync(join(PRISMA_DIR, "schema.prisma"), "utf8").replace(/\r\n/g, "\n");

const dirs = readdirSync(MIGRATIONS_DIR).filter((d) => d.endsWith("_warp_3521_pm_cycles_modules"));
const DIR = dirs[0];
const SQL = readFileSync(join(MIGRATIONS_DIR, DIR, "migration.sql"), "utf8").replace(/\r\n/g, "\n");

/** The body of `model <name> { ... }` including its leading `///` comment block. */
function modelBlock(name: string): string {
  const start = SCHEMA.indexOf(`model ${name} {`);
  expect(start, `schema.prisma must declare model ${name}`).toBeGreaterThan(-1);
  const end = SCHEMA.indexOf("\n}\n", start);
  // walk back over the contiguous `///` doc lines above the model
  const before = SCHEMA.slice(0, start).split("\n");
  const doc: string[] = [];
  for (let i = before.length - 2; i >= 0 && before[i].startsWith("///"); i -= 1) doc.unshift(before[i]);
  return doc.join("\n") + "\n" + SCHEMA.slice(start, end + 2);
}

describe("the WS-5 migration", () => {
  it("ships exactly once, under the reserved timestamp", () => {
    expect(dirs).toEqual(["20261004140000_warp_3521_pm_cycles_modules"]);
  });

  it("uses a timestamp strictly greater than every migration before it", () => {
    const stamps = readdirSync(MIGRATIONS_DIR)
      .filter((d) => /^\d{14}_/.test(d))
      .map((d) => d.slice(0, 14))
      .filter((s) => s < "20261004140000");
    expect(stamps.every((s) => s < "20261004140000")).toBe(true);
    expect([...stamps].sort().at(-1)! < "20261004140000").toBe(true);
  });

  it("adds the two completion columns, explicitly", () => {
    expect(SQL).toMatch(/ALTER TABLE "PmCycle" ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMP\(3\)/);
    expect(SQL).toMatch(/ALTER TABLE "PmCycle" ADD COLUMN IF NOT EXISTS "carriedOverCount" INTEGER NOT NULL DEFAULT 0/);
  });

  it("declares PmWorkItem.estimate idempotently, because WARP-3520 owns the same column", () => {
    expect(SQL).toMatch(/ALTER TABLE "PmWorkItem" ADD COLUMN IF NOT EXISTS "estimate" DOUBLE PRECISION/);
  });

  it("re-asserts the partial unique index: UNIQUE on projectId, WHERE status = 'active', IF NOT EXISTS", () => {
    expect(SQL).toMatch(
      /CREATE\s+UNIQUE\s+INDEX\s+IF NOT EXISTS\s+"PmCycle_projectId_active_key"\s+ON\s+"PmCycle"\s*\(\s*"projectId"\s*\)\s+WHERE\s+"status"\s*=\s*'active'/i,
    );
  });

  it("dedupes before it builds the index, so the statement is safe on any database state", () => {
    const dedupe = SQL.search(/UPDATE\s+"PmCycle"\s+SET\s+"status"\s*=\s*'draft'/i);
    const index = SQL.search(/CREATE\s+UNIQUE\s+INDEX\s+IF NOT EXISTS\s+"PmCycle_projectId_active_key"/i);
    expect(dedupe).toBeGreaterThan(-1);
    expect(index).toBeGreaterThan(dedupe);
  });

  it("adds both date-order CHECKs, guarded so the file can be applied twice", () => {
    expect(SQL).toMatch(/pg_constraint WHERE conname = 'PmCycle_dates_ordered'/);
    expect(SQL).toMatch(/CHECK \("startDate" IS NULL OR "endDate" IS NULL OR "endDate" >= "startDate"\)/);
    expect(SQL).toMatch(/pg_constraint WHERE conname = 'PmModule_dates_ordered'/);
    expect(SQL).toMatch(/CHECK \("startDate" IS NULL OR "targetDate" IS NULL OR "targetDate" >= "startDate"\)/);
  });

  it("repairs inverted dates BEFORE adding the CHECKs", () => {
    const repairCycle = SQL.search(/UPDATE "PmCycle"\s+SET "endDate" = "startDate"/);
    const repairModule = SQL.search(/UPDATE "PmModule"\s+SET "targetDate" = "startDate"/);
    const check = SQL.search(/ADD CONSTRAINT "PmCycle_dates_ordered"/);
    expect(repairCycle).toBeGreaterThan(-1);
    expect(repairModule).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(Math.max(repairCycle, repairModule));
  });

  it("guards a work item's cycle with a trigger on INSERT and UPDATE OF (cycleId, projectId)", () => {
    expect(SQL).toMatch(/CREATE OR REPLACE FUNCTION pmworkitem_enforce_cycle_same_project\(\)/);
    expect(SQL).toMatch(
      /CREATE TRIGGER pmworkitem_cycle_same_project\s+BEFORE INSERT OR UPDATE OF "cycleId", "projectId" ON "PmWorkItem"/,
    );
    expect(SQL).toMatch(/DROP TRIGGER IF EXISTS pmworkitem_cycle_same_project/);
    expect(SQL).toMatch(/USING ERRCODE = 'check_violation'/);
  });

  it("guards a module's items with a trigger on INSERT and UPDATE OF (moduleId, workItemId)", () => {
    expect(SQL).toMatch(/CREATE OR REPLACE FUNCTION pmmoduleworkitem_enforce_same_project\(\)/);
    expect(SQL).toMatch(
      /CREATE TRIGGER pmmoduleworkitem_same_project\s+BEFORE INSERT OR UPDATE OF "moduleId", "workItemId" ON "PmModuleWorkItem"/,
    );
    expect(SQL).toMatch(/DROP TRIGGER IF EXISTS pmmoduleworkitem_same_project/);
  });

  it("repairs, and audits the repair, before each trigger can refuse the rows it repairs", () => {
    const cycleAudit = SQL.search(/'cycle_removed'::"PmActivityVerb"/);
    const cycleRepair = SQL.search(/UPDATE "PmWorkItem" w\s+SET "cycleId" = NULL/);
    const cycleTrigger = SQL.search(/CREATE TRIGGER pmworkitem_cycle_same_project/);
    expect(cycleAudit).toBeGreaterThan(-1);
    expect(cycleRepair).toBeGreaterThan(cycleAudit); // audited BEFORE it is applied
    expect(cycleTrigger).toBeGreaterThan(cycleRepair);

    const moduleAudit = SQL.search(/'module_removed'::"PmActivityVerb"/);
    const moduleRepair = SQL.search(/DELETE FROM "PmModuleWorkItem" mw/);
    const moduleTrigger = SQL.search(/CREATE TRIGGER pmmoduleworkitem_same_project/);
    expect(moduleAudit).toBeGreaterThan(-1);
    expect(moduleRepair).toBeGreaterThan(moduleAudit);
    expect(moduleTrigger).toBeGreaterThan(moduleRepair);
  });

  it("does not use an enum value it adds in the same transaction (it adds none)", () => {
    expect(SQL).not.toMatch(/ALTER TYPE "PmActivityVerb" ADD VALUE/);
  });

  it("seeds no data", () => {
    // The only INSERTs are the repair-audit rows, each driven by a SELECT over
    // existing violators — never literal VALUES. (Comments are stripped: the
    // header talks about "values" in English.)
    const code = SQL.split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    for (const m of code.matchAll(/INSERT INTO "[A-Za-z]+"/g)) {
      expect(m[0]).toBe('INSERT INTO "PmActivity"');
    }
    expect(code).not.toMatch(/\bVALUES\s*\(/i);
  });
});

describe("schema.prisma documents what the migration holds", () => {
  it("PmCycle carries the new columns", () => {
    const m = modelBlock("PmCycle");
    expect(m).toMatch(/completedAt\s+DateTime\?/);
    expect(m).toMatch(/carriedOverCount\s+Int\s+@default\(0\)/);
  });

  it("PmCycle documents the partial unique index with a `///` comment — Prisma cannot express it", () => {
    const m = modelBlock("PmCycle");
    expect(m).toMatch(/^\/\/\/.*(at most ONE active cycle|ONE active cycle)/im);
    expect(m).toMatch(/\/\/\/.*PmCycle_projectId_active_key/);
    expect(m).toMatch(/\/\/\/.*WHERE "status" = 'active'/);
    expect(m).toMatch(/\/\/\/.*PmCycle_dates_ordered/);
    expect(m).toMatch(/\/\/\/.*pmworkitem_cycle_same_project/);
  });

  it("the stale 'no cycle write path exists yet' note is gone", () => {
    expect(SCHEMA).not.toMatch(/No cycle write\s+path exists yet/);
  });

  it("PmModule documents its CHECK and its trigger", () => {
    const m = modelBlock("PmModule");
    expect(m).toMatch(/\/\/\/.*PmModule_dates_ordered/);
    expect(m).toMatch(/\/\/\/.*pmmoduleworkitem_same_project/);
  });

  it("PmWorkItem declares estimate and documents cycleId's same-project rule", () => {
    const m = modelBlock("PmWorkItem");
    expect(m).toMatch(/estimate\s+Float\?/);
    expect(m).toMatch(/\/\/\/.*pmworkitem_cycle_same_project/);
  });

  it("the partial unique index is NOT modelled as a plain @@unique (that would be a different, wrong index)", () => {
    const m = modelBlock("PmCycle");
    expect(m).not.toMatch(/@@unique/);
  });

  it("the verbs the services write already exist in PmActivityVerb", () => {
    const body = /enum PmActivityVerb \{([\s\S]*?)\}/.exec(SCHEMA)![1];
    for (const verb of ["cycle_added", "cycle_removed", "module_added", "module_removed", "state_changed"]) {
      expect(body).toContain(verb);
    }
  });
});
