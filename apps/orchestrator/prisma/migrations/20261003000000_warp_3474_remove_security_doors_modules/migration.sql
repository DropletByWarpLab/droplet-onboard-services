-- WARP-3474 — drop what the Security command center and the doors module left in
-- the database.
--
-- Both modules are maintained outside this repository (enterprise-functionality).
-- Their twenty migration folders (WARP-2977, WARP-2978, WARP-2979, WARP-2980 and
-- ADR-055) and their models were deleted from this tree, so a database built from
-- it never creates the objects below. A box that applied those folders still
-- holds them; this migration brings it to the state a fresh box reaches. The
-- journal is not touched: the _prisma_migrations rows of the deleted folders stay
-- (an applied migration with no folder is tolerated by `prisma migrate deploy`,
-- as with the WARP-2896 re-stamp).
--
-- Why the objects are dropped rather than left behind
--
--   * The door-event retention purge leaves with the module. AccessEvent is
--     append-only in the database: its trigger refuses every DELETE except inside
--     access_event_purge(), which only the retention job called. Left behind, the
--     rows could never age out.
--   * The orphaned tables would keep their constraints with no code to maintain
--     them: the append-only trigger on SecurityEvent, the Restrict foreign keys
--     between the tables themselves (zone, incident, suppression, access point),
--     and SecurityAlertRecipient's foreign key onto "User", which cascades a
--     person's deletion into a table nothing reads.
--   * ModuleSetting, AccessRoleFeatureGrant and UserAccessException rows keyed
--     'security' or 'doors' name ModuleId labels the regenerated client no longer
--     declares, and a client cannot read a row that carries a label it does not
--     know.
--
-- What it does, in order
--
--   1. Deletes the rows that name the removed modules: ModuleSetting,
--      AccessRoleFeatureGrant and UserAccessException by "moduleId" (compared as
--      text, so the statement parses whether or not the enum still has the
--      labels), and AccessRoleToolGrant by "domain" (free text holding a tool
--      domain name, not the enum).
--   2. Departments stay, and so do their profiles. A profile whose template is
--      'security' becomes 'custom' (an explicit choice, not a fallback). Every
--      profile loses its '/security', '/doors', '/security/…' and '/doors/…'
--      navHrefs entries, order kept. homeWidgets is left as it is (the dashboard
--      skips a widget id it does not know), and so are updatedBy and updatedAt:
--      this is not a person's edit. Then "DepartmentTemplate" is rebuilt without
--      'security' (new type, ALTER COLUMN … USING, drop, rename, the shape of
--      20260905010000_warp_2739_erp_document_widening), because Postgres cannot
--      drop an enum label. A fresh database runs this step too:
--      20260922160000_warp_2976_department_profile still creates the type with
--      'security', and rebuilding it over an empty table is what makes a fresh
--      database's type match schema.prisma. The step is guarded on the live type
--      still having the label, so a second run skips it.
--   3. Drops the 26 tables (CASCADE), then the 4 functions, then the 46 enum
--      types: the tables' columns use the types, the triggers use the functions.
--
-- "ModuleId" keeps its 'security' and 'doors' labels on a box that has them:
-- every row that names one is deleted in step 1, nothing writes one any more, and
-- the label list cannot shrink without rebuilding a type that three tables key on.
--
-- Idempotent. On a database that never had the modules every DELETE matches
-- nothing and every DROP is IF EXISTS; step 2's rebuild, over an empty table, is
-- the only thing that changes a fresh database.
--
-- Rollback. OTA rollback does not restore the database schema, so an image from
-- before WARP-3474 will not find these tables. The pg_dump snapshot that
-- migrate-and-start.sh takes before applying a pending migration still holds the
-- dropped rows until it is pruned.

-- ── 1. Rows that name the removed modules ───────────────────────────────────

DELETE FROM "ModuleSetting" WHERE "moduleId"::text IN ('security', 'doors');
DELETE FROM "AccessRoleFeatureGrant" WHERE "moduleId"::text IN ('security', 'doors');
DELETE FROM "UserAccessException" WHERE "moduleId"::text IN ('security', 'doors');
DELETE FROM "AccessRoleToolGrant" WHERE "domain" IN ('security', 'doors');

-- ── 2. Department template: 'security' is gone, the departments are not ────

DO $$
DECLARE
  template_default text;
BEGIN
  -- Only while the live type still has the label: a re-run, or a database the
  -- type was already rebuilt on, skips the whole step.
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumtypid = to_regtype('"DepartmentTemplate"')::oid
      AND enumlabel = 'security'
  ) THEN
    RETURN;
  END IF;

  UPDATE "DepartmentProfile"
  SET "template" = 'custom'
  WHERE "template"::text = 'security';

  -- ARRAY(subquery) over no rows is '{}', not NULL.
  UPDATE "DepartmentProfile"
  SET "navHrefs" = ARRAY(
    SELECT t.href
    FROM unnest("navHrefs") WITH ORDINALITY AS t(href, ord)
    WHERE t.href NOT IN ('/security', '/doors')
      AND t.href NOT LIKE '/security/%'
      AND t.href NOT LIKE '/doors/%'
    ORDER BY t.ord
  )
  WHERE EXISTS (
    SELECT 1
    FROM unnest("navHrefs") AS h(href)
    WHERE h.href IN ('/security', '/doors')
      OR h.href LIKE '/security/%'
      OR h.href LIKE '/doors/%'
  );

  -- A column default cannot be cast across the swap: lift it, put it back. None
  -- exists today; a default that named 'security' falls to 'custom'.
  SELECT pg_get_expr(d.adbin, d.adrelid)
  INTO template_default
  FROM pg_attrdef d
  JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
  WHERE d.adrelid = to_regclass('"DepartmentProfile"')::oid
    AND a.attname = 'template';

  ALTER TABLE "DepartmentProfile" ALTER COLUMN "template" DROP DEFAULT;

  CREATE TYPE "DepartmentTemplate_new" AS ENUM (
    'sales', 'finance', 'operations', 'front_desk', 'it', 'custom'
  );

  ALTER TABLE "DepartmentProfile"
    ALTER COLUMN "template" TYPE "DepartmentTemplate_new"
    USING "template"::text::"DepartmentTemplate_new";

  DROP TYPE "DepartmentTemplate";
  ALTER TYPE "DepartmentTemplate_new" RENAME TO "DepartmentTemplate";

  IF template_default IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE "DepartmentProfile" ALTER COLUMN "template" SET DEFAULT %s',
      replace(template_default, '''security''', '''custom''')
    );
  END IF;
END $$;

-- ── 3. The tables, the functions, the types ─────────────────────────────────

-- Incidents (WARP-2978) and the pattern layer on them (WARP-2980).
DROP TABLE IF EXISTS "SecurityPatternFlag" CASCADE;
DROP TABLE IF EXISTS "SecuritySuppression" CASCADE;
DROP TABLE IF EXISTS "SecurityPatternDay" CASCADE;
DROP TABLE IF EXISTS "SecurityIncidentNotice" CASCADE;
DROP TABLE IF EXISTS "SecurityIncidentAck" CASCADE;
DROP TABLE IF EXISTS "SecurityEventTriage" CASCADE;
DROP TABLE IF EXISTS "SecurityIncidentReason" CASCADE;
DROP TABLE IF EXISTS "SecurityIncident" CASCADE;
DROP TABLE IF EXISTS "SecurityAlertRecipient" CASCADE;
DROP TABLE IF EXISTS "SecurityIncidentEngineState" CASCADE;

-- Events (WARP-2977).
DROP TABLE IF EXISTS "SecurityEvent" CASCADE;
DROP TABLE IF EXISTS "SecurityIngestState" CASCADE;

-- Zones, links, hours and mode (WARP-2977, WARP-2979).
DROP TABLE IF EXISTS "SecurityZoneLink" CASCADE;
DROP TABLE IF EXISTS "SecurityZone" CASCADE;
DROP TABLE IF EXISTS "SecurityScheduleException" CASCADE;
DROP TABLE IF EXISTS "SecuritySchedule" CASCADE;
DROP TABLE IF EXISTS "SecuritySiteHours" CASCADE;
DROP TABLE IF EXISTS "SecurityModeState" CASCADE;
DROP TABLE IF EXISTS "SecurityAiSettings" CASCADE;

-- Coverage and baselines (WARP-2980).
DROP TABLE IF EXISTS "SecurityBaselineCell" CASCADE;
DROP TABLE IF EXISTS "SecurityBaselineBuild" CASCADE;
DROP TABLE IF EXISTS "SecurityBaselineSource" CASCADE;
DROP TABLE IF EXISTS "SecurityBaselineJobState" CASCADE;
DROP TABLE IF EXISTS "SecurityCoverageSpan" CASCADE;

-- Doors (ADR-055).
DROP TABLE IF EXISTS "AccessEvent" CASCADE;
DROP TABLE IF EXISTS "AccessPoint" CASCADE;

-- The trigger functions, after the tables whose triggers called them.
DROP FUNCTION IF EXISTS "security_event_append_only"();
DROP FUNCTION IF EXISTS "access_event_append_only"();
DROP FUNCTION IF EXISTS "access_event_derived_guard"();
DROP FUNCTION IF EXISTS "access_event_purge"(timestamptz, integer, integer);

-- The enum types, after the tables whose columns used them.
DROP TYPE IF EXISTS
  "SecurityEventSource",
  "SecurityEventKind",
  "SecurityObservation",
  "SecuritySeverity";

DROP TYPE IF EXISTS
  "SecurityZoneKind",
  "SecurityZoneState",
  "SecurityZoneSourceKind",
  "SecurityZoneLinkState",
  "SecurityLinkActor";

DROP TYPE IF EXISTS
  "SecurityAiLinking",
  "SecurityAiSummaries";

DROP TYPE IF EXISTS
  "SecurityHoursState",
  "SecurityDayKind",
  "SecurityMode",
  "SecurityModeSource",
  "SecurityManualEnd";

DROP TYPE IF EXISTS
  "SecurityDayType",
  "SecurityBaselineState",
  "SecurityCoverageSpanState",
  "SecurityBaselineBuildState",
  "SecurityBaselineBuildTrigger",
  "SecurityBaselineKeyKind";

DROP TYPE IF EXISTS
  "SecurityIncidentScope",
  "SecurityIncidentGrouping",
  "SecurityIncidentState",
  "SecurityIncidentNotify",
  "SecurityIncidentEvents",
  "SecurityReasonCode",
  "SecurityIncidentVerdict",
  "SecurityNarrativeState",
  "SecurityTriageOutcome",
  "SecurityIncidentAckAction",
  "SecurityAlertRecipientState",
  "SecurityAlertRecipientOrigin",
  "SecurityNoticeReason",
  "SecurityNoticeOutcome";

DROP TYPE IF EXISTS
  "SecurityPatternFlagEffect",
  "SecuritySuppressionTarget",
  "SecuritySuppressionDays",
  "SecuritySuppressionState",
  "SecurityPatternOutcome";

DROP TYPE IF EXISTS
  "DoorPositionSource",
  "AccessPointStatus",
  "AccessEventKind",
  "AccessForcedClaim",
  "AccessTroubleCode";
