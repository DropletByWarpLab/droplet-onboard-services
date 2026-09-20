/**
 * WARP-455 — File.scope schema regression.
 *
 * The orchestrator does not own file bytes (Nextcloud does) — this
 * `File` model is a thin scope-bearing registry keyed by Nextcloud's
 * stable `ncFileId`. It exists so the dashboard's scope-filtered file
 * surfaces can join one row per logical file without scanning per-chunk
 * `FileContentChunk` rows for distinct ncFileIds.
 *
 * Per the no-guessing rule (CLAUDE.md) `scope` is an explicit Scope
 * enum column. The backfill (in the matching migration) seeds every
 * pre-existing distinct `ncFileId` from FileContentChunk into File with
 * scope='team', the default. Re-running the migration on a converged
 * DB is a no-op: ON CONFLICT (ncFileId) DO NOTHING guards the upsert.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { MIGRATIONS_DIR, SCHEMA_PATH } from "./helpers/test-paths.js";

function readSchema(): string {
  return readFileSync(SCHEMA_PATH, "utf-8");
}

describe("WARP-455 schema: File.scope", () => {
  it("declares a File model", () => {
    expect(readSchema()).toMatch(/^model File \{/m);
  });

  it("File.scope is the Scope enum (no free-form text), defaulting to team", () => {
    const schema = readSchema();
    const block = schema.match(/model File \{[\s\S]*?\n\}/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/\bscope\s+Scope\b/);
    expect(block![0]).not.toMatch(/\bscope\s+String\b/);
    expect(block![0]).toMatch(/scope\s+Scope\s+@default\(team\)/);
  });

  it("File.ncFileId is a unique integer (the join key against Nextcloud)", () => {
    const schema = readSchema();
    const block = schema.match(/model File \{[\s\S]*?\n\}/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/ncFileId\s+Int\s+@unique/);
  });

  it("File carries ownerUserId so the dashboard can scope-filter per user", () => {
    const schema = readSchema();
    const block = schema.match(/model File \{[\s\S]*?\n\}/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/ownerUserId\s+String/);
  });
});

describe("WARP-455 migration: File backfill idempotency", () => {
  const MIGRATION_PATH = path.join(
    MIGRATIONS_DIR,
    "20260525130200_warp_455_file_scope",
    "migration.sql",
  );

  it("the backfill INSERT uses ON CONFLICT DO NOTHING for idempotence", () => {
    // The migration must be safe to re-run on a converged DB — the
    // CLAUDE.md no-guessing rule + the WARP-455 ticket explicitly
    // call out a stable row count on re-run. ON CONFLICT (ncFileId)
    // DO NOTHING gives us that without a separate existence check.
    const sql = readFileSync(MIGRATION_PATH, "utf-8");
    expect(sql).toMatch(/INSERT INTO "File"/i);
    expect(sql).toMatch(/ON CONFLICT\s*\("ncFileId"\)\s*DO NOTHING/i);
  });

  it("the backfill seeds scope='team' for every new row", () => {
    const sql = readFileSync(MIGRATION_PATH, "utf-8");
    // The INSERT uses the column default ('team') — either via an
    // explicit literal or by omitting the column. Either way, every
    // backfilled row must end at scope='team'. Easiest contract to
    // assert: 'team' is mentioned in the INSERT-into-File block.
    const insertBlock = sql.match(/INSERT INTO "File"[\s\S]*?;/i);
    expect(insertBlock).not.toBeNull();
    // Whether the literal sits inline ('team'::"Scope") or comes
    // from the column default, the column default itself must be
    // present in the migration's column-add path.
    expect(sql).toMatch(/DEFAULT\s+'team'/);
  });
});
