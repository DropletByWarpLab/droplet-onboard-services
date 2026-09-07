-- WARP-2752 -- `ownerId`: make `scope = personal` actually mean something.
--
-- THE BUG THIS CLOSES. Neither table had an owner column, so `personal` was
-- unenforceable: `visibleScopeFilter` OR'd `{ scope: "personal" }` in for every
-- caller and every authenticated user -- `family` and `guest` included -- could
-- read every OTHER user's personal-scope rows through /api/brain/* and
-- `business_find`. That is the exact opposite of what the `BrainScope`
-- docstring promises ("personal = one user's own space").
--
-- An enum value nothing can enforce is the same defect as a column nothing
-- maintains. This schema already learned that once, with `departmentId`; the
-- personal arm shipped with the same hole and it took a reviewer to see it.
--
-- CASCADE, like `departmentId` and unlike `assigneeId`. `ownerId` is an
-- ACCESS-CONTROL key and an access key must never dangle; `assigneeId` is
-- provenance, so it SetNulls and the finding survives the person leaving.

-- AlterTable
ALTER TABLE "BrainDigest" ADD COLUMN "ownerId" TEXT;
ALTER TABLE "BrainFinding" ADD COLUMN "ownerId" TEXT;

-- CreateIndex
-- Leads with the owner: every personal read is "my rows", and the scope
-- narrows within that.
CREATE INDEX "BrainDigest_ownerId_scope_idx" ON "BrainDigest"("ownerId", "scope");
CREATE INDEX "BrainFinding_ownerId_status_idx" ON "BrainFinding"("ownerId", "status");

-- AddForeignKey
ALTER TABLE "BrainDigest" ADD CONSTRAINT "BrainDigest_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BrainFinding" ADD CONSTRAINT "BrainFinding_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Invariants Prisma's schema language cannot express ──────────────────────

-- WARP-2752: a `personal` row names its owner, and only a personal row may.
-- Both halves matter. Without the first the scope is unenforceable again;
-- without the second a `company` row could carry a stray ownerId that a later
-- owner-filtered query hides from everyone it was written for.
--
-- No backfill: these tables are introduced on this same branch and no box has
-- ever run the feature (BRAIN_ENABLED defaults off), so there are no existing
-- rows for the CHECK to reject.
ALTER TABLE "BrainDigest"
  ADD CONSTRAINT "BrainDigest_personal_scope_needs_owner"
  CHECK (("scope" = 'personal') = ("ownerId" IS NOT NULL));

ALTER TABLE "BrainFinding"
  ADD CONSTRAINT "BrainFinding_personal_scope_needs_owner"
  CHECK (("scope" = 'personal') = ("ownerId" IS NOT NULL));
