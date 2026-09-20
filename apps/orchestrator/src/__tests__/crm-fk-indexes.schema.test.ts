/**
 * WARP-2577 defect 2 — every `ON DELETE SET NULL` foreign key in the CRM must
 * be indexed.
 *
 * Postgres indexes the PRIMARY KEY side of a relation and never the
 * referencing side, so a nullable FK column starts life unindexed. The cost is
 * paid on the PARENT's delete: to null the children, Postgres must find them,
 * and with no index that is a sequential scan of the child table. Deleting one
 * note walked all of `CrmActivity`.
 *
 * This is written as a DERIVED rule rather than a list of five index names on
 * purpose. A list would be satisfied by exactly the columns that were wrong in
 * August and would say nothing about the sixth SetNull column somebody adds in
 * October — which is precisely how the first five got in, since the repo
 * already documents this hazard verbatim under WARP-845 on its own relation
 * and indexes it there.
 *
 * MUTATIONS THIS CATCHES:
 *   - delete any of the five `@@index` lines → red, naming the column
 *   - add a new `onDelete: SetNull` relation with no index → red
 *   - "fix" it by indexing the column second in a composite → red, because a
 *     non-leading column cannot serve this lookup
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { PRISMA_DIR } from "./helpers/test-paths.js";

const schema = readFileSync(join(PRISMA_DIR, "schema.prisma"), "utf8");

function modelBlock(name: string): string {
  const match = schema.match(new RegExp(`\\nmodel\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`));
  if (!match) throw new Error(`model ${name} not found in schema.prisma`);
  return match[1];
}

/**
 * The scalar columns backing every `onDelete: SetNull` relation on `model`.
 * Read off the relation line's `fields: [...]`, which is where Prisma states
 * which column actually carries the constraint.
 */
function setNullForeignKeyColumns(model: string): string[] {
  const columns: string[] = [];
  for (const line of modelBlock(model).split("\n")) {
    if (!line.includes("onDelete: SetNull")) continue;
    const fields = line.match(/fields:\s*\[([^\]]+)\]/);
    if (fields) columns.push(...fields[1].split(",").map((f) => f.trim()));
  }
  return columns;
}

/**
 * Columns that lead an index on `model` — the only position from which a
 * column can serve a lookup. `@@unique` counts: Postgres backs it with an
 * index like any other.
 */
function indexLeadingColumns(model: string): Set<string> {
  const block = modelBlock(model);
  const leading = new Set<string>();
  for (const pattern of [/@@index\(\[([^\]]+)\]/g, /@@unique\(\[([^\]]+)\]/g]) {
    for (const match of block.matchAll(pattern)) {
      leading.add(match[1].split(",")[0].trim());
    }
  }
  return leading;
}

describe("WARP-2577 — SetNull foreign keys are indexed", () => {
  // Both CRM tables a delete elsewhere in the box can reach. `Contact` is not
  // here because its relations are Cascade or owner-scoped, not SetNull.
  for (const model of ["CrmDeal", "CrmActivity"]) {
    it(`indexes every SetNull foreign key on ${model}`, () => {
      const columns = setNullForeignKeyColumns(model);
      // Guards the guard: if the parse ever silently returns nothing, the
      // for-loop below would pass vacuously and this test would be one of the
      // green-tests-that-cannot-fail the repo keeps finding.
      expect(columns.length, `${model} SetNull columns parsed`).toBeGreaterThan(0);

      const leading = indexLeadingColumns(model);
      for (const column of columns) {
        expect(
          leading.has(column),
          `${model}.${column} is ON DELETE SET NULL and leads no index — deleting the parent seq-scans ${model}`,
        ).toBe(true);
      }
    });
  }

  it("names the five columns this ticket was filed for", () => {
    // The derived rule above is the durable one. This is the regression pin:
    // it fails loudly if a future refactor drops one of the exact columns the
    // defect was about, even if some other SetNull column keeps the rule green.
    expect(setNullForeignKeyColumns("CrmDeal")).toContain("projectId");
    expect(setNullForeignKeyColumns("CrmActivity").sort()).toEqual([
      "calendarEventId",
      "emailMessageId",
      "noteId",
      "workItemId",
    ]);
  });

  it("ships the indexes in a migration, not only in the schema", () => {
    // A schema-only change is invisible to a deployed box: `prisma migrate
    // deploy` replays migration SQL and never reads schema.prisma.
    const sql = readFileSync(
      join(PRISMA_DIR, "migrations", "20260831173000_warp_2577_crm_fk_indexes", "migration.sql"),
      "utf8",
    );
    for (const [table, column] of [
      ["CrmDeal", "projectId"],
      ["CrmActivity", "noteId"],
      ["CrmActivity", "emailMessageId"],
      ["CrmActivity", "calendarEventId"],
      ["CrmActivity", "workItemId"],
    ]) {
      expect(sql).toContain(`CREATE INDEX "${table}_${column}_idx" ON "${table}"("${column}")`);
    }
  });

  it("does not duplicate an index the subject columns already lead", () => {
    // CrmActivity's three subject columns each lead a composite index already.
    // Adding single-column copies would be write amplification on the busiest
    // table here for no read that the composite cannot serve.
    const sql = readFileSync(
      join(PRISMA_DIR, "migrations", "20260831173000_warp_2577_crm_fk_indexes", "migration.sql"),
      "utf8",
    );
    for (const column of ["companyId", "contactId", "dealId"]) {
      expect(sql).not.toContain(`"CrmActivity_${column}_idx"`);
    }
  });
});
