-- WARP-2022 — explicit opt-in for a CalDAV server inside the trust boundary.
--
-- The orchestrator can reach the LAN, the Docker network and localhost, so a
-- user-supplied calendar URL is an SSRF primitive. `lib/outbound-url-guard.ts`
-- now refuses private space by default. Self-hosting a Nextcloud/Radicale on
-- the box's own LAN is a legitimate use case on this appliance, so the guard is
-- overridable — but per source, by an owner/admin, through THIS column.
--
-- An explicit boolean, not an exemption inferred from the URL: "this address
-- looks like the LAN, so presumably they meant it" is precisely the reasoning
-- that lets an attacker's URL exempt itself.
--
-- DEFAULT false is the fail-closed half. Every row that predates this
-- migration — including any already pointing at 192.168.x or 127.0.0.1 —
-- becomes non-exempt and starts failing on its next poller tick with
-- `lastSyncError = 'blocked_destination'`, which SubscriptionsPanel renders.
-- That is the intended behaviour: a source nobody has vouched for does not get
-- to keep reaching inside the boundary because it got there first.
ALTER TABLE "CalendarSource"
  ADD COLUMN "allowPrivateHost" BOOLEAN NOT NULL DEFAULT false;

-- Surface the rows an operator will have to vouch for, WITHOUT setting the
-- flag for them. Auto-setting would silently re-grant exactly the access this
-- ticket removes, to whichever URLs happened to already be in the table. The
-- notice goes to the migration log so the operator sees the count during
-- deploy and can go set the flag deliberately, per source, in the UI.
--
-- Deliberately a coarse textual match: it exists to produce an operator
-- warning, not to make a security decision. The security decision is the
-- runtime guard, which parses and resolves properly.
DO $$
DECLARE
  affected INTEGER;
BEGIN
  SELECT COUNT(*) INTO affected
  FROM "CalendarSource"
  WHERE "url" ~* '^https?://(localhost|127\.|10\.|192\.168\.|169\.254\.|100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|\[::1\])'
     OR "url" ~* '^https?://[^/]*\.(local|internal|home\.arpa)(:[0-9]+)?(/|$)';

  IF affected > 0 THEN
    RAISE NOTICE 'WARP-2022: % CalendarSource row(s) point inside the trust boundary and will fail closed on their next sync until an owner sets allowPrivateHost. They are NOT auto-exempted.', affected;
  END IF;
END $$;
