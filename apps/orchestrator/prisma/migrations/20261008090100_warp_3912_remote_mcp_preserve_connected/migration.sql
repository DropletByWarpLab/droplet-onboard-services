-- WARP-3912: upgrade safety for the new `remote_mcp` channel.
--
-- seedOffLanChannels inserts `remote_mcp` as enabled=false (insert-or-skip), so
-- a box that already has a live Atlassian connection would silently lose it on
-- upgrade. Persist enabled=true for exactly those boxes, BEFORE the seed runs
-- (migrations precede boot), so the seed's skipDuplicates leaves it alone. A
-- box with no CONNECTED Atlassian connection gets no row here and is seeded OFF.
-- ON CONFLICT DO NOTHING: an operator's existing choice is never overwritten.

INSERT INTO "OffLanAllowlistChannel" ("key", "enabled", "requiresAdmin", "lastChangedBy", "reason")
SELECT 'remote_mcp'::"OffLanChannelKey", true, true, NULL,
       'Enabled by upgrade: this box already had a connected Atlassian account (WARP-3912).'
WHERE EXISTS (
    SELECT 1 FROM "IntegrationConnection"
    WHERE "provider" = 'atlassian' AND "status" = 'CONNECTED'
)
ON CONFLICT ("key") DO NOTHING;
