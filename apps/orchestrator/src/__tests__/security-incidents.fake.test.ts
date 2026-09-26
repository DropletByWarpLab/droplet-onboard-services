/**
 * WARP-2978 (review R3) — the incident fake's transactions are the shared
 * WARP-1570 seam's, not a hand-rolled stub: the isolation level reaches it,
 * a throwing callback rolls every table back, and a RepeatableRead
 * transaction that lost a write-conflict aborts with P2034 while the
 * transaction that won keeps its write.
 */
import { describe, expect, it } from "vitest";
import { createFakeSecurityPrisma } from "./security-incidents.fake.js";

type Tx = { user: { update(a: unknown): Promise<unknown>; create(a: unknown): Promise<unknown> } };
type Client = { $transaction(fn: (tx: Tx) => Promise<unknown>, opts?: { isolationLevel?: string }): Promise<unknown> };

const U1 = "5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const U2 = "6b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e";

function fake() {
  const f = createFakeSecurityPrisma({
    user: [{ id: U1, username: "maria", displayName: "Maria", role: "family", directoryStatus: "ACTIVE" }],
  });
  return { f, client: f.client as unknown as Client };
}

describe("the incident fake's transactions (the WARP-1570 seam)", () => {
  it("records the isolation level asked for, and a throwing callback rolls every table back", async () => {
    const { f, client } = fake();
    await expect(
      client.$transaction(
        async (tx) => {
          await tx.user.update({ where: { id: U1 }, data: { displayName: "Changed" } });
          await tx.user.create({ data: { id: U2, username: "jordan", displayName: "Jordan", role: "admin", directoryStatus: "ACTIVE" } });
          throw new Error("boom");
        },
        { isolationLevel: "ReadCommitted" },
      ),
    ).rejects.toThrow("boom");
    expect(f.world.user).toEqual([expect.objectContaining({ id: U1, displayName: "Maria" })]);
    expect(f.txLevels).toEqual(["ReadCommitted"]);
    expect(f.txDepth()).toBe(0);
  });

  it("two overlapping RepeatableRead writers of one row: the later committer aborts with P2034; the winner's write survives the rollback", async () => {
    const { f, client } = fake();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const loser = client.$transaction(
      async (tx) => {
        await tx.user.update({ where: { id: U1 }, data: { displayName: "Loser" } });
        entered();
        await gate;
      },
      { isolationLevel: "RepeatableRead" },
    );
    await inside;
    await client.$transaction(async (tx) => tx.user.update({ where: { id: U1 }, data: { displayName: "Winner" } }), {
      isolationLevel: "RepeatableRead",
    });
    release();
    await expect(loser).rejects.toMatchObject({ code: "P2034" });
    expect(f.world.user.find((u) => u.id === U1)).toMatchObject({ displayName: "Winner" });
    expect(f.txLevels).toEqual(["RepeatableRead", "RepeatableRead"]);
  });

  it("at ReadCommitted the same overlap is not a conflict (last writer wins, as in Postgres)", async () => {
    const { f, client } = fake();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const first = client.$transaction(
      async (tx) => {
        entered();
        await gate;
        await tx.user.update({ where: { id: U1 }, data: { displayName: "Later" } });
      },
      { isolationLevel: "ReadCommitted" },
    );
    await inside;
    await client.$transaction(async (tx) => tx.user.update({ where: { id: U1 }, data: { displayName: "Earlier" } }), {
      isolationLevel: "ReadCommitted",
    });
    release();
    await first;
    expect(f.world.user.find((u) => u.id === U1)).toMatchObject({ displayName: "Later" });
  });
});

/**
 * WARP-2978 PR-D — the fake mirrors SecurityEvent_ongoing_shape
 * (20260925030200), so an engine bug that would write an ill-formed ongoing
 * row fails in the mocked lane the way Postgres would refuse it.
 */
describe("the incident fake's SecurityEvent_ongoing_shape mirror", () => {
  type Events = { securityEvent: { createMany(a: unknown): Promise<{ count: number }> } };
  const ongoing = (over: Record<string, unknown> = {}) => ({
    source: "frigate",
    kind: "detection_ongoing",
    severity: "info",
    camera: "back",
    sourceRef: "back/1790000000.1-abc",
    dedupeKey: "frigate-ongoing:1790000000.1-abc",
    labels: ["person"],
    cameraZones: [],
    score: 0.9,
    startedAt: new Date("2026-09-23T21:14:00Z"),
    endedAt: null,
    summary: "Person still in view after 30 s",
    ...over,
  });

  it("accepts a legal ongoing row", async () => {
    const f = createFakeSecurityPrisma();
    await expect((f.client as unknown as Events).securityEvent.createMany({ data: [ongoing()] })).resolves.toEqual({ count: 1 });
  });

  it.each([
    ["another source", { source: "frigate_status" }],
    ["no camera", { camera: null }],
    ["an end time", { endedAt: new Date("2026-09-23T21:15:00Z") }],
    ["a finished detection's key", { dedupeKey: "frigate:1790000000.1-abc" }],
  ])("refuses an ongoing row with %s", async (_name, over) => {
    const f = createFakeSecurityPrisma();
    await expect((f.client as unknown as Events).securityEvent.createMany({ data: [ongoing(over)] })).rejects.toThrow(
      /SecurityEvent_ongoing_shape/,
    );
    expect(f.world.securityEvent).toHaveLength(0);
  });
});

/**
 * Review 383d647e item 4 — the fake mirrors SecurityIncidentReason_site_evidence
 * (20260925030000), so an engine bug that would write a camera-less reason on
 * an area or camera incident fails in the mocked lane as Postgres refuses it.
 */
describe("the incident fake's SecurityIncidentReason_site_evidence mirror", () => {
  type Reasons = { securityIncidentReason: { createMany(a: unknown): Promise<{ count: number }> } };
  const reason = (code: string, severity: string, evidenceKind: string, evidenceCamera: string | null) => ({
    incidentId: "00000000-0000-4000-8000-0000000029a1",
    code,
    severity,
    rulesetVersion: 1,
    evidenceEventId: 1n,
    evidenceCamera,
    evidenceSource: "frigate_status",
    evidenceKind,
    evidenceAt: new Date("2026-09-23T21:14:00Z"),
    evidenceSummary: "x",
    detail: {},
  });

  it.each([
    ["a camera's alert", reason("after_hours_presence", "alert", "detection", "back")],
    ["a camera's offline notice", reason("camera_offline", "notice", "camera_offline", "back")],
    ["the camera system's offline notice", reason("camera_offline", "notice", "source_offline", null)],
    ["a threat", reason("threat_signal", "notice", "threat", null)],
  ])("accepts %s", async (_name, row) => {
    const f = createFakeSecurityPrisma();
    await expect((f.client as unknown as Reasons).securityIncidentReason.createMany({ data: [row] })).resolves.toEqual({ count: 1 });
  });

  it.each([
    ["an alert without a camera", reason("after_hours_presence", "alert", "detection", null)],
    ["a camera's offline notice without the camera", reason("camera_offline", "notice", "camera_offline", null)],
    ["a threat code on a camera's row", reason("threat_signal", "notice", "source_offline", null)],
  ])("refuses %s", async (_name, row) => {
    const f = createFakeSecurityPrisma();
    await expect((f.client as unknown as Reasons).securityIncidentReason.createMany({ data: [row] })).rejects.toThrow(
      /SecurityIncidentReason_site_evidence/,
    );
    expect(f.world.securityIncidentReason).toHaveLength(0);
  });
});

/**
 * WARP-2980 P5 PR-B — the fake mirrors 20260925060100's CHECKs, so an engine
 * or route bug that would write a flag, an expected activity or a verdict
 * Postgres refuses fails in the mocked lane too (the pg lane pins the real
 * text: security-pattern-flags.pg.test.ts). One legal row and one refusal per
 * rule the mocked suites lean on.
 */
describe("the incident fake's WARP-2980 PR-B mirrors", () => {
  type Tables = Record<string, { createMany(a: unknown): Promise<{ count: number }>; updateMany(a: unknown): Promise<{ count: number }> }>;
  const INC = "00000000-0000-4000-8000-0000000029a1";
  const at = new Date("2026-09-23T21:14:00Z");
  const flag = (over: Record<string, unknown> = {}) => ({
    incidentId: INC,
    code: "out_of_place",
    effect: "trial",
    severity: "alert",
    rulesetVersion: 3,
    zoneKey: "camera:back",
    keyCameras: ["back"],
    evidenceEventId: 1n,
    evidenceCamera: "back",
    evidenceLabel: "person",
    evidenceAt: at,
    evidenceSummary: "x",
    detail: {},
    ...over,
  });
  const suppression = (over: Record<string, unknown> = {}) => ({
    targetKind: "camera",
    camera: "back",
    label: "person",
    days: "weekdays",
    hourFrom: 22,
    hourCount: 3,
    codes: ["out_of_place"],
    reason: "The cleaner",
    createdById: "u-owner",
    createdByName: "Maria",
    createdAt: at,
    expiresAt: new Date(at.getTime() + 30 * 86_400_000),
    ...over,
  });

  it("accepts a legal flag and a legal expected activity; a fresh incident is unreviewed", async () => {
    const f = createFakeSecurityPrisma({ securityIncident: [{ id: INC, scope: "camera", scopeCamera: "back" }] });
    const t = f.client as unknown as Tables;
    await expect(t.securityPatternFlag!.createMany({ data: [flag()] })).resolves.toEqual({ count: 1 });
    await expect(t.securitySuppression!.createMany({ data: [suppression()] })).resolves.toEqual({ count: 1 });
    await expect(t.securitySuppression!.createMany({ data: [suppression({ hourFrom: 0, hourCount: 24 })] })).resolves.toEqual({ count: 1 });
    expect(f.world.securityIncident[0]).toMatchObject({ verdict: "unreviewed", verdictCodes: [], verdictAt: null });
  });

  it.each([
    ["an alert for a cat", { evidenceLabel: "cat" }],
    ["unusual_volume at alert", { code: "unusual_volume" }],
    ["suppressed without a suppression", { effect: "suppressed" }],
    ["an evidence camera outside keyCameras", { zoneKey: "area:00000000-0000-4000-8000-0000000029a2", keyCameras: ["front"] }],
    ["a camera key with another camera behind it", { keyCameras: ["back", "front"] }],
    ["ruleset v2", { rulesetVersion: 2 }],
  ])("refuses a flag with %s", async (_name, over) => {
    const f = createFakeSecurityPrisma({ securityIncident: [{ id: INC, scope: "camera", scopeCamera: "back" }] });
    await expect((f.client as unknown as Tables).securityPatternFlag!.createMany({ data: [flag(over)] })).rejects.toThrow(
      /SecurityPatternFlag_shape/,
    );
  });

  it.each([
    ["after_hours_presence", { codes: ["after_hours_presence"] }],
    ["long_dwell for a car", { label: "car", codes: ["long_dwell"] }],
    ["366 days", { expiresAt: new Date(at.getTime() + 366 * 86_400_000) }],
    ["removed without who", { state: "removed", endedAt: at }],
    ["a whole day from 3 PM", { hourFrom: 15, hourCount: 24 }],
  ])("refuses expected activity with %s", async (_name, over) => {
    const f = createFakeSecurityPrisma();
    await expect((f.client as unknown as Tables).securitySuppression!.createMany({ data: [suppression(over)] })).rejects.toThrow(
      /SecuritySuppression_shape/,
    );
  });

  it("refuses a verdict without its codes, or a mark without who", async () => {
    const f = createFakeSecurityPrisma({ securityIncident: [{ id: INC, scope: "camera", scopeCamera: "back" }] });
    const t = f.client as unknown as Tables;
    const mark = { verdict: "expected", verdictAt: at, verdictFirstAt: at, verdictById: "u", verdictByName: "Maria", verdictCodes: ["camera_offline"] };
    await expect(t.securityIncident!.updateMany({ where: { id: INC }, data: { ...mark, verdictCodes: [] } })).rejects.toThrow(
      /SecurityIncident_verdict_shape/,
    );
    await expect(t.securityIncident!.updateMany({ where: { id: INC }, data: { ...mark, verdictByName: null } })).rejects.toThrow(
      /SecurityIncident_verdict_shape/,
    );
    await expect(t.securityIncident!.updateMany({ where: { id: INC }, data: mark })).resolves.toEqual({ count: 1 });
  });
});
