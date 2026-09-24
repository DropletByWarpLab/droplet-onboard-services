/**
 * WARP-2978 (ADR-059 P3 §6.7, §7 route 22) — the notifier and the routing
 * writes against REAL Postgres.
 *
 * WHY THESE CASES RUN HERE AND NOT IN THE MOCKED LANE
 *
 *   the notifier  — the REAL recordNotification writes the NotificationLog
 *                   row inside the notice transaction and the REAL
 *                   deliverNotification stamps it after commit (web push is
 *                   closed by default here, so the push leg says so); every
 *                   notice outcome lands CHECK-valid; the `incident.alerted`
 *                   row joins the chain and the chain still verifies.
 *   the lock      — two people each turning off one of the last two eligible
 *                   receivers at the same moment: the routing advisory lock
 *                   makes exactly one win and the other answer no_recipient.
 *                   The interleaving is forced (each save waits at the count
 *                   for the other to arrive, up to a timeout), so the case
 *                   fails deterministically when the lock is missing.
 *
 * Gated on RUN_PG_INTEGRATION=1 + DATABASE_URL. Every user, camera, area and
 * incident is tagged `warp2978c`; recipient rows this file's lazy owner
 * default creates for OTHER files' owners are removed after; the audit chain
 * is only walked and cleaned after this file's floor.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.unmock("@prisma/client");

const mqtt = vi.hoisted(() => ({ publish: vi.fn() }));
vi.mock("./mqtt.service.js", () => ({ publish: mqtt.publish }));

import { notifyPendingIncidents, setAlertRouting } from "./security-alerts.service.js";
import type { EffectiveAccessResult } from "./effective-access.service.js";
import { createActivityRecorder } from "./activity.service.js";
import { _setActivityRecorderForTests } from "./activity.singleton.js";
import { createHmacSigner } from "./audit-signing.service.js";
import { verifyActivityChain } from "./audit-verify.service.js";
import {
  afterFloor,
  appendForeignRow,
  chainFloor,
  deleteAfterFloor,
  removeForeignRow,
  type ChainFloor,
} from "../__tests__/helpers/activity-chain-floor.js";

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

const TAG = "warp2978c";
const NOW = new Date("2026-09-23T21:20:00Z");

function access(level: "view" | "act" | "manage"): EffectiveAccessResult {
  return { tier: "family", features: [{ moduleId: "security", level }] } as unknown as EffectiveAccessResult;
}

describe.skipIf(!RUN)("Security alerts against real Postgres (WARP-2978)", () => {
  let prisma: PrismaClient;
  let floor: ChainFloor | null = null;
  let foreignRowId = 0n;
  const signer = createHmacSigner(Buffer.alloc(32, 29));
  let recipientsBefore = new Set<string>();
  const users: Record<string, string> = {};
  /** Only this file's people are eligible; other files' owners resolve to nothing. */
  const levels = new Map<string, "view" | "act" | "manage">();
  let hold: ((userId: string) => Promise<void>) | null = null;
  const resolve = async (userId: string): Promise<EffectiveAccessResult | null> => {
    if (hold) await hold(userId);
    const l = levels.get(userId);
    return l ? access(l) : null;
  };

  async function sweep(): Promise<void> {
    const ids = (await prisma.user.findMany({ where: { username: { startsWith: TAG } }, select: { id: true } })).map((u) => u.id);
    const incidents = (await prisma.securityIncident.findMany({ where: { zoneName: { startsWith: TAG } }, select: { id: true } })).map((i) => i.id);
    await prisma.securityIncident.deleteMany({ where: { id: { in: incidents } } });
    await prisma.notificationLog.deleteMany({ where: { username: { startsWith: TAG } } });
    await prisma.securityAlertRecipient.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.securityZone.deleteMany({ where: { name: { startsWith: TAG } } });
  }

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } = await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
    _setActivityRecorderForTests(createActivityRecorder({ prisma, signer }), signer);
    foreignRowId = await appendForeignRow(prisma, `${TAG} another file's row`);
    floor = await chainFloor(prisma);
    await sweep();
    recipientsBefore = new Set((await prisma.securityAlertRecipient.findMany({ select: { userId: true } })).map((r) => r.userId));
    for (const [key, role] of [
      ["owner", "owner"],
      ["maria", "family"],
      ["jordan", "family"],
    ] as const) {
      const u = await prisma.user.create({ data: { username: `${TAG}-${key}`, displayName: key[0]!.toUpperCase() + key.slice(1), role } });
      users[key] = u.id;
    }
  });

  afterAll(async () => {
    await sweep();
    // The owner default this file's reads created for OTHER files' owners.
    await prisma.securityAlertRecipient.deleteMany({ where: { userId: { notIn: [...recipientsBefore] }, origin: "owner_default" } });
    await deleteAfterFloor(prisma, floor);
    const foreignRowKept = await removeForeignRow(prisma, foreignRowId);
    _setActivityRecorderForTests(null, null);
    await prisma.$disconnect();
    expect(foreignRowKept).toBe(true);
  });

  it("notifies on real rows: the log row by username inside the notice transaction, stamped after commit; every notice CHECK-valid; audited", async () => {
    levels.set(users.owner!, "manage");
    levels.set(users.maria!, "act");
    const zone = await prisma.securityZone.create({ data: { name: `${TAG} Stock room`, nameKey: `${TAG} stock room`, kind: "interior" } });
    await prisma.securityAlertRecipient.create({ data: { userId: users.maria!, state: "receiving", origin: "chosen", setById: users.owner! } });
    const incident = await prisma.securityIncident.create({
      data: {
        scope: "area",
        zoneId: zone.id,
        zoneName: zone.name,
        zoneKind: "interior",
        zoneLinkIds: [],
        openedInMode: "closed",
        state: "open",
        severity: "alert",
        reasonCodes: ["after_hours_presence"],
        notifyState: "pending",
        alertedAt: NOW,
        rulesetVersion: 1,
        firstActivityAt: NOW,
        lastActivityAt: NOW,
        lastArrivalAt: NOW,
        eventCount: 1,
        countsByCamera: { [`${TAG}_back`]: { person: 1 } },
        cameras: [`${TAG}_back`],
        reasons: {
          create: {
            code: "after_hours_presence",
            severity: "alert",
            rulesetVersion: 1,
            evidenceEventId: 1n,
            evidenceCamera: `${TAG}_back`,
            evidenceSource: "frigate",
            evidenceKind: "detection",
            evidenceLabel: "person",
            evidenceAt: NOW,
            evidenceSummary: "Person seen",
            detail: { mode: "closed", modeSource: "schedule", nonOpenAt: NOW.toISOString(), zoneKind: "interior" },
          },
        },
      },
    });

    await notifyPendingIncidents(prisma, { isSecurityModuleOn: async () => true, resolveAccess: resolve }, NOW);

    expect(await prisma.securityIncident.findUniqueOrThrow({ where: { id: incident.id } })).toMatchObject({ notifyState: "done" });
    const notices = await prisma.securityIncidentNotice.findMany({ where: { incidentId: incident.id }, orderBy: { username: "asc" } });
    const byUser = new Map(notices.map((n) => [n.userId, n]));
    // Maria has no grant on the camera: skipped, settled, no log row.
    expect(byUser.get(users.maria!)).toMatchObject({ outcome: "skipped_not_visible", notificationLogId: null });
    expect(byUser.get(users.maria!)!.settledAt).not.toBeNull();
    const owner = byUser.get(users.owner!)!;
    expect(owner).toMatchObject({ username: `${TAG}-owner`, reason: "routed", outcome: "sent", channels: "toast" });
    expect(owner.pushOutcome).not.toBeNull();
    const log = await prisma.notificationLog.findUniqueOrThrow({ where: { id: owner.notificationLogId! } });
    expect(log).toMatchObject({ username: `${TAG}-owner`, kind: "event", url: `/security/incidents/${incident.id}`, ackState: "unacked" });
    expect(mqtt.publish).toHaveBeenCalledWith(`droplet/notifications/${TAG}-owner`, expect.objectContaining({ id: log.id, priority: "alert" }));

    const audits = await prisma.activityRow.findMany({ where: afterFloor(floor), orderBy: { id: "asc" } });
    expect(audits.map((a) => (a.refs as Record<string, unknown>)?.action)).toContain("incident.alerted");
    expect((await verifyActivityChain(prisma, signer, floor)).ok).toBe(true);
  });

  it("two saves removing the last two receivers at once: the routing lock lets exactly one win", async () => {
    levels.set(users.maria!, "act");
    levels.set(users.jordan!, "act");
    levels.set(users.owner!, "manage");
    await prisma.securityAlertRecipient.deleteMany({ where: { userId: { in: Object.values(users) } } });
    await prisma.securityAlertRecipient.createMany({
      data: [
        { userId: users.owner!, state: "not_receiving", origin: "chosen", version: 0 },
        { userId: users.maria!, state: "receiving", origin: "chosen", version: 0 },
        { userId: users.jordan!, state: "receiving", origin: "chosen", version: 0 },
      ],
    });
    const auditsBefore = await prisma.activityRow.count({ where: afterFloor(floor) });

    // Each save's count asks the resolver about the OTHER person: wait there
    // (up to 1.5 s) for the other save to reach the same point. With the lock,
    // the second save is blocked before it, so the first times out and goes on.
    // A person's FIRST resolver call is their own save's pre-transaction
    // eligibility check; the SECOND is the other save's in-transaction count.
    let arrived = 0;
    let waited = 0;
    let releaseAll!: () => void;
    const both = new Promise<void>((r) => (releaseAll = r));
    let counting = false;
    const calls = new Map<string, number>();
    hold = async (userId: string) => {
      if (!counting || (userId !== users.maria && userId !== users.jordan)) return;
      const n = (calls.get(userId) ?? 0) + 1;
      calls.set(userId, n);
      if (n !== 2) return;
      arrived++;
      if (arrived >= 2) releaseAll();
      const t0 = Date.now();
      await Promise.race([both, new Promise((r) => setTimeout(r, 1500))]);
      waited = Math.max(waited, Date.now() - t0);
    };
    const req = { user: { id: users.owner!, role: "owner" } };
    counting = true;
    const results = await Promise.all([
      setAlertRouting(prisma, resolve, req, { userId: users.maria!, state: "not_receiving", expectedVersion: 0 }, NOW),
      setAlertRouting(prisma, resolve, req, { userId: users.jordan!, state: "not_receiving", expectedVersion: 0 }, NOW),
    ]);
    counting = false;
    hold = null;

    expect(results.map((r) => r.status).sort()).toEqual(["no_recipient", "ok"]);
    // The first save reached its count and waited for the other, which the lock held back.
    expect(waited).toBeGreaterThanOrEqual(1000);
    const receiving = await prisma.securityAlertRecipient.count({ where: { userId: { in: [users.maria!, users.jordan!] }, state: "receiving" } });
    expect(receiving).toBe(1);
    expect(await prisma.activityRow.count({ where: afterFloor(floor) })).toBe(auditsBefore + 1);
    expect((await verifyActivityChain(prisma, signer, floor)).ok).toBe(true);
  });
});
