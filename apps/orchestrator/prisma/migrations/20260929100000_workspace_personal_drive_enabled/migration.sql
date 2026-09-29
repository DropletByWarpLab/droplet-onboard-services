-- Owner setting: personal WebDAV drives (Finder / File Explorer), OFF by default.
--
-- POST /api/storage/network-drive/personal mints a per-user Nextcloud app
-- password. An app password is full-scope and bypasses the orchestrator's
-- download audit and per-file upload cap, so the feature ships behind an
-- owner decision. EXPLICIT boolean on the Workspace singleton (id = 1), never
-- derived from DeviceClient rows or a role — CLAUDE.md "no guessing";
-- Workspace.orgConfigured is the precedent.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS. Existing rows (and a missing
-- singleton, which the route reads as off) get false.

ALTER TABLE "Workspace"
    ADD COLUMN IF NOT EXISTS "personalDriveEnabled" BOOLEAN NOT NULL DEFAULT false;
