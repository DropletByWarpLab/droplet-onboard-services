/**
 * WARP-3193 (db-performance) — schema + migration contract for the indexes
 * and status columns this theme adds. Reads schema.prisma and the migration
 * SQL as text (no DB), like the other `*.schema.test.ts` files; the drift gate
 * (scripts/check-schema-drift.sh) is what proves the two agree on a real
 * Postgres.
 *
 *   - PERF-7: ActivityRow is listed `ORDER BY id DESC LIMIT n`, optionally
 *     filtered by `kind` or an ILIKE on `what`/`sub`. `(at, kind)` serves
 *     neither, so a sparse filter walked the whole 90-day table.
 *   - PERF-15: the filing orphan sweep looks FileIndexStatus up by ncFileId,
 *     which led no index.
 *   - QUAL-3: UserInvite and Reminder lifecycles were derived from nullable
 *     timestamps. Each gets an explicit, indexed status enum, backfilled from
 *     those timestamps (CLAUDE.md "no guessing"; BrainMemoryItemStatus is the
 *     precedent).
 *   - PERF-14: the reminder poller's `status = 'scheduled' AND dueAt <= now
 *     ORDER BY dueAt` is served by the (status, dueAt) index.
 */
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, SCHEMA_PATH } from "./helpers/test-paths.js";

const schema = readFileSync(SCHEMA_PATH, "utf-8");

function modelBlock(name: string): string {
  const match = schema.match(new RegExp(`\\nmodel\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`));
  if (!match) throw new Error(`model ${name} not found in schema.prisma`);
  return match[1]!;
}

function enumValues(name: string): string[] {
  const match = schema.match(new RegExp(`\\nenum\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`));
  if (!match) throw new Error(`enum ${name} not found in schema.prisma`);
  return match[1]!
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, "").trim())
    .filter((l) => /^\w+$/.test(l));
}

function migration(suffix: string): string {
  const dirs = readdirSync(MIGRATIONS_DIR).filter((d) => d.endsWith(suffix));
  expect(dirs, `exactly one migration named *${suffix}`).toHaveLength(1);
  return readFileSync(path.join(MIGRATIONS_DIR, dirs[0]!, "migration.sql"), "utf-8");
}

/** Whitespace-insensitive "contains". */
function has(sql: string, fragment: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  return norm(sql).includes(norm(fragment));
}

describe("WARP-3193 PERF-7 — activity feed indexes", () => {
  const sql = migration("_warp_3193_activity_feed_indexes");

  it("indexes (kind, id DESC) for the kind-filtered, id-ordered page", () => {
    expect(modelBlock("ActivityRow")).toMatch(/@@index\(\[kind, id\(sort: Desc\)\]\)/);
    expect(has(sql, `ON "ActivityRow"("kind", "id" DESC)`)).toBe(true);
  });

  it("enables pg_trgm idempotently and adds trigram GIN indexes on what and sub", () => {
    expect(has(sql, "CREATE EXTENSION IF NOT EXISTS pg_trgm")).toBe(true);
    for (const col of ["what", "sub"]) {
      expect(modelBlock("ActivityRow")).toMatch(
        new RegExp(`@@index\\(\\[${col}\\(ops: raw\\("gin_trgm_ops"\\)\\)\\], type: Gin\\)`),
      );
      expect(has(sql, `ON "ActivityRow" USING GIN ("${col}" gin_trgm_ops)`)).toBe(true);
    }
  });
});

describe("WARP-3193 PERF-15 — FileIndexStatus.ncFileId index", () => {
  it("indexes the column the filing orphan sweep looks up by", () => {
    expect(modelBlock("FileIndexStatus")).toMatch(/@@index\(\[ncFileId\]\)/);
    const sql = migration("_warp_3193_file_index_status_ncfileid_index");
    expect(has(sql, `ON "FileIndexStatus"("ncFileId")`)).toBe(true);
  });
});


describe("WARP-3193 QUAL-3 — UserInvite.status", () => {
  const sql = migration("_warp_3193_user_invite_status");

  it("declares the four lifecycle states", () => {
    expect(enumValues("InviteStatus")).toEqual(["pending", "accepted", "revoked", "expired"]);
  });

  it("adds an indexed status column defaulting to pending", () => {
    const block = modelBlock("UserInvite");
    expect(block).toMatch(/\bstatus\s+InviteStatus\s+@default\(pending\)/);
    expect(block).toMatch(/@@index\(\[status\]\)/);
    expect(has(sql, `ADD COLUMN IF NOT EXISTS "status" "InviteStatus" NOT NULL DEFAULT 'pending'`)).toBe(true);
  });

  it("backfills from the timestamps, revoked first, as the old readers ranked them", () => {
    // Revoke never checked acceptedAt, so a row can carry both stamps. Every
    // old reader (accept route, dashboard pill) tested revokedAt first.
    const revoked = sql.search(/SET "status" = 'revoked'/);
    const accepted = sql.search(/SET "status" = 'accepted'/);
    const expired = sql.search(/SET "status" = 'expired'/);
    expect(revoked).toBeGreaterThan(-1);
    expect(accepted).toBeGreaterThan(revoked);
    expect(expired).toBeGreaterThan(accepted);
    expect(has(sql, `WHERE "revokedAt" IS NOT NULL`)).toBe(true);
    expect(has(sql, `WHERE "acceptedAt" IS NOT NULL AND "status" = 'pending'`)).toBe(true);
    expect(has(sql, `WHERE "expiresAt" < now() AND "status" = 'pending'`)).toBe(true);
  });
});

describe("WARP-3193 QUAL-3 / PERF-14 — Reminder.status", () => {
  const sql = migration("_warp_3193_reminder_status");

  it("declares the three lifecycle states", () => {
    expect(enumValues("ReminderStatus")).toEqual(["scheduled", "notified", "completed"]);
  });

  it("adds a status column defaulting to scheduled, indexed with dueAt for the poller", () => {
    const block = modelBlock("Reminder");
    expect(block).toMatch(/\bstatus\s+ReminderStatus\s+@default\(scheduled\)/);
    expect(block).toMatch(/@@index\(\[status, dueAt\]\)/);
    expect(has(sql, `ADD COLUMN IF NOT EXISTS "status" "ReminderStatus" NOT NULL DEFAULT 'scheduled'`)).toBe(true);
    expect(has(sql, `ON "Reminder"("status", "dueAt")`)).toBe(true);
  });

  it("backfills completed before notified, matching the poller's old predicate", () => {
    const completed = sql.search(/SET "status" = 'completed'/);
    const notified = sql.search(/SET "status" = 'notified'/);
    expect(completed).toBeGreaterThan(-1);
    expect(notified).toBeGreaterThan(completed);
    expect(has(sql, `WHERE "completedAt" IS NOT NULL`)).toBe(true);
    expect(has(sql, `WHERE "notifiedAt" IS NOT NULL AND "status" = 'scheduled'`)).toBe(true);
  });
});
