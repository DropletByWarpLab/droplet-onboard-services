/**
 * WARP-2729 (ADR-048) — the filing schema's two structural rules, checked as
 * TEXT so they run on the REQUIRED CI leg.
 *
 * `filing-schema.pg.test.ts` proves these invariants against a real Postgres,
 * which is the stronger proof — but `orchestrator-tests / pg-integration` is
 * not a required status check today (only `ci-summary`, `egress-gate` and the
 * WARP-title lint are; making the pg lane blocking is WARP-2728). So a schema
 * whose safety lives entirely in constraints would be merged by a red pg run
 * that blocked nothing. These two rules are the ones worth catching at the
 * text level, and they are DERIVED rather than listed, so they also bind the
 * next column somebody adds.
 *
 * RULE 1 — no CHECK may reference a column that an FK will SetNull.
 *
 *   An `onDelete: SetNull` FK whose column a NOT-NULL CHECK requires makes the
 *   parent row UN-DELETABLE: the SetNull fires inside the same statement the
 *   CHECK then rejects. This design has two such columns —
 *   `IngestProposal.emailMessageId` (whose grandparent `EmailAccount` cascades)
 *   and the `proposalId` back-pointers — and the whole shape of the migration
 *   is arranged around keeping them out of every constraint. A future
 *   "tightening" that adds `AND "emailMessageId" IS NOT NULL` would silently
 *   make `DELETE /api/email/accounts` fail forever.
 *
 * RULE 2 — every column added to a Python-written table is nullable or has a
 * DB-level DEFAULT.
 *
 *   `services/file-indexer/db.py set_index_status` INSERTs `FileIndexStatus`
 *   naming its own columns. A NOT NULL column with no DEFAULT breaks that
 *   INSERT — and breaks it SILENTLY, because `watcher.py _set_status` swallows
 *   every DB exception at `logger.debug`. Indexing would simply stop while the
 *   dashboard stayed green. Prisma's CLIENT-side defaults (`@default(uuid())`,
 *   `@default(cuid())`, `@updatedAt`) emit no DB default at all, so "it has a
 *   @default" is not sufficient — the migration SQL is what must be checked.
 *
 * MUTATIONS THIS CATCHES:
 *   - add `AND "emailMessageId" IS NOT NULL` to any IngestProposal CHECK → red
 *   - add a CHECK mentioning `proposalId` → red
 *   - add a NOT NULL column with no DEFAULT to FileIndexStatus → red
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { PRISMA_DIR } from "./helpers/test-paths.js";

const MIGRATIONS = join(PRISMA_DIR, "migrations");

/** Every filing migration's SQL, concatenated. */
function filingSql(): string {
  return readdirSync(MIGRATIONS)
    .filter((d) => d.includes("warp_2729"))
    .map((d) => readFileSync(join(MIGRATIONS, d, "migration.sql"), "utf8"))
    .join("\n");
}

/** Strip `--` comments so prose about a column never counts as a reference. */
function stripComments(sql: string): string {
  return sql
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");
}

/** Every `ADD CONSTRAINT ... CHECK (...)` body in the given SQL. */
function checkBodies(sql: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  const re = /ADD\s+CONSTRAINT\s+"([^"]+)"\s+CHECK\s*\(([\s\S]*?)\);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) out.push({ name: m[1], body: m[2] });
  return out;
}

describe("WARP-2729 — filing migrations exist and are self-consistent", () => {
  it("ships the three migrations the slice describes", () => {
    const dirs = readdirSync(MIGRATIONS).filter((d) => d.includes("warp_2729"));
    expect(dirs).toHaveLength(3);
    // The enum widening is alone in its own file: `ALTER TYPE ... ADD VALUE`
    // adds a label that cannot be USED until its transaction commits, and
    // Prisma runs one transaction per migration file.
    const enumFile = dirs.find((d) => d.includes("extracted_origin"));
    expect(enumFile).toBeTruthy();
    const enumSql = stripComments(
      readFileSync(join(MIGRATIONS, enumFile as string, "migration.sql"), "utf8"),
    );
    expect(enumSql).toMatch(/ALTER TYPE "CrmRecordOrigin" ADD VALUE 'EXTRACTED'/);
    expect(enumSql).toMatch(/ALTER TYPE "ContactOrigin" ADD VALUE 'EXTRACTED'/);
    // No other statement may share the file.
    const statements = enumSql.split(";").map((s) => s.trim()).filter(Boolean);
    expect(statements).toHaveLength(2);
  });

  it("sorts after every migration already on stage", () => {
    const all = readdirSync(MIGRATIONS).filter((d) => /^\d{14}_/.test(d)).sort();
    const ours = all.filter((d) => d.includes("warp_2729"));
    const others = all.filter((d) => !d.includes("warp_2729"));
    const lastOther = others[others.length - 1];
    // Pins the PREDECESSOR, not "mine sort last" — a test asserting the latter
    // is wrong by construction and the next migration falsifies it.
    expect(ours.every((d) => d > lastOther)).toBe(true);
  });
});

describe("RULE 1 — no CHECK constrains a column an FK will SetNull", () => {
  const sql = stripComments(filingSql());

  // Columns that are the referencing side of an `ON DELETE SET NULL` FK, read
  // off the migration rather than listed, so a new one is covered too.
  const setNullColumns = (() => {
    const out = new Set<string>();
    const re = /FOREIGN KEY \("([^"]+)"\)[\s\S]*?ON DELETE SET NULL/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql)) !== null) out.add(m[1]);
    return out;
  })();

  it("finds the SetNull columns this slice adds", () => {
    // If this goes empty the rule below would pass vacuously — the exact shape
    // of green-test-that-cannot-fail the repo has been bitten by. Counted two
    // ways because the set is DEDUPED by column name: `proposalId` is the
    // referencing column on both CrmCompany and Contact, so three FK
    // statements yield two names.
    const fkStatements = (sql.match(/ON DELETE SET NULL/g) ?? []).length;
    expect(fkStatements).toBeGreaterThanOrEqual(3);
    expect(setNullColumns.size).toBeGreaterThanOrEqual(2);
    expect(setNullColumns).toContain("emailMessageId");
    expect(setNullColumns).toContain("proposalId");
  });

  it.each([...setNullColumns])(
    'no CHECK requires "%s" to be non-null',
    (col) => {
      for (const { name, body } of checkBodies(sql)) {
        const requiresNonNull = new RegExp(`"${col}"\\s+IS\\s+NOT\\s+NULL`, "i").test(body);
        expect(
          requiresNonNull,
          `CHECK ${name} requires "${col}" IS NOT NULL, but that column is ` +
            `SetNull'd by an FK. The parent delete would fail inside the same ` +
            `statement. See the block comment at the top of the filing_tables ` +
            `migration.`,
        ).toBe(false);
      }
    },
  );

  it("states the source invariant over sourceKind, never over the nullable pointers", () => {
    const pointer = checkBodies(sql).find((c) =>
      c.name === "IngestProposal_source_pointer_matches_kind",
    );
    expect(pointer).toBeTruthy();
    // It may say a pointer IS NULL (that is the consistency half) but never
    // that one IS NOT NULL (that is the trap).
    expect(pointer?.body).toMatch(/"sourceKind"/);
    expect(pointer?.body).not.toMatch(/IS\s+NOT\s+NULL/i);
  });
});

describe("RULE 2 — Python-written tables only gain nullable or defaulted columns", () => {
  const sql = stripComments(filingSql());

  /** `ADD COLUMN "x" TYPE ...` clauses for one table, across all our SQL. */
  function addedColumns(table: string): { col: string; clause: string }[] {
    const out: { col: string; clause: string }[] = [];
    const alters = sql.match(
      new RegExp(`ALTER TABLE "${table}"([\\s\\S]*?);`, "g"),
    );
    for (const alter of alters ?? []) {
      const re = /ADD COLUMN\s+"([^"]+)"([^,;]*)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(alter)) !== null) out.push({ col: m[1], clause: m[2] });
    }
    return out;
  }

  const fileIndexStatusCols = addedColumns("FileIndexStatus");

  it("finds the columns this slice adds to FileIndexStatus", () => {
    expect(fileIndexStatusCols.length).toBeGreaterThanOrEqual(5);
  });

  it.each(fileIndexStatusCols)(
    'FileIndexStatus."$col" is nullable or has a DB-level DEFAULT',
    ({ col, clause }) => {
      const notNull = /NOT\s+NULL/i.test(clause);
      const hasDefault = /DEFAULT/i.test(clause);
      expect(
        !notNull || hasDefault,
        `FileIndexStatus."${col}" is NOT NULL with no DEFAULT. ` +
          `services/file-indexer/db.py set_index_status INSERTs this table ` +
          `naming its own columns and would start failing — silently, because ` +
          `watcher.py _set_status swallows DB errors at logger.debug.`,
      ).toBe(true);
    },
  );

  it("backfills both ledgers so enabling filing never files the whole history", () => {
    expect(sql).toMatch(/UPDATE "FileIndexStatus"[\s\S]*?'not_needed'[\s\S]*?'backlog'/);
    expect(sql).toMatch(/UPDATE "EmailMessage"[\s\S]*?'not_needed'[\s\S]*?'backlog'/);
  });
});

describe("the invariants that make auto mode a gate rather than a promise", () => {
  const sql = stripComments(filingSql());
  const names = checkBodies(sql).map((c) => c.name);

  it("refuses auto mode without a recorded canary pass", () => {
    expect(names).toContain("AutoFilingSetting_auto_requires_canary");
    const body = checkBodies(sql).find(
      (c) => c.name === "AutoFilingSetting_auto_requires_canary",
    )?.body;
    expect(body).toMatch(/"canaryPassedAt" IS NOT NULL/);
    expect(body).toMatch(/"canaryModel" IS NOT NULL/);
  });

  it("refuses consent without a named actor, in both directions", () => {
    const body = checkBodies(sql).find(
      (c) => c.name === "AutoFilingSetting_enabled_has_actor",
    )?.body;
    // An equality of two booleans, so neither direction can be forgotten.
    expect(body).toMatch(/=/);
    expect(body).toMatch(/"enabledById" IS NOT NULL/);
  });

  it("makes a NEVER-class proposal and a patient record unappliable in the database", () => {
    expect(names).toContain("IngestProposal_never_is_unappliable");
    expect(names).toContain("IngestProposal_record_verdict_never_applies");
  });
});
