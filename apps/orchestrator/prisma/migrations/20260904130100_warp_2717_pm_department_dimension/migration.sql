-- WARP-2717 (ADR-045 §5.3) (slice 8) — let a department OWN WORK.
--
-- `Department` (ADR-029 / WARP-1255) is a NEXTCLOUD GROUPFOLDER: `ncGroupRw`,
-- `ncGroupRo`, `ncGroupfolderId`, `quotaBytes`, `aclVersion`,
-- `state ProvisionState`. Its only relations are memberships, shares, invite
-- grants and a one-level self-hierarchy. Nothing in it has ever pointed at a
-- PM row, so "route this ticket to Front Desk" had no substrate at all — the
-- membership half was built and provisioned, the work half did not exist.
--
-- These two nullable columns are that substrate.
--
-- ── a DIMENSION, not a boundary ──────────────────────────────────────
--
-- PM is household-shared (ADR-026): every authenticated role reads every
-- project and every work item, and this migration does not change that by one
-- row. The column says who OWNS the work, not who may SEE it. A boundary
-- reading — Front Desk cannot see Clinical's tickets — would have to touch the
-- access catalog and every PM read path, and is a different change.
--
-- ── no new org entity ────────────────────────────────────────────────
--
-- Deliberately not a `Team` / `OrgUnit` beside `Department`. Department
-- exists, its membership is already provisioned, and a second org concept
-- beside it is the `Customer`-beside-`Contact` mistake ADR-044 rejected one
-- axis over, for exactly this reason.
--
-- ── resolution ───────────────────────────────────────────────────────
--
-- `PmWorkItem.departmentId` OVERRIDES `PmProject.departmentId` when set. Both
-- nullable at both levels, so "no department" stays representable and
-- inheritance is the default: tag the project once and every item in it reads
-- as that department's until an item says otherwise.
--
-- ── ON DELETE SET NULL, never CASCADE ────────────────────────────────
--
-- Deleting a department must never delete work. It must also never be the
-- reason work becomes invisible: a cleared item column falls back to the
-- project's, and a project with none reads as unassigned.
--
-- In practice this action almost never fires. `DELETE /api/departments/:id`
-- does NOT delete the row — it sets `state='archiving'` + `archivedAt` and
-- kicks the reconciler, and purge is not exposed in v1. So an ARCHIVED
-- department keeps its `id` and every ticket keeps pointing at it, on purpose;
-- see `pm-department.ts` for the assignment rule that pairs with this.
--
-- ── both FKs are INDEXED ─────────────────────────────────────────────
--
-- WARP-845: an unindexed ON DELETE SET NULL FK turns the parent delete into a
-- sequential scan of the child table. Five such columns already shipped
-- unindexed on the CRM side (`CrmDeal.projectId`,
-- `CrmActivity.workItemId|noteId|emailMessageId|calendarEventId` — the
-- constraints are in 20260829001000_warp_2117_contacts_crm and no matching
-- CREATE INDEX exists). Not repeating it here.
--
-- ── why there is no CHECK and no trigger ─────────────────────────────
--
-- Two rules guard assignment, and neither belongs in the database:
--
--   * "a department in an ARCHIVE-intent state accepts no NEW assignment" is a
--     TRANSITION rule, not an invariant. A department archived AFTER a ticket
--     was routed to it must keep that ticket (that is the whole point of the
--     SET NULL paragraph above). A CHECK or a trigger expresses an invariant —
--     something true of every row at all times — so encoding this one would
--     either be wrong on archive or fire on rows it must not touch.
--   * "the department is not HOUSEHOLD" IS a stable invariant (`kind` has no
--     mutation path — `updateDepartmentSchema` in routes/departments.ts does
--     not accept it). A BEFORE INSERT OR UPDATE trigger could carry it, and
--     this repo does have that precedent (WARP-113's ScheduleEvent
--     append-only trigger). It is deliberately not used: the rule is
--     CROSS-TABLE, so the trigger would have to SELECT from "Department" on
--     every single PmWorkItem write — the hot path of the whole board — to
--     re-refuse something the service layer already refuses at the one place
--     assignment can enter. The service-layer guard is pinned by
--     pm-department-dimension.pg.test.ts against a real Postgres instead.
--
-- ── additive and backfill-free ───────────────────────────────────────
--
-- Both columns default to NULL, so every existing project and work item keeps
-- reading exactly as it does today and no data migration runs.

ALTER TABLE "PmProject" ADD COLUMN     "departmentId" TEXT;

ALTER TABLE "PmWorkItem" ADD COLUMN     "departmentId" TEXT;

-- The ON DELETE SET NULL scan index (WARP-845), one per FK.
CREATE INDEX "PmProject_departmentId_idx" ON "PmProject"("departmentId");

CREATE INDEX "PmWorkItem_departmentId_idx" ON "PmWorkItem"("departmentId");

-- The board filter's real predicate is "this project's items, owned by
-- department X". `PmWorkItem_departmentId_idx` cannot serve it (wrong leading
-- column) and neither can `PmWorkItem_projectId_stateId_sortOrder_idx`, so the
-- filter gets its own composite. Kept to two columns: the unfiltered board
-- still orders off the state index, and a third column here would earn nothing.
CREATE INDEX "PmWorkItem_projectId_departmentId_idx" ON "PmWorkItem"("projectId", "departmentId");

ALTER TABLE "PmProject" ADD CONSTRAINT "PmProject_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PmWorkItem" ADD CONSTRAINT "PmWorkItem_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;
