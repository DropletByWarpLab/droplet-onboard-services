import { describe, it, expect } from "vitest";
import { computeDesiredEgress, getPhoneHomeView } from "./egress.service.js";

const inGroup = { groups: [{ blockPhoneHome: true }] };
const notInGroup = { groups: [{ blockPhoneHome: false }] };
const noGroups = { groups: [] };

describe("computeDesiredEgress", () => {
  it("yields to a full block regardless of master/group", () => {
    expect(
      computeDesiredEgress({ masterEnabled: true, device: inGroup, fullBlocked: true }),
    ).toBe("full_blocked");
    expect(
      computeDesiredEgress({ masterEnabled: false, device: inGroup, fullBlocked: true }),
    ).toBe("full_blocked");
  });

  it("is open when the master toggle is off", () => {
    expect(
      computeDesiredEgress({ masterEnabled: false, device: inGroup, fullBlocked: false }),
    ).toBe("open");
  });

  it("blocks phone-home when master is on and the device is in a blockPhoneHome group", () => {
    expect(
      computeDesiredEgress({ masterEnabled: true, device: inGroup, fullBlocked: false }),
    ).toBe("phone_home_blocked");
  });

  it("is open when master is on but no group blocks phone-home", () => {
    expect(
      computeDesiredEgress({ masterEnabled: true, device: notInGroup, fullBlocked: false }),
    ).toBe("open");
    expect(
      computeDesiredEgress({ masterEnabled: true, device: noGroups, fullBlocked: false }),
    ).toBe("open");
  });

  it("blocks when the device is in ANY blockPhoneHome group", () => {
    expect(
      computeDesiredEgress({
        masterEnabled: true,
        device: { groups: [{ blockPhoneHome: false }, { blockPhoneHome: true }] },
        fullBlocked: false,
      }),
    ).toBe("phone_home_blocked");
  });
});

function viewPrisma(opts: {
  settings: Record<string, boolean>;
  devices: any[];
  groups: any[];
  events: any[];
}) {
  const { settings, devices, groups, events } = opts;
  const match = (w: any) =>
    events
      .filter((e) => e.subjectType === w.subjectType && e.reason === w.reason)
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
  return {
    workspaceSetting: {
      findUnique: async (q: any) =>
        q.where.key in settings ? { valueJson: settings[q.where.key] } : null,
    },
    scheduleEvent: {
      findFirst: async (q: any) => match(q.where)[0] ?? null,
      findMany: async (q: any) => match(q.where),
    },
    networkDevice: { findMany: async () => devices },
    deviceGroup: { findMany: async () => groups },
  } as any;
}

describe("getPhoneHomeView", () => {
  const MASTER = "network.block_phone_home_enabled";
  const CAMS = "network.cameras_block_phone_home";
  const grp = (id: string, name: string, blockPhoneHome: boolean, count: number) => ({
    id, name, blockPhoneHome, _count: { devices: count },
  });

  it("reports cameras pending when desired-on but not yet applied", async () => {
    const view = await getPhoneHomeView(
      viewPrisma({ settings: { [MASTER]: true, [CAMS]: true }, devices: [], groups: [], events: [] }),
    );
    expect(view.cameras.desired).toBe(true);
    expect(view.cameras.applied).toBe(false);
    expect(view.pending).toBe(1);
    expect(view.enabled.applied).toBe(false);
  });

  it("reports a converged group as applied, with desired flag + appliedAt", async () => {
    const now = Date.now();
    const view = await getPhoneHomeView(
      viewPrisma({
        settings: { [MASTER]: true, [CAMS]: false },
        devices: [
          { mac: "AA", lastAppliedBlocked: null, lastAppliedEgress: "phone_home_blocked", groups: [{ id: "g1", blockPhoneHome: true }] },
        ],
        groups: [grp("g1", "IoT", true, 1)],
        events: [
          { subjectType: "cameras", reason: "phone_home", transition: "unblocked", occurredAt: new Date(now - 5000) },
          { subjectType: "device", reason: "phone_home", transition: "blocked", deviceMac: "AA", occurredAt: new Date(now - 5000) },
        ],
      }),
    );
    const g = view.groups.find((x) => x.id === "g1")!;
    expect(g.desired).toBe(true);
    expect(g.applied).toBe(true);
    expect(g.deviceCount).toBe(1);
    expect(g.appliedAt).not.toBeNull();
    expect(view.cameras.applied).toBe(false);
    expect(view.pending).toBe(0);
    expect(view.enabled.applied).toBe(true);
  });

  it("marks a group pending when a member device hasn't converged", async () => {
    const view = await getPhoneHomeView(
      viewPrisma({
        settings: { [MASTER]: true, [CAMS]: false },
        devices: [
          { mac: "BB", lastAppliedBlocked: null, lastAppliedEgress: "open", groups: [{ id: "g1", blockPhoneHome: true }] },
        ],
        groups: [grp("g1", "IoT", true, 1)],
        events: [],
      }),
    );
    expect(view.groups.find((x) => x.id === "g1")!.applied).toBe(false);
    expect(view.pending).toBe(1);
  });
});
