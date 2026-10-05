/**
 * WARP-3526 (ADR-069 WS-10) — schema + migration assertions for time tracking.
 *
 * Vitest mocks @prisma/client (see ./setup.ts), so these tests guard the
 * migration SQL and schema.prisma content directly — the same pattern as
 * pm-work-item-relation.schema.test.ts. A CHECK constraint lives only in
 * migration SQL, and a datamodel push never runs it.
 *
 * The BEHAVIOUR of those constraints is proven against a real Postgres in
 * pm-time.pg.test.ts. This file proves they are still SHIPPED, and that the
 * bounds the application validates are the bounds the database enforces.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS_DIR, readSchema } from "./helpers/test-paths.js";
import { WORKLOG_MAX_MINUTES, WORKLOG_MIN_MINUTES } from "../services/pm/pm-time.js";

const SCHEMA = readSchema();

function findMigrationDir(needle: string): string {
  const dirs = readdirSync(MIGRATIONS_DIR).filter((d) => d.includes(needle));
  expect(dirs.length, `must ship a migration directory matching "${needle}"`).toBe(1);
  return dirs[0];
}

const DIR = findMigrationDir("warp_3526_pm_time_tracking");
const SQL = readFileSync(join(MIGRATIONS_DIR, DIR, "migration.sql"), "utf8");

describe("time tracking migration (WARP-3526)", () => {
  it("uses the timestamp the slice spec reserves, which sorts after every earlier migration", () => {
    expect(DIR.slice(0, 14)).toBe("20261004100000");
    const earlier = readdirSync(MIGRATIONS_DIR)
      .filter((d) => /^\d{14}_/.test(d) && d !== DIR)
      .map((d) => d.slice(0, 14))
      .filter((stamp) => stamp < "20261004100000")
      .sort();
    expect(earlier.length).toBeGreaterThan(0);
    expect("20261004100000" > earlier[earlier.length - 1]).toBe(true);
  });

  it("creates PmWorklog and PmTimer, and keys the timer on the person alone", () => {
    expect(/CREATE TABLE "PmWorklog"/.test(SQL)).toBe(true);
    expect(/CREATE TABLE "PmTimer"/.test(SQL)).toBe(true);
    // The primary key IS the one-running-timer-per-person rule.
    expect(/CONSTRAINT "PmTimer_pkey" PRIMARY KEY \("userId"\)/.test(SQL)).toBe(true);
  });

  it("cascades both tables from the work item — a timer must not outlive its item", () => {
    for (const table of ["PmWorklog", "PmTimer"]) {
      expect(
        new RegExp(
          `ALTER TABLE "${table}" ADD CONSTRAINT "${table}_workItemId_fkey" FOREIGN KEY \\("workItemId"\\) REFERENCES "PmWorkItem"\\("id"\\) ON DELETE CASCADE`,
        ).test(SQL),
        `${table}.workItemId must cascade`,
      ).toBe(true);
    }
  });

  it("indexes every read path and the cascade scan — an unindexed FK is the WARP-845 hazard", () => {
    for (const idx of [
      /CREATE INDEX "PmWorklog_workItemId_startedAt_idx" ON "PmWorklog"\("workItemId", "startedAt"\)/,
      /CREATE INDEX "PmWorklog_userId_startedAt_idx" ON "PmWorklog"\("userId", "startedAt"\)/,
      /CREATE INDEX "PmWorklog_startedAt_idx" ON "PmWorklog"\("startedAt"\)/,
      /CREATE INDEX "PmTimer_workItemId_idx" ON "PmTimer"\("workItemId"\)/,
    ]) {
      expect(idx.test(SQL), String(idx)).toBe(true);
    }
  });

  it("bounds an entry to 1..1440 minutes with a CHECK, and those are the bounds the application validates", () => {
    const m = /ADD CONSTRAINT "PmWorklog_minutes_range"\s*CHECK \("minutes" >= (\d+) AND "minutes" <= (\d+)\)/.exec(SQL);
    expect(m, "the minutes CHECK must ship").not.toBeNull();
    expect(Number(m![1])).toBe(WORKLOG_MIN_MINUTES);
    expect(Number(m![2])).toBe(WORKLOG_MAX_MINUTES);
    expect(WORKLOG_MAX_MINUTES).toBe(24 * 60);
  });

  it("extends PmActivityVerb with the three time verbs, idempotently", () => {
    for (const verb of ["time_logged", "time_log_updated", "time_log_removed"]) {
      expect(new RegExp(`ALTER TYPE "PmActivityVerb" ADD VALUE '${verb}'`).test(SQL)).toBe(true);
      expect(
        new RegExp(`enumlabel = '${verb}'`).test(SQL),
        `${verb} must be added behind the pg_enum existence guard`,
      ).toBe(true);
    }
  });

  it("never USES a verb it added in the same transaction", () => {
    // Postgres refuses to use an enum value added by ALTER TYPE inside the same
    // transaction, and Prisma applies a migration file in one.
    for (const verb of ["time_logged", "time_log_updated", "time_log_removed"]) {
      expect(new RegExp(`'${verb}'::"PmActivityVerb"`).test(SQL), verb).toBe(false);
    }
    expect(/INSERT INTO "PmActivity"/.test(SQL)).toBe(false);
  });
});

describe("schema.prisma declares time tracking (WARP-3526)", () => {
  it("declares PmWorklog with the per-item, per-person and per-window indexes and a cascading item FK", () => {
    const match = /model PmWorklog \{([\s\S]*?)\n\}/.exec(SCHEMA);
    expect(match, "PmWorklog model must exist").not.toBeNull();
    const body = match![1];
    expect(body).toContain("@@index([workItemId, startedAt])");
    expect(body).toContain("@@index([userId, startedAt])");
    expect(body).toContain("@@index([startedAt])");
    expect(body).toContain("onDelete: Cascade");
    // A note is a string, never NULL: one way to say "no note".
    expect(/note\s+String\s+@default\(""\)/.test(body)).toBe(true);
  });

  it("declares PmTimer keyed on userId — one running timer per person is the primary key", () => {
    const match = /model PmTimer \{([\s\S]*?)\n\}/.exec(SCHEMA);
    expect(match, "PmTimer model must exist").not.toBeNull();
    const body = match![1];
    expect(/userId\s+String\s+@id/.test(body)).toBe(true);
    expect(body).toContain("@@index([workItemId])");
    expect(body).toContain("onDelete: Cascade");
  });

  it("PmWorkItem carries both back-relations", () => {
    const match = /model PmWorkItem \{([\s\S]*?)\n\}/.exec(SCHEMA);
    expect(match).not.toBeNull();
    expect(match![1]).toContain("worklogs PmWorklog[]");
    expect(match![1]).toContain("timers   PmTimer[]");
  });

  it("PmActivityVerb declares the three time verbs", () => {
    const match = /enum PmActivityVerb \{([\s\S]*?)\}/.exec(SCHEMA);
    expect(match).not.toBeNull();
    for (const verb of ["time_logged", "time_log_updated", "time_log_removed"]) {
      expect(match![1]).toContain(verb);
    }
  });
});
