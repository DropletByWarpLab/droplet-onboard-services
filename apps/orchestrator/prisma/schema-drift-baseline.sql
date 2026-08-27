-- =============================================================================
-- WARP-1542 — documented schema-drift baseline.
--
-- THIS IS NOT A MIGRATION. Nothing ever executes this file. It is the frozen,
-- reviewed answer to `prisma migrate diff --from-migrations
-- --to-schema-datamodel`, i.e. "replay every migration into an empty database
-- — what would still have to change for it to match schema.prisma?"
--
-- scripts/check-schema-drift.sh regenerates that diff in CI (the pg-integration
-- job in .github/workflows/orchestrator-tests.yml) and compares it to the
-- statements below. Any NEW drift fails the job. Drift that gets CLOSED also
-- fails, so this file cannot quietly decay into a blanket exemption.
--
-- WHY A BASELINE INSTEAD OF AN EMPTY DIFF
-- ---------------------------------------
-- main already carried this delta when the gate was added (measured on
-- 479f2569). Two of the entries can NEVER be closed — Prisma has no datamodel
-- syntax for a GENERATED column expression or a GIN index, so `migrate diff`
-- reports them on every run by construction. Demanding an empty diff would
-- have reddened main on day one. Freezing the measured delta gates every
-- FUTURE divergence without pretending the existing one isn't there.
--
-- THE ENTRIES, ANNOTATED
-- ----------------------
-- Classification is either PRISMA-INEXPRESSIBLE (permanent, by construction)
-- or OPEN DRIFT (closable; needs its own ticket, migration and QA — a CI
-- ticket is the wrong place to change appliance behaviour).
--
--  1. ToolRunStatus is missing `pending` and `running`; ToolRun.status
--     defaults to 'ok' in SQL and `pending` in the datamodel.
--     -> OPEN DRIFT. 20260528100000_warp_462_tool_spec created the enum with
--        only ('ok','failed','cancelled'). Latent today: tool-spec-runner
--        .service.ts only ever writes 'ok' or 'failed', and it always passes
--        `status` explicitly, so the differing column default is never
--        exercised. It bites the first time any code omits `status` (Prisma
--        would leave the column out and Postgres would silently write 'ok'
--        where the datamodel promises 'pending') or writes 'running'.
--        Closing it needs TWO migrations: Postgres will not accept a new enum
--        value and a DEFAULT that USES that value in the same transaction.
--
--  2. Department_parentId_fkey is ON DELETE RESTRICT in SQL, ON DELETE SET
--     NULL in the datamodel.
--     -> OPEN DRIFT, and the one with real behavioural consequences:
--        20260711000000_warp_1255_departments hand-wrote RESTRICT, while
--        Prisma's default for an optional self-relation is SET NULL. On a
--        migrated box, deleting a parent department ERRORS; the datamodel says
--        it should null the children's parentId. Which one is correct is a
--        product decision, not a CI decision — hence a ticket, not a drive-by
--        fix in this PR.
--
--  3. Department_parentId_idx exists in SQL, absent from the datamodel.
--     -> OPEN DRIFT, harmless. The migration creates the index; schema.prisma
--        has no `@@index([parentId])`. Postgres does not auto-index FK
--        columns, so the index is doing real work — the datamodel should
--        declare it rather than the index being dropped.
--
--  4. AssistantPersona.updatedAt / BusinessProfile.updatedAt / TlsCert
--     .updatedAt carry DEFAULT CURRENT_TIMESTAMP in SQL, none in the
--     datamodel.
--     -> OPEN DRIFT, harmless. `@updatedAt` is application-managed, so Prisma
--        emits no column default; the hand-written migrations added one
--        anyway. The default is only reachable by a non-Prisma writer.
--
--  5. FileContentChunk.text_tsv loses its generated expression, and
--     FileContentChunk_text_tsv_idx is dropped.
--     -> PRISMA-INEXPRESSIBLE, permanent. text_tsv is `Unsupported("tsvector")`
--        with a `GENERATED ALWAYS AS (...)` expression (WARP-286, reshaped by
--        WARP-242 so sensitive chunks index as NULL), indexed with GIN. Prisma
--        has no datamodel syntax for either, so `migrate diff` proposes
--        removing both on every run, forever. These two statements must never
--        be "fixed" — doing so would drop the lexical-search index and the
--        crypto-shred guarantee that rides on it.
--
--  6. FileContentChunk_embedding_hnsw_idx is dropped.
--     -> PRISMA-INEXPRESSIBLE, permanent. WARP-2193 gave the vector arm an
--        HNSW index (`USING hnsw (embedding vector_cosine_ops)`, migration
--        20260826120000). `embedding` is `Unsupported("vector(384)")` and
--        Prisma has no datamodel syntax for an index on one, let alone for
--        the hnsw access method — so `migrate diff` proposes removing it on
--        every run, forever, exactly as it already does for the GIN index in
--        entry 5. It must never be "fixed": doing so drops the only ANN index
--        on the corpus and returns every semantic search to a sequential
--        scan. That is not hypothetical — it is what happened between
--        20260425220000 (which dropped the predecessor IVFFlat index as
--        generated collateral) and WARP-2193, unnoticed for four months.
--
--        !! THE GENERATED SECTION BELOW DOES NOT YET INCLUDE THIS ENTRY. It
--        needs one `scripts/check-schema-drift.sh --update` run against a
--        pgvector shadow database, which the branch that added this note had
--        no Postgres to do. Until then the pg-integration job's drift gate
--        fails with a "drift grew" diff naming exactly this one statement.
--
-- UPDATING THIS FILE
-- ------------------
-- Do not hand-edit below the sentinel. Run:
--   scripts/check-schema-drift.sh --update
-- then read the resulting diff and record WHY it moved in the list above.
-- =============================================================================
-- ===== GENERATED BASELINE BELOW: regenerate with check-schema-drift.sh --update =====
-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ToolRunStatus" ADD VALUE 'pending';
ALTER TYPE "ToolRunStatus" ADD VALUE 'running';

-- DropForeignKey
ALTER TABLE "Department" DROP CONSTRAINT "Department_parentId_fkey";

-- DropIndex
DROP INDEX "Department_parentId_idx";

-- DropIndex
DROP INDEX "FileContentChunk_text_tsv_idx";

-- AlterTable
ALTER TABLE "AssistantPersona" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "BusinessProfile" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "FileContentChunk" ALTER COLUMN "text_tsv" DROP DEFAULT;

-- AlterTable
ALTER TABLE "TlsCert" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "ToolRun" ALTER COLUMN "status" SET DEFAULT 'pending';

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;
