/**
 * WARP-2980 (ADR-059 P5 PR-B) — pattern flags, expected activity and
 * verdicts against REAL Postgres.
 *
 * WHY THESE CASES RUN HERE AND NOT IN THE MOCKED LANE
 *
 *   trial        — SecurityIncidentReason_code_severity (20260925030000) was
 *                  deliberately NOT widened: Postgres refuses a P5 code on a
 *                  reason, so "trial never counts" is a database fact (D3).
 *   the CHECKs   — every hand-written CHECK in 20260925060100_warp_2980_…
 *                  refuses its bad row with SQLSTATE 23514 AND its own name (a
 *                  row refused by the WRONG rule does not count). They are
 *                  invisible to `prisma migrate diff`.
 *   the FKs      — an area or a suppression that something points at cannot
 *                  be deleted (Restrict); an incident takes its flags with it.
 *   re-runnable  — both folders applied a second time change nothing.
 *   end to end   — 28 days of coverage and daytime detections, a REAL build
 *                  and learning state, a 03:10 detection through the REAL
 *                  engine: one trial flag whose numbers are route 31's for the
 *                  same instant, and which a later rebuild never moves (D20);
 *   k            — only `detection` rows count, and the query is served by
 *                  the (camera, startedAt) index at 10k rows (D8);
 *   retention    — a marked plain incident outlives the event horizon; its
 *                  unmarked twin does not, and takes its flags with it (D19).
 *
 * Every probe runs in a transaction that ALWAYS rolls back, so the file leaves
 * no row behind. Gated on RUN_PG_INTEGRATION=1 + DATABASE_URL, like every
 * *.pg.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Prisma, PrismaClient } from "@prisma/client";
import { MIGRATIONS_DIR } from "../__tests__/helpers/test-paths.js";

vi.unmock("@prisma/client");

import { runFullBuild } from "./security-baseline-build.js";
import { refreshBaselineSources } from "./security-coverage.js";
import { tickSecurityIncidents, trimSecurityIncidents, _resetIncidentHealthForTests } from "./security-incidents.service.js";
import { countSlotDetections, _resetPatternRulesForTests } from "./security-pattern-rules.js";
import { explainSecurityPattern } from "./security-patterns-read.js";
import { slotOf } from "../lib/security-baseline-slots.js";
import { windowFor } from "../lib/security-baseline-slots.js";

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

const CAM = "warp2980b_front";
const INC = "00000000-0000-4000-8000-00000002980b";
const ZONE = "00000000-0000-4000-8000-0000000298a0";
const SUP = "00000000-0000-4000-8000-0000000298b0";

const CODES_FOLDER = "20260925060000_warp_2980_security_pattern_codes";
const MAIN_FOLDER = "20260925060100_warp_2980_security_patterns_verdicts";
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

/** Thrown to roll a probe transaction back after a successful statement. */
class Rollback extends Error {}

type Outcome = "inserted" | { sqlstate: string; constraint: string | null };
const rejectedBy = (constraint: string): Outcome => ({ sqlstate: "23514", constraint });
const q = (v: string | null): string => (v === null ? "NULL" : `'${v.replace(/'/g, "''")}'`);

/** A row as SQL: `over` replaces columns (SQL literals); a value of `undefined` leaves the column out. */
function insert(table: string, base: Record<string, string>, over: Record<string, string | undefined> = {}): string {
  const cols = { ...base, ...over };
  const kept = Object.entries(cols).filter((e): e is [string, string] => e[1] !== undefined);
  return `INSERT INTO "${table}" (${kept.map(([c]) => `"${c}"`).join(",")}) VALUES (${kept.map(([, v]) => v).join(",")})`;
}

/** A legal plain-activity camera incident. */
const incident = (over: Record<string, string | undefined> = {}) =>
  insert(
    "SecurityIncident",
    {
      id: q(INC),
      scope: "'camera'",
      zoneLinkIds: "ARRAY[]::text[]",
      scopeCamera: q(CAM),
      openedInMode: "'closed'",
      rulesetVersion: "3",
      firstActivityAt: "now()",
      lastActivityAt: "now()",
      lastArrivalAt: "now()",
      eventCount: "1",
      countsByCamera: "'{}'::jsonb",
      spanByCamera: "'{}'::jsonb",
      cameras: `ARRAY[${q(CAM)}]::text[]`,
      reasonCodes: `ARRAY[]::"SecurityReasonCode"[]`,
      updatedAt: "now()",
    },
    over,
  );

/** A legal active camera suppression. */
const suppression = (over: Record<string, string | undefined> = {}) =>
  insert(
    "SecuritySuppression",
    {
      id: q(SUP),
      targetKind: "'camera'",
      camera: q(CAM),
      label: "'person'",
      days: "'weekdays'",
      hourFrom: "22",
      hourCount: "3",
      codes: `ARRAY['out_of_place']::"SecurityReasonCode"[]`,
      reason: "'The cleaner comes late'",
      createdById: "'u-owner'",
      createdByName: "'Maria'",
      createdAt: "'2026-09-25 10:00:00'",
      expiresAt: "'2026-10-25 10:00:00'",
    },
    over,
  );

/** A legal trial out_of_place flag on the incident, judged against the camera key. */
const flag = (over: Record<string, string | undefined> = {}) =>
  insert(
    "SecurityPatternFlag",
    {
      id: "gen_random_uuid()::text",
      incidentId: q(INC),
      code: "'out_of_place'",
      effect: "'trial'",
      severity: "'alert'",
      rulesetVersion: "3",
      zoneKey: q(`camera:${CAM}`),
      keyCameras: `ARRAY[${q(CAM)}]::text[]`,
      evidenceEventId: "1",
      evidenceCamera: q(CAM),
      evidenceLabel: "'person'",
      evidenceAt: "now()",
      evidenceSummary: "'Person seen'",
      detail: `'{"p":"0.0238"}'::jsonb`,
    },
    over,
  );

/** A legal active area (P2b's CHECKs: nameKey = lower(btrim(name))). */
const zone = () =>
  insert("SecurityZone", {
    id: q(ZONE),
    name: "'warp2980b Stock room'",
    nameKey: "'warp2980b stock room'",
    kind: "'restricted'",
    updatedAt: "now()",
  });

describe.skipIf(!RUN)("WARP-2980 P5 PR-B schema against real Postgres", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } = await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
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
    throw new Error("unreachable");
  }

  // ── 47: trial is a database fact (D3) ────────────────────────────────────

  describe("SecurityIncidentReason_code_severity still refuses every P5 code", () => {
    const reason = (code: string, severity: string) =>
      insert("SecurityIncidentReason", {
        id: "gen_random_uuid()::text",
        incidentId: q(INC),
        code: q(code),
        severity: q(severity),
        rulesetVersion: "3",
        evidenceEventId: "1",
        evidenceCamera: q(CAM),
        evidenceSource: "'frigate'",
        evidenceKind: "'detection'",
        evidenceLabel: "'person'",
        evidenceAt: "now()",
        evidenceSummary: "'x'",
        detail: "'{}'::jsonb",
      });

    it.each([
      ["out_of_place", "notice"],
      ["out_of_place", "alert"],
      ["unusual_volume", "notice"],
      ["unusual_volume", "alert"],
      ["long_dwell", "notice"],
      ["long_dwell", "alert"],
    ])("%s at %s → refused by the P3 CHECK (a flag never becomes a reason before PR-D)", async (code, severity) => {
      expect(await run(incident(), reason(code, severity))).toEqual(rejectedBy("SecurityIncidentReason_code_severity"));
    });

    it("the probe's reason row is otherwise legal (a P3 code on the same shape inserts)", async () => {
      expect(await run(incident(), reason("camera_offline", "notice"))).toBe("inserted");
    });
  });

  // ── 48: SecurityIncident_verdict_shape ───────────────────────────────────

  describe("SecurityIncident_verdict_shape", () => {
    const set = (cols: string) => `UPDATE "SecurityIncident" SET ${cols} WHERE id = ${q(INC)}`;
    const MARKED = `"verdict" = 'not_expected', "verdictAt" = now(), "verdictFirstAt" = now() - interval '1 day', "verdictById" = 'u-owner', "verdictByName" = 'Maria', "verdictCodes" = ARRAY['out_of_place']::"SecurityReasonCode"[]`;

    it("a new incident is unreviewed with no codes, and a full mark is legal", async () => {
      expect(await run(incident())).toBe("inserted");
      expect(await run(incident(), set(MARKED))).toBe("inserted");
    });

    it.each([
      ["verdictCodes {out_of_place,NULL}", `"verdictCodes" = ARRAY['out_of_place', NULL]::"SecurityReasonCode"[]`],
      ["verdictCodes NULL", `"verdictCodes" = NULL`],
      ["expected with no codes", `"verdictCodes" = ARRAY[]::"SecurityReasonCode"[]`],
      ["no verdictAt", `"verdictAt" = NULL`],
      ["no first mark", `"verdictFirstAt" = NULL`],
      ["the first mark after the latest", `"verdictFirstAt" = now() + interval '1 minute'`],
      ["no verdictById", `"verdictById" = NULL`],
      ["a NULL verdictByName beside a set verdictById", `"verdictByName" = NULL`],
    ])("a mark with %s → refused", async (_what, broken) => {
      expect(await run(incident(), set(MARKED), set(broken))).toEqual(rejectedBy("SecurityIncident_verdict_shape"));
    });

    it("unreviewed with a code → refused", async () => {
      expect(await run(incident(), set(`"verdictCodes" = ARRAY['camera_offline']::"SecurityReasonCode"[]`))).toEqual(
        rejectedBy("SecurityIncident_verdict_shape"),
      );
    });

    it("unreviewed with who and when set → refused", async () => {
      expect(await run(incident(), set(`"verdictAt" = now(), "verdictFirstAt" = now(), "verdictById" = 'u', "verdictByName" = 'M'`))).toEqual(
        rejectedBy("SecurityIncident_verdict_shape"),
      );
    });
  });

  // ── 49: SecurityPatternFlag_shape ────────────────────────────────────────

  describe("SecurityPatternFlag_shape", () => {
    it("the legal shapes insert: a person at alert, a quietened flag, a car at notice, busier-than-usual at info, an area key", async () => {
      expect(await run(incident(), flag())).toBe("inserted");
      expect(await run(incident(), suppression(), flag({ effect: "'suppressed'", suppressionId: q(SUP) }))).toBe("inserted");
      expect(await run(incident(), flag({ severity: "'notice'", evidenceLabel: "'car'" }))).toBe("inserted");
      expect(await run(incident(), flag({ code: "'unusual_volume'", severity: "'info'" }))).toBe("inserted");
      expect(
        await run(incident(), flag({ zoneKey: q(`area:${ZONE}`), keyCameras: `ARRAY[${q(CAM)}, 'warp2980b_back']::text[]` })),
      ).toBe("inserted");
    });

    it.each([
      ["suppressed without a suppression", { effect: "'suppressed'" }],
      ["unusual_volume at alert", { code: "'unusual_volume'", severity: "'alert'" }],
      ["out_of_place at info", { severity: "'info'" }],
      ["long_dwell at info", { code: "'long_dwell'", severity: "'info'" }],
      ["a P3 code", { code: "'after_hours_presence'" }],
      ["an alert for a cat", { evidenceLabel: "'cat'" }],
      ["long_dwell for a car, at notice", { code: "'long_dwell'", severity: "'notice'", evidenceLabel: "'car'" }],
      ["a bad zoneKey", { zoneKey: "'zone:front'" }],
      ["an area key that is not a uuid", { zoneKey: "'area:front'" }],
      ["keyCameras {}", { keyCameras: "ARRAY[]::text[]" }],
      ["keyCameras {NULL}", { keyCameras: "ARRAY[NULL]::text[]" }],
      ["a NULL beside the evidence camera on an area key", { zoneKey: q(`area:${ZONE}`), keyCameras: `ARRAY[${q(CAM)}, NULL]::text[]` }],
      ["keyCameras NULL", { keyCameras: "NULL" }],
      ["an evidence camera outside keyCameras", { keyCameras: "ARRAY['warp2980b_back']::text[]", zoneKey: q(`area:${ZONE}`) }],
      ["a camera key whose cameras are not exactly that camera", { keyCameras: `ARRAY[${q(CAM)}, 'warp2980b_back']::text[]` }],
      ["a bad evidence camera", { evidenceCamera: "'front door'" }],
      ["rulesetVersion 2", { rulesetVersion: "2" }],
      ["detail []", { detail: "'[]'::jsonb" }],
    ] as Array<[string, Record<string, string>]>)("%s → refused", async (_what, over) => {
      expect(await run(incident(), flag(over))).toEqual(rejectedBy("SecurityPatternFlag_shape"));
    });

    it("trial with a suppression id → refused", async () => {
      expect(await run(incident(), suppression(), flag({ suppressionId: q(SUP) }))).toEqual(rejectedBy("SecurityPatternFlag_shape"));
    });

    it("a second flag for the same (incident, code, event) → 23505", async () => {
      const out = await run(incident(), flag(), flag());
      expect(out).toEqual({ sqlstate: "23505", constraint: null });
    });
  });

  // ── 50: SecuritySuppression_shape ────────────────────────────────────────

  describe("SecuritySuppression_shape", () => {
    it("the legal shapes insert: a camera, an area, every code for a person, a whole day, a year", async () => {
      expect(await run(suppression())).toBe("inserted");
      expect(await run(zone(), suppression({ targetKind: "'area'", camera: undefined, zoneId: q(ZONE) }))).toBe("inserted");
      expect(await run(suppression({ codes: `ARRAY['out_of_place','unusual_volume','long_dwell']::"SecurityReasonCode"[]`, hourFrom: "0", hourCount: "24" }))).toBe(
        "inserted",
      );
      expect(await run(suppression({ expiresAt: "'2026-09-25 10:00:00'::timestamp + interval '365 days'" }))).toBe("inserted");
      expect(await run(suppression({ state: "'removed'", endedAt: "now()", endedById: "'u-owner'" }))).toBe("inserted");
      expect(await run(suppression({ state: "'expired'", endedAt: "now()" }))).toBe("inserted");
    });

    it("a duplicate code is ACCEPTED here (zod refuses it; harmless to matching)", async () => {
      expect(await run(suppression({ codes: `ARRAY['out_of_place','out_of_place']::"SecurityReasonCode"[]` }))).toBe("inserted");
    });

    it.each([
      ["codes {after_hours_presence}", { codes: `ARRAY['after_hours_presence']::"SecurityReasonCode"[]` }],
      ["codes {camera_offline, out_of_place}", { codes: `ARRAY['camera_offline','out_of_place']::"SecurityReasonCode"[]` }],
      ["codes {out_of_place,NULL}", { codes: `ARRAY['out_of_place', NULL]::"SecurityReasonCode"[]` }],
      ["codes {}", { codes: `ARRAY[]::"SecurityReasonCode"[]` }],
      ["codes NULL", { codes: "NULL" }],
      ["four codes", { codes: `ARRAY['out_of_place','unusual_volume','long_dwell','out_of_place']::"SecurityReasonCode"[]` }],
      ["long_dwell for a car", { label: "'car'", codes: `ARRAY['long_dwell']::"SecurityReasonCode"[]` }],
      ["expiring 366 days after", { expiresAt: "'2026-09-25 10:00:00'::timestamp + interval '366 days'" }],
      ["expiring when made", { expiresAt: "'2026-09-25 10:00:00'" }],
      ["removed without who", { state: "'removed'", endedAt: "now()" }],
      ["expired with who", { state: "'expired'", endedAt: "now()", endedById: "'u-owner'" }],
      ["active with endedAt", { endedAt: "now()" }],
      ["ended without endedAt", { state: "'expired'" }],
      ["a whitespace reason", { reason: "'   '" }],
      ["a whitespace name", { createdByName: "' '" }],
      ["an area target without an area", { targetKind: "'area'", camera: undefined }],
      ["a camera target with an area", { zoneId: q(ZONE) }],
      ["a bad camera", { camera: "'front door'" }],
      ["a bad label", { label: "'a person'" }],
      ["hourFrom 24", { hourFrom: "24" }],
      ["hourCount 0", { hourCount: "0" }],
      ["hourCount 25", { hourCount: "25" }],
      // A whole day starts at midnight: from 15:00 it would quiet the wrong days while the page says "All day".
      ["a whole day from 15:00", { hourFrom: "15", hourCount: "24" }],
    ] as Array<[string, Record<string, string | undefined>]>)("%s → refused", async (_what, over) => {
      expect(await run(zone(), suppression(over))).toEqual(rejectedBy("SecuritySuppression_shape"));
    });
  });

  describe("SecurityPatternDay_shape", () => {
    const day = (date: string, count: string) =>
      `INSERT INTO "SecurityPatternDay" ("date","outcome","count","updatedAt") VALUES (${q(date)}, 'judged', ${count}, now())`;
    it("a site date and a count insert; a malformed date or a negative count → refused", async () => {
      expect(await run(day("2026-09-25", "4"))).toBe("inserted");
      expect(await run(day("25/09/2026", "4"))).toEqual(rejectedBy("SecurityPatternDay_shape"));
      expect(await run(day("2026-09-25", "-1"))).toEqual(rejectedBy("SecurityPatternDay_shape"));
    });
  });

  // ── 51: the foreign keys ─────────────────────────────────────────────────

  describe("foreign keys", () => {
    const fkRefused = { sqlstate: "23503", constraint: null };
    it("an area with expected activity cannot be deleted (Restrict)", async () => {
      expect(
        await run(zone(), suppression({ targetKind: "'area'", camera: undefined, zoneId: q(ZONE) }), `DELETE FROM "SecurityZone" WHERE id = ${q(ZONE)}`),
      ).toEqual(fkRefused);
    });

    it("expected activity that quietened a flag cannot be deleted (Restrict)", async () => {
      expect(
        await run(incident(), suppression(), flag({ effect: "'suppressed'", suppressionId: q(SUP) }), `DELETE FROM "SecuritySuppression" WHERE id = ${q(SUP)}`),
      ).toEqual(fkRefused);
    });

    it("deleting an incident takes its flags with it, even a quietened one", async () => {
      const left = await prisma
        .$transaction(async (tx) => {
          for (const s of [incident(), suppression(), flag({ effect: "'suppressed'", suppressionId: q(SUP) })]) await tx.$executeRawUnsafe(s);
          await tx.$executeRawUnsafe(`DELETE FROM "SecurityIncident" WHERE id = ${q(INC)}`);
          const rows = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM "SecurityPatternFlag" WHERE "incidentId" = ${q(INC)}`);
          throw Object.assign(new Rollback("probe"), { n: Number(rows[0]!.n) });
        })
        .catch((e: Rollback & { n?: number }) => e.n);
      expect(left).toBe(0);
    });
  });

  // ── 52: re-runnable ──────────────────────────────────────────────────────

  it("applying both folders again changes nothing: 6 codes, the same CHECK and FK text", async () => {
    const snapshot = async (tx: Pick<PrismaClient, "$queryRawUnsafe">) => ({
      labels: (
        await tx.$queryRawUnsafe<Array<{ l: string }>>(
          `SELECT enumlabel AS l FROM pg_enum WHERE enumtypid = '"SecurityReasonCode"'::regtype ORDER BY enumsortorder`,
        )
      ).map((r) => r.l),
      constraints: await tx.$queryRawUnsafe<Array<{ name: string; def: string }>>(
        `SELECT c.conname AS name, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
          WHERE t.relname IN ('SecurityIncident','SecurityPatternFlag','SecuritySuppression','SecurityPatternDay') ORDER BY 1`,
      ),
      columns: await tx.$queryRawUnsafe<Array<{ c: string; d: string | null; n: string }>>(
        `SELECT column_name AS c, column_default AS d, is_nullable AS n FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'SecurityIncident' AND column_name LIKE 'verdict%' ORDER BY 1`,
      ),
    });
    const outcome = await prisma
      .$transaction(async (tx) => {
        const before = await snapshot(tx);
        for (const folder of [CODES_FOLDER, MAIN_FOLDER]) for (const stmt of statements(migration(folder))) await tx.$executeRawUnsafe(stmt);
        const after = await snapshot(tx);
        throw Object.assign(new Rollback("probe"), { before, after });
      })
      .catch((e: Rollback & { before?: unknown; after?: unknown }) => {
        if (!(e instanceof Rollback)) throw e;
        return e;
      });
    const { before, after } = outcome as unknown as { before: Awaited<ReturnType<typeof snapshot>>; after: Awaited<ReturnType<typeof snapshot>> };
    expect(before.labels).toEqual(["after_hours_presence", "camera_offline", "threat_signal", "out_of_place", "unusual_volume", "long_dwell"]);
    expect(after).toEqual(before);
    expect(before.constraints.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        "SecurityIncident_verdict_shape",
        "SecurityPatternFlag_shape",
        "SecuritySuppression_shape",
        "SecurityPatternDay_shape",
        "SecurityPatternFlag_incidentId_fkey",
        "SecurityPatternFlag_suppressionId_fkey",
        "SecuritySuppression_zoneId_fkey",
      ]),
    );
  });

  it("the main folder leaves the P3 reasons CHECK alone (it never names code_severity)", () => {
    expect(migration(MAIN_FOLDER).replace(/^\s*--.*$/gm, "")).not.toMatch(/SecurityIncidentReason_code_severity/);
    expect(migration(CODES_FOLDER).replace(/^\s*--.*$/gm, "").trim().split("\n")).toHaveLength(3);
  });
});

// ── 53–54: the engine and k on real rows ─────────────────────────────────────

/**
 * FIXTURE SCOPING — camera `warp2980p_front`, the area `warp2980p Front door`,
 * events `warp2980p:*` / `frigate-ongoing:warp2980p-*`, and dates in March
 * 2034 (the baseline-build pg file uses 2031 and 2033, coverage 2032). The
 * engine, hours and mode singletons are saved before and restored after; the
 * builds this file makes (window 2034-…) are deleted.
 */
describe.skipIf(!RUN)("WARP-2980 P5 PR-B: the pattern rules on real rows", () => {
  const TAG = "warp2980p";
  const PCAM = `${TAG}_front`;
  const TZ = "Europe/London";
  /** Wednesday 2034-03-15 03:12 in London (GMT): the window is 2034-02-15 … 2034-03-14 (20 weekdays). */
  const NOW = new Date("2034-03-15T03:12:00Z");
  const AT_0310 = new Date("2034-03-15T03:10:00Z");
  const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);
  let prisma: PrismaClient;
  let zoneId = "";
  let n = 0;
  let saved: { engine: unknown; hours: unknown; days: unknown[]; mode: unknown } = { engine: null, hours: null, days: [], mode: null };

  const person = (at: Date, over: Partial<Prisma.SecurityEventCreateManyInput> = {}): Prisma.SecurityEventCreateManyInput => ({
    source: "frigate",
    kind: "detection",
    severity: "info",
    camera: PCAM,
    sourceRef: `${PCAM}/${++n}.5-a`,
    dedupeKey: `${TAG}:ev-${n}`,
    labels: ["person"],
    cameraZones: [],
    score: 0.9,
    startedAt: at,
    endedAt: plus(at, 20_000),
    summary: "Person seen by front",
    ...over,
  });

  async function sweep(): Promise<void> {
    const incidents = await prisma.securityIncident.findMany({ where: { cameras: { has: PCAM } }, select: { id: true } });
    await prisma.securityEvent.deleteMany({ where: { OR: [{ dedupeKey: { startsWith: `${TAG}:` } }, { dedupeKey: { startsWith: `frigate-ongoing:${TAG}-` } }] } });
    await prisma.securityIncident.deleteMany({ where: { id: { in: incidents.map((i) => i.id) } } });
    const zones = await prisma.securityZone.findMany({ where: { name: { startsWith: `${TAG} ` } }, select: { id: true } });
    await prisma.securityZoneLink.deleteMany({ where: { zoneId: { in: zones.map((z) => z.id) } } });
    await prisma.securityZone.deleteMany({ where: { id: { in: zones.map((z) => z.id) } } });
    await prisma.securityCoverageSpan.deleteMany({ where: { camera: { startsWith: `${TAG}_` } } });
    await prisma.securityBaselineSource.deleteMany({ where: { camera: { startsWith: `${TAG}_` } } });
    await prisma.securityBaselineBuild.deleteMany({ where: { windowFrom: { startsWith: "2034-" } } });
    await prisma.securityPatternDay.deleteMany({ where: { date: { startsWith: "2034-" } } });
  }

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } = await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
    saved = {
      engine: await prisma.securityIncidentEngineState.findUnique({ where: { id: "singleton" } }),
      hours: await prisma.securitySiteHours.findUnique({ where: { id: "singleton" } }),
      days: await prisma.securitySchedule.findMany(),
      mode: await prisma.securityModeState.findUnique({ where: { id: "singleton" } }),
    };
    await sweep();
    // One ready build at a time: this file needs the database's to be its own.
    expect(await prisma.securityBaselineBuild.count({ where: { state: "ready" } })).toBe(0);

    // A closed site in London (Mon–Fri 09–17) and a stored closed mode.
    await prisma.securitySchedule.deleteMany({});
    await prisma.securitySiteHours.deleteMany({});
    await prisma.securityModeState.deleteMany({});
    await prisma.securitySiteHours.create({ data: { id: "singleton", state: "set", timezone: TZ, version: 1 } });
    await prisma.securitySchedule.createMany({
      data: [1, 2, 3, 4, 5, 6, 7].map((weekday) =>
        weekday <= 5 ? { weekday, kind: "hours" as const, opensMin: 540, closesMin: 1020 } : { weekday, kind: "closed" as const },
      ),
    });
    await prisma.securityModeState.create({ data: { id: "singleton", mode: "closed", modeSource: "schedule", setAt: plus(NOW, -86_400_000) } });

    // The Front door (entry), linked to the whole camera.
    const zone = await prisma.securityZone.create({ data: { name: `${TAG} Front door`, nameKey: `${TAG} front door`, kind: "entry" } });
    zoneId = zone.id;
    await prisma.securityZoneLink.create({ data: { zoneId, sourceKind: "camera", sourceRef: PCAM, sourceLabel: PCAM, state: "active" } });

    // 28 days of coverage, and a person at noon every day of the window.
    await prisma.securityCoverageSpan.create({
      data: {
        camera: PCAM,
        state: "closed",
        startedAt: new Date("2034-02-14T00:00:00Z"),
        coveredUntil: new Date("2034-03-15T03:00:00Z"),
        closedAt: new Date("2034-03-15T03:00:00Z"),
        processId: "0b9f3c3e-7d0a-4b5e-9d64-1f2a3b4c5d6e",
      },
    });
    const window = windowFor(NOW, TZ);
    expect(window).toEqual({ from: "2034-02-15", to: "2034-03-14" });
    const noons: Prisma.SecurityEventCreateManyInput[] = [];
    for (let d = new Date("2034-02-15T12:00:00Z"); d < new Date("2034-03-15T00:00:00Z"); d = plus(d, 86_400_000)) noons.push(person(d));
    await prisma.securityEvent.createMany({ data: noons });
  });

  afterAll(async () => {
    await sweep();
    await prisma.securityIncidentEngineState.deleteMany({});
    if (saved.engine) await prisma.securityIncidentEngineState.create({ data: saved.engine as Prisma.SecurityIncidentEngineStateCreateInput });
    await prisma.securitySchedule.deleteMany({});
    if (saved.days.length) await prisma.securitySchedule.createMany({ data: saved.days as Prisma.SecurityScheduleCreateManyInput[] });
    await prisma.securitySiteHours.deleteMany({});
    if (saved.hours) await prisma.securitySiteHours.create({ data: saved.hours as Prisma.SecuritySiteHoursCreateInput });
    await prisma.securityModeState.deleteMany({});
    if (saved.mode) await prisma.securityModeState.create({ data: saved.mode as Prisma.SecurityModeStateCreateInput });
    await prisma.$disconnect();
  });

  it("53 — a 03:10 person at the Front door: one trial flag whose numbers are route 31's, unmoved by a later rebuild", async () => {
    _resetIncidentHealthForTests();
    _resetPatternRulesForTests();
    const built = await runFullBuild(prisma, "first", TZ, NOW);
    expect(built.status).toBe("built");
    await refreshBaselineSources(prisma, TZ, NOW);
    expect(await prisma.securityBaselineSource.findUnique({ where: { sourceKey: `camera:${PCAM}` } })).toMatchObject({ state: "active" });

    // The engine starts at the store's head: only the 03:10 row is triaged.
    const { _max } = await prisma.securityEvent.aggregate({ _max: { id: true } });
    const head = _max.id ?? 0n;
    await prisma.securityIncidentEngineState.deleteMany({});
    await prisma.securityIncidentEngineState.create({
      data: { id: "singleton", startedAtId: head, triageFloor: head, floorCandidate: head, floorCandidateAt: plus(NOW, -600_000) },
    });
    await prisma.securityEvent.createMany({ data: [person(AT_0310)] });
    await tickSecurityIncidents(prisma, { isSecurityModuleOn: async () => false, resolveAccess: async () => null, now: () => NOW });

    const incident = await prisma.securityIncident.findFirstOrThrow({ where: { cameras: { has: PCAM } } });
    expect(incident).toMatchObject({ scope: "area", zoneId, severity: "info", state: "no_action", reasonCodes: [] });
    const flags = await prisma.securityPatternFlag.findMany({ where: { incidentId: incident.id } });
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ code: "out_of_place", effect: "trial", severity: "alert", zoneKey: `area:${zoneId}`, keyCameras: [PCAM], rulesetVersion: 3 });
    const detail = flags[0]!.detail as Record<string, unknown>;

    const explained = await explainSecurityPattern(prisma, { visibleCameras: "all", mayReadThreats: true, mayReadLocks: true }, { zoneId, label: "person", at: AT_0310 }, NOW);
    expect(explained.status).toBe("ok");
    const cell = (explained as Extract<typeof explained, { status: "ok" }>).view.cell!;
    expect(detail).toMatchObject({
      dayType: "weekday",
      hour: 3,
      daysObserved: cell.daysObserved,
      daysWithEvent: 0,
      smoothedDaysObserved: String(cell.smoothed.daysObserved),
      smoothedDaysWithEvent: String(cell.smoothed.daysWithEvent),
      p: cell.rarity.p.toPrecision(3),
      windowFrom: "2034-02-15",
      windowTo: "2034-03-14",
    });
    expect(cell.daysObserved).toBe(20);
    expect(cell.rarity.wouldFlag).toBe(true);
    expect(await prisma.securityPatternDay.findMany({ where: { date: "2034-03-15" }, select: { outcome: true, count: true } })).toEqual([
      { outcome: "judged", count: 1 },
    ]);

    // New events at 03:05 on five window days, and a rebuild: the stored flag does not move (D20).
    await prisma.securityEvent.createMany({
      data: ["2034-03-06", "2034-03-07", "2034-03-08", "2034-03-09", "2034-03-10"].map((d) => person(new Date(`${d}T03:05:00Z`))),
    });
    expect((await runFullBuild(prisma, "nightly", TZ, plus(NOW, 60_000))).status).toBe("built");
    const after = await prisma.securityPatternFlag.findUniqueOrThrow({ where: { id: flags[0]!.id } });
    expect(JSON.stringify(after.detail)).toBe(JSON.stringify(flags[0]!.detail));
    const reexplained = await explainSecurityPattern(prisma, { visibleCameras: "all", mayReadThreats: true, mayReadLocks: true }, { zoneId, label: "person", at: AT_0310 }, NOW);
    expect((reexplained as Extract<typeof reexplained, { status: "ok" }>).view.cell!.daysWithEvent).toBe(5);
  });

  it("54 — k counts `detection` rows only, and the query uses the (camera, startedAt) index at 10k rows", async () => {
    const slot = slotOf(AT_0310, TZ);
    const inSlot = (min: number) => new Date(`2034-03-15T03:${String(min).padStart(2, "0")}:30Z`);
    // Noise: 10k detections across other cameras and hours, so the planner has something to skip.
    const noise: Prisma.SecurityEventCreateManyInput[] = [];
    for (let i = 0; i < 10_000; i += 1) {
      noise.push(person(new Date(Date.UTC(2034, 1, 15 + (i % 28), i % 24, i % 60)), { camera: `${TAG}_n${i % 10}`, sourceRef: `${TAG}_n/${i}` }));
    }
    for (let i = 0; i < noise.length; i += 2_000) await prisma.securityEvent.createMany({ data: noise.slice(i, i + 2_000) });
    await prisma.securityEvent.createMany({
      data: [
        person(inSlot(1)),
        person(inSlot(2)),
        person(inSlot(3)),
        person(inSlot(4), { kind: "detection_ongoing", endedAt: null, dedupeKey: `frigate-ongoing:${TAG}-1` }),
      ],
    });
    const { _max } = await prisma.securityEvent.aggregate({ _max: { id: true } });
    await prisma.$executeRawUnsafe(`ANALYZE "SecurityEvent"`);

    const { PrismaClient: RealPrismaClient } = await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    const logging = new RealPrismaClient({ log: [{ emit: "event", level: "query" }] });
    const seen: Array<{ query: string; params: string }> = [];
    logging.$on("query", (e) => seen.push({ query: e.query, params: e.params }));
    try {
      // The 03:10 row from case 53 is in this slot too (id below the head): 3 + 1.
      const k = await countSlotDetections(logging, { keyCameras: [PCAM], zoneId: null, label: "person", slot, eventId: _max.id!, links: [] });
      expect(k).toBe(4);
      const q = seen.find((x) => /FROM "public"\."SecurityEvent"/.test(x.query));
      expect(q, "the k query was not captured").toBeDefined();
      // Bound as UNTYPED literals, so Postgres infers each type from its column (as it does for Prisma's own bind).
      const params = JSON.parse(q!.params) as unknown[];
      const literal = (v: unknown): string =>
        typeof v === "number" ? String(v) : Array.isArray(v) ? `'{${v.map((x) => `"${String(x)}"`).join(",")}}'` : `'${String(v).replace(/'/g, "''")}'`;
      const sql = q!.query.replace(/\$(\d+)/g, (_m, i: string) => literal(params[Number(i) - 1]));
      const plan = (await prisma.$queryRawUnsafe<Array<{ "QUERY PLAN": string }>>(`EXPLAIN ${sql}`)).map((r) => r["QUERY PLAN"]).join("\n");
      expect(plan, plan).toMatch(/SecurityEvent_camera_startedAt_idx/);
      expect(plan, plan).not.toMatch(/Seq Scan on "SecurityEvent"/);
    } finally {
      await logging.$disconnect();
    }
  });

  it("55 — retention step 1 keeps plain activity a person marked, and deletes its unmarked twin with its flags", async () => {
    const at = new Date("2034-01-10T03:00:00Z");
    const make = (verdict: boolean) =>
      prisma.securityIncident.create({
        data: {
          scope: "camera",
          scopeCamera: PCAM,
          openedInMode: "closed",
          grouping: "closed",
          closedAt: at,
          rulesetVersion: 3,
          firstActivityAt: at,
          lastActivityAt: at,
          lastArrivalAt: at,
          eventCount: 1,
          countsByCamera: {},
          spanByCamera: {},
          cameras: [PCAM],
          reasonCodes: [],
          zoneLinkIds: [],
          ...(verdict
            ? { verdict: "not_expected" as const, verdictById: "u-owner", verdictByName: "Stefan", verdictAt: at, verdictFirstAt: at, verdictCodes: ["out_of_place" as const] }
            : {}),
        },
        select: { id: true },
      });
    const marked = await make(true);
    const twin = await make(false);
    for (const [i, incidentId] of [marked.id, twin.id].entries()) {
      await prisma.securityPatternFlag.create({
        data: {
          incidentId,
          code: "out_of_place",
          effect: "trial",
          severity: "alert",
          rulesetVersion: 3,
          zoneKey: `camera:${PCAM}`,
          keyCameras: [PCAM],
          evidenceEventId: BigInt(900_000 + i),
          evidenceCamera: PCAM,
          evidenceLabel: "person",
          evidenceAt: at,
          evidenceSummary: "x",
          detail: {},
        },
      });
    }
    await trimSecurityIncidents(prisma, new Date("2034-02-10T03:50:00Z"), new Date("2034-02-10T03:50:00Z"));
    const left = await prisma.securityIncident.findMany({ where: { id: { in: [marked.id, twin.id] } }, select: { id: true } });
    expect(left.map((r) => r.id)).toEqual([marked.id]);
    expect((await prisma.securityPatternFlag.findMany({ where: { incidentId: { in: [marked.id, twin.id] } }, select: { incidentId: true } })).map((r) => r.incidentId)).toEqual([
      marked.id,
    ]);
  });
});
