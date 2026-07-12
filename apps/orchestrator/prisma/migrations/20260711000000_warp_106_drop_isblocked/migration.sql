-- WARP-106: disambiguate NetworkDevice block state.
--
-- `NetworkDevice` carried three overlapping block booleans:
--   isBlocked          — reconciler-authored projection (a duplicate of the
--                        firewall's live state)
--   manualBlock        — user intent (input to the schedule ticker)
--   lastAppliedBlocked — ticker-authored effective firewall state
--
-- The reconciler-authored `isBlocked` raced the schedule ticker: on any tick
-- where the firewall snapshot lagged the ticker's dispatch, the reconciler
-- could overwrite the displayed state and clobber ticker intent. Per the
-- "ticker = source of truth, reconciler = drift detector" architecture we
-- DROP `isBlocked` entirely. `lastAppliedBlocked` (falling back to
-- `manualBlock`) is the single source of truth; the API boundary exposes a
-- COMPUTED `isBlocked = (lastAppliedBlocked ?? manualBlock)` for display.
--
-- Idempotent (same discipline as 20260710000000_warp_1202_pairing_code_status):
-- DROP COLUMN IF EXISTS is a no-op on a re-run after the column is gone.

ALTER TABLE "NetworkDevice" DROP COLUMN IF EXISTS "isBlocked";
