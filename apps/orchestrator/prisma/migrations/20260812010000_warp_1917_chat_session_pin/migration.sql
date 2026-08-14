-- WARP-1917: pin a chat to the top of the /chat history sidebar.
--
-- `pinned` is the explicit boolean state column (CLAUDE.md "no guessing":
-- pin state is never derived from `pinnedAt IS NULL`). `pinnedAt` exists
-- only to order the Pinned section (most recent pin first); it is set on
-- pin and cleared on unpin, always in lockstep with `pinned`.
ALTER TABLE "ChatSession" ADD COLUMN "pinned" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ChatSession" ADD COLUMN "pinnedAt" TIMESTAMP(3);
