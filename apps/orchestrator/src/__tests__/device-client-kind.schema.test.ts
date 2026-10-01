/**
 * DeviceClient.kind — the explicit discriminator between a native-app pairing
 * and a personal-drive (Finder / File Explorer) login.
 *
 * "Personal drives off" revokes the `personal_drive` rows and must leave the
 * `app_pairing` rows alone, so the column is an enum with a safe default — never
 * derived from `deviceName` or from the absence of pairing columns (CLAUDE.md
 * no-guessing). The migration must be idempotent and must NOT guess a backfill:
 * rows that predate it keep the default.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { MIGRATIONS_DIR, readSchema } from "./helpers/test-paths.js";

describe("DeviceClient.kind schema", () => {
  it("declares the DeviceClientKind enum with exactly app_pairing and personal_drive", () => {
    const block = readSchema().match(/enum DeviceClientKind \{([\s\S]*?)\n\}/);
    expect(block).not.toBeNull();
    const members = block![1]!
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("//"));
    expect(members).toEqual(["app_pairing", "personal_drive"]);
  });

  it("is a required enum column defaulting to app_pairing", () => {
    const block = readSchema().match(/model DeviceClient \{[\s\S]*?\n\}/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/\n\s+kind\s+DeviceClientKind\s+@default\(app_pairing\)/);
    expect(block![0]).not.toMatch(/\n\s+kind\s+DeviceClientKind\?/);
  });

  it("has an idempotent migration that defaults existing rows and does not backfill by guessing", () => {
    const folders = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith("_device_client_kind"));
    expect(folders).toHaveLength(1);
    const sql = readFileSync(path.join(MIGRATIONS_DIR, folders[0]!, "migration.sql"), "utf-8");
    expect(sql).toMatch(
      /CREATE TYPE "DeviceClientKind" AS ENUM \('app_pairing', 'personal_drive'\);\s*EXCEPTION\s+WHEN duplicate_object THEN null;/,
    );
    expect(sql).toMatch(
      /ALTER TABLE "DeviceClient"\s+ADD COLUMN IF NOT EXISTS "kind" "DeviceClientKind" NOT NULL DEFAULT 'app_pairing';/,
    );
    // No data statement: a backfill keyed on deviceName would be a guess.
    expect(sql).not.toMatch(/^\s*UPDATE\b/im);
  });
});
