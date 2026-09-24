/**
 * WARP-2978 (ADR-059 P3) — the incident engine against REAL Postgres.
 *
 * WHY THESE CASES RUN HERE AND NOT IN THE MOCKED LANE
 *
 *   the CHECKs    — every hand-written CHECK in 20260925020000_warp_2978_…
 *                   refuses its bad row, with SQLSTATE 23514 AND the
 *                   constraint's own name (a row refused by the WRONG rule does
 *                   not count). They are invisible to `prisma migrate diff`.
 *   append-only   — the BEFORE UPDATE trigger refuses an UPDATE of a
 *                   SecurityEvent; DELETE (retention) still works (D11).
 *   the floor     — a SecurityEvent inserted by a transaction that is still
 *                   OPEN when a later row is triaged is found after it commits,
 *                   never skipped (§6.1 step 3) — the gap only real MVCC makes.
 *   overlap       — two ticks at once: one triage row and one membership per
 *                   event, never two incidents for one event.
 *   the matcher   — `matchAreasForEvent` (memory, the engine's) picks exactly
 *                   the rows `zoneEventWhere` (SQL, the feed's) selects, for
 *                   200 generated events × random link sets.
 *   retention     — `eventsKept` follows the real cascade from the event trim;
 *                   plain activity goes at 30 d, coded incidents stay; the
 *                   `members: {none}` guard means the Restrict FK never fails.
 *
 * Gated on RUN_PG_INTEGRATION=1 + DATABASE_URL, like every *.pg.test.ts.
 * FIXTURE SCOPING — every camera, area, event and incident this file mints is
 * tagged `warp2978` and every cleanup is scoped to that tag. The engine's
 * singleton row is saved before the file and restored after it; each engine
 * case starts the floor at the store's current max id, so rows other files
 * left behind are never triaged here.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient, Prisma } from "@prisma/client";

vi.unmock("@prisma/client");

import { tickSecurityIncidents, trimSecurityIncidents, _resetIncidentHealthForTests, type SecurityIncidentDeps } from "./security-incidents.service.js";
import { loadActiveLinks, matchAreasForEvent, zoneEventWhere } from "./security-zones.service.js";

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

const TAG = "warp2978";
const CAM = `${TAG}_back`;
/** 22:14 in London on a Wednesday: closed by the hours below. Derived, never "now". */
const T0 = new Date("2026-09-23T21:14:00Z");
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);

/** Thrown to roll a probe transaction back after a successful insert. */
class Rollback extends Error {}
type Outcome = "inserted" | { sqlstate: string; constraint: string | null };
const rejectedBy = (constraint: string): Outcome => ({ sqlstate: "23514", constraint });
const q = (v: string | null): string => (v === null ? "NULL" : `'${v.replace(/'/g, "''")}'`);

/** Deterministic PRNG (mulberry32) — a failure reproduces from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe.skipIf(!RUN)("Security incidents against real Postgres (WARP-2978)", () => {
  let prisma: PrismaClient;
  let savedEngine: Prisma.SecurityIncidentEngineStateGetPayload<Record<string, never>> | null = null;
  let savedMode: unknown = null;
  let savedHours: unknown = null;
  let savedDays: unknown[] = [];

  async function sweep(): Promise<void> {
    const incidents = await prisma.securityIncident.findMany({
      where: { OR: [{ zoneName: { startsWith: TAG } }, { scopeCamera: { startsWith: TAG } }, { cameras: { has: CAM } }] },
      select: { id: true },
    });
    const ids = incidents.map((i) => i.id);
    await prisma.securityEvent.deleteMany({ where: { dedupeKey: { startsWith: `${TAG}:` } } });
    await prisma.securityEventTriage.deleteMany({ where: { incidentId: { in: ids } } });
    await prisma.securityIncident.deleteMany({ where: { id: { in: ids } } });
    const zones = await prisma.securityZone.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
    await prisma.securityZoneLink.deleteMany({ where: { zoneId: { in: zones.map((z) => z.id) } } });
    await prisma.securityZone.deleteMany({ where: { id: { in: zones.map((z) => z.id) } } });
  }

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } = await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
    savedEngine = await prisma.securityIncidentEngineState.findUnique({ where: { id: "singleton" } });
    savedMode = await prisma.securityModeState.findUnique({ where: { id: "singleton" } });
    savedHours = await prisma.securitySiteHours.findUnique({ where: { id: "singleton" } });
    savedDays = await prisma.securitySchedule.findMany();
    await sweep();
  });

  afterAll(async () => {
    await sweep();
    await prisma.securityIncidentEngineState.deleteMany({});
    if (savedEngine) await prisma.securityIncidentEngineState.create({ data: savedEngine });
    await prisma.securitySchedule.deleteMany({});
    if (savedDays.length) await prisma.securitySchedule.createMany({ data: savedDays as Prisma.SecurityScheduleCreateManyInput[] });
    await prisma.securitySiteHours.deleteMany({});
    if (savedHours) await prisma.securitySiteHours.create({ data: savedHours as Prisma.SecuritySiteHoursCreateInput });
    await prisma.securityModeState.deleteMany({});
    if (savedMode) await prisma.securityModeState.create({ data: savedMode as Prisma.SecurityModeStateCreateInput });
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

  // ── the CHECKs ────────────────────────────────────────────────────────────

  describe("the WARP-2978 CHECKs refuse their bad rows", () => {
    const INC = "00000000-0000-4000-8000-0000000029a1";
    /** A legal plain-activity camera incident; `over` replaces columns (SQL literals). */
    function incident(over: Record<string, string> = {}): string {
      const cols: Record<string, string> = {
        id: q(INC),
        scope: "'camera'",
        zoneId: "NULL",
        zoneName: "NULL",
        zoneKind: "NULL",
        zoneLinkIds: "ARRAY[]::text[]",
        scopeCamera: q(CAM),
        openedInMode: "'closed'",
        grouping: "'collecting'",
        state: "'no_action'",
        severity: "'info'",
        reasonCodes: `ARRAY[]::"SecurityReasonCode"[]`,
        notifyState: "'not_needed'",
        notifyAttempts: "0",
        rulesetVersion: "1",
        firstActivityAt: "now()",
        lastActivityAt: "now()",
        lastArrivalAt: "now()",
        eventCount: "1",
        countsByCamera: "'{}'::jsonb",
        cameras: `ARRAY[${q(CAM)}]::text[]`,
        closedAt: "NULL",
        alertedAt: "NULL",
        resolvedAt: "NULL",
        resolvedById: "NULL",
        updatedAt: "now()",
        ...over,
      };
      return `INSERT INTO "SecurityIncident" (${Object.keys(cols).map((c) => `"${c}"`).join(",")}) VALUES (${Object.values(cols).join(",")})`;
    }
    const alertCols = {
      state: "'open'",
      severity: "'alert'",
      reasonCodes: `ARRAY['after_hours_presence']::"SecurityReasonCode"[]`,
      notifyState: "'pending'",
      alertedAt: "now()",
    };

    it("the legal shapes insert (plain, alert, resolved-and-closed, an area snapshot)", async () => {
      expect(await run(incident())).toBe("inserted");
      expect(await run(incident(alertCols))).toBe("inserted");
      expect(
        await run(incident({ ...alertCols, state: "'resolved'", grouping: "'closed'", closedAt: "now()", resolvedAt: "now()", resolvedById: "'u1'" })),
      ).toBe("inserted");
    });

    it.each([
      ["info but open", { state: "'open'" }, "SecurityIncident_state_shape"],
      ["a code at info", { reasonCodes: `ARRAY['camera_offline']::"SecurityReasonCode"[]` }, "SecurityIncident_state_shape"],
      ["resolved while collecting", { ...alertCols, state: "'resolved'", resolvedAt: "now()", resolvedById: "'u1'" }, "SecurityIncident_state_shape"],
      ["closed without closedAt", { grouping: "'closed'" }, "SecurityIncident_state_shape"],
      ["alert without alertedAt", { ...alertCols, alertedAt: "NULL" }, "SecurityIncident_state_shape"],
      ["alert with notify not_needed", { ...alertCols, notifyState: "'not_needed'" }, "SecurityIncident_state_shape"],
      ["area scope without a snapshot", { scope: "'area'", scopeCamera: "NULL" }, "SecurityIncident_scope_shape"],
      ["camera scope without a camera", { scopeCamera: "NULL" }, "SecurityIncident_scope_shape"],
      ["a camera name that is not a Frigate name", { scopeCamera: "'back/../x'" }, "SecurityIncident_scope_shape"],
      ["link ids outside area scope", { zoneLinkIds: "ARRAY['l1']::text[]" }, "SecurityIncident_scope_shape"],
      ["a NULL link array", { zoneLinkIds: "NULL" }, "SecurityIncident_scope_shape"],
      ["a NULL code array", { reasonCodes: "NULL" }, "SecurityIncident_scope_shape"],
      ["a backwards span", { lastActivityAt: "now() - interval '1 minute'" }, "SecurityIncident_span"],
      ["zero events", { eventCount: "0" }, "SecurityIncident_span"],
      ["11 notify attempts", { notifyAttempts: "11" }, "SecurityIncident_span"],
    ])("SecurityIncident: %s", async (_n, over, constraint) => {
      expect(await run(incident(over))).toEqual(rejectedBy(constraint));
    });

    const reason = (code: string, severity: string, camera: string | null = CAM) =>
      `INSERT INTO "SecurityIncidentReason" ("id","incidentId","code","severity","rulesetVersion","evidenceEventId","evidenceCamera","evidenceSource","evidenceKind","evidenceAt","evidenceSummary","detail")
       VALUES (gen_random_uuid()::text,${q(INC)},'${code}','${severity}',1,1,${q(camera)},'frigate','detection',now(),'x','{}'::jsonb)`;

    it("SecurityIncidentReason: severity follows the code (D18), and the camera is a Frigate name", async () => {
      expect(await run(incident(alertCols), reason("after_hours_presence", "alert"))).toBe("inserted");
      expect(await run(incident(alertCols), reason("after_hours_presence", "notice"))).toEqual(rejectedBy("SecurityIncidentReason_code_severity"));
      expect(await run(incident(alertCols), reason("camera_offline", "alert"))).toEqual(rejectedBy("SecurityIncidentReason_code_severity"));
      expect(await run(incident(alertCols), reason("threat_signal", "alert", null))).toEqual(rejectedBy("SecurityIncidentReason_code_severity"));
      expect(await run(incident(alertCols), reason("camera_offline", "notice", "a b"))).toEqual(rejectedBy("SecurityIncidentReason_camera"));
    });

    const EV = `${TAG}:check-ev`;
    const eventSql = `INSERT INTO "SecurityEvent" ("source","kind","severity","camera","sourceRef","dedupeKey","labels","cameraZones","startedAt","summary")
      VALUES ('frigate','detection','info',${q(CAM)},'r',${q(EV)},ARRAY['person'],ARRAY[]::text[],now(),'x')`;
    const triageSql = (outcome: string, incidentId: string | null, error: string | null, links = "ARRAY[]::text[]") =>
      `INSERT INTO "SecurityEventTriage" ("eventId","outcome","incidentId","matchedLinkIds","alsoZoneIds","rulesetVersion","error")
       SELECT id,'${outcome}',${q(incidentId)},${links},ARRAY[]::text[],1,${q(error)} FROM "SecurityEvent" WHERE "dedupeKey" = ${q(EV)}`;

    it("SecurityEventTriage: grouped iff an incident; failed iff an error; lists only on a member", async () => {
      expect(await run(incident(), eventSql, triageSql("grouped", INC, null))).toBe("inserted");
      expect(await run(eventSql, triageSql("grouped", null, null))).toEqual(rejectedBy("SecurityEventTriage_shape"));
      expect(await run(eventSql, triageSql("failed", null, null))).toEqual(rejectedBy("SecurityEventTriage_shape"));
      expect(await run(eventSql, triageSql("context", null, null, "ARRAY['l1']::text[]"))).toEqual(rejectedBy("SecurityEventTriage_shape"));
      expect(await run(eventSql, triageSql("low", null, null, "NULL"))).toEqual(rejectedBy("SecurityEventTriage_shape"));
    });

    const notice = (outcome: string, logId: string | null, settled: string, channels = "''", push = "NULL") =>
      `INSERT INTO "SecurityIncidentNotice" ("id","incidentId","userId","username","reason","outcome","notificationLogId","channels","pushOutcome","settledAt")
       VALUES (gen_random_uuid()::text,${q(INC)},'u1','maria','routed','${outcome}',${q(logId)},${channels},${push},${settled})`;

    it("SecurityIncidentNotice: a log row iff written; settled iff not queued; transport only when transported", async () => {
      expect(await run(incident(alertCols), notice("queued", "log1", "NULL"))).toBe("inserted");
      expect(await run(incident(alertCols), notice("queued", "log1", "now()"))).toEqual(rejectedBy("SecurityIncidentNotice_shape"));
      expect(await run(incident(alertCols), notice("sent", null, "now()"))).toEqual(rejectedBy("SecurityIncidentNotice_shape"));
      expect(await run(incident(alertCols), notice("skipped_capped", "log1", "now()"))).toEqual(rejectedBy("SecurityIncidentNotice_shape"));
      expect(await run(incident(alertCols), notice("skipped_not_visible", null, "now()", "'push'"))).toEqual(rejectedBy("SecurityIncidentNotice_shape"));
      expect(await run(incident(alertCols), notice("sent", "log1", "now()", "'toast,push'", "'sent'"))).toBe("inserted");
    });

    const ack = (action: string, note: string, sid: string | null, checked: boolean) =>
      `INSERT INTO "SecurityIncidentAck" ("id","incidentId","action","byUserId","byName","sessionId","sessionChecked","note")
       VALUES (gen_random_uuid()::text,${q(INC)},'${action}','u1','Maria',${q(sid)},${checked},${q(note)})`;

    it("SecurityIncidentAck: a note only on a resolve; sessionChecked only with a sign-in id", async () => {
      expect(await run(incident(alertCols), ack("resolve", "false alarm", "s1", true))).toBe("inserted");
      expect(await run(incident(alertCols), ack("acknowledge", "hi", "s1", true))).toEqual(rejectedBy("SecurityIncidentAck_note"));
      expect(await run(incident(alertCols), ack("acknowledge", "", null, true))).toEqual(rejectedBy("SecurityIncidentAck_session"));
      expect(await run(incident(alertCols), ack("acknowledge", "", null, false))).toBe("inserted");
    });

    it("SecurityIncidentEngineState: one row, floor between start and candidate", async () => {
      const state = (id: string, start: number, floor: number, cand: number) =>
        `INSERT INTO "SecurityIncidentEngineState" ("id","startedAtId","triageFloor","floorCandidate","floorCandidateAt","updatedAt")
         VALUES ('${id}',${start},${floor},${cand},now(),now())`;
      const clear = `DELETE FROM "SecurityIncidentEngineState"`;
      expect(await run(clear, state("singleton", 1, 2, 3))).toBe("inserted");
      expect(await run(clear, state("other", 1, 2, 3))).toEqual(rejectedBy("SecurityIncidentEngineState_shape"));
      expect(await run(clear, state("singleton", 3, 2, 3))).toEqual(rejectedBy("SecurityIncidentEngineState_shape"));
      expect(await run(clear, state("singleton", 1, 4, 3))).toEqual(rejectedBy("SecurityIncidentEngineState_shape"));
    });
  });

  // ── append-only ───────────────────────────────────────────────────────────

  it("SecurityEvent is append-only: UPDATE is refused by the trigger, DELETE still works (D11)", async () => {
    const e = await prisma.securityEvent.create({
      data: { source: "frigate", kind: "detection", severity: "info", camera: CAM, sourceRef: "r", dedupeKey: `${TAG}:append`, labels: ["person"], cameraZones: [], startedAt: T0, summary: "x" },
    });
    await expect(prisma.$executeRawUnsafe(`UPDATE "SecurityEvent" SET "summary" = 'changed' WHERE id = ${e.id}`)).rejects.toThrow(
      /append-only/,
    );
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "SecurityEvent" SET "summary" = 'changed' WHERE id = ${e.id}`),
    ).rejects.toMatchObject({ meta: { code: "23001" } });
    expect((await prisma.securityEvent.findUniqueOrThrow({ where: { id: e.id } })).summary).toBe("x");
    expect(await prisma.securityEvent.deleteMany({ where: { id: e.id } })).toEqual({ count: 1 });
  });

  // ── the engine ────────────────────────────────────────────────────────────

  describe("the engine on real rows", () => {
    let zoneId = "";
    let n = 0;
    const deps = (now: Date): SecurityIncidentDeps => ({ isSecurityModuleOn: async () => false, resolveAccess: async () => null, now: () => now });

    /** Closed by the hours (Mon–Fri 09–17, London) and a stored closed mode. */
    async function closedSite(): Promise<void> {
      await prisma.securitySchedule.deleteMany({});
      await prisma.securitySiteHours.deleteMany({});
      await prisma.securityModeState.deleteMany({});
      await prisma.securitySiteHours.create({ data: { id: "singleton", state: "set", timezone: "Europe/London", version: 1 } });
      await prisma.securitySchedule.createMany({
        data: [1, 2, 3, 4, 5, 6, 7].map((weekday) =>
          weekday <= 5 ? { weekday, kind: "hours" as const, opensMin: 540, closesMin: 1020 } : { weekday, kind: "closed" as const },
        ),
      });
      await prisma.securityModeState.create({ data: { id: "singleton", mode: "closed", modeSource: "schedule", setAt: T0 } });
    }

    /** The floor at the store's max id: only rows this case inserts are triaged. */
    async function engineAtHead(candidateAt = plus(T0, -600_000)): Promise<bigint> {
      const { _max } = await prisma.securityEvent.aggregate({ _max: { id: true } });
      const head = _max.id ?? 0n;
      await prisma.securityIncidentEngineState.deleteMany({});
      await prisma.securityIncidentEngineState.create({
        data: { id: "singleton", startedAtId: head, triageFloor: head, floorCandidate: head, floorCandidateAt: candidateAt },
      });
      return head;
    }

    const person = (at: Date, over: Partial<Prisma.SecurityEventCreateInput> = {}): Prisma.SecurityEventCreateInput => ({
      source: "frigate",
      kind: "detection",
      severity: "info",
      camera: CAM,
      sourceRef: `${CAM}/${++n}.5-a`,
      dedupeKey: `${TAG}:ev-${n}-${Date.now()}`,
      labels: ["person"],
      cameraZones: [],
      score: 0.9,
      startedAt: at,
      endedAt: plus(at, 20_000),
      summary: "Person seen by back",
      ...over,
    });

    beforeAll(async () => {
      await closedSite();
      const zone = await prisma.securityZone.create({ data: { name: `${TAG} Stock room`, nameKey: `${TAG} stock room`, kind: "interior" } });
      zoneId = zone.id;
      await prisma.securityZoneLink.create({
        data: { zoneId, sourceKind: "camera", sourceRef: CAM, sourceLabel: "Back", state: "active" },
      });
    });

    beforeEach(() => {
      _resetIncidentHealthForTests();
    });

    it("a person after closing → an alert incident with its evidence and membership, all CHECK-valid — grouped even with the module off", async () => {
      await engineAtHead();
      const e = await prisma.securityEvent.create({ data: person(T0) });
      await tickSecurityIncidents(prisma, deps(plus(T0, 30_000)));
      const t = await prisma.securityEventTriage.findUniqueOrThrow({ where: { eventId: e.id }, include: { incident: { include: { reasons: true } } } });
      expect(t).toMatchObject({ outcome: "grouped", matchedLinkIds: [expect.any(String)] });
      expect(t.incident).toMatchObject({
        scope: "area",
        zoneId,
        zoneName: `${TAG} Stock room`,
        openedInMode: "closed",
        severity: "alert",
        state: "open",
        // The module is off in these cases (deps): grouped all the same, never sent (D29).
        notifyState: "module_off",
        reasonCodes: ["after_hours_presence"],
        countsByCamera: { [CAM]: { person: 1 } },
      });
      expect(t.incident!.reasons).toEqual([expect.objectContaining({ code: "after_hours_presence", evidenceEventId: e.id, evidenceCamera: CAM })]);
    });

    it("the floor: a row whose transaction is still open when a later row is triaged is triaged after it commits — never skipped", async () => {
      const floor = await engineAtHead(plus(T0, -600_000));
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let inserted!: (id: bigint) => void;
      const insertedId = new Promise<bigint>((r) => (inserted = r));
      const slow = prisma.$transaction(
        async (tx) => {
          const row = await tx.securityEvent.create({ data: person(plus(T0, 60_000)), select: { id: true } });
          inserted(row.id);
          await held;
        },
        { timeout: 60_000 },
      );
      const lowId = await insertedId;
      const later = await prisma.securityEvent.create({ data: person(plus(T0, 90_000), { camera: `${TAG}_yard`, sourceRef: `${TAG}_yard/x` }) });
      expect(later.id).toBeGreaterThan(lowId);

      // Tick 1 sees only the later row; the candidate is old, so the floor
      // moves — but only to the OLD candidate (the head read before the test).
      await tickSecurityIncidents(prisma, deps(plus(T0, 100_000)));
      // Tick 2, ten seconds later: the new candidate is not 2 min old yet.
      await tickSecurityIncidents(prisma, deps(plus(T0, 110_000)));
      const state = await prisma.securityIncidentEngineState.findUniqueOrThrow({ where: { id: "singleton" } });
      expect(state.triageFloor).toBe(floor);
      expect(await prisma.securityEventTriage.count({ where: { eventId: lowId } })).toBe(0);

      release();
      await slow;
      await tickSecurityIncidents(prisma, deps(plus(T0, 120_000)));
      expect(await prisma.securityEventTriage.findUnique({ where: { eventId: lowId } })).toMatchObject({ outcome: "grouped" });
    });

    it("three ticks at once: one triage row and one membership per event, and every count adds up (no double count)", async () => {
      await engineAtHead();
      const rows = [];
      for (let k = 0; k < 8; k++) rows.push(await prisma.securityEvent.create({ data: person(plus(T0, k * 20_000)) }));
      const d = deps(plus(T0, 200_000));
      await Promise.all([tickSecurityIncidents(prisma, d), tickSecurityIncidents(prisma, d), tickSecurityIncidents(prisma, d)]);
      const ids = rows.map((r) => r.id);
      const triage = await prisma.securityEventTriage.findMany({ where: { eventId: { in: ids } } });
      expect(triage).toHaveLength(8);
      const incidentIds = new Set(triage.map((t) => t.incidentId));
      expect(new Set(triage.map((t) => t.eventId.toString())).size).toBe(8);
      expect(triage.every((t) => t.outcome === "grouped")).toBe(true);
      const incidents = await prisma.securityIncident.findMany({ where: { id: { in: [...incidentIds].filter((x): x is string => !!x) } } });
      // The losers rolled back: every incident's count is exactly its members (no double
      // count), and none is left without a member.
      expect(incidents.length).toBeGreaterThan(0);
      for (const i of incidents) {
        const members = await prisma.securityEventTriage.count({ where: { incidentId: i.id } });
        expect(members).toBe(i.eventCount);
        expect(members).toBeGreaterThan(0);
      }
    });

    it("matchAreasForEvent picks exactly the rows zoneEventWhere selects (200 events × random links)", async () => {
      const r = rng(2978);
      const cams = [`${TAG}_m1`, `${TAG}_m2`, `${TAG}_m3`];
      const parts = ["porch", "drive", "yard", "till"];
      const zones: string[] = [];
      for (let z = 0; z < 4; z++) {
        const zone = await prisma.securityZone.create({ data: { name: `${TAG} m${z}`, nameKey: `${TAG} m${z}`, kind: "interior" } });
        zones.push(zone.id);
        const links = new Set<string>();
        for (let k = 0; k < 1 + Math.floor(r() * 3); k++) {
          const cam = cams[Math.floor(r() * cams.length)]!;
          links.add(r() < 0.4 ? cam : `${cam}/${parts[Math.floor(r() * parts.length)]}`);
        }
        for (const ref of links) {
          await prisma.securityZoneLink.create({
            data: { zoneId: zone.id, sourceKind: ref.includes("/") ? "camera_zone" : "camera", sourceRef: ref, sourceLabel: "x", state: "active" },
          });
        }
      }
      const kinds = ["detection", "detection_low", "camera_offline", "camera_online"] as const;
      const events = [];
      for (let k = 0; k < 200; k++) {
        events.push({
          source: kinds[Math.floor(r() * kinds.length)]!.startsWith("camera") ? ("frigate_status" as const) : ("frigate" as const),
          kind: kinds[Math.floor(r() * kinds.length)]!,
          severity: "info" as const,
          camera: cams[Math.floor(r() * cams.length)]!,
          sourceRef: `m/${k}`,
          dedupeKey: `${TAG}:m-${k}-${Date.now()}`,
          labels: ["person"],
          cameraZones: parts.filter(() => r() < 0.3),
          startedAt: T0,
          summary: "m",
        });
      }
      await prisma.securityEvent.createMany({ data: events });
      const stored = await prisma.securityEvent.findMany({ where: { dedupeKey: { startsWith: `${TAG}:m-` } } });
      const all = (await loadActiveLinks(prisma)).filter((l) => zones.includes(l.zoneId));
      for (const zone of zones) {
        const clause = zoneEventWhere(all.filter((l) => l.zoneId === zone));
        const sql = clause === "none" ? [] : await prisma.securityEvent.findMany({ where: { AND: [{ dedupeKey: { startsWith: `${TAG}:m-` } }, clause] }, select: { id: true } });
        const memory = stored.filter((e) => matchAreasForEvent(e, all).some((m) => m.zoneId === zone));
        expect(memory.map((e) => e.id).sort(), zone).toEqual(sql.map((e) => e.id).sort());
      }
    });
  });

  // ── retention ─────────────────────────────────────────────────────────────

  describe("retention (§6.10)", () => {
    const BEFORE = new Date("2026-08-24T03:50:00Z");
    const NOW = new Date("2026-09-23T03:50:00Z");

    async function incidentWith(tag: string, over: Partial<Prisma.SecurityIncidentUncheckedCreateInput>, eventAt: Date | null) {
      const coded = over.severity && over.severity !== "info";
      const i = await prisma.securityIncident.create({
        data: {
          scope: "camera",
          scopeCamera: `${TAG}_${tag}`,
          openedInMode: "closed",
          grouping: "closed",
          closedAt: BEFORE,
          rulesetVersion: 1,
          firstActivityAt: plus(BEFORE, -7_200_000),
          lastActivityAt: plus(BEFORE, -3_600_000),
          lastArrivalAt: plus(BEFORE, -3_600_000),
          eventCount: 1,
          countsByCamera: {},
          cameras: [`${TAG}_${tag}`],
          zoneLinkIds: [],
          reasonCodes: coded ? ["camera_offline"] : [],
          state: coded ? "open" : "no_action",
          ...over,
        },
      });
      if (eventAt) {
        const e = await prisma.securityEvent.create({
          data: { source: "frigate", kind: "detection", severity: "info", camera: `${TAG}_${tag}`, sourceRef: "r", dedupeKey: `${TAG}:ret-${tag}-${Date.now()}`, labels: [], cameraZones: [], startedAt: eventAt, summary: "x" },
        });
        await prisma.securityEventTriage.create({
          data: { eventId: e.id, outcome: "grouped", incidentId: i.id, matchedLinkIds: [], alsoZoneIds: [], rulesetVersion: 1 },
        });
      }
      return i.id;
    }

    it("the real cascade: events trimmed → eventsKept follows; plain activity goes, coded stays; the Restrict FK never fails", async () => {
      const plainGone = await incidentWith("plain", {}, plus(BEFORE, -7_200_000));
      const codedGone = await incidentWith("coded", { severity: "notice" }, plus(BEFORE, -7_200_000));
      const straddle = await incidentWith("straddle", { severity: "notice", firstActivityAt: plus(BEFORE, -60_000), lastActivityAt: plus(BEFORE, 60_000) }, plus(BEFORE, -60_000));
      const straddleEvent = await prisma.securityEvent.create({
        data: { source: "frigate", kind: "detection", severity: "info", camera: `${TAG}_straddle`, sourceRef: "r", dedupeKey: `${TAG}:ret-straddle2-${Date.now()}`, labels: [], cameraZones: [], startedAt: plus(BEFORE, 30_000), summary: "x" },
      });
      await prisma.securityEventTriage.create({
        data: { eventId: straddleEvent.id, outcome: "grouped", incidentId: straddle, matchedLinkIds: [], alsoZoneIds: [], rulesetVersion: 1 },
      });
      // An info incident past the horizon that still has a member (never expected, but must not break the job).
      const odd = await incidentWith("odd", {}, plus(BEFORE, 10));

      // The events' own trim, scoped to this file's rows (the real one deletes by startedAt alone).
      await prisma.securityEvent.deleteMany({ where: { dedupeKey: { startsWith: `${TAG}:ret-` }, startedAt: { lt: BEFORE } } });
      const r = await trimSecurityIncidents(prisma, BEFORE, NOW);
      expect(r.deleted).toBeGreaterThanOrEqual(1);

      const left = new Map((await prisma.securityIncident.findMany({ where: { id: { in: [plainGone, codedGone, straddle, odd] } } })).map((i) => [i.id, i]));
      expect(left.has(plainGone)).toBe(false);
      expect(left.get(codedGone)).toMatchObject({ eventsKept: "removed" });
      expect(left.get(straddle)).toMatchObject({ eventsKept: "partly_removed" });
      expect(left.get(odd)).toMatchObject({ eventsKept: "partly_removed" });
    });
  });
});
