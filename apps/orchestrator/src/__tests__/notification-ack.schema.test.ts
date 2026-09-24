/**
 * WARP-2804 — a notification can be acknowledged by its recipient.
 *
 * Asserted against the schema AND the migration, in the DB-less lane every PR
 * runs: the schema is what the client believes, the migration is what every
 * box's database will hold. The CI drift gate (`scripts/check-schema-drift.sh`)
 * proves the columns, enums and index agree; it cannot see a CHECK, and it
 * cannot see WHICH value the existing rows were backfilled with — those two
 * are what this file pins. The real-Postgres twin is
 * `notifications-ack.pg.test.ts`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, readSchema } from "./helpers/test-paths.js";

const schema = readSchema().replace(/\r\n/g, "\n");
const MIGRATION = "20260924040000_warp_2804_notification_ack";
const sql = readFileSync(join(MIGRATIONS_DIR, MIGRATION, "migration.sql"), "utf8").replace(/\r\n/g, "\n");
/** The statements alone: the header may SAY things the code must not do. */
const code = sql
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");

function block(kind: "model" | "enum", name: string): string {
  const match = schema.match(new RegExp(`\\n${kind}\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`));
  if (!match) throw new Error(`${kind} ${name} not found in schema.prisma`);
  return match[1]!;
}

/** The value lines of an enum, in order (doc comments dropped). */
function enumValues(name: string): string[] {
  return block("enum", name)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("//"));
}

describe("🔴 WARP-2804 NotificationLog carries the recipient's acknowledgement", () => {
  it("two explicit enums: the state, and the path that acked", () => {
    expect(enumValues("NotificationAckState")).toEqual(["unacked", "acked", "untracked"]);
    expect(enumValues("NotificationAckMethod")).toEqual(["inbox", "opened", "all", "incident"]);
  });

  it("five columns: an explicit state (default unacked) and the four ack facts", () => {
    const body = block("model", "NotificationLog");
    expect(body).toMatch(/\n\s+ackState\s+NotificationAckState\s+@default\(unacked\)/);
    expect(body).toMatch(/\n\s+ackedAt\s+DateTime\?/);
    expect(body).toMatch(/\n\s+ackMethod\s+NotificationAckMethod\?/);
    expect(body).toMatch(/\n\s+ackSessionId\s+String\?\s+@db\.VarChar\(64\)/);
    expect(body).toMatch(/\n\s+ackClient\s+String\?\s+@db\.VarChar\(120\)/);
  });

  it("review F3: whether the ack's sign-in was confirmed live is its own NOT NULL flag, default false", () => {
    const body = block("model", "NotificationLog");
    expect(body).toMatch(/\n\s+ackSessionChecked\s+Boolean\s+@default\(false\)/);
    // The sid comment no longer claims more than the box can check.
    expect(body).not.toMatch(/PROVEN/);
  });

  it("the unread index leads with the recipient and the state", () => {
    const body = block("model", "NotificationLog");
    expect(body).toContain("@@index([username, createdAt])");
    expect(body).toContain("@@index([username, ackState, createdAt])");
  });
});

describe("🔴 WARP-2804 the migration", () => {
  it("creates both types with the schema's values, in order", () => {
    expect(code).toMatch(/CREATE TYPE "NotificationAckState" AS ENUM \('unacked', 'acked', 'untracked'\)/);
    expect(code).toMatch(/CREATE TYPE "NotificationAckMethod" AS ENUM \('inbox', 'opened', 'all', 'incident'\)/);
  });

  it("adds the five columns with the database types the schema declares", () => {
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS "ackState" "NotificationAckState" NOT NULL DEFAULT 'untracked'/);
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS "ackedAt" TIMESTAMP\(3\)/);
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS "ackMethod" "NotificationAckMethod"/);
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS "ackSessionId" VARCHAR\(64\)/);
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS "ackClient" VARCHAR\(120\)/);
  });

  it("MUTATION: rows written before WARP-2804 are backfilled `untracked`, and only then does the default become `unacked`", () => {
    // `unacked` as the backfill floods every badge with 90 days of history;
    // `acked` fakes an ack nobody made. The ADD COLUMN's DEFAULT is what the
    // existing rows get; the SET DEFAULT after it is what new rows get.
    const add = code.indexOf(`"ackState" "NotificationAckState" NOT NULL DEFAULT 'untracked'`);
    const setDefault = code.search(/ALTER COLUMN "ackState" SET DEFAULT 'unacked'/);
    expect(add).toBeGreaterThan(-1);
    expect(setDefault).toBeGreaterThan(add);
    // Exactly one DEFAULT on the add: nothing else backfills the column.
    expect(code.match(/"ackState" "NotificationAckState"[^,;]*DEFAULT '(\w+)'/g)).toHaveLength(1);
    // No UPDATE rewrites history either way.
    expect(code).not.toMatch(/\bUPDATE\s+"NotificationLog"/i);
  });

  it("creates the unread index under the name Prisma derives", () => {
    expect(code).toMatch(
      /CREATE INDEX IF NOT EXISTS "NotificationLog_username_ackState_createdAt_idx"\s+ON "NotificationLog" \("username", "ackState", "createdAt"\)/,
    );
  });

  it("the CHECK: acked ⇔ (ackedAt and ackMethod), and the device facts only on an acked row", () => {
    const flat = code.replace(/\s+/g, " ");
    expect(flat).toContain(`CONSTRAINT "NotificationLog_ack_shape" CHECK (`);
    expect(flat).toContain(`("ackState" = 'acked') = ("ackedAt" IS NOT NULL AND "ackMethod" IS NOT NULL)`);
    expect(flat).toContain(`("ackState" = 'acked' OR ("ackSessionId" IS NULL AND "ackClient" IS NULL))`);
  });

  it("review F3: ackSessionChecked is added NOT NULL DEFAULT false, and a second CHECK holds it to an acked row with a sign-in", () => {
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS "ackSessionChecked" BOOLEAN NOT NULL DEFAULT false/);
    const flat = code.replace(/\s+/g, " ");
    expect(flat).toContain(`CONSTRAINT "NotificationLog_ack_session_checked" CHECK (`);
    expect(flat).toContain(
      `CHECK ( NOT "ackSessionChecked" OR ("ackState" = 'acked' AND "ackSessionId" IS NOT NULL) )`,
    );
    expect(flat).toContain(
      `FROM pg_constraint WHERE conname = 'NotificationLog_ack_session_checked' AND conrelid = '"NotificationLog"'::regclass`,
    );
  });

  it("is re-runnable: types and the CHECK are guarded, columns and the index use IF NOT EXISTS", () => {
    // Repo idiom (WARP-2896's folder): a migration is safe to run twice —
    // a re-stamped folder, a hand re-run — so a second run is a no-op rather
    // than a failed migration and a dark box.
    expect(code.match(/WHEN duplicate_object THEN NULL/g)).toHaveLength(2);
    expect(code.replace(/\s+/g, " ")).toContain(
      `FROM pg_constraint WHERE conname = 'NotificationLog_ack_shape' AND conrelid = '"NotificationLog"'::regclass`,
    );
    expect(code.match(/ADD COLUMN IF NOT EXISTS/g)).toHaveLength(6);
    expect(code).not.toMatch(/ADD COLUMN (?!IF NOT EXISTS)/);
  });

  it("drops and rewrites nothing", () => {
    expect(code).not.toMatch(/\bDROP\b/i);
    expect(code).not.toMatch(/\bDELETE\b/i);
    expect(code).not.toMatch(/\bINSERT\b/i);
  });
});
