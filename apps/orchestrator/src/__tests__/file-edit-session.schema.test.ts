/**
 * WARP-882 / WS-4: schema + migration assertions for FileEditSession.
 *
 * Vitest mocks `@prisma/client` (see ./setup.ts) so we can't drive a real DB.
 * The contracts this test guards live in the migration SQL + schema.prisma:
 *   - the migration is SAFE TO RE-RUN (duplicate_object enum idiom, IF NOT
 *     EXISTS table/index) — a re-run on a populated box must be a no-op;
 *   - it does NOT use the INVALID `CREATE TYPE ... IF NOT EXISTS`;
 *   - `status` is an EXPLICIT enum column with a default (no IS-NULL derivation);
 *   - the table is keyed on ncFileId.
 *
 * Mirrors the vpn-peer-unique-ip.schema.test.ts pattern (glob the migrations
 * dir + the schema, assert the SQL/Prisma payload).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PRISMA_DIR } from "./helpers/test-paths.js";

const MIGRATIONS_DIR = join(PRISMA_DIR, "migrations");
const SCHEMA = readFileSync(join(PRISMA_DIR, "schema.prisma"), "utf8");

function migrationSql(): string {
  const dir = readdirSync(MIGRATIONS_DIR).find((d) =>
    d.includes("warp_882_file_edit_session"),
  );
  expect(dir, "must ship a `warp_882_file_edit_session` migration directory").toBeTruthy();
  return readFileSync(join(MIGRATIONS_DIR, dir!, "migration.sql"), "utf8");
}

describe("FileEditSession migration (WARP-882)", () => {
  it("creates both enums via the duplicate_object idiom (re-run safe)", () => {
    const sql = migrationSql();
    for (const enumName of ["FileEditSessionMode", "FileEditSessionStatus"]) {
      const block = new RegExp(
        `DO \\$\\$ BEGIN[\\s\\S]*?CREATE TYPE "${enumName}"[\\s\\S]*?EXCEPTION[\\s\\S]*?WHEN duplicate_object THEN null;[\\s\\S]*?END \\$\\$;`,
      );
      expect(block.test(sql), `${enumName} must use the duplicate_object idiom`).toBe(true);
    }
  });

  it("does NOT use the INVALID `CREATE TYPE ... IF NOT EXISTS`", () => {
    // Strip `--` line comments first: the migration's header legitimately NAMES
    // the invalid idiom as a warning, which must not trip the check. Then
    // constrain the match to a single statement (no semicolon between).
    //
    // Split on /\r?\n/, not "\n" (WARP-1008): the checked-in migration is LF
    // (now pinned via .gitattributes), but a stale Windows working tree can
    // still be CRLF. A trailing `\r` defeats `/--.*$/` (`.` never matches `\r`
    // and a non-multiline `$` only matches end-of-string), so the comment
    // survives and the header warning trips the check. Splitting on either
    // terminator keeps the guard correct regardless of checkout EOL.
    const sqlNoComments = migrationSql()
      .split(/\r?\n/)
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n");
    expect(
      /CREATE\s+TYPE[^;]*?IF\s+NOT\s+EXISTS/i.test(sqlNoComments),
      "CREATE TYPE ... IF NOT EXISTS is invalid Postgres — must use duplicate_object",
    ).toBe(false);
  });

  it("creates the table + indexes with IF NOT EXISTS (re-run is a no-op)", () => {
    const sql = migrationSql();
    expect(/CREATE TABLE IF NOT EXISTS "FileEditSession"/.test(sql)).toBe(true);
    expect(
      (sql.match(/CREATE INDEX IF NOT EXISTS/g) ?? []).length,
      "every index must be guarded with IF NOT EXISTS",
    ).toBeGreaterThanOrEqual(2);
  });

  it("keys the table on ncFileId", () => {
    const sql = migrationSql();
    expect(
      /CONSTRAINT "FileEditSession_pkey" PRIMARY KEY \("ncFileId"\)/.test(sql),
      "FileEditSession must be keyed on ncFileId",
    ).toBe(true);
  });

  it("declares status as an EXPLICIT enum column with a default (no IS-NULL state)", () => {
    const sql = migrationSql();
    expect(
      /"status"\s+"FileEditSessionStatus"\s+NOT NULL DEFAULT 'open'/.test(sql),
      "status must be a NOT NULL enum column defaulting to 'open'",
    ).toBe(true);
  });

  it("uses a timestamp strictly greater than its predecessor", () => {
    const stamps = [
      ...new Set(
        readdirSync(MIGRATIONS_DIR)
          .filter((d) => /^\d{14}_/.test(d))
          .map((d) => d.slice(0, 14)),
      ),
    ].sort();
    const dir = readdirSync(MIGRATIONS_DIR).find((d) =>
      d.includes("warp_882_file_edit_session"),
    )!;
    const stamp = dir.slice(0, 14);
    const idx = stamps.indexOf(stamp);
    expect(idx).toBeGreaterThan(-1);
    if (idx > 0) {
      expect(stamp > stamps[idx - 1]).toBe(true);
    }
  });
});

describe("FileEditSession Prisma model (WARP-882)", () => {
  it("declares the model keyed on ncFileId with an explicit status enum", () => {
    expect(/model FileEditSession \{/.test(SCHEMA)).toBe(true);
    expect(/ncFileId\s+Int\s+@id/.test(SCHEMA)).toBe(true);
    expect(/status\s+FileEditSessionStatus\s+@default\(open\)/.test(SCHEMA)).toBe(true);
  });

  it("declares the two enums", () => {
    expect(/enum FileEditSessionMode \{[\s\S]*?edit[\s\S]*?view[\s\S]*?\}/.test(SCHEMA)).toBe(true);
    expect(
      /enum FileEditSessionStatus \{[\s\S]*?open[\s\S]*?closing[\s\S]*?closed[\s\S]*?\}/.test(SCHEMA),
    ).toBe(true);
  });
});
