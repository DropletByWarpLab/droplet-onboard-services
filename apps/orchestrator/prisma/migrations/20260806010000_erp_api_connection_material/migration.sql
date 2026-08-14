-- ERP REST-track connection material — the three things `EaglesoftApiConnector`
-- needs before it can reach a real (or rehearsal) Eaglesoft box.
--
-- Until now the orchestrator could name a host and a provider but could not
-- actually connect on the REST track: `connectorForProvider` built the
-- connector with no route map and no way to resolve credentials, so it stayed
-- blocked no matter what was listening. These columns are what it was missing.
--
-- Purely ADDITIVE: three nullable columns on one existing table. No backfill,
-- no default, no row rewritten. The direct-SQL provider ("eaglesoft") leaves
-- all three NULL forever — it keeps its credentials behind `secretRef` and has
-- no route contract to carry.
--
-- Column notes:
--
--   apiCredentialsEnc  aes-256-gcm ciphertext (see services/encryption.service.ts,
--                      keyed by DEVICE_SECRET_KEY) of the JSON triple
--                      {integrationKey,userId,password}. TEXT, not bytea: the
--                      encryption service already returns a base64 blob, and
--                      calendar.service.ts stores its credentials the same way.
--                      `secretRef` is NOT replaced — it stays the pointer/label
--                      that appears in logs and audit rows, and this is the
--                      ciphertext it refers to. Cleartext never lands here.
--
--   apiRouteMap        JSONB. The route contract discovered from the box's own
--                      /help page, shaped as `EaglesoftApiRouteMap`. JSONB
--                      rather than TEXT so a later migration can query into it
--                      (e.g. "which boxes still lack a discovered write
--                      route") without parsing every row in application code.
--                      Deliberately NOT a set of typed columns: the shape is
--                      Patterson's, it varies per box and per Eaglesoft
--                      version, and pinning it into DDL would make a schema
--                      migration out of what should be a config edit.
--
--   apiCaCert          PEM of the CA to trust for this box's certificate. NULL
--                      means "use the system trust store" — it never means
--                      "skip verification", which is not an option the
--                      connector offers.
--
--   port               NOT REST-specific, and a pre-existing bug rather than a
--                      new feature: `connect()` has always accepted a `port` in
--                      its payload and then dropped it on the floor, because
--                      there was nowhere to put it. Every connection therefore
--                      fell back to the track default (2638 / 9888), and a
--                      practice running on any other port could not be
--                      configured at all. NULL keeps that default behaviour, so
--                      every existing row is unaffected.

ALTER TABLE "IntegrationConnection"
  ADD COLUMN "apiCredentialsEnc" TEXT,
  ADD COLUMN "apiRouteMap"       JSONB,
  ADD COLUMN "apiCaCert"         TEXT,
  ADD COLUMN "port"              INTEGER;
