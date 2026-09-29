-- WARP-3169 — a hand-over's claim on the leaver while the file transfer runs,
-- so a second concurrent hand-over is refused. See User.deletionStatus.
ALTER TYPE "UserDeletionStatus" ADD VALUE 'HANDING_OVER';
