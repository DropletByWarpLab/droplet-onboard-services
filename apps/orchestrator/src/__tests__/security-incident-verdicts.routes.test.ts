/**
 * WARP-2980 (ADR-059 P5 PR-B, brief §4.4, spec D15–D16; review items 2, 3) —
 * route 18's pattern flags and verdict, and route 35 (Expected / Not
 * expected), through the REAL incidents router, the real gates (the §9
 * resolver injected), the real read model and actions over the in-memory
 * fake, and the real audit helpers — only the chain append and the rate
 * limiter are stubbed.
 *
 * DS-005 pins: a family member's detail (and routes 16–17 for everyone) is
 * byte-identical with and without flags in the world — absent, not
 * redacted; the verdict is shown only to a viewer who sees everything; route
 * 35 is floored at owner/admin, so nobody overwrites a judgement about
 * cameras they cannot see. A verdict never moves state, severity, codes or
 * notifications.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type NextFunction, type Request, type Response } from "express";
import type { PrismaClient } from "@prisma/client";

const h = vi.hoisted(() => {
  const passThrough = (_req: unknown, _res: unknown, next: () => void) => next();
  return { inTx: vi.fn(), limiter: passThrough };
});

vi.mock("../middleware/rate-limit.js", async (orig) => ({
  ...(await orig<typeof import("../middleware/rate-limit.js")>()),
  sensitiveRateLimit: h.limiter,
}));

vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(null),
  recordActivityInTx: (...args: unknown[]) => h.inTx(...args),
  getActivityRecorder: () => null,
}));

vi.mock("../services/off-lan-gate.service.js", () => ({ webPushGate: async () => true }));

vi.mock("../services/security-incident-page.js", async () => ({
  projectedIncidentPage: (await import("./security-incidents.fake.js")).referenceProjectedIncidentPage,
}));

import { createSecurityIncidentsRouter } from "../routes/security-incidents.js";
import { setIncidentVerdict } from "../services/security-incident-actions.js";
import type { EffectiveAccessResult } from "../services/effective-access.service.js";
import { createFakeSecurityPrisma, type FakeSecurityPrisma } from "./security-incidents.fake.js";

type Role = "owner" | "admin" | "family";
type Level = "view" | "act" | "manage";

const T = new Date("2026-09-23T21:14:00Z");
let now = new Date("2026-09-23T21:30:00Z");
const STEFAN = "11111111-1111-4111-8111-111111111111";
const MARIA = "22222222-2222-4222-8222-222222222222";
const JORDAN = "33333333-3333-4333-8333-333333333333";
const USERS: Record<Role, { id: string; username: string; displayName: string }> = {
  owner: { id: STEFAN, username: "stefan", displayName: "Stefan" },
  admin: { id: JORDAN, username: "jordan", displayName: "Jordan" },
  family: { id: MARIA, username: "maria", displayName: "Maria" },
};
const STOCK = "3f1c2a9e-0b7d-4c55-9a51-1c2d3e4f5a61";

/** Plain activity on front with one trial out_of_place flag (alert): judgeable by owner/admin only. */
const PLAIN = "0b7c9d1e-2f3a-4b5c-8d6e-7f8091a2b3c4";
/** Plain activity whose only flags were never raised: one quietened, one at info. */
const QUIET = "1c8d0e2f-3a4b-4c5d-9e6f-8091a2b3c4d5";
/** Plain activity with no flag at all. */
const BARE = "2d9e1f3a-4b5c-4d6e-8f70-91a2b3c4d5e6";
/** An open alert on front, no flag. */
const CODED = "3e0f2a4b-5c6d-4e7f-8091-a2b3c4d5e6f7";
/** Resolved. */
const RESOLVED = "4f1a3b5c-6d7e-4f80-9102-b3c4d5e6f708";
/** An open alert still waiting for the notifier. */
const PENDING = "7c4d6e8f-9a01-4b23-8435-e6f708192a3b";
/** An alert on front (Maria sees it) and a notice on back (she does not): not partial for her. */
const SHARED = "8d5e7f90-a1b2-4c34-9546-f708192a3b4c";
/** An alert on back only — hidden from Maria. */
const BACK_ONLY = "5a2b4c6d-7e8f-4a91-8213-c4d5e6f70819";
const MISSING = "9f9f9f9f-9f9f-4f9f-8f9f-9f9f9f9f9f9f";
const SUP = "a0000000-0000-4000-8000-000000000001";

function access(level: Level | null, tier: EffectiveAccessResult["tier"] = "family"): EffectiveAccessResult {
  return {
    tier,
    features: (level ? [{ moduleId: "security", level }] : []) as EffectiveAccessResult["features"],
    toolDomains: [],
    locks: false,
    cloud: false,
    connectors: {},
    connectorGrants: null,
    usage: {
      storageQuotaBytes: null,
      maxUploadSizeMb: null,
      llmDailyMessageCap: null,
      source: "default",
      sources: { storageQuotaBytes: "default", maxUploadSizeMb: "default", llmDailyMessageCap: "default" },
    },
    deptRights: [],
    exceptions: [],
  } as unknown as EffectiveAccessResult;
}

function incident(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    scope: "area",
    zoneId: STOCK,
    zoneName: "Stock room",
    zoneKind: "interior",
    zoneLinkIds: ["l0"],
    openedInMode: "closed",
    grouping: "closed",
    closedAt: T,
    state: "no_action",
    severity: "info",
    reasonCodes: [],
    notifyState: "not_needed",
    alertedAt: null,
    rulesetVersion: 3,
    firstActivityAt: T,
    lastActivityAt: T,
    lastArrivalAt: T,
    eventCount: 1,
    countsByCamera: { front: { person: 1 } },
    cameras: ["front"],
    spanByCamera: {},
    version: 2,
    ...over,
  };
}

const alert = { state: "open", severity: "alert", reasonCodes: ["after_hours_presence"], notifyState: "done", alertedAt: T, grouping: "collecting", closedAt: null };

function reason(incidentId: string, camera: string, id: bigint) {
  return {
    incidentId,
    code: "after_hours_presence",
    severity: "alert",
    rulesetVersion: 3,
    evidenceEventId: id,
    evidenceCamera: camera,
    evidenceSource: "frigate",
    evidenceKind: "detection",
    evidenceLabel: "person",
    evidenceAt: T,
    evidenceSummary: "x",
    detail: {},
  };
}

function flag(incidentId: string, id: bigint, over: Record<string, unknown> = {}) {
  return {
    incidentId,
    code: "out_of_place",
    effect: "trial",
    severity: "alert",
    rulesetVersion: 3,
    zoneKey: `area:${STOCK}`,
    keyCameras: ["front"],
    evidenceEventId: id,
    evidenceCamera: "front",
    evidenceLabel: "person",
    evidenceAt: T,
    evidenceSummary: "Person seen by front",
    detail: { hour: 22, p: "0.0161" },
    ...over,
  };
}

function world(opts: { flags?: boolean } = {}): FakeSecurityPrisma {
  return createFakeSecurityPrisma(
    {
      user: [
        { ...USERS.owner, role: "owner", directoryStatus: "ACTIVE" },
        { ...USERS.family, role: "family", directoryStatus: "ACTIVE" },
        { ...USERS.admin, role: "admin", directoryStatus: "ACTIVE" },
      ],
      camera: [
        { id: "cam-back", name: "back", displayName: "Back camera" },
        { id: "cam-front", name: "front", displayName: "Front door" },
      ],
      cameraAccessGrant: [{ id: "g1", userId: MARIA, cameraId: "cam-front" }],
      securityIncident: [
        incident(PLAIN),
        incident(QUIET),
        incident(BARE),
        incident(CODED, alert),
        incident(RESOLVED, { ...alert, state: "resolved", grouping: "closed", closedAt: T, resolvedAt: T, resolvedById: STEFAN }),
        incident(BACK_ONLY, { ...alert, cameras: ["back"], countsByCamera: { back: { person: 1 } } }),
        incident(PENDING, { ...alert, notifyState: "pending" }),
        incident(SHARED, { ...alert, reasonCodes: ["after_hours_presence", "camera_offline"], cameras: ["back", "front"] }),
      ],
      securityIncidentReason: [
        reason(CODED, "front", 11n),
        reason(RESOLVED, "front", 12n),
        reason(BACK_ONLY, "back", 13n),
        reason(PENDING, "front", 14n),
        reason(SHARED, "front", 15n),
        { ...reason(SHARED, "back", 16n), code: "camera_offline", severity: "notice", evidenceKind: "camera_offline", evidenceLabel: null },
      ],
      securitySuppression: [
        {
          id: SUP,
          targetKind: "area",
          zoneId: STOCK,
          label: "person",
          days: "every_day",
          hourFrom: 0,
          hourCount: 24,
          codes: ["out_of_place"],
          reason: "The cleaner",
          createdById: STEFAN,
          createdByName: "Stefan",
          createdAt: T,
          expiresAt: new Date(T.getTime() + 86_400_000),
          state: "removed",
          endedAt: T,
          endedById: STEFAN,
        },
      ],
      securityPatternFlag:
        opts.flags === false
          ? []
          : [
              flag(PLAIN, 1n, { id: "f-1" }),
              flag(QUIET, 2n, { id: "f-2", effect: "suppressed", suppressionId: SUP }),
              flag(QUIET, 3n, { id: "f-3", code: "unusual_volume", severity: "info" }),
            ],
      securitySiteHours: [{ id: "singleton", state: "set", timezone: "Europe/London", version: 1 }],
    },
    now,
  );
}

let f: FakeSecurityPrisma;

function app(role: Role | null, level: Level | null) {
  const resolve = vi.fn(async (_userId: string) => access(level, role === "owner" ? "owner" : "family"));
  const server = express();
  server.use(express.json());
  server.use((req: Request, _res: Response, next: NextFunction) => {
    if (role !== null) (req as unknown as { user?: unknown }).user = { ...USERS[role], role, sid: "sess-1" };
    next();
  });
  server.use("/api", createSecurityIncidentsRouter(f.client as unknown as PrismaClient, { resolve, now: () => now }));
  return { server, resolve };
}

const audits = () =>
  h.inTx.mock.calls.map((c) => {
    const p = c[1] as { what: string; refs: Record<string, unknown> };
    return { what: p.what, refs: p.refs };
  });
const stored = (id: string) => f.world.securityIncident.find((i) => i.id === id)!;
const mark = (role: Role, level: Level, id: string, body: unknown) => request(app(role, level).server).post(`/api/security/incidents/${id}/verdict`).send(body as object);

beforeEach(() => {
  now = new Date("2026-09-23T21:30:00Z");
  f = world();
  h.inTx.mockReset().mockResolvedValue({ id: 1n });
});

// ── route 18 ─────────────────────────────────────────────────────────────

describe("route 18 — pattern flags and the verdict (D16, review item 2)", () => {
  it("the owner sees the flag with its numbers, the unreviewed verdict, and may give one", async () => {
    const res = await request(app("owner", "manage").server).get(`/api/security/incidents/${PLAIN}`);
    expect(res.status).toBe(200);
    expect(res.body.patternFlags).toEqual([
      {
        code: "out_of_place",
        effect: "trial",
        severity: "alert",
        key: { kind: "area", zoneId: STOCK, camera: null },
        evidence: { eventId: "1", camera: "front", label: "person", at: T.toISOString(), summary: "Person seen by front" },
        detail: { hour: 22, p: "0.0161" },
        suppression: null,
      },
    ]);
    expect(res.body.verdict).toEqual({ state: "unreviewed", byName: null, at: null, codes: [] });
    expect(res.body.viewer).toEqual({ level: "manage", acknowledged: false, canGiveVerdict: true });
    // Plain activity stays plain: the flag counts for nothing.
    expect(res.body).toMatchObject({ state: "no_action", severity: "info", reasonCodes: [], actionable: false });
  });

  it("a quietened flag carries its expected activity AS IT IS NOW (removed since)", async () => {
    const res = await request(app("owner", "manage").server).get(`/api/security/incidents/${QUIET}`);
    expect(res.body.patternFlags.map((x: { effect: string; suppression: unknown }) => [x.effect, x.suppression])).toEqual([
      ["suppressed", { id: SUP, reason: "The cleaner", state: "removed" }],
      ["trial", null],
    ]);
    // Nothing on it was ever raised: nothing to judge.
    expect(res.body.viewer.canGiveVerdict).toBe(false);
  });

  it("family (act) on the same incident: no flags, no verdict, cannot give one — byte-identical to a world with no flags (absent, not redacted)", async () => {
    const flagsRead = vi.spyOn(f.client.securityPatternFlag as { findMany: (a: unknown) => Promise<unknown> }, "findMany");
    const withFlags = await request(app("family", "act").server).get(`/api/security/incidents/${PLAIN}`);
    // D16: the role clause is checked before the query — family's detail never reads the flags at all.
    expect(flagsRead).not.toHaveBeenCalled();
    f = world({ flags: false });
    const without = await request(app("family", "act").server).get(`/api/security/incidents/${PLAIN}`);
    expect(withFlags.status).toBe(200);
    expect(withFlags.body).toMatchObject({ patternFlags: [], verdict: null, viewer: { canGiveVerdict: false } });
    expect(JSON.stringify(withFlags.body)).toBe(JSON.stringify(without.body));
  });

  it("family never sees a verdict, even once the owner marked it", async () => {
    await mark("owner", "manage", CODED, { verdict: "not_expected" });
    const res = await request(app("family", "act").server).get(`/api/security/incidents/${CODED}`);
    expect(res.body.verdict).toBeNull();
    expect(res.body.viewer.canGiveVerdict).toBe(false);
  });

  it("an owner/admin narrowed to view: canGiveVerdict false", async () => {
    const res = await request(app("admin", "view").server).get(`/api/security/incidents/${PLAIN}`);
    expect(res.body.viewer).toEqual({ level: "view", acknowledged: false, canGiveVerdict: false });
    expect(res.body.patternFlags).toHaveLength(1);
  });

  it("routes 16 and 17 are byte-identical with and without flags, for the owner and for family", async () => {
    for (const [role, level] of [
      ["owner", "manage"],
      ["family", "act"],
    ] as const) {
      f = world();
      const list = await request(app(role, level).server).get("/api/security/incidents");
      const summary = await request(app(role, level).server).get("/api/security/incidents/summary");
      f = world({ flags: false });
      expect(JSON.stringify((await request(app(role, level).server).get("/api/security/incidents")).body), role).toBe(JSON.stringify(list.body));
      expect(JSON.stringify((await request(app(role, level).server).get("/api/security/incidents/summary")).body), role).toBe(JSON.stringify(summary.body));
    }
  });
});

// ── route 35 ─────────────────────────────────────────────────────────────

describe("route 35 POST /api/security/incidents/:id/verdict (act, owner/admin floor)", () => {
  it("200 changed:true: every column stamped, the detail back, ONE in-transaction audit; nothing else about the incident moves", async () => {
    const before = { ...stored(PLAIN) };
    const res = await mark("owner", "manage", PLAIN, { verdict: "not_expected" });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);
    expect(res.body.incident.verdict).toEqual({ state: "not_expected", byName: "Stefan", at: now.toISOString(), codes: ["out_of_place"] });
    expect(stored(PLAIN)).toMatchObject({
      verdict: "not_expected",
      verdictById: STEFAN,
      verdictByName: "Stefan",
      verdictAt: now,
      verdictFirstAt: now,
      verdictCodes: ["out_of_place"],
      version: (before.version as number) + 1,
      state: before.state,
      severity: before.severity,
      reasonCodes: before.reasonCodes,
      notifyState: before.notifyState,
    });
    expect(audits()).toEqual([
      {
        what: "Security: marked an incident in Stock room as not expected",
        refs: { surface: "security", action: "incident.verdict", incidentId: PLAIN, verdict: "not_expected", from: "unreviewed", codes: ["out_of_place"], incidentCodes: [] },
      },
    ]);
    expect(f.txLevels).toContain("ReadCommitted");
  });

  it("the same verdict with the same codes → changed:false, no audit", async () => {
    await mark("owner", "manage", PLAIN, { verdict: "not_expected" });
    const again = await mark("admin", "act", PLAIN, { verdict: "not_expected" });
    expect(again.body.changed).toBe(false);
    expect(h.inTx).toHaveBeenCalledTimes(1);
  });

  it("a change re-stamps who, when and the codes — the first mark never moves", async () => {
    await mark("owner", "manage", PLAIN, { verdict: "not_expected" });
    const first = now;
    now = new Date(now.getTime() + 3_600_000);
    const res = await mark("admin", "act", PLAIN, { verdict: "expected" });
    expect(res.body.changed).toBe(true);
    expect(stored(PLAIN)).toMatchObject({ verdict: "expected", verdictById: JORDAN, verdictByName: "Jordan", verdictAt: now, verdictFirstAt: first });
    expect(audits()[1]!.refs).toMatchObject({ verdict: "expected", from: "not_expected" });
  });

  it("review item 2 — the same verdict again after a code joined picks the new code up", async () => {
    await mark("owner", "manage", PLAIN, { verdict: "not_expected" });
    f.world.securityPatternFlag.push({ id: "f-late", createdAt: T, suppressionId: null, ...flag(PLAIN, 9n, { code: "long_dwell" }) });
    const res = await mark("owner", "manage", PLAIN, { verdict: "not_expected" });
    expect(res.body.changed).toBe(true);
    expect(stored(PLAIN).verdictCodes).toEqual(["out_of_place", "long_dwell"]);
  });

  it("nothing to judge → 409 NOT_JUDGEABLE, one body: only flags never raised, or plain activity with none", async () => {
    const quiet = await mark("owner", "manage", QUIET, { verdict: "expected" });
    const bare = await mark("owner", "manage", BARE, { verdict: "expected" });
    expect(quiet.status).toBe(409);
    expect(quiet.body).toEqual({ error: { code: "NOT_JUDGEABLE", message: "There's nothing here to mark." } });
    expect(bare.body).toEqual(quiet.body);
    expect(stored(QUIET).verdict).toBe("unreviewed");
    expect(h.inTx).not.toHaveBeenCalled();
  });

  it("a verdict never quiets anything: Expected on an alert still waiting for the notifier leaves it pending and open", async () => {
    const res = await mark("owner", "manage", PENDING, { verdict: "expected" });
    expect(res.body.changed).toBe(true);
    expect(stored(PENDING)).toMatchObject({ state: "open", severity: "alert", notifyState: "pending", reasonCodes: ["after_hours_presence"], verdict: "expected" });
  });

  it("allowed on a resolved incident (people review last night in the morning) — the state stays", async () => {
    const res = await mark("owner", "manage", RESOLVED, { verdict: "expected" });
    expect(res.body.changed).toBe(true);
    expect(stored(RESOLVED)).toMatchObject({ state: "resolved", verdict: "expected", verdictCodes: ["after_hours_presence"] });
    expect(audits()[0]!.what).toBe("Security: marked an alert in Stock room as expected");
  });

  it("missing → 404 INCIDENT_NOT_FOUND", async () => {
    const res = await mark("owner", "manage", MISSING, { verdict: "expected" });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: "INCIDENT_NOT_FOUND", message: "There is no such incident." } });
  });

  it.each([
    ["unreviewed", { verdict: "unreviewed" }],
    ["an extra key", { verdict: "expected", codes: ["out_of_place"] }],
    ["no body", {}],
  ])("400 — %s", async (_what, body) => {
    const res = await mark("owner", "manage", PLAIN, body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(h.inTx).not.toHaveBeenCalled();
  });

  it("400 — a non-uuid id", async () => {
    expect((await mark("owner", "manage", "not-an-id", { verdict: "expected" })).status).toBe(400);
  });

  it("the audit fails → 503 AUDIT_UNAVAILABLE and the row is unchanged (the transaction rolled back)", async () => {
    const before = JSON.stringify(stored(PLAIN), (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    h.inTx.mockRejectedValueOnce(new Error("chain down"));
    const res = await mark("owner", "manage", PLAIN, { verdict: "expected" });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("AUDIT_UNAVAILABLE");
    expect(JSON.stringify(stored(PLAIN), (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toBe(before);
  });

  it("losing the CAS twice → 409 INCIDENT_CONFLICT, nothing written", async () => {
    const bump = (w: { securityIncident: Array<Record<string, unknown>> }) => {
      const row = w.securityIncident.find((i) => i.id === PLAIN)!;
      row.version = (row.version as number) + 1;
    };
    f.onCall("securityIncident", "updateMany", bump);
    f.onCall("securityIncident", "updateMany", bump);
    const res = await mark("owner", "manage", PLAIN, { verdict: "expected" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("INCIDENT_CONFLICT");
    expect(stored(PLAIN).verdict).toBe("unreviewed");
    expect(h.inTx).not.toHaveBeenCalled();
  });

  it("level pins: family → 403 at the role floor (the resolver never asked); admin at view → 404 module_disabled; admin at act → 200", async () => {
    const family = app("family", "manage");
    expect((await request(family.server).post(`/api/security/incidents/${CODED}/verdict`).send({ verdict: "expected" })).status).toBe(403);
    expect(family.resolve).not.toHaveBeenCalled();
    const view = app("admin", "view");
    const below = await request(view.server).post(`/api/security/incidents/${CODED}/verdict`).send({ verdict: "expected" });
    expect(below.status).toBe(404);
    expect(view.resolve).toHaveBeenCalledWith(JORDAN);
    expect((await mark("admin", "act", CODED, { verdict: "expected" })).status).toBe(200);
  });
});

// ── the service, for viewers the route floor never lets through ──────────

describe("setIncidentVerdict — the DS-005 rules behind route 35 (D15)", () => {
  const actor = { id: MARIA, username: "maria", role: "family", displayName: "Maria", sessionId: null, sessionChecked: false, client: null };
  const maria = { userId: MARIA, visibleCameras: new Set(["front"]), mayReadThreats: false, mayReadLocks: false, ownerOrAdmin: false };
  const db = () => f.client as unknown as PrismaClient;

  it("a hidden incident answers exactly like a missing one", async () => {
    expect(await setIncidentVerdict(db(), { incidentId: BACK_ONLY, verdict: "expected", actor, viewer: maria, now })).toEqual({ status: "not_found" });
    expect(await setIncidentVerdict(db(), { incidentId: MISSING, verdict: "expected", actor, viewer: maria, now })).toEqual({ status: "not_found" });
  });

  it("a PARTIAL view is not judgeable: the same code on a camera she cannot see", async () => {
    f.world.securityIncident.push({ ...incident("6b3c5d7e-8f90-4a12-9324-d5e6f708192a", { ...alert, cameras: ["back", "front"] }), verdict: "unreviewed", verdictCodes: [] });
    f.world.securityIncidentReason.push(
      { id: "rp1", createdAt: T, ...reason("6b3c5d7e-8f90-4a12-9324-d5e6f708192a", "front", 21n) },
      { id: "rp2", createdAt: T, ...reason("6b3c5d7e-8f90-4a12-9324-d5e6f708192a", "back", 22n) },
    );
    expect(await setIncidentVerdict(db(), { incidentId: "6b3c5d7e-8f90-4a12-9324-d5e6f708192a", verdict: "expected", actor, viewer: maria, now })).toEqual({
      status: "not_judgeable",
    });
  });

  it("only the codes SHE can see are stamped — never a hidden camera's code, never a flag (flags are not hers)", async () => {
    f.world.securityPatternFlag.push({ id: "f-s", createdAt: T, suppressionId: null, ...flag(SHARED, 8n) });
    expect(await setIncidentVerdict(db(), { incidentId: SHARED, verdict: "expected", actor, viewer: maria, now })).toEqual({ status: "ok", changed: true });
    expect(stored(SHARED).verdictCodes).toEqual(["after_hours_presence"]);
  });

  it("a viewer who sees the code fully may mark it, and only their judgeable codes are stamped (flags are not hers)", async () => {
    f.world.securityPatternFlag.push({ id: "f-c", createdAt: T, suppressionId: null, ...flag(CODED, 7n) });
    expect(await setIncidentVerdict(db(), { incidentId: CODED, verdict: "expected", actor, viewer: maria, now })).toEqual({ status: "ok", changed: true });
    expect(stored(CODED).verdictCodes).toEqual(["after_hours_presence"]);
  });
});
