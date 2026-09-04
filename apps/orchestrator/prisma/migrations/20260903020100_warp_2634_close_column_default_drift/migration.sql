-- WARP-2634 — close the column-DEFAULT half of the schema/migrations drift.
--
-- Entries 1 and 4 of prisma/schema-drift-baseline.sql. Both are cases where a
-- hand-written migration put a DEFAULT on a column that schema.prisma does not
-- declare (or declares differently), so replaying every migration from scratch
-- produced a database the generated client disagreed with.
--
-- Every statement here only changes a column DEFAULT. `ALTER COLUMN … SET/DROP
-- DEFAULT` is a catalog-only change: it rewrites no rows, takes no table
-- rewrite lock beyond a brief ACCESS EXCLUSIVE, and leaves every existing value
-- exactly as it is. Nothing in this file can fail on populated data.
--
-- ── 1 · ToolRun.status DEFAULT 'ok' → 'pending' ──
--
-- 20260528100000_warp_462_tool_spec wrote DEFAULT 'ok'; schema.prisma declares
-- `@default(pending)`. The value being set was added by 20260903020000, in the
-- previous migration and therefore the previous transaction — Postgres will not
-- accept a new enum value and a DEFAULT that uses it in one transaction, which
-- is why this is a second file.
--
-- No behaviour changes today: tool-spec-runner.service.ts:410 is the only
-- writer and always passes `status` explicitly, so the column default is never
-- reached. It matters the first time a writer omits `status` — Prisma would
-- leave the column out of the INSERT and Postgres would silently store 'ok'
-- where the datamodel promises 'pending'.

ALTER TABLE "ToolRun" ALTER COLUMN "status" SET DEFAULT 'pending';

-- ── 2 · AssistantPersona / BusinessProfile / TlsCert .updatedAt DROP DEFAULT ──
--
-- `@updatedAt` is application-managed: Prisma stamps the column on every create
-- and every update and emits NO database default for it. The hand-written
-- migrations 20260708000001_warp_1118_persona_business_profile and
-- 20260613000000_adr_023_tls_cert_state added `DEFAULT CURRENT_TIMESTAMP`
-- anyway, so the replayed database carried a default the datamodel never
-- declared. This is the migration side of the drift, not the schema side —
-- `@updatedAt @default(now())` would make the datamodel describe a default
-- Prisma itself never generates for an `@updatedAt` column, i.e. it would move
-- the lie rather than remove it.
--
-- Safe to drop: no writer depends on it. All three tables are written only
-- through Prisma (prisma.assistantPersona.*, prisma.businessProfile.*,
-- prisma.tlsCert.upsert in tls-issuance.adapters.ts:186), and Prisma always
-- supplies `updatedAt`. There is no raw-SQL INSERT into any of the three
-- outside the migration set. The two singleton seeds in
-- 20260708000001_warp_1118_persona_business_profile:141,145 list "updatedAt" in
-- their column list and pass CURRENT_TIMESTAMP explicitly — that seed's own
-- comment already states the column "has no DB default outside this seed's
-- CURRENT_TIMESTAMP", which is the intent this migration finally makes true.
-- They also run BEFORE this file on a fresh replay, so the ordering holds.

ALTER TABLE "AssistantPersona" ALTER COLUMN "updatedAt" DROP DEFAULT;
ALTER TABLE "BusinessProfile" ALTER COLUMN "updatedAt" DROP DEFAULT;
ALTER TABLE "TlsCert" ALTER COLUMN "updatedAt" DROP DEFAULT;
