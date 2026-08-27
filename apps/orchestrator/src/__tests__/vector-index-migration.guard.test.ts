/**
 * WARP-2193 — the vector index must survive the whole migration chain.
 *
 * This guard exists because it already failed once, silently:
 *
 *   20260412000000_add_file_content_index  CREATE INDEX … USING ivfflat
 *   20260425220000_add_camera_audit_…      DROP INDEX "FileContentChunk_embedding_idx"
 *
 * The DROP was Prisma-generated collateral. Prisma's schema diff cannot model
 * an index on an `Unsupported("vector(384)")` column, so `migrate dev` reads
 * the raw index as drift and emits a drop at the top of whatever unrelated
 * migration is being generated that day. Nothing recreated it, no test
 * noticed, and the vector arm ran on exact sequential scans for four months
 * while every query kept returning plausible results.
 *
 * That is the failure class: an ANN index does not fail loudly when it
 * disappears — it just gets slow and, once `ef_search`/`probes` enter the
 * picture, less accurate. So the check has to be on the migration chain
 * itself, and it has to run in the DB-less lane where every PR sees it.
 *
 * The check REPLAYS index events across the migrations in filename order and
 * asserts the surviving set. It is deliberately not a grep for one line: a
 * grep would go green on a migration that creates the index and drops it
 * again two statements later.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";

const MIGRATIONS_DIR = path.resolve(__dirname, "../../prisma/migrations");

/** This ticket's migration — named so the ordering assertion can be explicit. */
const HNSW_MIGRATION = "20260826120000_warp_2193_hnsw_vector_index";
const HNSW_INDEX_NAME = "FileContentChunk_embedding_hnsw_idx";
/** The IVFFlat index this replaces, dropped as collateral back in April. */
const LEGACY_IVFFLAT_INDEX_NAME = "FileContentChunk_embedding_idx";

/**
 * SQL comments have to go before parsing: this file's own migration DISCUSSES
 * `DROP INDEX "FileContentChunk_embedding_idx"` in prose, and a parser that
 * cannot tell prose from DDL would read the explanation as a second drop.
 */
function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/**
 * One regex, two alternatives, so events are seen in POSITIONAL order within
 * a file. Collecting all creates and then all drops would mis-replay any
 * migration that drops and recreates the same name.
 */
const INDEX_EVENT = new RegExp(
  [
    String.raw`CREATE\s+INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?"(?<created>[^"]+)"\s+ON\s+"FileContentChunk"\s+USING\s+(?<am>\w+)\s*\(\s*"?embedding"?`,
    String.raw`DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?"(?<dropped>[^"]+)"`,
  ].join("|"),
  "gi",
);

function migrationDirs(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((d) => statSync(path.join(MIGRATIONS_DIR, d)).isDirectory())
    .sort(); // timestamp-prefixed names sort in apply order
}

function readMigration(dir: string): string {
  return stripSqlComments(
    readFileSync(path.join(MIGRATIONS_DIR, dir, "migration.sql"), "utf8"),
  );
}

/** Replay every migration and return the embedding indexes still standing. */
function survivingEmbeddingIndexes(): Map<string, string> {
  const live = new Map<string, string>(); // index name -> access method
  for (const dir of migrationDirs()) {
    for (const m of readMigration(dir).matchAll(INDEX_EVENT)) {
      const g = m.groups!;
      if (g.created) live.set(g.created, g.am!.toLowerCase());
      // A drop can name an index this replay never saw created (e.g. a btree)
      // — deleting a missing key is a no-op, which is the correct semantics.
      else if (g.dropped) live.delete(g.dropped);
    }
  }
  return live;
}

describe("FileContentChunk vector index — migration-chain guard (WARP-2193)", () => {
  it("leaves exactly one ANN index on embedding, and it is HNSW", () => {
    const live = survivingEmbeddingIndexes();
    expect([...live.keys()]).toEqual([HNSW_INDEX_NAME]);
    expect(live.get(HNSW_INDEX_NAME)).toBe("hnsw");
  });

  it("does not leave the IVFFlat index standing alongside it", () => {
    // Two ANN indexes on one column waste disk on every insert and let the
    // planner pick either, so a latency measurement stops being repeatable.
    expect(survivingEmbeddingIndexes().has(LEGACY_IVFFLAT_INDEX_NAME)).toBe(
      false,
    );
  });

  it("drops the legacy IVFFlat index with IF EXISTS", () => {
    // On every database migrated past 20260425220000 that index is ALREADY
    // gone (Prisma dropped it as drift). A bare DROP would raise and abort
    // `prisma migrate deploy` for the whole file — i.e. this migration would
    // fail on every existing box while passing on a fresh one.
    expect(readMigration(HNSW_MIGRATION)).toMatch(
      new RegExp(
        String.raw`DROP\s+INDEX\s+IF\s+EXISTS\s+"${LEGACY_IVFFLAT_INDEX_NAME}"`,
        "i",
      ),
    );
  });

  it("sorts after the migration that was latest on main when it was written", () => {
    // Migrations authored on a branch carry the timestamp of the day they were
    // generated. If main moves on before the branch merges, the file can land
    // BEFORE a migration it was written against — Prisma applies by filename,
    // not by merge date. Pinned against the then-latest rather than against
    // "is last", so a migration merged after this one does not fail the guard.
    const dirs = migrationDirs();
    expect(dirs).toContain(HNSW_MIGRATION);
    expect(HNSW_MIGRATION > "20260826043700_warp_2137_erp_cloud_connection_config").toBe(
      true,
    );
  });
});
