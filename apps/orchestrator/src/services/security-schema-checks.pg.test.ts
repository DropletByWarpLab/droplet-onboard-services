/**
 * WARP-2977 P2b — every hand-written CHECK in migration
 * 20260924000100_warp_2977_security_zones_hours_mode, on a real Postgres.
 *
 * Why this file exists: the CHECKs are invisible to `prisma migrate diff`, so
 * check-schema-drift cannot see one being dropped or loosened, and a mocked
 * test cannot see them at all. Each case asserts the SQLSTATE (23514) AND the
 * constraint that fired, so a row refused by the WRONG rule (or by a NOT NULL
 * or a type error) does not count as a pass.
 *
 * NULL discipline: a CHECK that evaluates to NULL PASSES. The migration
 * wraps the rules that read nullable inputs in COALESCE(…, false) (and spells
 * `IS NOT NULL` on the minutes), so the NULL cases below — a mode_changed row
 * with NULL labels or a NULL element, an `hours` day with a NULL minute — are
 * the ones a "simplification" of the SQL would silently let through.
 *
 * Every case runs inside a transaction that ALWAYS rolls back, so the file
 * leaves no row behind and never touches a real singleton; fixtures are still
 * tagged `warp2977b-` and swept (scoped) before and after, belt and braces.
 *
 * Mutation-tested against scratch copies of the migration on fresh databases
 * (each CHECK arm and each COALESCE dropped in turn): see the WARP-2977 PR.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

// The global unit setup mocks @prisma/client; this file needs the real one.
vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

const TAG = "warp2977b-";

/** Thrown to roll a probe transaction back after a successful insert. */
class Rollback extends Error {}

type Outcome = "inserted" | { sqlstate: string; constraint: string | null };

const rejectedBy = (constraint: string): Outcome => ({ sqlstate: "23514", constraint });

/** SQL string literal. */
const q = (v: string | null): string => (v === null ? "NULL" : `'${v.replace(/'/g, "''")}'`);
const num = (v: number | null): string => (v === null ? "NULL" : String(v));

describe.skipIf(!RUN)("P2b schema CHECKs live in the database (WARP-2977)", () => {
  let prisma: PrismaClient;

  async function sweep(): Promise<void> {
    await prisma.securityZoneLink.deleteMany({ where: { zone: { name: { startsWith: TAG } } } });
    await prisma.securityZone.deleteMany({ where: { name: { startsWith: TAG } } });
    await prisma.securityEvent.deleteMany({ where: { dedupeKey: { startsWith: TAG } } });
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
        const msg = err.meta.message ?? "";
        // A CHECK names itself; for a unique violation Prisma passes only the
        // DETAIL (`Key ("nameKey")=(…) already exists.`), so report the column.
        const m = /violates check constraint "([^"]+)"/.exec(msg) ?? /^Key \("([^"]+)"\)/.exec(msg);
        return { sqlstate: err.meta.code, constraint: m?.[1] ?? null };
      }
      throw e;
    }
    throw new Error("unreachable: the probe transaction always rolls back");
  }

  // ── SecurityEvent_site_mode_shape ─────────────────────────────────────────

  let ev = 0;
  const event = (source: string, kind: string, camera: string | null, labels: string): string =>
    `INSERT INTO "SecurityEvent" ("source","kind","severity","camera","sourceRef","dedupeKey","labels","cameraZones","startedAt","summary")
     VALUES ('${source}','${kind}','info',${q(camera)},'${TAG}ref','${TAG}ev-${++ev}',${labels},ARRAY[]::text[],now(),'${TAG}summary')`;

  describe("SecurityEvent_site_mode_shape", () => {
    it("accepts every legal mode_changed row, and leaves the P2a row shapes alone", async () => {
      for (const mode of ["open", "closed", "away"]) {
        for (const source of ["schedule", "manual"]) {
          for (const from of ["open", "closed", "away"].filter((m) => m !== mode)) {
            expect(await run(event("site_mode", "mode_changed", null, `ARRAY['${mode}','${source}','${from}']::text[]`)), `${mode}/${source}/${from}`).toBe(
              "inserted",
            );
          }
        }
      }
      expect(await run(event("frigate", "detection", `${TAG}cam`, "ARRAY['person']::text[]"))).toBe("inserted");
      // P2a rows carry NULL labels; the new CHECK must not trip on them.
      expect(await run(event("frigate_status", "source_offline", null, "NULL"))).toBe("inserted");
      expect(await run(event("activity_mirror", "threat", null, "NULL"))).toBe("inserted");
    });

    it.each([
      ["a site_mode row that is not mode_changed", "site_mode", "detection", null, "ARRAY['closed','manual','open']::text[]"],
      ["a mode_changed row from another source", "frigate", "mode_changed", null, "ARRAY['closed','manual','open']::text[]"],
      ["a mode_changed row with a camera", "site_mode", "mode_changed", `${TAG}cam`, "ARRAY['closed','manual','open']::text[]"],
      ["a mode_changed row with 1 label", "site_mode", "mode_changed", null, "ARRAY['closed']::text[]"],
      ["a mode_changed row with 2 labels (no FROM mode)", "site_mode", "mode_changed", null, "ARRAY['closed','manual']::text[]"],
      ["a mode_changed row with 4 labels", "site_mode", "mode_changed", null, "ARRAY['closed','manual','open','x']::text[]"],
      ["a mode_changed row with no labels", "site_mode", "mode_changed", null, "ARRAY[]::text[]"],
      ["an unknown mode label", "site_mode", "mode_changed", null, "ARRAY['armed','manual','open']::text[]"],
      ["an unknown source label", "site_mode", "mode_changed", null, "ARRAY['closed','auto','open']::text[]"],
      ["an unknown FROM mode", "site_mode", "mode_changed", null, "ARRAY['closed','manual','armed']::text[]"],
      ["a FROM mode equal to the mode (no change)", "site_mode", "mode_changed", null, "ARRAY['closed','manual','closed']::text[]"],
      ["the labels swapped", "site_mode", "mode_changed", null, "ARRAY['manual','closed','open']::text[]"],
      ["NULL labels", "site_mode", "mode_changed", null, "NULL"],
      ["a NULL mode label", "site_mode", "mode_changed", null, "ARRAY[NULL,'manual','open']::text[]"],
      ["a NULL source label", "site_mode", "mode_changed", null, "ARRAY['closed',NULL,'open']::text[]"],
      ["a NULL FROM mode", "site_mode", "mode_changed", null, "ARRAY['closed','manual',NULL]::text[]"],
    ])("refuses %s", async (_name, source, kind, camera, labels) => {
      expect(await run(event(source, kind, camera, labels))).toEqual(rejectedBy("SecurityEvent_site_mode_shape"));
    });
  });

  // ── SecurityZone_name_key (+ the nameKey unique index) ────────────────────

  let zn = 0;
  const zone = (name: string, nameKeySql: string, id = `${TAG}zone-${++zn}`): string =>
    `INSERT INTO "SecurityZone" ("id","name","nameKey","kind","updatedAt") VALUES (${q(id)},${q(name)},${nameKeySql},'entry',now())`;
  const pgKey = (name: string): string => `lower(btrim(${q(name)}))`;

  describe("SecurityZone_name_key", () => {
    it("accepts a nameKey that is exactly lower(btrim(name)), computed by Postgres", async () => {
      expect(await run(zone(`${TAG}Front Door`, pgKey(`${TAG}Front Door`)))).toBe("inserted");
      expect(await run(zone(`${TAG}Front Door`, q(`${TAG}front door`)))).toBe("inserted");
      expect(await run(zone(`  ${TAG}Lobby `, q(`${TAG}lobby`)))).toBe("inserted");
    });

    it.each([
      ["a key that is not lowercased", `${TAG}Front Door`, `${TAG}Front Door`],
      ["a key that is not trimmed", `  ${TAG}Lobby `, `  ${TAG}lobby `],
      ["a key for a different name", `${TAG}Dock`, `${TAG}yard`],
      ["a blank name", "   ", "''"],
      ["an empty name", "", "''"],
    ])("refuses %s", async (_name, name, key) => {
      const keySql = key === "''" ? "''" : q(key);
      expect(await run(zone(name, keySql))).toEqual(rejectedBy("SecurityZone_name_key"));
    });

    it("refuses a key computed with JS toLowerCase() where Postgres lower() disagrees (İ, final Σ)", async () => {
      for (const name of [`${TAG}İstanbul`, `${TAG}ΟΔΟΣ`]) {
        const jsKey = name.trim().toLowerCase();
        const pg = await prisma.$queryRawUnsafe<Array<{ k: string }>>(`SELECT lower(btrim(${q(name)})) AS k`);
        // Not vacuous: on this database the two really differ for this name.
        expect(pg[0]!.k, name).not.toBe(jsKey);
        expect(await run(zone(name, q(jsKey))), name).toEqual(rejectedBy("SecurityZone_name_key"));
        expect(await run(zone(name, pgKey(name))), name).toBe("inserted");
      }
    });

    it("nameKey is unique across case variants (23505 on the unique index, not an app pre-check)", async () => {
      expect(
        await run(zone(`${TAG}Dock`, pgKey(`${TAG}Dock`)), zone(`${TAG}DOCK `, pgKey(`${TAG}DOCK `))),
      ).toEqual({ sqlstate: "23505", constraint: "nameKey" });
    });
  });

  // ── SecurityZoneLink_ref ──────────────────────────────────────────────────

  const link = (kind: string, ref: string): string[] => [
    zone(`${TAG}links`, q(`${TAG}links`), `${TAG}zone-links`),
    `INSERT INTO "SecurityZoneLink" ("id","zoneId","sourceKind","sourceRef","sourceLabel","state")
     VALUES ('${TAG}link','${TAG}zone-links','${kind}',${q(ref)},'Front door','active')`,
  ];

  describe("SecurityZoneLink_ref", () => {
    it("accepts Frigate names: a camera, and camera/zone", async () => {
      expect(await run(...link("camera", "front_door"))).toBe("inserted");
      expect(await run(...link("camera", "Cam-2_b"))).toBe("inserted");
      expect(await run(...link("camera", "a".repeat(64)))).toBe("inserted");
      expect(await run(...link("camera_zone", "front_door/till-1"))).toBe("inserted");
    });

    it.each([
      ["camera", "front door", "a space"],
      ["camera", "", "an empty ref"],
      ["camera", "a".repeat(65), "65 characters"],
      ["camera", "kamera€", "a non-ASCII character"],
      ["camera", "front_door/till", "a camera/zone ref on a camera link"],
      ["camera_zone", "front_door", "a camera ref on a camera_zone link"],
      ["camera_zone", "front_door/", "an empty zone"],
      ["camera_zone", "/till", "an empty camera"],
      ["camera_zone", "a/b/c", "two slashes"],
    ])("refuses a %s link with %j (%s)", async (kind, ref) => {
      expect(await run(...link(kind, ref))).toEqual(rejectedBy("SecurityZoneLink_ref"));
    });
  });

  // ── SecuritySiteHours_shape and the two default singletons ───────────────

  const hours = (id: string, state: string, tz: string | null): string[] => [
    `DELETE FROM "SecuritySiteHours"`,
    `INSERT INTO "SecuritySiteHours" ("id","state","timezone","updatedAt") VALUES (${q(id)},'${state}',${q(tz)},now())`,
  ];

  describe("SecuritySiteHours_shape", () => {
    it("accepts not_set without a zone and set with one", async () => {
      expect(await run(...hours("singleton", "not_set", null))).toBe("inserted");
      expect(await run(...hours("singleton", "set", "Europe/London"))).toBe("inserted");
    });

    it.each([
      ["set without a timezone", "singleton", "set", null],
      ["not_set with a timezone", "singleton", "not_set", "Europe/London"],
      ["a second row", `${TAG}hours`, "not_set", null],
    ])("refuses %s", async (_name, id, state, tz) => {
      expect(await run(...hours(id, state, tz))).toEqual(rejectedBy("SecuritySiteHours_shape"));
    });
  });

  describe("the default singletons", () => {
    it("both insert from their column defaults alone (raw)", async () => {
      expect(await run(`DELETE FROM "SecuritySiteHours"`, `INSERT INTO "SecuritySiteHours" ("updatedAt") VALUES (now())`)).toBe(
        "inserted",
      );
      expect(await run(`DELETE FROM "SecurityModeState"`, `INSERT INTO "SecurityModeState" ("updatedAt") VALUES (now())`)).toBe(
        "inserted",
      );
    });

    it("both insert through the service's lazy create (ON CONFLICT DO NOTHING), with the defaults the CHECKs expect", async () => {
      await expect(
        prisma.$transaction(async (tx) => {
          // Rolled back below: never touches a real singleton.
          await tx.$executeRawUnsafe(`DELETE FROM "SecuritySiteHours"`);
          await tx.$executeRawUnsafe(`DELETE FROM "SecurityModeState"`);
          await tx.securitySiteHours.createMany({ data: [{ id: "singleton" }], skipDuplicates: true });
          await tx.securityModeState.createMany({ data: [{ id: "singleton" }], skipDuplicates: true });
          const h = await tx.securitySiteHours.findUniqueOrThrow({ where: { id: "singleton" } });
          const m = await tx.securityModeState.findUniqueOrThrow({ where: { id: "singleton" } });
          expect(h).toMatchObject({ id: "singleton", state: "not_set", timezone: null, version: 0 });
          expect(m).toMatchObject({ id: "singleton", mode: "open", modeSource: "schedule", manualEnd: "none", manualUntil: null, version: 0 });
          throw new Rollback("probe");
        }),
      ).rejects.toBeInstanceOf(Rollback);
    });
  });

  // ── SecuritySchedule_weekday ──────────────────────────────────────────────

  describe("SecuritySchedule_weekday", () => {
    const day = (weekday: number): string[] => [
      `DELETE FROM "SecuritySchedule" WHERE "weekday" = ${weekday}`,
      `INSERT INTO "SecuritySchedule" ("weekday","kind","updatedAt") VALUES (${weekday},'closed',now())`,
    ];
    it("accepts ISO weekdays 1..7", async () => {
      expect(await run(...day(1))).toBe("inserted");
      expect(await run(...day(7))).toBe("inserted");
    });
    it.each([[0], [8], [-1]])("refuses weekday %i", async (weekday) => {
      expect(await run(...day(weekday))).toEqual(rejectedBy("SecuritySchedule_weekday"));
    });
  });

  // ── SecuritySchedule_shape / SecurityScheduleException_shape ─────────────

  const EX_DATE = "2099-01-02";
  const dayRow = {
    SecuritySchedule: (kind: string, opens: number | null, closes: number | null): string[] => [
      `DELETE FROM "SecuritySchedule" WHERE "weekday" = 3`,
      `INSERT INTO "SecuritySchedule" ("weekday","kind","opensMin","closesMin","updatedAt") VALUES (3,'${kind}',${num(opens)},${num(closes)},now())`,
    ],
    SecurityScheduleException: (kind: string, opens: number | null, closes: number | null): string[] => [
      `DELETE FROM "SecurityScheduleException" WHERE "date" = '${EX_DATE}'`,
      `INSERT INTO "SecurityScheduleException" ("date","kind","opensMin","closesMin","updatedAt") VALUES ('${EX_DATE}','${kind}',${num(opens)},${num(closes)},now())`,
    ],
  } as const;

  describe.each([["SecuritySchedule"], ["SecurityScheduleException"]] as const)("%s_shape", (table) => {
    const constraint = `${table}_shape`;

    it("accepts hours in range (incl. past midnight), and minute-less closed / open_all_day", async () => {
      expect(await run(...dayRow[table]("hours", 540, 1020))).toBe("inserted");
      expect(await run(...dayRow[table]("hours", 1080, 120))).toBe("inserted");
      expect(await run(...dayRow[table]("hours", 0, 1439))).toBe("inserted");
      expect(await run(...dayRow[table]("closed", null, null))).toBe("inserted");
      expect(await run(...dayRow[table]("open_all_day", null, null))).toBe("inserted");
    });

    it.each([
      ["hours with a NULL opening", "hours", null, 1020],
      ["hours with a NULL closing", "hours", 540, null],
      ["hours with no minutes at all", "hours", null, null],
      ["hours with equal minutes", "hours", 540, 540],
      ["hours opening at 1440", "hours", 1440, 60],
      ["hours opening before midnight", "hours", -1, 60],
      ["hours closing at 1440", "hours", 540, 1440],
      ["hours closing below 0", "hours", 540, -1],
      ["closed with both minutes", "closed", 540, 1020],
      ["closed with an opening only", "closed", 540, null],
      ["open_all_day with a closing only", "open_all_day", null, 1020],
      // Folded in from security-mode.pg.test.ts (Z1: one canonical place per CHECK).
      ["open_all_day with both minutes", "open_all_day", 0, 600],
    ])("refuses %s", async (_name, kind, opens, closes) => {
      expect(await run(...dayRow[table](kind, opens, closes))).toEqual(rejectedBy(constraint));
    });
  });

  // ── SecurityScheduleException_date ────────────────────────────────────────

  describe("SecurityScheduleException_date", () => {
    const exception = (date: string): string[] => [
      `DELETE FROM "SecurityScheduleException" WHERE "date" = ${q(date)}`,
      `INSERT INTO "SecurityScheduleException" ("date","kind","updatedAt") VALUES (${q(date)},'closed',now())`,
    ];
    it("accepts a YYYY-MM-DD string", async () => {
      expect(await run(...exception(EX_DATE))).toBe("inserted");
    });
    // "2099-1-02" / "2026-9-1": a one-digit month (and day) and nothing else
    // wrong — folded in from security-mode.pg.test.ts.
    it.each([["2099/01/02"], ["2099-1-02x"], ["02-01-2099"], ["abcd-ef-gh"], ["2099-01-2"], ["2099-1-02"], ["2026-9-1"]])("refuses %j", async (date) => {
      expect(await run(...exception(date))).toEqual(rejectedBy("SecurityScheduleException_date"));
    });
  });

  // ── SecurityModeState_shape: the whole combination space ─────────────────

  describe("SecurityModeState_shape", () => {
    const LEGAL = new Set([
      "schedule/none/open/-",
      "schedule/none/closed/-",
      "manual/next_opening/closed/until",
      "manual/until_changed/closed/-",
      "manual/until_changed/away/-",
      "manual/at_time/open/until",
    ]);
    const modeRow = (id: string, mode: string, source: string, end: string, until: boolean): string[] => [
      `DELETE FROM "SecurityModeState"`,
      `INSERT INTO "SecurityModeState" ("id","mode","modeSource","manualEnd","manualUntil","updatedAt")
       VALUES (${q(id)},'${mode}','${source}','${end}',${until ? "now() + interval '1 hour'" : "NULL"},now())`,
    ];

    it("exactly the 6 legal (source, end, mode, until) combinations of all 48 insert; every other one is refused by the shape rule", async () => {
      const got: Record<string, string> = {};
      const want: Record<string, string> = {};
      for (const source of ["schedule", "manual"]) {
        for (const end of ["none", "next_opening", "at_time", "until_changed"]) {
          for (const mode of ["open", "closed", "away"]) {
            for (const until of [false, true]) {
              const key = `${source}/${end}/${mode}/${until ? "until" : "-"}`;
              const outcome = await run(...modeRow("singleton", mode, source, end, until));
              got[key] = outcome === "inserted" ? "inserted" : `${outcome.sqlstate}:${outcome.constraint}`;
              want[key] = LEGAL.has(key) ? "inserted" : "23514:SecurityModeState_shape";
            }
          }
        }
      }
      expect(Object.keys(got)).toHaveLength(48);
      expect(got).toEqual(want);
    });

    it("refuses a second row even when its shape is legal", async () => {
      expect(await run(...modeRow(`${TAG}mode`, "open", "schedule", "none", false))).toEqual(
        rejectedBy("SecurityModeState_shape"),
      );
    });
  });
});
