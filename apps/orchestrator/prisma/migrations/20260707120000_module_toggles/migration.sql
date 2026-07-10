-- Module toggles per business type.
-- Spec: docs/superpowers/specs/2026-07-07-module-toggles-design.md

-- CreateEnum
CREATE TYPE "BusinessType" AS ENUM (
    'home', 'professional_office', 'retail', 'clinic', 'hospitality', 'custom'
);

-- CreateEnum
CREATE TYPE "ModuleId" AS ENUM (
    'chat', 'knowledge', 'files', 'docs', 'email', 'calendar', 'projects',
    'voice', 'cameras', 'smart_home', 'network', 'managed_switch'
);

-- CreateTable
-- One explicit row per module (no row → registry defaultEnabled; never inferred).
CREATE TABLE "ModuleSetting" (
    "moduleId" "ModuleId" NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "setBy" TEXT,
    "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ModuleSetting_pkey" PRIMARY KEY ("moduleId")
);

-- AlterTable
-- Bounded module-preset selector on the Workspace singleton (nullable — null
-- until a preset is applied). Distinct from the free-form `industry` hint.
ALTER TABLE "Workspace"
    ADD COLUMN "businessType" "BusinessType",
    ADD COLUMN "businessTypeSetBy" TEXT,
    ADD COLUMN "businessTypeSetAt" TIMESTAMP(3);
