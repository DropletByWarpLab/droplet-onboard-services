-- WARP-3960 (Romain, 2026-10-10): connected MCP servers are always available.
--
-- `remote_mcp` stops being an owner switch and stays only as a metering label
-- (egress_meter counts bytes under it). Force the row on so any box that had
-- switched it off (or never had a row) reads as always-on; the PATCH route now
-- refuses the key, so nothing can turn it off again. The Postgres enum value
-- stays: dropping an enum value is not worth a migration.

INSERT INTO "OffLanAllowlistChannel" ("key", "enabled", "requiresAdmin", "lastChangedBy", "reason")
VALUES ('remote_mcp'::"OffLanChannelKey", true, true, NULL,
        'Always on: metering label only, no longer an owner switch (WARP-3960).')
ON CONFLICT ("key") DO UPDATE SET "enabled" = true;
