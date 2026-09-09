/**
 * WARP-2587 (ADR-045 slice I) — schema + migration assertions.
 *
 * Vitest mocks `@prisma/client` (./setup.ts) so these guard the migration SQL
 * and schema.prisma content directly. Same pattern as
 * pm-schema-hardening.schema.test.ts and vpn-peer-unique-ip.schema.test.ts:
 * it is this repo's way of covering "prisma db push bypasses migration-only
 * constraints" without a live Postgres, and it runs on EVERY PR rather than
 * only in the pg-integration job.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
// WARP-2654: paths are anchored to the owning file, never to the runner's
// cwd — the guard in test-paths.guard.test.ts refuses cwd-relative lookups.
import { MIGRATIONS_DIR, readSchema } from "./helpers/test-paths.js";

const SCHEMA = readSchema();

const DIR = readdirSync(MIGRATIONS_DIR).filter((d) => d.includes("activity_notify"));
const SQL = DIR.length > 0 ? readFileSync(join(MIGRATIONS_DIR, DIR[0], "migration.sql"), "utf8") : "";

describe("WARP-2587 notify claim", () => {
  it("ships a migration", () => {
    expect(DIR.length, 'must ship a migration directory matching "activity_notify"').toBe(1);
  });

  it("the claim is an ENUM column, not an IS-NULL over notifiedAt", () => {
    // CLAUDE.md "no guessing": persistent state lives in explicit columns.
    // Mutation: delete `notifyStatus` from either model and this goes red.
    expect(SQL).toContain(`CREATE TYPE "NotifyStatus" AS ENUM ('pending', 'sent', 'not_needed')`);
    expect(SCHEMA).toMatch(/notifyStatus\s+NotifyStatus\s+@default\(pending\)/);
    for (const model of ["PmActivity", "CrmActivity"]) {
      expect(SQL).toMatch(
        // `\s+` not a literal space: the statement is wrapped across two
        // lines in the migration, and SQL formatting is not the invariant —
        // the column being added is.
        new RegExp(`ALTER TABLE "${model}"\\s+ADD COLUMN IF NOT EXISTS "notifyStatus"`),
      );
    }
  });

  it("backfills pre-existing rows to a terminal, not to pending", () => {
    // Every activity row that predates this migration was never notified and
    // must never BE notified — a box upgrading with 4,000 rows of history
    // would otherwise flood every assignee on the first tick. The column is
    // added with DEFAULT 'not_needed' (metadata-only on PG11+, so no table
    // rewrite) and the default is THEN moved to 'pending' for new rows.
    for (const model of ["PmActivity", "CrmActivity"]) {
      expect(SQL).toMatch(
        new RegExp(
          `ADD COLUMN IF NOT EXISTS "notifyStatus" "NotifyStatus"\\s+NOT NULL DEFAULT 'not_needed'`,
        ),
      );
      expect(SQL).toMatch(
        new RegExp(`ALTER TABLE "${model}" ALTER COLUMN "notifyStatus" SET DEFAULT 'pending'`),
      );
    }
  });

  it("pins notifiedAt to the enum with a CHECK Prisma cannot express", () => {
    for (const model of ["PmActivity", "CrmActivity"]) {
      expect(SQL).toContain(`"${model}_notifiedAt_matches_status"`);
    }
    expect(SQL).toMatch(/CHECK\s*\(\s*\("notifyStatus" = 'sent'\) = \("notifiedAt" IS NOT NULL\)\s*\)/);
  });

  it("indexes the pending scan on both tables", () => {
    // Without these the 60s sweep table-walks an append-only history table
    // whose rows are ~100% terminal.
    expect(SQL).toContain('"PmActivity_notifyStatus_createdAt_idx"');
    expect(SQL).toContain('"CrmActivity_notifyStatus_createdAt_idx"');
    expect(SCHEMA).toMatch(/@@index\(\[notifyStatus, createdAt\]\)/);
  });
});

describe("WARP-2587 NotificationLog.kind is an enum", () => {
  it("creates the type with exactly the four documented labels", () => {
    // The vocabulary used to live in a COMMENT above a String column. Same
    // string-soup the ContextPin docstring cites CLAUDE.md against.
    expect(SQL).toContain(
      `CREATE TYPE "NotificationKind" AS ENUM ('reminder', 'event', 'system', 'ai')`,
    );
    expect(SCHEMA).toMatch(/kind\s+NotificationKind/);
    expect(SCHEMA).not.toMatch(/\/\/ "reminder" \| "event" \| "system" \| "ai"/);
  });

  it("normalises any out-of-vocabulary value before the cast instead of aborting the deploy", () => {
    // `kind` was a free String, so nothing at the DB level guaranteed the four
    // labels. Every shipped writer is constrained (the service's TS union, the
    // route's zod enum, tools-core's hardcoded 'ai'), but a failed cast would
    // brick an OTA update over one row in a 90-day-retention log. Coerce,
    // RAISE NOTICE the count, carry on — the calendar allowPrivateHost
    // migration's operator-notice idiom.
    expect(SQL).toMatch(/UPDATE "NotificationLog"[\s\S]*SET "kind" = 'system'/);
    expect(SQL).toContain("RAISE NOTICE");
  });

  it("guards the type change so the migration stays re-runnable", () => {
    // Repo idiom: every migration is safe to re-run on a populated DB.
    // `ALTER COLUMN ... TYPE` is not idempotent on its own.
    expect(SQL).toContain("information_schema.columns");
    expect(SQL).toMatch(/ALTER COLUMN "kind" TYPE "NotificationKind" USING "kind"::"NotificationKind"/);
  });
});
