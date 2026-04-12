-- Drop legacy file-sync tables.
--
-- The orchestrator no longer runs the Python watchdog daemon that indexed
-- filesystem metadata. All file storage is now handled by Nextcloud, which
-- has its own filecache table. Dropping these tables reclaims disk space
-- and removes the per-request foreign-key overhead on file listings.

DROP TABLE IF EXISTS "FileEntry";
DROP TABLE IF EXISTS "SyncTarget";
