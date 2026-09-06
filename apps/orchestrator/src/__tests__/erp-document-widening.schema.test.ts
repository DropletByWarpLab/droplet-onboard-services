/**
 * WARP-2739 (ADR-049 §4.1) — the widening, asserted against the schema and the
 * migration that produces it.
 *
 * ── Why both, and not just the schema ──────────────────────────────────────
 *
 * `schema.prisma` is what the CLIENT believes and the migration is what the
 * DATABASE will hold, and nothing in the build makes them agree about an enum's
 * VALUES. Prisma's `migrate diff` gate (`check-schema-drift.sh`) catches a
 * missing column or index; it does not catch a `CREATE TYPE` listing thirteen
 * labels where the datamodel lists fourteen, because the datamodel is where the
 * diff's "to" side comes from. The failure that produces is a P2009 on the one
 * status nobody tested, months later.
 *
 * ── And the migration ORDER ────────────────────────────────────────────────
 *
 * Asserted as a RELATION — this migration must sort after WARP-2581's, the one
 * that created the table — rather than as a position in a list. A test that
 * named the folders that exist today would have to be edited by every
 * subsequent migration, and a test edited by everyone is a test nobody reads.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, PRISMA_DIR } from "./helpers/test-paths.js";

const schema = readFileSync(join(PRISMA_DIR, "schema.prisma"), "utf8");

/** The migration that CREATED the table, and the one that widened it. */
const CREATED_TABLE = "20260901050000_warp_2581_erp_document";
const WIDENED = "20260905010000_warp_2739_erp_document_widening";

function block(kind: "model" | "enum", name: string): string {
  const match = schema.match(new RegExp(`\\n${kind}\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`));
  if (!match) throw new Error(`${kind} ${name} not found in schema.prisma`);
  return match[1];
}

/** Enum values as the datamodel declares them, comments and blanks dropped. */
function enumValues(name: string): string[] {
  return block("enum", name)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("//") && !line.startsWith("///"));
}

/** The same enum's labels as the MIGRATION writes them. */
function migrationEnumValues(sql: string, name: string): string[] {
  const match = sql.match(new RegExp(`CREATE TYPE "${name}" AS ENUM \\(([^)]*)\\)`));
  if (!match) throw new Error(`no CREATE TYPE for ${name} in the migration`);
  return [...match[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
}

const migration = readFileSync(join(MIGRATIONS_DIR, WIDENED, "migration.sql"), "utf8");

describe("🔴 ErpDocumentKind is a kind, not a direction", () => {
  it("holds the six values and neither of the two it replaced", () => {
    expect(enumValues("ErpDocumentKind")).toEqual([
      "QUOTE",
      "ORDER",
      "INVOICE",
      "BILL",
      "CREDIT_NOTE",
      "RECEIPT",
    ]);
  });

  it("maps the old values forward rather than dropping rows on a bench box", () => {
    // `ErpDocument` has never reached `main`, so this runs over an empty table
    // on every customer box — but a bench box that landed from a sandbox
    // connection has data, and a USING cast with no CASE would fail on it.
    expect(migration).toMatch(/WHEN 'RECEIVABLE' THEN 'INVOICE'/);
    expect(migration).toMatch(/WHEN 'PAYABLE'\s+THEN 'BILL'/);
  });

  it("leaves no unreachable label behind in the type", () => {
    // An `ALTER TYPE ... ADD VALUE` path would keep RECEIVABLE and PAYABLE in
    // the type forever, readable by anything that types a literal.
    const labels = migrationEnumValues(migration, "ErpDocumentKind_new");
    expect(labels).not.toContain("RECEIVABLE");
    expect(labels).not.toContain("PAYABLE");
    expect(migration).toContain('DROP TYPE "ErpDocumentKind"');
  });
});

describe("🔴 the datamodel and the migration agree about every enum", () => {
  it("ErpDocumentStatus has the same labels on both sides", () => {
    // Nothing in the build compares these. A label present in one and absent
    // from the other surfaces as a P2009 on the one status nobody tested.
    expect(migrationEnumValues(migration, "ErpDocumentStatus").sort()).toEqual(
      enumValues("ErpDocumentStatus").sort(),
    );
  });

  it("ErpDocumentOrigin has the same labels on both sides", () => {
    expect(migrationEnumValues(migration, "ErpDocumentOrigin").sort()).toEqual(
      enumValues("ErpDocumentOrigin").sort(),
    );
  });

  it("ErpDocumentKind has the same labels on both sides", () => {
    // The migration builds it under a `_new` suffix and renames; the labels are
    // what matter.
    expect(migrationEnumValues(migration, "ErpDocumentKind_new").sort()).toEqual(
      enumValues("ErpDocumentKind").sort(),
    );
  });
});

describe("provenance became conditional", () => {
  const model = block("model", "ErpDocument");

  it("defaults origin to LANDED, so the migration rewrites no history", () => {
    expect(model).toMatch(/origin\s+ErpDocumentOrigin\s+@default\(LANDED\)/);
    expect(migration).toMatch(/ADD COLUMN "origin" "ErpDocumentOrigin" NOT NULL DEFAULT 'LANDED'/);
  });

  it("makes all three provenance columns nullable", () => {
    for (const column of ["connectionId", "externalSystem", "externalId"]) {
      expect(model).toMatch(new RegExp(`${column}\\s+String\\?`));
      expect(migration).toMatch(
        new RegExp(`ALTER COLUMN "${column}" DROP NOT NULL`),
      );
    }
  });

  it("🔴 keeps the vendor's word and the box's lifecycle in separate columns", () => {
    // One column for both would mean a query for unpaid invoices silently
    // matching the vendor string "Paid".
    expect(model).toMatch(/vendorStatus\s+String\?/);
    expect(model).toMatch(/status\s+ErpDocumentStatus\?/);
    expect(migration).toContain('RENAME COLUMN "status" TO "vendorStatus"');
  });

  it("🔴 refuses a LOCAL row that borrows a connection", () => {
    const check = migration.match(
      /ADD CONSTRAINT "ErpDocument_provenance" CHECK \(([\s\S]*?)\n\);/,
    );
    expect(check).not.toBeNull();
    const body = check![1];
    // Both branches, both directions. A CHECK that only pinned LANDED would let
    // a local row carry a connection and become vendor-owned — uneditable,
    // archive-only, overwritten by the next landing tick.
    expect(body).toMatch(/"origin" = 'LANDED'/);
    expect(body).toMatch(/"origin" = 'LOCAL'/);
    expect(body).toMatch(/"connectionId"\s+IS NOT NULL/);
    expect(body).toMatch(/"connectionId"\s+IS NULL/);
    expect(body).toMatch(/"status"\s+IS NULL/);
    expect(body).toMatch(/"status"\s+IS NOT NULL/);
  });

  it("🔴 does NOT require a party in the CHECK, and says why", () => {
    // `companyId` is ON DELETE SET NULL: a CHECK requiring it would fire inside
    // the statement that nulls it, making a customer with one local invoice
    // permanently un-deletable with a constraint error naming a table nobody
    // touched. The refusal lives in `deleteCompany` instead.
    const check = migration.match(
      /ADD CONSTRAINT "ErpDocument_provenance" CHECK \(([\s\S]*?)\n\);/,
    )![1];
    expect(check).not.toMatch(/"companyId"/);
    expect(migration).toMatch(/DELIBERATELY ABSENT/);
  });

  it("indexes the local-document list", () => {
    expect(block("model", "ErpDocument")).toMatch(/@@index\(\[origin, kind, status\]\)/);
    expect(migration).toContain('"ErpDocument_origin_kind_status_idx"');
  });
});

describe("the migration is ordered and clean", () => {
  it("sorts after the migration that created the table", () => {
    // A RELATION, not a position: naming the folders that exist today would
    // make this test something every later migration has to edit.
    const folders = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{14}_/.test(f)).sort();
    expect(folders).toContain(CREATED_TABLE);
    expect(folders).toContain(WIDENED);
    expect(folders.indexOf(WIDENED)).toBeGreaterThan(folders.indexOf(CREATED_TABLE));
  });

  it("🔴 does not drop the vector index prisma migrate dev wants to remove", () => {
    // `prisma migrate dev` prepends `DROP INDEX
    // "FileContentChunk_embedding_hnsw_idx";` to any generated migration,
    // because the HNSW index is Prisma-inexpressible and reads as drift. Left
    // in, it silently removes the vector search index from every box that
    // applies this migration.
    expect(migration).not.toContain("FileContentChunk_embedding_hnsw_idx");
    expect(migration).not.toMatch(/DROP INDEX/i);
  });
});
