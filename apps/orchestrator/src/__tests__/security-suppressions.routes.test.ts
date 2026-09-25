/**
 * WARP-2980 (ADR-059 P5 PR-B, p5b spec §7 routes 32–34, §11.1 E) — expected
 * activity through the REAL patterns router, the real `requireRole` and
 * `requireFeatureAccess` (the §9 resolver injected through `deps.resolve`),
 * the real service over the in-memory incidents fake, and the real audit
 * helpers — only the chain append and the rate limiter are stubbed.
 *
 *   32 (view): DS-005 through P5-A's own `visibleKeyCameras` — a family member
 *      granted `front` sees a camera:front row and an area whose every camera
 *      is front; never a mixed area, camera:back, an unlinked or archived
 *      area, or an area whose CELLS still hold a hidden camera (review item
 *      9); `quietedFlags` for owner/admin only; `canManage` is the server's
 *      answer (D22); an outage is a 503, never an empty list;
 *   33 (manage): the body exactly, the reason off the chain, the route's
 *      clock, the limit counted under the lock, the audit in the transaction;
 *   34 (manage): active → removed with who and when, once; a row past its
 *      expiresAt is not a person's to end (review item 17).
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

import { createSecurityPatternsRouter } from "../routes/security-patterns.js";
import { SECURITY_SUPPRESSION_ACTIVE_LIMIT } from "../services/security-suppressions.service.js";
import type { EffectiveAccessResult } from "../services/effective-access.service.js";
import { baselineRows, createFakeSecurityPrisma, type FakeSecurityPrisma } from "./security-incidents.fake.js";

type Role = "owner" | "admin" | "family";
type Level = "view" | "act" | "manage";

const NOW = new Date("2026-09-23T21:30:00Z");
const DAY = 86_400_000;
const STEFAN = "11111111-1111-4111-8111-111111111111";
const MARIA = "22222222-2222-4222-8222-222222222222";
const JORDAN = "33333333-3333-4333-8333-333333333333";
const USERS: Record<Role, { id: string; username: string; displayName: string }> = {
  owner: { id: STEFAN, username: "stefan", displayName: "Stefan" },
  admin: { id: JORDAN, username: "jordan", displayName: "Jordan" },
  family: { id: MARIA, username: "maria", displayName: "Maria" },
};

/** front + back. */
const MIXED = "3f1c2a9e-0b7d-4c55-9a51-1c2d3e4f5a61";
/** front only. */
const FRONT_AREA = "7a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c82";
/** No links. */
const UNLINKED = "5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f";
/** Archived (its link still names front). */
const ARCHIVED = "0d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6";
/** Linked to front only NOW, but its cells were built from front AND back (review item 9). */
const CHANGED = "6e7f8091-a2b3-4c4d-8e5f-60718293a4b5";
const MISSING = "9f9f9f9f-9f9f-4f9f-8f9f-9f9f9f9f9f9f";

const S = {
  cameraFront: "a0000000-0000-4000-8000-000000000001",
  cameraBack: "a0000000-0000-4000-8000-000000000002",
  mixed: "a0000000-0000-4000-8000-000000000003",
  frontArea: "a0000000-0000-4000-8000-000000000004",
  unlinked: "a0000000-0000-4000-8000-000000000005",
  archived: "a0000000-0000-4000-8000-000000000006",
  changed: "a0000000-0000-4000-8000-000000000007",
  lagging: "a0000000-0000-4000-8000-000000000008",
};

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

const zone = (id: string, name: string, state = "active") => ({ id, name, nameKey: name.toLowerCase(), kind: "interior", state, version: 0 });
const link = (zoneId: string, camera: string, n: number) => ({ id: `${zoneId.slice(0, 6)}-l${n}`, zoneId, sourceKind: "camera", sourceRef: camera, sourceLabel: camera, state: "active" });
const sup = (id: string, target: { zoneId: string } | { camera: string }, over: Record<string, unknown> = {}) => ({
  id,
  targetKind: "zoneId" in target ? "area" : "camera",
  zoneId: "zoneId" in target ? target.zoneId : null,
  camera: "camera" in target ? target.camera : null,
  label: "person",
  days: "weekdays",
  hourFrom: 22,
  hourCount: 3,
  codes: ["out_of_place"],
  reason: "The cleaner comes late",
  createdById: STEFAN,
  createdByName: "Stefan",
  createdAt: new Date(NOW.getTime() - DAY),
  expiresAt: new Date(NOW.getTime() + 29 * DAY),
  state: "active",
  endedAt: null,
  endedById: null,
  ...over,
});

function world(): FakeSecurityPrisma {
  const b = baselineRows({
    keys: [
      { zoneKey: `area:${FRONT_AREA}`, cameras: ["front"] },
      { zoneKey: `area:${CHANGED}`, cameras: ["back", "front"] },
    ],
    sources: [],
  });
  return createFakeSecurityPrisma(
    {
      user: [
        { ...USERS.owner, role: "owner", directoryStatus: "ACTIVE" },
        { ...USERS.family, role: "family", directoryStatus: "ACTIVE" },
        { ...USERS.admin, role: "admin", directoryStatus: "ACTIVE" },
      ],
      camera: [
        { id: "cam-back", name: "back", displayName: "Back camera" },
        { id: "cam-front", name: "front", displayName: "Front door camera" },
      ],
      cameraAccessGrant: [{ id: "g1", userId: MARIA, cameraId: "cam-front" }],
      securityZone: [
        zone(MIXED, "Shop floor"),
        zone(FRONT_AREA, "Front door"),
        zone(UNLINKED, "Loft"),
        zone(ARCHIVED, "Old stock room", "archived"),
        zone(CHANGED, "Porch"),
      ],
      securityZoneLink: [link(MIXED, "front", 1), link(MIXED, "back", 2), link(FRONT_AREA, "front", 1), link(ARCHIVED, "front", 1), link(CHANGED, "front", 1)],
      securityBaselineBuild: [b.build],
      securityBaselineCell: b.cells,
      securitySuppression: [
        sup(S.cameraFront, { camera: "front" }),
        sup(S.cameraBack, { camera: "back" }),
        sup(S.mixed, { zoneId: MIXED }),
        sup(S.frontArea, { zoneId: FRONT_AREA }, { hourFrom: 6 }),
        sup(S.unlinked, { zoneId: UNLINKED }),
        sup(S.archived, { zoneId: ARCHIVED }),
        sup(S.changed, { zoneId: CHANGED }),
        // Active, but past its expiresAt: the job has not marked it yet — never listed, never counted.
        sup(S.lagging, { camera: "front" }, { expiresAt: NOW }),
      ],
      securityPatternFlag: [
        { incidentId: "i1", code: "out_of_place", effect: "suppressed", severity: "alert", suppressionId: S.cameraFront, rulesetVersion: 3, zoneKey: "camera:front", keyCameras: ["front"], evidenceEventId: 1n, evidenceCamera: "front", evidenceLabel: "person", evidenceAt: NOW, evidenceSummary: "x", detail: {} },
        { incidentId: "i1", code: "out_of_place", effect: "suppressed", severity: "alert", suppressionId: S.cameraFront, rulesetVersion: 3, zoneKey: "camera:front", keyCameras: ["front"], evidenceEventId: 2n, evidenceCamera: "front", evidenceLabel: "person", evidenceAt: NOW, evidenceSummary: "x", detail: {} },
      ],
      securitySiteHours: [{ id: "singleton", state: "set", timezone: "Europe/London", version: 1 }],
    },
    NOW,
  );
}

let f: FakeSecurityPrisma;

function app(role: Role | null, level: Level | null, resolveImpl?: () => Promise<EffectiveAccessResult | null>) {
  const resolve = vi.fn(resolveImpl ?? (async (_userId: string) => access(level, role === "owner" ? "owner" : "family")));
  const server = express();
  server.use(express.json());
  server.use((req: Request, _res: Response, next: NextFunction) => {
    if (role !== null) (req as unknown as { user?: unknown }).user = { ...USERS[role], role };
    next();
  });
  server.use("/api", createSecurityPatternsRouter(f.client as unknown as PrismaClient, { resolve, now: () => NOW }));
  return { server, resolve };
}

const audits = () =>
  h.inTx.mock.calls.map((c) => {
    const p = c[1] as { what: string; refs: Record<string, unknown> };
    return { what: p.what, refs: p.refs };
  });
const idsOf = (body: { suppressions: Array<{ id: string }> }) => body.suppressions.map((s) => s.id).sort();

beforeEach(() => {
  f = world();
  h.inTx.mockReset().mockResolvedValue({ id: 1n });
});

// ── 32 ───────────────────────────────────────────────────────────────────

describe("32 GET /api/security/suppressions (view)", () => {
  it("DS-005 (review item 9): family (front only) sees camera:front and the all-front area — nothing else", async () => {
    const res = await request(app("family", "act").server).get("/api/security/suppressions");
    expect(res.status).toBe(200);
    expect(idsOf(res.body)).toEqual([S.cameraFront, S.frontArea].sort());
  });

  it("owner/admin see every live row, archived and unlinked areas included; the lagging one is not listed", async () => {
    for (const role of ["owner", "admin"] as const) {
      const res = await request(app(role, "manage").server).get("/api/security/suppressions");
      expect(idsOf(res.body), role).toEqual([S.cameraFront, S.cameraBack, S.mixed, S.frontArea, S.unlinked, S.archived, S.changed].sort());
    }
  });

  it("the row shape: the place's name, archived, the window and the reason; sorted by place, label, hour", async () => {
    const res = await request(app("owner", "manage").server).get("/api/security/suppressions");
    expect(res.body.limit).toBe(SECURITY_SUPPRESSION_ACTIVE_LIMIT);
    expect(res.body.suppressions.map((s: { target: { name: string } }) => s.target.name)).toEqual([
      "Back camera",
      "Front door",
      "Front door camera",
      "Loft",
      "Old stock room",
      "Porch",
      "Shop floor",
    ]);
    const archived = res.body.suppressions.find((s: { id: string }) => s.id === S.archived);
    expect(archived).toEqual({
      id: S.archived,
      target: { kind: "area", zoneId: ARCHIVED, name: "Old stock room", archived: true },
      label: "person",
      days: "weekdays",
      hourFrom: 22,
      hourCount: 3,
      codes: ["out_of_place"],
      reason: "The cleaner comes late",
      createdByName: "Stefan",
      createdAt: new Date(NOW.getTime() - DAY).toISOString(),
      expiresAt: new Date(NOW.getTime() + 29 * DAY).toISOString(),
      quietedFlags: 0,
    });
  });

  it("quietedFlags: a number for owner/admin, null for anyone else (flags are owner/admin's, D16)", async () => {
    const owner = await request(app("owner", "manage").server).get("/api/security/suppressions");
    expect(owner.body.suppressions.find((s: { id: string }) => s.id === S.cameraFront).quietedFlags).toBe(2);
    const family = await request(app("family", "act").server).get("/api/security/suppressions");
    expect(family.body.suppressions.map((s: { quietedFlags: unknown }) => s.quietedFlags)).toEqual([null, null]);
  });

  it("canManage is the server's answer (D22): owner at manage yes; family no; an admin narrowed to act no; an unresolved owner yes", async () => {
    expect((await request(app("owner", "manage").server).get("/api/security/suppressions")).body.canManage).toBe(true);
    expect((await request(app("family", "manage").server).get("/api/security/suppressions")).body.canManage).toBe(false);
    expect((await request(app("admin", "act").server).get("/api/security/suppressions")).body.canManage).toBe(false);
    expect((await request(app("owner", null, async () => null).server).get("/api/security/suppressions")).body.canManage).toBe(true);
  });

  it("an outage is a 503, never an empty list: the rows, or the resolver", async () => {
    f.failOn("securitySuppression", "findMany");
    const read = await request(app("owner", "manage").server).get("/api/security/suppressions");
    expect(read.status).toBe(503);
    expect(read.body).toEqual({ error: { code: "SUPPRESSIONS_UNAVAILABLE", message: expect.any(String) } });
    const resolver = await request(app("owner", "manage", async () => Promise.reject(new Error("resolver down"))).server).get("/api/security/suppressions");
    expect(resolver.status).toBe(503);
    expect(resolver.body.error.code).toBe("SUPPRESSIONS_UNAVAILABLE");
  });

  it("any query string → 400", async () => {
    expect((await request(app("owner", "manage").server).get("/api/security/suppressions?all=1")).status).toBe(400);
  });
});

// ── 33 ───────────────────────────────────────────────────────────────────

const body = (over: Record<string, unknown> = {}) => ({
  target: { kind: "area", zoneId: FRONT_AREA },
  label: "person",
  days: "weekdays",
  hourFrom: 22,
  hourCount: 4,
  codes: ["out_of_place", "long_dwell"],
  reason: "  The cleaner comes on weekday evenings  ",
  ...over,
});

describe("33 POST /api/security/suppressions (manage)", () => {
  it("201: the row from the route's clock (30 days by default), its view, and ONE in-transaction audit without the reason", async () => {
    const res = await request(app("owner", "manage").server).post("/api/security/suppressions").send(body());
    expect(res.status).toBe(201);
    const created = f.world.securitySuppression.find((r) => r.reason === "The cleaner comes on weekday evenings")!;
    expect(created).toMatchObject({
      targetKind: "area",
      zoneId: FRONT_AREA,
      camera: null,
      codes: ["out_of_place", "long_dwell"],
      state: "active",
      createdById: STEFAN,
      createdByName: "Stefan",
      createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + 30 * DAY),
    });
    expect(res.body.suppression).toMatchObject({ id: created.id, target: { kind: "area", zoneId: FRONT_AREA, name: "Front door", archived: false }, quietedFlags: 0 });
    expect(audits()).toEqual([
      {
        what: "Security: added expected activity in Front door",
        refs: {
          surface: "security",
          action: "suppression.create",
          suppressionId: created.id,
          target: { kind: "area", zoneId: FRONT_AREA },
          label: "person",
          days: "weekdays",
          hourFrom: 22,
          hourCount: 4,
          codes: ["out_of_place", "long_dwell"],
          expiresAt: new Date(NOW.getTime() + 30 * DAY).toISOString(),
        },
      },
    ]);
    expect(JSON.stringify(h.inTx.mock.calls[0])).not.toContain("cleaner");
    expect(f.txLevels).toContain("ReadCommitted");
  });

  it("a camera target, a year", async () => {
    const res = await request(app("admin", "manage").server)
      .post("/api/security/suppressions")
      .send(body({ target: { kind: "camera", camera: "back" }, codes: ["unusual_volume"], label: "car", expiresInDays: 365 }));
    expect(res.status).toBe(201);
    expect(res.body.suppression).toMatchObject({ target: { kind: "camera", camera: "back", name: "Back camera" }, label: "car", expiresAt: new Date(NOW.getTime() + 365 * DAY).toISOString() });
    expect(audits()[0]!.what).toBe("Security: added expected activity on camera back");
  });

  it("a whole day from midnight is added (from any other hour it is a 400, below)", async () => {
    const res = await request(app("owner", "manage").server).post("/api/security/suppressions").send(body({ hourFrom: 0, hourCount: 24 }));
    expect(res.status).toBe(201);
    expect(res.body.suppression).toMatchObject({ days: "weekdays", hourFrom: 0, hourCount: 24 });
  });

  it.each([
    ["expiresInDays 0", { expiresInDays: 0 }],
    ["expiresInDays 366", { expiresInDays: 366 }],
    ["4 codes", { codes: ["out_of_place", "unusual_volume", "long_dwell", "out_of_place"] }],
    ["no code", { codes: [] }],
    ["after_hours_presence (D12)", { codes: ["after_hours_presence"] }],
    ["camera_offline beside a pattern code", { codes: ["out_of_place", "camera_offline"] }],
    ["a duplicate code", { codes: ["out_of_place", "out_of_place"] }],
    ["long_dwell for a car", { label: "car", codes: ["long_dwell"] }],
    ["an empty reason", { reason: "" }],
    ["a whitespace reason", { reason: "   " }],
    ["a 121-character reason", { reason: "x".repeat(121) }],
    ["a bidi override", { reason: "Cleaner \u202eyrros" }],
    ["U+0000", { reason: "Cleaner\u0000" }],
    ["hourCount 0", { hourCount: 0 }],
    ["hourCount 25", { hourCount: 25 }],
    // "Weekdays, all day" opened at 3 PM would quiet Saturday morning and not Monday's.
    ["a whole day from 3 PM", { hourFrom: 15, hourCount: 24 }],
    ["hourFrom 24", { hourFrom: 24 }],
    ["a fractional hour", { hourFrom: 22.5 }],
    ["an unknown key", { fromIncidentId: MISSING }],
    ["a target with an extra key", { target: { kind: "area", zoneId: FRONT_AREA, camera: "front" } }],
    ["a bad label", { label: "a person" }],
    ["unknown days", { days: "holidays" }],
  ])("400 — %s, and nothing written", async (_what, over) => {
    const res = await request(app("owner", "manage").server).post("/api/security/suppressions").send(body(over));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(f.world.securitySuppression).toHaveLength(8);
    expect(h.inTx).not.toHaveBeenCalled();
  });

  it("120 characters (code points, after trimming) is fine", async () => {
    const res = await request(app("owner", "manage").server).post("/api/security/suppressions").send(body({ reason: ` ${"é".repeat(119)}🙂 ` }));
    expect(res.status).toBe(201);
  });

  it("an archived area → 409 ZONE_ARCHIVED; a missing area and an unknown camera → ONE 404 body; nothing written", async () => {
    const archived = await request(app("owner", "manage").server).post("/api/security/suppressions").send(body({ target: { kind: "area", zoneId: ARCHIVED } }));
    expect(archived.status).toBe(409);
    expect(archived.body.error.code).toBe("ZONE_ARCHIVED");
    const missing = await request(app("owner", "manage").server).post("/api/security/suppressions").send(body({ target: { kind: "area", zoneId: MISSING } }));
    const camera = await request(app("owner", "manage").server).post("/api/security/suppressions").send(body({ target: { kind: "camera", camera: "garage" } }));
    expect(missing.status).toBe(404);
    expect(camera.status).toBe(404);
    expect(missing.body).toEqual(camera.body);
    expect(missing.body.error.code).toBe("SUPPRESSION_TARGET_NOT_FOUND");
    expect(f.world.securitySuppression).toHaveLength(8);
    expect(h.inTx).not.toHaveBeenCalled();
  });

  it("the limit: 100 live → 409 SUPPRESSION_LIMIT and nothing written; a row past its expiresAt does not count", async () => {
    // 7 live rows seeded (+ the lagging one, which does not count): top up to 99 live.
    for (let i = 0; i < 92; i += 1) f.world.securitySuppression.push(sup(`b0000000-0000-4000-8000-${String(i).padStart(12, "0")}`, { camera: "front" }));
    const ok = await request(app("owner", "manage").server).post("/api/security/suppressions").send(body());
    expect(ok.status).toBe(201);
    const full = await request(app("owner", "manage").server).post("/api/security/suppressions").send(body());
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe("SUPPRESSION_LIMIT");
    expect(f.world.securitySuppression.filter((r) => r.state === "active")).toHaveLength(101); // 100 live + the lagging one
    expect(h.inTx).toHaveBeenCalledTimes(1);
  });

  it("the limit's advisory lock is taken BEFORE the count", async () => {
    let lockedFirst = false;
    f.onCall("securitySuppression", "count", () => {
      lockedFirst = f.raw.some((sql) => sql.includes("pg_advisory_xact_lock") && sql.includes("hashtext"));
    });
    await request(app("owner", "manage").server).post("/api/security/suppressions").send(body());
    expect(lockedFirst).toBe(true);
  });

  it("the audit fails → 503 AUDIT_UNAVAILABLE and nothing created (the transaction rolled back)", async () => {
    h.inTx.mockRejectedValueOnce(new Error("chain down"));
    const res = await request(app("owner", "manage").server).post("/api/security/suppressions").send(body());
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("AUDIT_UNAVAILABLE");
    expect(f.world.securitySuppression).toHaveLength(8);
  });

  it("level pins: family → 403 at the role floor (the resolver never asked); admin at act → 404 module_disabled; admin at manage → 201", async () => {
    const family = app("family", "manage");
    expect((await request(family.server).post("/api/security/suppressions").send(body())).status).toBe(403);
    expect(family.resolve).not.toHaveBeenCalled();
    const act = app("admin", "act");
    const below = await request(act.server).post("/api/security/suppressions").send(body());
    expect(below.status).toBe(404);
    expect(act.resolve).toHaveBeenCalledWith(JORDAN);
    expect((await request(app("admin", "manage").server).post("/api/security/suppressions").send(body())).status).toBe(201);
    expect(h.inTx).toHaveBeenCalledTimes(1);
  });
});

// ── 34 ───────────────────────────────────────────────────────────────────

describe("34 POST /api/security/suppressions/:id/remove (manage)", () => {
  it("200 changed:true → removed with who and when, one audit; again → changed:false and no second audit", async () => {
    const res = await request(app("owner", "manage").server).post(`/api/security/suppressions/${S.mixed}/remove`).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ changed: true });
    expect(f.world.securitySuppression.find((r) => r.id === S.mixed)).toMatchObject({ state: "removed", endedAt: NOW, endedById: STEFAN });
    expect(audits()).toEqual([
      { what: "Security: removed expected activity in Shop floor", refs: { surface: "security", action: "suppression.remove", suppressionId: S.mixed } },
    ]);
    const again = await request(app("owner", "manage").server).post(`/api/security/suppressions/${S.mixed}/remove`).send({});
    expect(again.body).toEqual({ changed: false });
    expect(h.inTx).toHaveBeenCalledTimes(1);
  });

  it("review item 17 — an active row already past its expiresAt is not a person's to end: changed:false, no audit, untouched", async () => {
    const res = await request(app("owner", "manage").server).post(`/api/security/suppressions/${S.lagging}/remove`).send({});
    expect(res.body).toEqual({ changed: false });
    expect(f.world.securitySuppression.find((r) => r.id === S.lagging)).toMatchObject({ state: "active", endedAt: null });
    expect(h.inTx).not.toHaveBeenCalled();
  });

  it("an expired row → changed:false; a missing id → 404; a body or a non-uuid → 400", async () => {
    f.world.securitySuppression.find((r) => r.id === S.unlinked)!.state = "expired";
    f.world.securitySuppression.find((r) => r.id === S.unlinked)!.endedAt = NOW;
    expect((await request(app("owner", "manage").server).post(`/api/security/suppressions/${S.unlinked}/remove`).send({})).body).toEqual({ changed: false });
    const missing = await request(app("owner", "manage").server).post(`/api/security/suppressions/${MISSING}/remove`).send({});
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("SUPPRESSION_NOT_FOUND");
    expect((await request(app("owner", "manage").server).post(`/api/security/suppressions/${S.mixed}/remove`).send({ x: 1 })).status).toBe(400);
    expect((await request(app("owner", "manage").server).post("/api/security/suppressions/not-a-uuid/remove").send({})).status).toBe(400);
    expect(h.inTx).not.toHaveBeenCalled();
  });

  it("the audit fails → 503 and the row is still active", async () => {
    h.inTx.mockRejectedValueOnce(new Error("chain down"));
    const res = await request(app("owner", "manage").server).post(`/api/security/suppressions/${S.mixed}/remove`).send({});
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("AUDIT_UNAVAILABLE");
    expect(f.world.securitySuppression.find((r) => r.id === S.mixed)).toMatchObject({ state: "active", endedAt: null, endedById: null });
  });

  it("family → 403 at the role floor", async () => {
    expect((await request(app("family", "manage").server).post(`/api/security/suppressions/${S.mixed}/remove`).send({})).status).toBe(403);
  });
});
