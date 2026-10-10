-- WARP-3960 (Romain, 2026-10-10): connected MCP servers are always available.
--
-- `remote_mcp` stops being an owner switch and stays only as a metering label
-- (egress_meter counts bytes under it). The Postgres enum value stays: dropping
-- an enum value is not worth a migration.
--
-- SECURITY REVIEW: forcing the label on must not silently hand egress back to an
-- owner who deliberately turned remote MCP off. An explicit owner act is a
-- `remote_mcp` row with enabled = false AND "lastChangedBy" IS NOT NULL (the
-- seeded default has no actor). For such a box, carry the intent over to the
-- per-server off: the registered MCP server (today only `atlassian`) is set to
-- status DISABLED. Only the status is written; credentials and every other
-- column of an existing row are kept. A seeded-off or missing row is just the
-- metering label and touches nothing. This runs BEFORE the upsert below, which
-- is what overwrites the evidence.

UPDATE "IntegrationConnection"
SET "status" = 'DISABLED', "updatedAt" = now()
WHERE "provider" = 'atlassian'
  AND "status" <> 'DISABLED'
  AND EXISTS (
    SELECT 1 FROM "OffLanAllowlistChannel"
    WHERE "key" = 'remote_mcp'::"OffLanChannelKey"
      AND "enabled" = false
      AND "lastChangedBy" IS NOT NULL
  );

-- No row yet (the owner switched it off before anyone connected): create the
-- DISABLED row so a later connect starts from the owner's "off", not from default-on.
INSERT INTO "IntegrationConnection" ("id", "provider", "status", "host", "databaseName", "secretRef", "updatedAt")
SELECT 'conn_atlassian_warp3960', 'atlassian', 'DISABLED', '', '', '', now()
WHERE EXISTS (
    SELECT 1 FROM "OffLanAllowlistChannel"
    WHERE "key" = 'remote_mcp'::"OffLanChannelKey"
      AND "enabled" = false
      AND "lastChangedBy" IS NOT NULL
  )
  AND NOT EXISTS (SELECT 1 FROM "IntegrationConnection" WHERE "provider" = 'atlassian');

INSERT INTO "OffLanAllowlistChannel" ("key", "enabled", "requiresAdmin", "lastChangedBy", "reason")
VALUES ('remote_mcp'::"OffLanChannelKey", true, true, NULL,
        'Always on: metering label only, no longer an owner switch (WARP-3960).')
ON CONFLICT ("key") DO UPDATE SET "enabled" = true;
