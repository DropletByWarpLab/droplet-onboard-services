/**
 * WARP-457 — workspace settings seeder (idempotent).
 *
 * `seedWorkspaceSettings(prisma)` populates the WorkspaceSetting table
 * from a canonical set of defaults (workspace name, memory/privacy
 * posture, off-LAN feature flags, hardware feature flags, appearance
 * theme). On first run it inserts every default; on subsequent runs
 * it MUST be a no-op:
 *
 *   - Existing rows are never overwritten — the seeder is insert-or-
 *     skip, not upsert. Operators rely on this so a deploy can't reset
 *     a value they tuned from the dashboard.
 *   - Row count is stable across re-runs.
 *
 * This file drives the seeder through an in-memory Prisma mock that
 * surfaces `findMany` + `create` calls. The real seeder uses
 * `createMany({skipDuplicates: true})` for atomicity; the mock here
 * mirrors that semantic (it skips already-present keys without
 * surfacing a uniqueness violation).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

interface MockSettingRow {
  id: string;
  key: string;
  section: string;
  type: string;
  valueJson: unknown;
  createdAt: Date;
  updatedAt: Date;
}

function createPrismaMock(initial: MockSettingRow[] = []) {
  const rows = new Map<string, MockSettingRow>(
    initial.map((r) => [r.key, r]),
  );
  return {
    rows,
    workspaceSetting: {
      findMany: vi.fn(async () => [...rows.values()]),
      createMany: vi.fn(
        async ({
          data,
          skipDuplicates,
        }: {
          data: Array<Omit<MockSettingRow, "id" | "createdAt" | "updatedAt">>;
          skipDuplicates?: boolean;
        }) => {
          let count = 0;
          for (const candidate of data) {
            if (rows.has(candidate.key)) {
              if (skipDuplicates) continue;
              throw new Error(`unique constraint: ${candidate.key}`);
            }
            const now = new Date();
            rows.set(candidate.key, {
              id: `ws-${candidate.key}`,
              key: candidate.key,
              section: candidate.section,
              type: candidate.type,
              valueJson: candidate.valueJson,
              createdAt: now,
              updatedAt: now,
            });
            count += 1;
          }
          return { count };
        },
      ),
    },
  };
}

// Hoisted import so each test imports the live seeder under test.
import { seedWorkspaceSettings, WORKSPACE_SETTING_DEFAULTS } from "../services/workspace-settings.service.js";
import { ALLOWED_ENUM_VALUES } from "../routes/settings.js";

describe("seedWorkspaceSettings", () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  beforeEach(() => {
    prisma = createPrismaMock();
  });

  it("populates every canonical default on first run", async () => {
    const result = await seedWorkspaceSettings(prisma as any);

    // Inserted count equals the number of canonical defaults.
    expect(result.inserted).toBe(WORKSPACE_SETTING_DEFAULTS.length);
    expect(prisma.rows.size).toBe(WORKSPACE_SETTING_DEFAULTS.length);

    // Every default lands in the table with its section + type + value.
    for (const def of WORKSPACE_SETTING_DEFAULTS) {
      const row = prisma.rows.get(def.key);
      expect(row, `expected row for key=${def.key}`).toBeDefined();
      expect(row!.section).toBe(def.section);
      expect(row!.type).toBe(def.type);
      expect(row!.valueJson).toEqual(def.value);
    }
  });

  it("is idempotent — a second run inserts zero rows and keeps the count stable", async () => {
    await seedWorkspaceSettings(prisma as any);
    const firstCount = prisma.rows.size;

    const second = await seedWorkspaceSettings(prisma as any);

    expect(second.inserted).toBe(0);
    expect(prisma.rows.size).toBe(firstCount);
  });

  it("never overwrites a user-edited value (insert-or-skip, never upsert)", async () => {
    // Seed once.
    await seedWorkspaceSettings(prisma as any);

    // Operator edits the workspace name via the dashboard (simulated
    // direct mutation of the in-memory map).
    const workspaceNameKey = "workspace.name";
    const row = prisma.rows.get(workspaceNameKey);
    expect(row).toBeDefined();
    prisma.rows.set(workspaceNameKey, {
      ...row!,
      valueJson: "Cruceru Household",
    });

    // Re-run the seeder. The edited value must survive.
    await seedWorkspaceSettings(prisma as any);

    expect(prisma.rows.get(workspaceNameKey)!.valueJson).toBe(
      "Cruceru Household",
    );
  });

  it("declares one default per SettingSection (sanity: no section is empty)", () => {
    // Defensive coverage: each enum section must have at least one
    // canonical default so the dashboard's Settings surface doesn't
    // render an empty section on a fresh device.
    const sections = new Set(
      WORKSPACE_SETTING_DEFAULTS.map((d) => d.section),
    );
    for (const required of [
      "workspace",
      "memory_privacy",
      "off_lan",
      "hardware",
      "appearance",
    ]) {
      expect(sections, `missing default for section=${required}`).toContain(
        required,
      );
    }
  });

  it("every default's type matches one of the canonical SettingType values", () => {
    const allowed = new Set([
      "string",
      "number",
      "bool",
      "duration_seconds",
      "enum",
      "json",
    ]);
    for (const def of WORKSPACE_SETTING_DEFAULTS) {
      expect(allowed, `unknown type for key=${def.key}`).toContain(def.type);
    }
  });

  // WARP-483 — the enum-validation invariant. Every `type: "enum"`
  // default MUST have a matching entry in the route's
  // ALLOWED_ENUM_VALUES allow-list. If it doesn't, `validateValue`'s
  // enum branch silently falls through to "any string accepted" and
  // the PATCH surface stops gating that key's values — a whole class
  // of invalid writes would sail through unnoticed. This test locks
  // the two tables together: shipping a new enum default without its
  // allow-list entry (or deleting an entry an enum default relies on)
  // fails CI here instead of in production.
  it("every enum default has a matching ALLOWED_ENUM_VALUES entry", () => {
    const enumDefaults = WORKSPACE_SETTING_DEFAULTS.filter(
      (d) => d.type === "enum",
    );
    // Guard against a vacuous pass — if the filter ever yields nothing
    // (e.g. the defaults are refactored away) this assertion makes the
    // silence loud rather than green-by-accident.
    expect(enumDefaults.length).toBeGreaterThan(0);

    for (const def of enumDefaults) {
      const allowed = ALLOWED_ENUM_VALUES[def.key];
      expect(
        allowed,
        `enum default "${def.key}" has no ALLOWED_ENUM_VALUES entry — ` +
          `its PATCH validation would accept any string`,
      ).toBeDefined();
      // The seeded default itself must be a member of its own allow-set.
      expect(
        allowed,
        `enum default "${def.key}" value "${String(def.value)}" is not in ` +
          `its own ALLOWED_ENUM_VALUES allow-list`,
      ).toContain(def.value);
    }
  });
});
