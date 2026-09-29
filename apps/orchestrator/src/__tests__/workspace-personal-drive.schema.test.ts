/**
 * Workspace.personalDriveEnabled — the owner setting behind
 * POST /api/storage/network-drive/personal (docs/network-drive.md).
 *
 * Per the no-guessing rule (CLAUDE.md) the setting is an EXPLICIT, NOT NULL
 * boolean on the Workspace singleton that defaults OFF — never derived from
 * DeviceClient rows or a role. The migration must default existing rows to
 * false and stay idempotent (ADD COLUMN IF NOT EXISTS).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { MIGRATIONS_DIR, readSchema } from "./helpers/test-paths.js";

describe("Workspace.personalDriveEnabled schema", () => {
  it("is a required boolean that defaults to false", () => {
    const block = readSchema().match(/model Workspace \{[\s\S]*?\n\}/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/personalDriveEnabled\s+Boolean\s+@default\(false\)/);
    expect(block![0]).not.toMatch(/personalDriveEnabled\s+Boolean\?/);
  });

  it("has an idempotent migration that defaults the column to false", () => {
    const folders = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith("_workspace_personal_drive_enabled"));
    expect(folders).toHaveLength(1);
    const sql = readFileSync(path.join(MIGRATIONS_DIR, folders[0]!, "migration.sql"), "utf-8");
    expect(sql).toMatch(
      /ALTER TABLE "Workspace"\s+ADD COLUMN IF NOT EXISTS "personalDriveEnabled" BOOLEAN NOT NULL DEFAULT false;/,
    );
  });
});
