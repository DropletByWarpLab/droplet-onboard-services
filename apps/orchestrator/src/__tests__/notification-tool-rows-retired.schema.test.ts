/**
 * WARP-3060 — the migration that retires the rows `send_notification` wrote
 * and nothing delivered, read as text (default lane, no DB).
 *
 * The behaviour is proven against real Postgres in
 * `notification-tool-rows-retired.pg.test.ts`. This file pins the shape that
 * makes the migration safe on every box: data only, never a delete, one
 * UPDATE whose predicate only the tool's rows can match, and an ack change
 * that never invents an ack. It also pins the order: the migration reads
 * WARP-2804's `ackState`, so it must sort after the migration that adds it.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { MIGRATIONS_DIR } from "./helpers/test-paths.js";

const MIGRATION = "20260925020000_warp_3060_retire_undelivered_tool_notifications";
const sql = readFileSync(join(MIGRATIONS_DIR, MIGRATION, "migration.sql"), "utf8");
/** The statements alone: the header is allowed to talk about what it does not do. */
const code = sql
  .split(/\r?\n/)
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");
/** Whitespace-collapsed, so a clause reads the same across line breaks. */
const flat = code.replace(/\s+/g, " ").trim();

const PREDICATE = [
  `"kind" = 'ai'`,
  `"channels" = ''`,
  `"deliveredAt" IS NULL`,
  `"error" IS NULL`,
  `"pushOutcome" IS NULL`,
];

describe("🔴 WARP-3060 retiring the tool's undelivered rows", () => {
  it("one UPDATE, over exactly the tool's shape — kind ai, no channel, no delivery, no error, no push outcome", () => {
    expect(flat.match(/UPDATE "NotificationLog"/g)).toHaveLength(1);
    const where = flat.slice(flat.indexOf(" WHERE "));
    for (const clause of PREDICATE) expect(where, clause).toContain(clause);
    expect(flat).toContain(`"error" = 'delivery: never_sent (WARP-3060)'`);
  });

  it("an unacked row stops counting as unread; nothing is marked acked", () => {
    expect(flat).toContain(
      `"ackState" = CASE WHEN "ackState" = 'unacked' THEN 'untracked'::"NotificationAckState" ELSE "ackState" END`,
    );
    expect(code).not.toMatch(/'acked'/);
    expect(code).not.toMatch(/"ackedAt"|"ackMethod"/);
  });

  it("data only — no DDL, and no row is deleted: the notification history stays", () => {
    expect(code).not.toMatch(/\b(CREATE|ALTER|DROP|TRUNCATE|DELETE|INSERT)\b/i);
  });

  it("sorts after WARP-2804's notification-ack migration, whose ackState it reads", () => {
    const names = readdirSync(MIGRATIONS_DIR).filter((n) => /^\d{14}_/.test(n)).sort();
    const ack = names.findIndex((n) => n.endsWith("_warp_2804_notification_ack"));
    expect(ack).toBeGreaterThanOrEqual(0);
    expect(names.indexOf(MIGRATION)).toBeGreaterThan(ack);
  });
});
