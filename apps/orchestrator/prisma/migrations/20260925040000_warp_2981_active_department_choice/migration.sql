-- WARP-2981 (ADR-059 P6, DS-003) — the department a person's shell is
-- arranged around, kept on the server so it follows them across devices.
--
-- One row per person, and the row IS their choice: `scope` says Whole business
-- or a department, and `departmentId` is set exactly when it is a department
-- (the CHECK below). No row means the person has never chosen, on any device —
-- a state of its own, not a synonym for Whole business: the box shows Whole
-- business (DS-014) but a browser still holding a P1 choice keeps it. The row
-- never outlives the person or the department (both FKs cascade). It SHOWS,
-- never grants; the routes re-check choosability on every read and write.
--
-- Additive. No seed and no backfill: the dashboard's per-browser localStorage
-- choice is a first-paint cache, not migrated. A box with the P1 tables and no
-- rows here reads "never chosen" for everyone, which is today's behaviour.
--
-- Stamped after stage's newest (20260925020000) and after the stamps the open
-- ADR-059 PRs reserved (000000/000100 locks, 030000/030100 early presence), so
-- the PRs merge in any order.
--
-- CHANGED IN PLACE (review of the P6 PR, before it reached stage). The first
-- version had no `scope`: a row was always a department and Whole business was
-- the absence of a row, so "chose Whole business" and "never chose" read the
-- same. A dev box that applied that version converges by re-running this file
-- by hand: the ADD COLUMN gives its rows `department` (every row there is a
-- department choice), DROP DEFAULT and DROP NOT NULL bring the columns to the
-- datamodel, and the CHECK then holds for every row. On a fresh box those
-- three statements are no-ops.
--
-- Re-runnable (repo idiom, WARP-2896's): the type, each FK and the CHECK are
-- guarded, the table, column and index use IF NOT EXISTS, so a second run (a
-- re-stamped folder, a hand re-run) is a no-op rather than a failed migration
-- and a dark box. Apart from those guards and the convergence block, the
-- statements are Prisma's own `migrate diff` output, so check-schema-drift
-- sees no difference. The CHECK is invisible to it (Prisma cannot declare
-- one); active-department-choice.pg.test.ts pins it instead.

-- CreateEnum
DO $$
BEGIN
  CREATE TYPE "ActiveDepartmentScope" AS ENUM ('whole_business', 'department');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "ActiveDepartmentChoice" (
    "userId" TEXT NOT NULL,
    "scope" "ActiveDepartmentScope" NOT NULL,
    "departmentId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActiveDepartmentChoice_pkey" PRIMARY KEY ("userId")
);

-- Converge the first version's shape (see the header): its rows are
-- department choices; then the datamodel's columns, no default, nullable id.
ALTER TABLE "ActiveDepartmentChoice"
  ADD COLUMN IF NOT EXISTS "scope" "ActiveDepartmentScope" NOT NULL DEFAULT 'department';
ALTER TABLE "ActiveDepartmentChoice" ALTER COLUMN "scope" DROP DEFAULT;
ALTER TABLE "ActiveDepartmentChoice" ALTER COLUMN "departmentId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ActiveDepartmentChoice_departmentId_idx" ON "ActiveDepartmentChoice"("departmentId");

-- AddForeignKey
DO $$
BEGIN
  ALTER TABLE "ActiveDepartmentChoice" ADD CONSTRAINT "ActiveDepartmentChoice_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
  ALTER TABLE "ActiveDepartmentChoice" ADD CONSTRAINT "ActiveDepartmentChoice_departmentId_fkey"
    FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- A department choice names its department; Whole business names none. Both
-- sides are never NULL (`scope` is NOT NULL, IS NOT NULL is a boolean), so the
-- CHECK cannot pass by evaluating to NULL.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ActiveDepartmentChoice_scope_shape'
      AND conrelid = '"ActiveDepartmentChoice"'::regclass
  ) THEN
    ALTER TABLE "ActiveDepartmentChoice" ADD CONSTRAINT "ActiveDepartmentChoice_scope_shape"
      CHECK (("scope" = 'department') = ("departmentId" IS NOT NULL));
  END IF;
END $$;
