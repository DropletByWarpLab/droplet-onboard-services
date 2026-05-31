import { describe, it, expect, vi } from "vitest";
import { createEgressReconciler } from "./egress-reconciler.js";
import { RouterError } from "../types/router-error.js";
import { MASTER_SETTING_KEY, CAMERAS_SETTING_KEY } from "./egress.service.js";

// In-memory prisma mock mirroring schedule-ticker.test.ts. Devices carry
// `lastAppliedEgress` (mutated via networkDevice.update inside a $transaction)
// and `lastAppliedBlocked` (read-only here — owned by the schedule ticker).
function makePrisma(settings: Record<string, boolean> = {}) {
  const devices = new Map<string, any>();
  const events: any[] = [];

  const networkDevice = {
    findMany: vi.fn(async () =>
      Array.from(devices.values()).map((d) => ({
        ...d,
        groups: d.groups ?? [],
        lastAppliedBlocked: d.lastAppliedBlocked ?? null,
        lastAppliedEgress: d.lastAppliedEgress ?? "open",
      })),
    ),
    update: vi.fn(async (q: any) => {
      const row = devices.get(q.where.mac);
      if (row) Object.assign(row, q.data);
      return row;
    }),
  };
  const workspaceSetting = {
    findUnique: vi.fn(async (q: any) => {
      const key = q.where.key;
      return key in settings ? { key, valueJson: settings[key] } : null;
    }),
  };
  const scheduleEvent = {
    create: vi.fn(async (q: any) => {
      events.push(q.data);
      return q.data;
    }),
    findFirst: vi.fn(async (q: any) => {
      const w = q?.where ?? {};
      const matches = events
        .filter(
          (e) =>
            (w.subjectType === undefined || e.subjectType === w.subjectType) &&
            (w.reason === undefined || e.reason === w.reason),
        )
        .sort((a, b) => (b.occurredAt?.getTime?.() ?? 0) - (a.occurredAt?.getTime?.() ?? 0));
      return matches[0] ?? null;
    }),
  };
  const $transaction = vi.fn(async (ops: any[]) => {
    const out: any[] = [];
    for (const op of ops) out.push(await op);
    return out;
  });

  return { _stores: { devices, events }, networkDevice, workspaceSetting, scheduleEvent, $transaction };
}

function makeEgress() {
  return {
    blockPhoneHome: vi.fn(async (_mac: string) => {}),
    unblockPhoneHome: vi.fn(async (_mac: string) => {}),
    setCameraPhoneHome: vi.fn(async (_blocked: boolean) => {}),
  };
}

const MAC = "AA:BB:CC:DD:EE:FF";

describe("egress-reconciler — camera pass", () => {
  it("blocks the camera VLAN when master AND cameras are on, once, and records an event", async () => {
    const prisma = makePrisma({ [MASTER_SETTING_KEY]: true, [CAMERAS_SETTING_KEY]: true }) as any;
    const egress = makeEgress();
    const r = createEgressReconciler(prisma, egress);

    await r.tickOnce();
    expect(egress.setCameraPhoneHome).toHaveBeenCalledWith(true);
    expect(prisma.scheduleEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ subjectType: "cameras", transition: "blocked", reason: "phone_home" }),
      }),
    );
    // Second tick: applied (from the persisted event) now matches desired — no re-dispatch.
    await r.tickOnce();
    expect(egress.setCameraPhoneHome).toHaveBeenCalledTimes(1);
  });

  it("does NOT dispatch when desired already matches applied (master off, no prior event)", async () => {
    const prisma = makePrisma({ [MASTER_SETTING_KEY]: false, [CAMERAS_SETTING_KEY]: true }) as any;
    const egress = makeEgress();
    await createEgressReconciler(prisma, egress).tickOnce();
    expect(egress.setCameraPhoneHome).not.toHaveBeenCalled();
  });

  it("unblocks cameras when master goes off after a prior applied-on", async () => {
    const prisma = makePrisma({ [MASTER_SETTING_KEY]: false, [CAMERAS_SETTING_KEY]: true }) as any;
    // Seed a prior 'blocked' camera event so applied = true.
    prisma._stores.events.push({
      subjectType: "cameras",
      reason: "phone_home",
      transition: "blocked",
      occurredAt: new Date(Date.now() - 1000),
    });
    const egress = makeEgress();
    await createEgressReconciler(prisma, egress).tickOnce();
    expect(egress.setCameraPhoneHome).toHaveBeenCalledWith(false);
  });
});

describe("egress-reconciler — per-device pass", () => {
  it("blocks phone-home for a device in a blockPhoneHome group when master is on", async () => {
    const prisma = makePrisma({ [MASTER_SETTING_KEY]: true }) as any;
    const egress = makeEgress();
    prisma._stores.devices.set(MAC, {
      mac: MAC,
      lastAppliedBlocked: null,
      lastAppliedEgress: "open",
      groups: [{ blockPhoneHome: true }],
    });

    await createEgressReconciler(prisma, egress).tickOnce();

    expect(egress.blockPhoneHome).toHaveBeenCalledWith(MAC);
    expect(prisma.networkDevice.update).toHaveBeenCalledWith({
      where: { mac: MAC },
      data: { lastAppliedEgress: "phone_home_blocked" },
    });
    expect(prisma.scheduleEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ reason: "phone_home", transition: "blocked" }) }),
    );
  });

  it("yields to a full block: removes the phone-home rule and records full_blocked", async () => {
    const prisma = makePrisma({ [MASTER_SETTING_KEY]: true }) as any;
    const egress = makeEgress();
    prisma._stores.devices.set(MAC, {
      mac: MAC,
      lastAppliedBlocked: true, // schedule ticker holds a full block
      lastAppliedEgress: "phone_home_blocked",
      groups: [{ blockPhoneHome: true }],
    });

    await createEgressReconciler(prisma, egress).tickOnce();

    // No phone-home rule should remain (the full block covers WAN; an NTP
    // carve-out would be a leak).
    expect(egress.unblockPhoneHome).toHaveBeenCalledWith(MAC);
    expect(egress.blockPhoneHome).not.toHaveBeenCalled();
    expect(prisma.networkDevice.update).toHaveBeenCalledWith({
      where: { mac: MAC },
      data: { lastAppliedEgress: "full_blocked" },
    });
  });

  it("clears the phone-home rule when master is turned off", async () => {
    const prisma = makePrisma({ [MASTER_SETTING_KEY]: false }) as any;
    const egress = makeEgress();
    prisma._stores.devices.set(MAC, {
      mac: MAC,
      lastAppliedBlocked: null,
      lastAppliedEgress: "phone_home_blocked",
      groups: [{ blockPhoneHome: true }],
    });

    await createEgressReconciler(prisma, egress).tickOnce();

    expect(egress.unblockPhoneHome).toHaveBeenCalledWith(MAC);
    expect(prisma.networkDevice.update).toHaveBeenCalledWith({
      where: { mac: MAC },
      data: { lastAppliedEgress: "open" },
    });
  });

  it("is a no-op when applied state already matches desired", async () => {
    const prisma = makePrisma({ [MASTER_SETTING_KEY]: true }) as any;
    const egress = makeEgress();
    prisma._stores.devices.set(MAC, {
      mac: MAC,
      lastAppliedBlocked: null,
      lastAppliedEgress: "phone_home_blocked",
      groups: [{ blockPhoneHome: true }],
    });

    await createEgressReconciler(prisma, egress).tickOnce();

    expect(egress.blockPhoneHome).not.toHaveBeenCalled();
    expect(egress.unblockPhoneHome).not.toHaveBeenCalled();
    expect(prisma.networkDevice.update).not.toHaveBeenCalled();
  });

  it("preserves state on RouterError and retries next tick", async () => {
    const prisma = makePrisma({ [MASTER_SETTING_KEY]: true }) as any;
    const egress = makeEgress();
    egress.blockPhoneHome.mockRejectedValueOnce(RouterError.unreachable("router down"));
    prisma._stores.devices.set(MAC, {
      mac: MAC,
      lastAppliedBlocked: null,
      lastAppliedEgress: "open",
      groups: [{ blockPhoneHome: true }],
    });

    const r = createEgressReconciler(prisma, egress);
    await r.tickOnce();
    // Device row update skipped (state preserved); no audit event.
    expect(prisma.networkDevice.update).not.toHaveBeenCalled();
    expect(prisma.scheduleEvent.create).not.toHaveBeenCalled();

    // Second tick re-attempts because lastAppliedEgress is still "open".
    await r.tickOnce();
    expect(egress.blockPhoneHome).toHaveBeenCalledTimes(2);
  });
});
