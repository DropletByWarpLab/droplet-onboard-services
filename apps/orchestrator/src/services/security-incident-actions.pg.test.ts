/**
 * WARP-2978 (ADR-059 P3 §6.6) — acknowledging an incident against REAL
 * Postgres, with the real audit chain.
 *
 *   two people at once — each records a row (D23), the state changes once,
 *                        two audit rows, and audit-verify still passes: the
 *                        CAS on version serialises them, and each audit is
 *                        the last statement of its own transaction;
 *   a rolled-back ack  — an audit that cannot be written rolls the whole
 *                        acknowledgement back: no ack row, no state change, no
 *                        NotificationLog ack, and no ActivityRow.
 *
 * Gated on RUN_PG_INTEGRATION=1 + DATABASE_URL. Fixtures are tagged
 * `warp2978d`; the audit chain is only walked and cleaned after this file's
 * floor (__tests__/helpers/activity-chain-floor.ts).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.unmock("@prisma/client");

import { actOnIncident, type IncidentActor } from "./security-incident-actions.js";
import type { IncidentViewer } from "./security-incident-view.js";
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

const TAG = "warp2978d";
const NOW = new Date("2026-09-23T21:30:00Z");
const T = new Date("2026-09-23T21:14:00Z");

describe.skipIf(!RUN)("Incident acknowledgement against real Postgres (WARP-2978)", () => {
  let prisma: PrismaClient;
  let floor: ChainFloor | null = null;
  let foreignRowId = 0n;
  const signer = createHmacSigner(Buffer.alloc(32, 31));
  const users: Record<string, { id: string; username: string }> = {};

  async function sweep(): Promise<void> {
    const incidents = (await prisma.securityIncident.findMany({ where: { scopeCamera: { startsWith: TAG } }, select: { id: true } })).map((i) => i.id);
    await prisma.securityIncident.deleteMany({ where: { id: { in: incidents } } });
    await prisma.notificationLog.deleteMany({ where: { username: { startsWith: TAG } } });
    await prisma.user.deleteMany({ where: { username: { startsWith: TAG } } });
  }

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } = await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
    _setActivityRecorderForTests(createActivityRecorder({ prisma, signer }), signer);
    foreignRowId = await appendForeignRow(prisma, `${TAG} another file's row`);
    floor = await chainFloor(prisma);
    await sweep();
    for (const [key, role] of [
      ["owner", "owner"],
      ["maria", "family"],
    ] as const) {
      const u = await prisma.user.create({ data: { username: `${TAG}-${key}`, displayName: key, role } });
      users[key] = { id: u.id, username: u.username };
    }
  });

  afterAll(async () => {
    await sweep();
    await deleteAfterFloor(prisma, floor);
    const foreignRowKept = await removeForeignRow(prisma, foreignRowId);
    _setActivityRecorderForTests(null, null);
    await prisma.$disconnect();
    expect(foreignRowKept).toBe(true);
  });

  const viewer = (key: string): IncidentViewer => ({ userId: users[key]!.id, visibleCameras: "all", mayReadThreats: true, ownerOrAdmin: true });
  const actor = (key: string, role: string): IncidentActor => ({
    id: users[key]!.id,
    username: users[key]!.username,
    role,
    displayName: key === "owner" ? "Stefan" : "Maria",
    sessionId: `sess-${key}`,
    sessionChecked: true,
    client: "droplet-ios/1.4.0 (iOS 18.2)",
  });

  async function openIncident(camera: string): Promise<string> {
    const i = await prisma.securityIncident.create({
      data: {
        scope: "camera",
        scopeCamera: camera,
        zoneLinkIds: [],
        openedInMode: "closed",
        state: "open",
        severity: "notice",
        reasonCodes: ["camera_offline"],
        rulesetVersion: 1,
        firstActivityAt: T,
        lastActivityAt: T,
        lastArrivalAt: T,
        eventCount: 1,
        countsByCamera: { [camera]: { _status: 1 } },
        spanByCamera: { [camera]: { first: T.toISOString(), last: T.toISOString() } },
        cameras: [camera],
        reasons: {
          create: {
            code: "camera_offline",
            severity: "notice",
            rulesetVersion: 1,
            evidenceEventId: 9n,
            evidenceCamera: camera,
            evidenceSource: "frigate_status",
            evidenceKind: "camera_offline",
            evidenceAt: T,
            evidenceSummary: "Camera stopped reporting",
            detail: { offlineForSec: null, backAt: null },
          },
        },
      },
    });
    return i.id;
  }

  it("two people acknowledge at once: two rows, one state change, two audits — and the chain verifies", async () => {
    const id = await openIncident(`${TAG}_c1`);
    const results = await Promise.all([
      actOnIncident(prisma, { incidentId: id, action: "acknowledge", actor: actor("owner", "owner"), viewer: viewer("owner"), now: NOW }),
      actOnIncident(prisma, { incidentId: id, action: "acknowledge", actor: actor("maria", "family"), viewer: viewer("maria"), now: NOW }),
    ]);
    expect(results).toEqual([
      { status: "ok", changed: true },
      { status: "ok", changed: true },
    ]);
    const acks = await prisma.securityIncidentAck.findMany({ where: { incidentId: id } });
    expect(acks.map((a) => a.byUserId).sort()).toEqual([users.maria!.id, users.owner!.id].sort());
    expect(acks.every((a) => a.sessionChecked && a.sessionId !== null)).toBe(true);
    const incident = await prisma.securityIncident.findUniqueOrThrow({ where: { id } });
    expect(incident.state).toBe("acknowledged");
    // One state change (by whoever won), and one version bump per recorded ack.
    expect(incident.version).toBe(2);
    const rows = await prisma.activityRow.findMany({ where: afterFloor(floor) });
    const mine = rows.filter((r) => (r.refs as Record<string, unknown> | null)?.incidentId === id);
    expect(mine).toHaveLength(2);
    // Review b7e1: each signed row carries what its actor could see beside the incident-wide codes.
    expect(mine.map((r) => (r.refs as Record<string, unknown>).visibleCodes)).toEqual([["camera_offline"], ["camera_offline"]]);
    expect(mine.map((r) => (r.refs as Record<string, unknown>).codes)).toEqual([["camera_offline"], ["camera_offline"]]);
    expect((await verifyActivityChain(prisma, signer, floor)).ok).toBe(true);
  });

  it("a rolled-back acknowledgement leaves no ack row, no state change, no notification ack, and no ActivityRow", async () => {
    const id = await openIncident(`${TAG}_c2`);
    const log = await prisma.notificationLog.create({ data: { username: users.maria!.username, kind: "event", title: "t", channels: "toast" } });
    await prisma.securityIncidentNotice.create({
      data: { incidentId: id, userId: users.maria!.id, username: users.maria!.username, reason: "routed", outcome: "sent", notificationLogId: log.id, channels: "toast", settledAt: T },
    });
    const before = await prisma.activityRow.count({ where: afterFloor(floor) });
    _setActivityRecorderForTests(null, null);
    try {
      await expect(
        actOnIncident(prisma, { incidentId: id, action: "acknowledge", actor: actor("maria", "family"), viewer: viewer("maria"), now: NOW }),
      ).rejects.toBeTruthy();
    } finally {
      _setActivityRecorderForTests(createActivityRecorder({ prisma, signer }), signer);
    }
    expect(await prisma.securityIncidentAck.count({ where: { incidentId: id } })).toBe(0);
    expect(await prisma.securityIncident.findUniqueOrThrow({ where: { id } })).toMatchObject({ state: "open", version: 0 });
    expect(await prisma.notificationLog.findUniqueOrThrow({ where: { id: log.id } })).toMatchObject({ ackState: "unacked", ackMethod: null });
    expect(await prisma.activityRow.count({ where: afterFloor(floor) })).toBe(before);

    // And with the recorder back, the same acknowledgement goes through and acks her row.
    await actOnIncident(prisma, { incidentId: id, action: "acknowledge", actor: actor("maria", "family"), viewer: viewer("maria"), now: NOW });
    expect(await prisma.notificationLog.findUniqueOrThrow({ where: { id: log.id } })).toMatchObject({ ackState: "acked", ackMethod: "incident" });
    expect((await verifyActivityChain(prisma, signer, floor)).ok).toBe(true);
  });
});
