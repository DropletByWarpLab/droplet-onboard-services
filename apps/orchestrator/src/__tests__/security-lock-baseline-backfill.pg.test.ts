/**
 * WARP-2977 fix — the lock-baseline backfill against a REAL Postgres.
 *
 * 20261001100000_warp_2977_security_lock_baseline backfilled
 * SecurityEvent."baseline" with an UPDATE that the append-only trigger
 * ("SecurityEvent_append_only", ADR-059 §3.3) refuses, so a box holding one
 * baseline lock row could not boot (test box, 2026-10-02). The fix,
 * 20261001095900_warp_2977_security_lock_baseline_backfill, does the backfill
 * first with the trigger switched off for that one statement.
 *
 * This replays both migrations' statements against a database that holds a
 * baseline-shaped row, and pins: the row is backfilled, the trigger is enabled
 * again afterwards (an UPDATE is still refused), and the shipped migration's
 * UPDATE then applies cleanly (zero rows match, so the row-level trigger never
 * fires).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

const MIGRATIONS = join(__dirname, "..", "..", "prisma", "migrations");

/** A migration's statements, minus comments and its own BEGIN/COMMIT (the
 *  test runs them inside one Prisma transaction instead). None of these two
 *  files has a `;` inside a statement. */
function statements(migration: string): string[] {
  return readFileSync(join(MIGRATIONS, migration, "migration.sql"), "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^(BEGIN|COMMIT)$/i.test(s));
}

describe.skipIf(!RUN)("SecurityEvent lock-baseline backfill — real-Postgres (WARP-2977)", () => {
  let prisma: PrismaClient;
  const KEY = "warp2977fix:lock:front-door:after:none:1";
  const OTHER = "warp2977fix:lock:front-door:after:41:2";

  async function cleanup() {
    // DELETE is allowed on SecurityEvent (the guard is BEFORE UPDATE only).
    await prisma.$executeRawUnsafe(`DELETE FROM "SecurityEvent" WHERE "dedupeKey" LIKE 'warp2977fix:%'`);
  }

  async function insertLockRow(dedupeKey: string) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "SecurityEvent"
         ("source", "kind", "severity", "sourceRef", "dedupeKey", "labels", "cameraZones", "startedAt", "summary", "baseline")
       VALUES ('matter_lock', 'lock_state', 'info', 'front-door', $1, '{}', '{}', now(), 'Front door locked', false)`,
      dedupeKey,
    );
  }

  const baseline = async (dedupeKey: string) =>
    (
      await prisma.$queryRawUnsafe<{ baseline: boolean }[]>(
        `SELECT "baseline" FROM "SecurityEvent" WHERE "dedupeKey" = $1`,
        dedupeKey,
      )
    )[0]?.baseline;

  beforeAll(async () => {
    const { PrismaClient } = await import("@prisma/client");
    prisma = new PrismaClient();
  });
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });
  beforeEach(cleanup);

  it("the shipped migration alone is refused on a box holding a baseline row (the bug)", async () => {
    await insertLockRow(KEY);
    const [, update] = statements("20261001100000_warp_2977_security_lock_baseline");
    await expect(prisma.$executeRawUnsafe(update!)).rejects.toThrow(/append-only/);
  });

  it("the fix backfills the row, re-enables the guard, and the shipped migration then applies", async () => {
    await insertLockRow(KEY);
    await insertLockRow(OTHER);

    await prisma.$transaction(async (tx) => {
      for (const sql of statements("20261001095900_warp_2977_security_lock_baseline_backfill")) {
        await tx.$executeRawUnsafe(sql);
      }
    });

    expect(await baseline(KEY)).toBe(true);
    // Only baseline-keyed lock rows are touched.
    expect(await baseline(OTHER)).toBe(false);

    // The guard is enabled again ('O' = fires in origin/local sessions)…
    const [trig] = await prisma.$queryRawUnsafe<{ tgenabled: string }[]>(
      `SELECT tgenabled FROM pg_trigger WHERE tgname = 'SecurityEvent_append_only'`,
    );
    expect(trig?.tgenabled).toBe("O");
    // …so an ordinary UPDATE is still refused.
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "SecurityEvent" SET "summary" = 'x' WHERE "dedupeKey" = $1`, KEY),
    ).rejects.toThrow(/append-only/);

    // The shipped migration now matches zero rows and applies cleanly.
    for (const sql of statements("20261001100000_warp_2977_security_lock_baseline")) {
      await expect(prisma.$executeRawUnsafe(sql)).resolves.toBe(0);
    }
  });

  it("a failed backfill leaves the guard enabled (one transaction)", async () => {
    await insertLockRow(KEY);
    const stmts = statements("20261001095900_warp_2977_security_lock_baseline_backfill");
    await expect(
      prisma.$transaction(async (tx) => {
        for (const sql of stmts.slice(0, 2)) await tx.$executeRawUnsafe(sql); // add column, disable guard
        throw new Error("simulated failure mid-backfill");
      }),
    ).rejects.toThrow(/simulated/);
    const [trig] = await prisma.$queryRawUnsafe<{ tgenabled: string }[]>(
      `SELECT tgenabled FROM pg_trigger WHERE tgname = 'SecurityEvent_append_only'`,
    );
    expect(trig?.tgenabled).toBe("O");
    expect(await baseline(KEY)).toBe(false);
  });
});
