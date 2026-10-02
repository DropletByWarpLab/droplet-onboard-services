-- WARP-2976 (ADR-059 P1) — a department's dashboard arrangement.
--
-- One row per DEPARTMENT that has been set up: which template it started from,
-- the nav destinations its switcher view shows, and the widgets on its
-- /d/<slug> home. It GRANTS NOTHING — the dashboard intersects `navHrefs` with
-- the viewer's existing role / capability / module gates, and ADR-032 plus
-- CameraAccessGrant still decide every route. A missing row is the explicit
-- "not set up" state; nothing infers a template from a department's name.
--
-- Cascade on delete mirrors the other department-owned rows: a profile never
-- outlives its department. (Nothing row-deletes a Department today — DELETE
-- /api/departments/:id archives — so this only matters if that ever changes.)

-- CreateEnum
CREATE TYPE "DepartmentTemplate" AS ENUM ('security', 'sales', 'finance', 'operations', 'front_desk', 'it', 'custom');

-- CreateTable
CREATE TABLE "DepartmentProfile" (
    "departmentId" TEXT NOT NULL,
    "template" "DepartmentTemplate" NOT NULL,
    "icon" TEXT NOT NULL,
    "navHrefs" TEXT[],
    "homeWidgets" JSONB NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DepartmentProfile_pkey" PRIMARY KEY ("departmentId")
);

-- AddForeignKey
ALTER TABLE "DepartmentProfile" ADD CONSTRAINT "DepartmentProfile_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;
