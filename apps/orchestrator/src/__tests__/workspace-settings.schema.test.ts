/**
 * WARP-457 — Prisma schema regression for the workspace settings registry.
 *
 * These tests run against the schema.prisma file text (no DB needed) to
 * lock the contract that the generated client must expose:
 *
 *   - `WorkspaceSetting` model: id, key (unique), section, type, valueJson,
 *     createdAt, updatedAt.
 *   - `SettingSection` enum: workspace | memory_privacy | off_lan |
 *     hardware | appearance.
 *   - `SettingType` enum: string | number | bool | duration_seconds |
 *     enum | json.
 *
 * Per the no-guessing rule (CLAUDE.md) both `section` and `type` are
 * explicit Prisma enum columns — never derived from a nullable field
 * or a free-form string. Mirrors WARP-218's BrainMemoryItemStatus
 * pattern and WARP-455's Role/Scope usage.
 *
 * The seeder + route layer trust these enums for indexable section
 * grouping (GET /api/settings groups by `section`) and per-type
 * validation (PATCH /api/settings/:section validates `value` against
 * `type`). Changing the enum members here is a breaking-change for
 * the dashboard and must go through a migration with a backfill plan.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { SCHEMA_PATH } from "./helpers/test-paths.js";

function readSchema(): string {
  return readFileSync(SCHEMA_PATH, "utf-8");
}

describe("WARP-457 schema: workspace settings", () => {
  it("declares a WorkspaceSetting model", () => {
    const schema = readSchema();
    expect(schema).toMatch(/^model WorkspaceSetting \{/m);
  });

  it("WorkspaceSetting.key is unique", () => {
    const schema = readSchema();
    const block = schema.match(/model WorkspaceSetting \{[\s\S]*?\n\}/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/key\s+String\s+@unique/);
  });

  it("WorkspaceSetting.section is a SettingSection enum (no free-form text)", () => {
    const schema = readSchema();
    const block = schema.match(/model WorkspaceSetting \{[\s\S]*?\n\}/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/\bsection\s+SettingSection\b/);
    expect(block![0]).not.toMatch(/\bsection\s+String\b/);
  });

  it("WorkspaceSetting.type is a SettingType enum (no free-form text)", () => {
    const schema = readSchema();
    const block = schema.match(/model WorkspaceSetting \{[\s\S]*?\n\}/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/\btype\s+SettingType\b/);
    expect(block![0]).not.toMatch(/\btype\s+String\b/);
  });

  it("WorkspaceSetting.valueJson is a Json column", () => {
    // Carrier for every type-erased value. The recorder + route layer
    // validate the shape against `type` before write/read; keeping the
    // storage as Json means adding a new SettingType doesn't need a
    // schema migration on the value column.
    const schema = readSchema();
    const block = schema.match(/model WorkspaceSetting \{[\s\S]*?\n\}/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/valueJson\s+Json\b/);
  });

  it("WorkspaceSetting indexes section so GET /api/settings can group efficiently", () => {
    // GET /api/settings groups by section; an index on `section` keeps
    // the grouped query plan stable as the row count grows. Without it
    // the dashboard's initial-load query would degrade once memory_privacy
    // and off_lan fan out.
    const schema = readSchema();
    const block = schema.match(/model WorkspaceSetting \{[\s\S]*?\n\}/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/@@index\(\[section\]\)/);
  });

  it("declares SettingSection enum with the 6 canonical members", () => {
    const schema = readSchema();
    expect(schema).toMatch(/^enum SettingSection \{/m);
    const block = schema.match(/enum SettingSection \{[\s\S]*?\n\}/);
    expect(block).not.toBeNull();
    for (const member of [
      "workspace",
      "memory_privacy",
      "off_lan",
      "hardware",
      "appearance",
      // WARP-1112 — active local model choice (`ai.model.chat`), managed
      // from /models. Deliberately NOT in the settings route's
      // SECTION_VALUES; PATCH /api/models/active is the only writer.
      "ai",
    ]) {
      // Match the bare token on its own line to avoid substring
      // matches (e.g. `memory_privacy` accidentally matching `memory`).
      expect(block![0]).toMatch(new RegExp(`^\\s*${member}\\s*$`, "m"));
    }
  });

  it("declares SettingType enum with the 6 canonical members", () => {
    const schema = readSchema();
    expect(schema).toMatch(/^enum SettingType \{/m);
    const block = schema.match(/enum SettingType \{[\s\S]*?\n\}/);
    expect(block).not.toBeNull();
    for (const member of [
      "string",
      "number",
      "bool",
      "duration_seconds",
      "enum",
      "json",
    ]) {
      expect(block![0]).toMatch(new RegExp(`^\\s*${member}\\s*$`, "m"));
    }
  });
});
