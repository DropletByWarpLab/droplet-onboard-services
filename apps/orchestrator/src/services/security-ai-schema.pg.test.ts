/**
 * WARP-2979 (ADR-059 P4 §5, §9 pg lane) — every hand-written CHECK in
 * 20260926000100_warp_2979_security_ai, the enum values of
 * 20260926000000_warp_2979_security_ai_values, and the backfill rule, on a
 * real Postgres.
 *
 * Why this file exists: CHECKs are invisible to `prisma migrate diff`, so
 * check-schema-drift cannot see one dropped or loosened, and a mocked test
 * cannot see them at all. Each refusal asserts the SQLSTATE (23514) AND the
 * constraint that fired, so a row refused by the WRONG rule (a NOT NULL, a
 * type error, another CHECK) does not count as a pass.
 *
 * The provenance CHECK is "Droplet never removes or rejects" in the database:
 * `removed` and `rejected` are always a person's; `droplet` sets a state only
 * on its own rows, and only `proposed` or `active`.
 *
 * NULL discipline: a CHECK that evaluates to NULL PASSES — the NULL cases
 * below (half of Droplet's evidence columns set) are the ones a
 * "simplification" of the SQL would let through.
 *
 * Every probe runs in a transaction that ALWAYS rolls back; fixtures are
 * tagged `warp2979-` and swept before and after anyway.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Prisma, PrismaClient } from "@prisma/client";
import { MIGRATIONS_DIR } from "../__tests__/helpers/test-paths.js";
import { readSecurityAiSettings } from "./security-ai-settings.js";

// The global unit setup mocks @prisma/client; this file needs the real one.
vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

const TAG = "warp2979-";
const CAM = "warp2979_back";
const VALUES_FOLDER = "20260926000000_warp_2979_security_ai_values";
const MAIN_FOLDER = "20260926000100_warp_2979_security_ai";
const migration = (folder: string) => readFileSync(join(MIGRATIONS_DIR, folder, "migration.sql"), "utf8");

/** The migration's statements, split at top-level `;` (a `DO $$ … $$` body keeps its own) — WARP-2804's splitter. */
function statements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inDollar = false;
  for (const line of sql.replace(/\r\n/g, "\n").split("\n")) {
    if (line.trim().startsWith("--") && !inDollar) continue;
    cur += line + "\n";
    inDollar = (line.match(/\$\$/g)?.length ?? 0) % 2 === 1 ? !inDollar : inDollar;
    if (!inDollar && line.trimEnd().endsWith(";")) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Thrown to roll a probe transaction back. */
class Rollback extends Error {}

type Outcome = "inserted" | { sqlstate: string; constraint: string | null };
const rejectedBy = (constraint: string): Outcome => ({ sqlstate: "23514", constraint });
const q = (v: string | null): string => (v === null ? "NULL" : `'${v.replace(/'/g, "''")}'`);

/** A row as SQL: `over` replaces columns (SQL literals); `undefined` leaves the column out. */
function insert(table: string, base: Record<string, string>, over: Record<string, string | undefined> = {}): string {
  const cols = Object.entries({ ...base, ...over }).filter((e): e is [string, string] => e[1] !== undefined);
  return `INSERT INTO "${table}" (${cols.map(([c]) => `"${c}"`).join(",")}) VALUES (${cols.map(([, v]) => v).join(",")})`;
}

/** LinkEvidenceV1-shaped enough for the CHECK (which only asks for a JSON object); the shape is `parseLinkEvidence`'s. */
const EVIDENCE = `'{"v":1}'::jsonb`;

describe.skipIf(!RUN)("WARP-2979 schema: Droplet's links, the AI settings row and incident summaries", () => {
  let prisma: PrismaClient;

  async function sweep(): Promise<void> {
    await prisma.securityZoneLink.deleteMany({ where: { zone: { name: { startsWith: TAG } } } });
    await prisma.securityZone.deleteMany({ where: { name: { startsWith: TAG } } });
  }

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } = await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
    await sweep();
  });

  afterAll(async () => {
    await sweep();
    await prisma.$disconnect();
  });

  /** Run the statements in one transaction that always rolls back; report what the last one did. */
  async function run(...sql: string[]): Promise<Outcome> {
    try {
      await prisma.$transaction(async (tx) => {
        for (const s of sql) await tx.$executeRawUnsafe(s);
        throw new Rollback("probe");
      });
    } catch (e) {
      if (e instanceof Rollback) return "inserted";
      const err = e as { code?: string; meta?: { code?: string; message?: string } };
      if (err.code === "P2010" && typeof err.meta?.code === "string") {
        const m = /violates check constraint "([^"]+)"/.exec(err.meta.message ?? "");
        return { sqlstate: err.meta.code, constraint: m?.[1] ?? null };
      }
      throw e;
    }
    throw new Error("unreachable: the probe transaction always rolls back");
  }

  // ── SecurityZoneLink_origin_shape ─────────────────────────────────────────

  describe("SecurityZoneLink_origin_shape — provenance in the database", () => {
    const ZONE = `${TAG}zone`;
    const zone = `INSERT INTO "SecurityZone" ("id","name","nameKey","kind","updatedAt") VALUES (${q(ZONE)},${q(`${TAG}Stock room`)},${q(`${TAG}stock room`)},'interior',now())`;
    const person = { origin: "'person'", stateSetBy: "'person'" };
    const dropletFields = { evidence: EVIDENCE, confidence: "0.601", rulesVersion: "1", evidenceAt: "now()" };
    const link = (over: Record<string, string | undefined>) =>
      insert(
        "SecurityZoneLink",
        { id: q(`${TAG}link`), zoneId: q(ZONE), sourceKind: "'camera'", sourceRef: q(CAM), sourceLabel: "'Back camera'", state: "'active'" },
        over,
      );

    it.each<[string, Record<string, string | undefined>]>([
      ["a person's active link (route 12)", { ...person }],
      ["a person's removed link", { ...person, state: "'removed'" }],
      ["Droplet's suggestion, with its evidence", { origin: "'droplet'", stateSetBy: "'droplet'", state: "'proposed'", ...dropletFields }],
      ["a link Droplet activated on its own", { origin: "'droplet'", stateSetBy: "'droplet'", ...dropletFields }],
      ["Droplet's link a person kept (or a suggestion a person added)", { origin: "'droplet'", stateSetBy: "'person'", ...dropletFields }],
      ["Droplet's suggestion or link a person turned down (rejected)", { origin: "'droplet'", stateSetBy: "'person'", state: "'rejected'", ...dropletFields }],
      ["Droplet's link a person unticked (removed)", { origin: "'droplet'", stateSetBy: "'person'", state: "'removed'", ...dropletFields }],
      ["a confidence of exactly 0", { origin: "'droplet'", stateSetBy: "'droplet'", ...dropletFields, confidence: "0" }],
      ["a confidence of exactly 1", { origin: "'droplet'", stateSetBy: "'droplet'", ...dropletFields, confidence: "1" }],
    ])("accepts %s", async (_name, over) => {
      expect(await run(zone, link(over))).toBe("inserted");
    });

    it.each<[string, Record<string, string | undefined>]>([
      ["Droplet's row without evidence", { origin: "'droplet'", stateSetBy: "'droplet'", state: "'proposed'" }],
      ["Droplet's row with only some of its evidence columns (NULL confidence)", { origin: "'droplet'", stateSetBy: "'droplet'", ...dropletFields, confidence: "NULL" }],
      ["Droplet's row with no rules version", { origin: "'droplet'", stateSetBy: "'droplet'", ...dropletFields, rulesVersion: "NULL" }],
      ["Droplet's row with no evidence time", { origin: "'droplet'", stateSetBy: "'droplet'", ...dropletFields, evidenceAt: "NULL" }],
      ["a person's row carrying evidence", { ...person, ...dropletFields }],
      ["a person's row carrying only a confidence", { ...person, confidence: "0.5" }],
      ["a confidence of 1.2", { origin: "'droplet'", stateSetBy: "'droplet'", ...dropletFields, confidence: "1.2" }],
      ["a negative confidence", { origin: "'droplet'", stateSetBy: "'droplet'", ...dropletFields, confidence: "-0.1" }],
      ["rules version 0", { origin: "'droplet'", stateSetBy: "'droplet'", ...dropletFields, rulesVersion: "0" }],
      ["evidence as an array", { origin: "'droplet'", stateSetBy: "'droplet'", ...dropletFields, evidence: `'[1]'::jsonb` }],
      ["evidence as a string", { origin: "'droplet'", stateSetBy: "'droplet'", ...dropletFields, evidence: `'"x"'::jsonb` }],
      ["a suggestion a person made (origin person)", { ...person, state: "'proposed'" }],
      ["a suggestion set by a person", { origin: "'droplet'", stateSetBy: "'person'", state: "'proposed'", ...dropletFields }],
      ["a rejected row a person made (origin person)", { ...person, state: "'rejected'" }],
      ["Droplet rejecting (rejected, stateSetBy droplet)", { origin: "'droplet'", stateSetBy: "'droplet'", state: "'rejected'", ...dropletFields }],
      ["Droplet removing (removed, stateSetBy droplet)", { origin: "'droplet'", stateSetBy: "'droplet'", state: "'removed'", ...dropletFields }],
      ["Droplet setting the state of a person's row", { origin: "'person'", stateSetBy: "'droplet'" }],
    ])("refuses %s", async (_name, over) => {
      expect(await run(zone, link(over))).toEqual(rejectedBy("SecurityZoneLink_origin_shape"));
    });

    it("origin and stateSetBy have no default: a writer that names neither is refused (NOT NULL, 23502)", async () => {
      expect(await run(zone, link({}))).toEqual({ sqlstate: "23502", constraint: null });
      expect(await run(zone, link({ origin: "'person'" }))).toEqual({ sqlstate: "23502", constraint: null });
    });
  });

  // ── the backfill rule, as the migrated database shows it ─────────────────

  it("origin and stateSetBy carry no column default after the backfill; narrativeState defaults to none", async () => {
    const cols = await prisma.$queryRawUnsafe<Array<{ table: string; column: string; dflt: string | null; nullable: string }>>(
      `SELECT table_name AS "table", column_name AS "column", column_default AS dflt, is_nullable AS nullable
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND ((table_name = 'SecurityZoneLink' AND column_name IN ('origin','stateSetBy'))
            OR (table_name = 'SecurityIncident' AND column_name = 'narrativeState'))
        ORDER BY 1, 2`,
    );
    expect(cols).toEqual([
      { table: "SecurityIncident", column: "narrativeState", dflt: `'none'::"SecurityNarrativeState"`, nullable: "NO" },
      { table: "SecurityZoneLink", column: "origin", dflt: null, nullable: "NO" },
      { table: "SecurityZoneLink", column: "stateSetBy", dflt: null, nullable: "NO" },
    ]);
  });

  it("a link row written before P4 is backfilled person/person by re-running the folder's link step on it", async () => {
    // A P2b-shaped table in a scratch schema: the P2b row gets exactly person/person, and the
    // defaults are gone afterwards — the same two statements the folder runs.
    const SCRATCH = "warp2979_backfill";
    const main = statements(migration(MAIN_FOLDER));
    const addCols = main.find((s) => s.startsWith(`ALTER TABLE "SecurityZoneLink"\n  ADD COLUMN IF NOT EXISTS "origin"`));
    const dropDefaults = main.find((s) => s.startsWith(`ALTER TABLE "SecurityZoneLink" ALTER COLUMN "origin" DROP DEFAULT`));
    expect(addCols, "the folder's ADD COLUMN step").toBeDefined();
    expect(dropDefaults, "the folder's DROP DEFAULT step").toBeDefined();
    const out = await prisma
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`CREATE SCHEMA ${SCRATCH}`);
        await tx.$executeRawUnsafe(`SET LOCAL search_path TO ${SCRATCH}, public`);
        await tx.$executeRawUnsafe(
          `CREATE TABLE "SecurityZoneLink" ("id" TEXT PRIMARY KEY, "state" "SecurityZoneLinkState" NOT NULL)`,
        );
        await tx.$executeRawUnsafe(`INSERT INTO "SecurityZoneLink" ("id","state") VALUES ('p2b-active','active'),('p2b-removed','removed')`);
        await tx.$executeRawUnsafe(addCols!);
        await tx.$executeRawUnsafe(dropDefaults!);
        const rows = await tx.$queryRawUnsafe<Array<{ id: string; origin: string; setBy: string }>>(
          `SELECT "id", "origin"::text AS origin, "stateSetBy"::text AS "setBy" FROM "SecurityZoneLink" ORDER BY 1`,
        );
        const defaults = await tx.$queryRawUnsafe<Array<{ c: string; d: string | null }>>(
          `SELECT column_name AS c, column_default AS d FROM information_schema.columns
            WHERE table_schema = '${SCRATCH}' AND table_name = 'SecurityZoneLink' AND column_name IN ('origin','stateSetBy') ORDER BY 1`,
        );
        throw Object.assign(new Rollback("probe"), { rows, defaults });
      })
      .catch((e: Rollback & { rows?: unknown; defaults?: unknown }) => {
        if (!(e instanceof Rollback)) throw e;
        return e;
      });
    expect(out.rows).toEqual([
      { id: "p2b-active", origin: "person", setBy: "person" },
      { id: "p2b-removed", origin: "person", setBy: "person" },
    ]);
    expect(out.defaults).toEqual([
      { c: "origin", d: null },
      { c: "stateSetBy", d: null },
    ]);
  });

  // ── incidents and reasons ─────────────────────────────────────────────────

  describe("SecurityIncident_narrative_shape and the reasons' related sources", () => {
    const INC = "00000000-0000-4000-8000-0000000029c1";
    /** A legal plain-activity camera incident (P3's fixture); `over` replaces columns. */
    const incident = (over: Record<string, string | undefined> = {}) =>
      insert(
        "SecurityIncident",
        {
          id: q(INC),
          scope: "'camera'",
          zoneLinkIds: "ARRAY[]::text[]",
          scopeCamera: q(CAM),
          openedInMode: "'closed'",
          grouping: "'collecting'",
          state: "'no_action'",
          severity: "'info'",
          reasonCodes: `ARRAY[]::"SecurityReasonCode"[]`,
          notifyState: "'not_needed'",
          rulesetVersion: "1",
          firstActivityAt: "now()",
          lastActivityAt: "now()",
          lastArrivalAt: "now()",
          eventCount: "1",
          countsByCamera: "'{}'::jsonb",
          spanByCamera: "'{}'::jsonb",
          cameras: `ARRAY[${q(CAM)}]::text[]`,
          updatedAt: "now()",
        },
        over,
      );
    const notice = { state: "'open'", severity: "'notice'", reasonCodes: `ARRAY['camera_offline']::"SecurityReasonCode"[]` };
    const alert = {
      state: "'open'",
      severity: "'alert'",
      reasonCodes: `ARRAY['camera_offline_during_activity']::"SecurityReasonCode"[]`,
      notifyState: "'pending'",
      alertedAt: "now()",
    };
    const written = {
      narrativeState: "'written'",
      narrative: q("Someone was seen in the stock room after closing, then the back camera stopped reporting."),
      narrativeModel: "'gpt-oss:20b'",
      narrativePromptVersion: "1",
      narratedAt: "now()",
      narrativeAudience: `'{"cameras":["${CAM}"],"threats":false,"locks":false}'::jsonb`,
    };

    it.each<[string, Record<string, string | undefined>]>([
      ["plain activity, never narrated (the default none)", {}],
      ["a notice waiting for the narrator", { ...notice, narrativeState: "'pending'" }],
      ["an alert with its summary", { ...alert, ...written }],
      ["a Regenerate: pending keeps the previous text visible", { ...alert, ...written, narrativeState: "'pending'", narrativeAttempts: "1" }],
      ["a failed summary with its reason", { ...notice, narrativeState: "'failed'", narrativeAttempts: "3", narrativeError: "'CHECK_FAILED:names'" }],
      ["an expired one", { ...notice, narrativeState: "'expired'" }],
    ])("accepts %s", async (_name, over) => {
      expect(await run(incident(over))).toBe("inserted");
    });

    it.each<[string, Record<string, string | undefined>]>([
      ["text without its model", { ...alert, ...written, narrativeModel: "NULL" }],
      ["text without its prompt version", { ...alert, ...written, narrativePromptVersion: "NULL" }],
      ["text without its time", { ...alert, ...written, narratedAt: "NULL" }],
      ["text without its audience", { ...alert, ...written, narrativeAudience: "NULL" }],
      ["a model with no text", { ...alert, narrativeModel: "'gpt-oss:20b'" }],
      ["written without text", { ...alert, narrativeState: "'written'" }],
      ["plain activity waiting for a summary", { narrativeState: "'pending'" }],
      ["plain activity with a summary", { ...written }],
      ["failed without a reason", { ...notice, narrativeState: "'failed'" }],
      ["11 attempts", { ...notice, narrativeState: "'pending'", narrativeAttempts: "11" }],
      ["a negative attempt count", { ...notice, narrativeAttempts: "-1" }],
      ["prompt version 0", { ...alert, ...written, narrativePromptVersion: "0" }],
      ["an audience that is not an object", { ...alert, ...written, narrativeAudience: `'["${CAM}"]'::jsonb` }],
    ])("SecurityIncident refuses %s", async (_name, over) => {
      expect(await run(incident(over))).toEqual(rejectedBy("SecurityIncident_narrative_shape"));
    });

    const reason = (code: string, severity: string, over: Record<string, string | undefined> = {}) =>
      insert(
        "SecurityIncidentReason",
        {
          id: "gen_random_uuid()::text",
          incidentId: q(INC),
          code: q(code),
          severity: q(severity),
          rulesetVersion: "4",
          evidenceEventId: "1",
          evidenceCamera: q(CAM),
          evidenceSource: "'frigate_status'",
          evidenceKind: "'camera_offline'",
          evidenceAt: "now()",
          evidenceSummary: "'x'",
          detail: "'{}'::jsonb",
        },
        over,
      );

    it("camera_offline_during_activity is always an alert, and may name where the person was seen", async () => {
      expect(await run(incident(alert), reason("camera_offline_during_activity", "alert"))).toBe("inserted");
      expect(await run(incident(alert), reason("camera_offline_during_activity", "alert", { relatedCamera: "'stock_cam'" }))).toBe("inserted");
      expect(await run(incident(alert), reason("camera_offline_during_activity", "alert", { relatedLock: "true" }))).toBe("inserted");
      expect(await run(incident(alert), reason("camera_offline_during_activity", "notice"))).toEqual(
        rejectedBy("SecurityIncidentReason_code_severity"),
      );
    });

    it("P3's codes keep their severities under the widened CHECK", async () => {
      expect(await run(incident(alert), reason("after_hours_presence", "alert", { evidenceKind: "'detection'", evidenceSource: "'frigate'" }))).toBe(
        "inserted",
      );
      expect(await run(incident(alert), reason("camera_offline", "notice"))).toBe("inserted");
      expect(await run(incident(alert), reason("camera_offline", "alert"))).toEqual(rejectedBy("SecurityIncidentReason_code_severity"));
      // P5's pattern codes stay refused on a reason until P5 PR-D widens the CHECK.
      expect(await run(incident(alert), reason("out_of_place", "alert"))).toEqual(rejectedBy("SecurityIncidentReason_code_severity"));
    });

    it.each<[string, string, string, Record<string, string | undefined>]>([
      ["a related camera on camera_offline", "camera_offline", "notice", { relatedCamera: "'stock_cam'" }],
      ["a related lock on camera_offline", "camera_offline", "notice", { relatedLock: "true" }],
      ["a related camera on after_hours_presence", "after_hours_presence", "alert", { relatedCamera: "'stock_cam'", evidenceKind: "'detection'" }],
      ["a related camera that is not a Frigate name", "camera_offline_during_activity", "alert", { relatedCamera: "'stock cam'" }],
      ["an empty related camera", "camera_offline_during_activity", "alert", { relatedCamera: "''" }],
    ])("SecurityIncidentReason refuses %s", async (_name, code, severity, over) => {
      expect(await run(incident(alert), reason(code, severity, over))).toEqual(rejectedBy("SecurityIncidentReason_related"));
    });

    it("a related camera past 64 characters never reaches the CHECK: the column refuses it (22001)", async () => {
      const got = await run(incident(alert), reason("camera_offline_during_activity", "alert", { relatedCamera: q("a".repeat(65)) }));
      expect(got).toEqual({ sqlstate: "22001", constraint: null });
    });
  });

  // ── SecurityAiSettings ────────────────────────────────────────────────────

  describe("SecurityAiSettings — one row", () => {
    it("the lazy create (ON CONFLICT DO NOTHING, then a read) gives the defaults the CHECK expects", async () => {
      const got = await prisma
        .$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`DELETE FROM "SecurityAiSettings"`);
          const first = await readSecurityAiSettings(tx);
          const again = await readSecurityAiSettings(tx);
          const n = await tx.securityAiSettings.count();
          throw Object.assign(new Rollback("probe"), { first, again, n });
        })
        .catch((e: Rollback & { first?: unknown; again?: unknown; n?: number }) => {
          if (!(e instanceof Rollback)) throw e;
          return e;
        });
      expect(got.first).toEqual({ linking: "link_and_suggest", summaries: "on", version: 0 });
      expect(got.again).toEqual(got.first);
      expect(got.n).toBe(1);
    });

    it("refuses a second row, and a negative version", async () => {
      expect(await run(`DELETE FROM "SecurityAiSettings"`, `INSERT INTO "SecurityAiSettings" ("id","updatedAt") VALUES ('other',now())`)).toEqual(
        rejectedBy("SecurityAiSettings_singleton"),
      );
      expect(
        await run(`DELETE FROM "SecurityAiSettings"`, `INSERT INTO "SecurityAiSettings" ("id","version","updatedAt") VALUES ('singleton',-1,now())`),
      ).toEqual(rejectedBy("SecurityAiSettings_singleton"));
      expect(await run(`DELETE FROM "SecurityAiSettings"`, `INSERT INTO "SecurityAiSettings" ("updatedAt") VALUES (now())`)).toBe("inserted");
    });
  });

  // ── re-runnable ───────────────────────────────────────────────────────────

  it("applying both folders again changes nothing: the same enum labels, CHECK text, columns and indexes", async () => {
    const TABLES = `('SecurityZoneLink','SecurityIncident','SecurityIncidentReason','SecurityAiSettings')`;
    const snapshot = async (tx: Pick<PrismaClient, "$queryRawUnsafe">) => ({
      labels: await tx.$queryRawUnsafe<Array<{ t: string; l: string }>>(
        `SELECT t.typname AS t, e.enumlabel AS l FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
          WHERE t.typname IN ('SecurityZoneLinkState','SecurityReasonCode','SecurityLinkActor','SecurityAiLinking','SecurityAiSummaries','SecurityNarrativeState')
          ORDER BY 1, e.enumsortorder`,
      ),
      constraints: await tx.$queryRawUnsafe<Array<{ name: string; def: string }>>(
        `SELECT c.conname AS name, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = 'public' AND t.relname IN ${TABLES} ORDER BY 1`,
      ),
      columns: await tx.$queryRawUnsafe<Array<{ t: string; c: string; d: string | null; n: string }>>(
        `SELECT table_name AS t, column_name AS c, column_default AS d, is_nullable AS n FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name IN ${TABLES} ORDER BY 1, 2`,
      ),
      indexes: await tx.$queryRawUnsafe<Array<{ i: string }>>(
        `SELECT indexname AS i FROM pg_indexes WHERE schemaname = 'public' AND tablename IN ${TABLES} ORDER BY 1`,
      ),
    });
    const outcome = await prisma
      .$transaction(
        async (tx: Prisma.TransactionClient) => {
          const before = await snapshot(tx);
          for (const folder of [VALUES_FOLDER, MAIN_FOLDER]) for (const stmt of statements(migration(folder))) await tx.$executeRawUnsafe(stmt);
          const after = await snapshot(tx);
          throw Object.assign(new Rollback("probe"), { before, after });
        },
        { timeout: 60_000 },
      )
      .catch((e: Rollback & { before?: unknown; after?: unknown }) => {
        if (!(e instanceof Rollback)) throw e;
        return e;
      });
    const { before, after } = outcome as unknown as {
      before: Awaited<ReturnType<typeof snapshot>>;
      after: Awaited<ReturnType<typeof snapshot>>;
    };
    expect(before.labels.filter((r) => r.t === "SecurityZoneLinkState").map((r) => r.l)).toEqual(["active", "removed", "proposed", "rejected"]);
    expect(before.labels.filter((r) => r.t === "SecurityReasonCode").map((r) => r.l).at(-1)).toBe("camera_offline_during_activity");
    expect(before.constraints.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        "SecurityZoneLink_origin_shape",
        "SecurityIncident_narrative_shape",
        "SecurityIncidentReason_related",
        "SecurityIncidentReason_code_severity",
        "SecurityAiSettings_singleton",
      ]),
    );
    expect(after).toEqual(before);
  });
});
