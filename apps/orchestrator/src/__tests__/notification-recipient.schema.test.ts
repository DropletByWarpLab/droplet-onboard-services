/**
 * WARP-2911 — the notification recipient columns are named for what they hold.
 *
 * `NotificationLog.userId` and `PushSubscription.userId` only ever held a
 * Nextcloud username, and the name invited three callers (WARP-2783,
 * WARP-2813, WARP-2910) to pass a `User.id` that reached nobody. Both columns
 * are `username` now, with a doc comment saying which vocabulary they speak.
 *
 * Asserted against the schema AND the migration: the schema is what the client
 * believes, the migration is what the database will hold. The CI drift gate
 * (`scripts/check-schema-drift.sh`) proves they agree; this proves the
 * migration is the RENAME the ticket decided on — no data rewrite, no drop and
 * re-add that would empty the column on every box.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, readSchema } from "./helpers/test-paths.js";

const schema = readSchema().replace(/\r\n/g, "\n");
const MIGRATION = "20260924020000_warp_2911_notification_recipient_username";
const sql = readFileSync(join(MIGRATIONS_DIR, MIGRATION, "migration.sql"), "utf8");
/** The statements alone: the header is allowed to SAY "no UPDATE". */
const code = sql
  .split(/\r?\n/)
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");

function model(name: string): string {
  const match = schema.match(new RegExp(`\\nmodel\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`));
  if (!match) throw new Error(`model ${name} not found in schema.prisma`);
  return match[1]!;
}

const DOC = "/// Nextcloud username (`User.username`), never `User.id`";

describe("🔴 WARP-2911 the recipient column is `username`", () => {
  for (const name of ["NotificationLog", "PushSubscription"]) {
    it(`${name}: a documented \`username\` column and no \`userId\``, () => {
      const body = model(name);
      expect(body).toMatch(/\n\s+username\s+String\s*\n/);
      expect(body).not.toMatch(/\n\s+userId\s/);
      // The doc comment sits directly above the column it describes.
      const lines = body.split("\n").map((l) => l.trim());
      const at = lines.findIndex((l) => /^username\s+String$/.test(l));
      expect(lines[at - 1]).toContain(DOC);
    });
  }

  it("the indexes follow the column", () => {
    expect(model("NotificationLog")).toContain("@@index([username, createdAt])");
    expect(model("PushSubscription")).toContain("@@index([username])");
  });
});

describe("🔴 WARP-2911 the migration renames and rewrites nothing", () => {
  it("renames both columns in place", () => {
    expect(sql).toContain(`ALTER TABLE "NotificationLog" RENAME COLUMN "userId" TO "username"`);
    expect(sql).toContain(`ALTER TABLE "PushSubscription" RENAME COLUMN "userId" TO "username"`);
  });

  it("renames both indexes to the names Prisma derives, and leaves the endpoint key alone", () => {
    expect(sql).toMatch(
      /ALTER INDEX (IF EXISTS )?"NotificationLog_userId_createdAt_idx" RENAME TO "NotificationLog_username_createdAt_idx"/,
    );
    expect(sql).toMatch(/ALTER INDEX (IF EXISTS )?"PushSubscription_userId_idx" RENAME TO "PushSubscription_username_idx"/);
    expect(code).not.toContain("PushSubscription_endpoint_key");
  });

  it("MUTATION: a drop-and-add or a backfill — every box loses its notification history", () => {
    expect(code).not.toMatch(/\bDROP\b/i);
    expect(code).not.toMatch(/\bADD COLUMN\b/i);
    expect(code).not.toMatch(/\bUPDATE\b/i);
    expect(code).not.toMatch(/\bINSERT\b/i);
    expect(code).not.toMatch(/\bDELETE\b/i);
  });

  it("is re-runnable: each column rename is guarded on the old column existing", () => {
    // Repo idiom: a migration is safe to run twice (a re-stamped folder, a hand
    // re-run). An unguarded RENAME COLUMN fails the second time — a failed
    // migration and a dark box.
    expect(sql).toContain("information_schema.columns");
    expect(sql.match(/column_name = 'userId'/g)).toHaveLength(2);
  });
});
