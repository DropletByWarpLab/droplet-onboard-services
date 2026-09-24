-- WARP-2981 (ADR-059 P6, DS-003) — the department a person's shell is
-- arranged around, kept on the server so it follows them across devices.
--
-- One row per person, and only while a department is chosen: no row is Whole
-- business, the default for everyone (DS-014). The row never outlives the
-- person or the department (both FKs cascade). It SHOWS, never grants; the
-- routes re-check choosability on every read and write.
--
-- Additive. No seed and no backfill: the dashboard's per-browser localStorage
-- choice is a first-paint cache, not migrated. A box with the P1 tables and no
-- rows here reads Whole business for everyone, which is today's behaviour.
--
-- Stamped after stage's newest (20260925010000) and after the stamps the open
-- ADR-059 PRs reserved (000000/000100 locks, 020000 incidents, 030000/030100
-- early presence), so the PRs merge in any order.
--
-- Re-runnable (repo idiom, WARP-2896's): the table and index use IF NOT
-- EXISTS and each FK is duplicate_object-guarded, so a second run (a
-- re-stamped folder, a hand re-run) is a no-op rather than a failed migration
-- and a dark box. The statements are Prisma's own `migrate diff` output with
-- only those guards added, so check-schema-drift sees no difference.

-- CreateTable
CREATE TABLE IF NOT EXISTS "ActiveDepartmentChoice" (
    "userId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActiveDepartmentChoice_pkey" PRIMARY KEY ("userId")
);

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
