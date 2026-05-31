/**
 * Phone-home egress control — pure decision function + settings helpers
 * (WARP-613, ADR-012).
 *
 * `computeDesiredEgress` is called once per device per tick by the egress
 * reconciler and diffed against `NetworkDevice.lastAppliedEgress` to decide
 * whether to dispatch a phone-home block/unblock. Kept pure + deterministic
 * (no I/O), same shape as `schedule.service.ts`'s `computeDesiredBlocked`.
 *
 * Precedence (ADR-012): full_blocked > phone_home_blocked > open. This module
 * never *creates* a full block — the schedule ticker owns that. When a device
 * is already full-blocked we return `full_blocked`, which makes the reconciler
 * ensure NO phone-home rule is present, so an NTP carve-out can never leak past
 * a full WAN block.
 */
import type { DeviceEgressState, PrismaClient } from "@prisma/client";

export const MASTER_SETTING_KEY = "network.block_phone_home_enabled";
export const CAMERAS_SETTING_KEY = "network.cameras_block_phone_home";
// Internal, reconciler-owned APPLIED-state for the camera zone. Explicit +
// persistent (handbook "state is explicit, never derive from absence") so it
// survives the 7-day ScheduleEvent purge — the per-device path uses
// NetworkDevice.lastAppliedEgress for the same reason.
export const CAMERAS_APPLIED_KEY = "network.cameras_phone_home_applied";

interface DeviceLike {
  groups: Array<{ blockPhoneHome: boolean }>;
}

export interface ComputeEgressInput {
  masterEnabled: boolean;
  device: DeviceLike;
  /**
   * True when the schedule ticker currently holds a full WAN block on this
   * device (`lastAppliedBlocked === true`). Phone-home yields to it.
   */
  fullBlocked: boolean;
}

export function computeDesiredEgress(input: ComputeEgressInput): DeviceEgressState {
  if (input.fullBlocked) return "full_blocked";
  if (!input.masterEnabled) return "open";
  const inBlockedGroup = (input.device.groups ?? []).some((g) => g.blockPhoneHome);
  return inBlockedGroup ? "phone_home_blocked" : "open";
}

// --- Settings I/O ---
//
// The master + camera toggles live in WorkspaceSetting (section `hardware`,
// type `bool`) so they show up in the generic Settings tree, but writes flow
// through the phone-home routes (which upsert) and enforcement is the
// reconciler's job — there is no immediate router dispatch on write.

export async function readBoolSetting(prisma: PrismaClient, key: string): Promise<boolean> {
  const row = await prisma.workspaceSetting.findUnique({ where: { key } });
  return row?.valueJson === true;
}

export interface PhoneHomeSettings {
  enabled: boolean;
  cameras: boolean;
}

export async function getPhoneHomeSettings(prisma: PrismaClient): Promise<PhoneHomeSettings> {
  const [enabled, cameras] = await Promise.all([
    readBoolSetting(prisma, MASTER_SETTING_KEY),
    readBoolSetting(prisma, CAMERAS_SETTING_KEY),
  ]);
  return { enabled, cameras };
}

export async function setPhoneHomeSetting(
  prisma: PrismaClient,
  key: typeof MASTER_SETTING_KEY | typeof CAMERAS_SETTING_KEY,
  value: boolean,
): Promise<void> {
  await prisma.workspaceSetting.upsert({
    where: { key },
    update: { valueJson: value },
    create: { key, section: "hardware", type: "bool", valueJson: value },
  });
}

// --- Applied-state view (WARP-613 option A) ---
//
// The dashboard card needs *applied* state, not just desired, so it can show
// "Applying… → Blocked / Can phone home" + "enforced {ago}". Source of truth:
//   - camera applied  → explicit CAMERAS_APPLIED_KEY flag (purge-safe)
//   - device applied  → NetworkDevice.lastAppliedEgress (vs computeDesiredEgress)
//   - timestamps      → ScheduleEvent.occurredAt (reason="phone_home")
// Read-only; no schema change.

export interface ScopeView {
  desired: boolean;
  applied: boolean;
  appliedAt: string | null;
}
export interface PhoneHomeGroupView extends ScopeView {
  id: string;
  name: string;
  deviceCount: number;
}
export interface PhoneHomeView {
  enabled: ScopeView;
  cameras: ScopeView & { count: number | null };
  groups: PhoneHomeGroupView[];
  lastSync: string | null;
  pending: number;
}

const MAX_EVENT_SCAN = 500;

export async function getPhoneHomeView(prisma: PrismaClient): Promise<PhoneHomeView> {
  const { enabled: masterDesired, cameras: camerasDesired } = await getPhoneHomeSettings(prisma);

  // Camera applied-state from the explicit persistent flag (purge-safe); the
  // ScheduleEvent is kept only for the audit timestamp.
  const camerasApplied = await readBoolSetting(prisma, CAMERAS_APPLIED_KEY);
  const camEvent = await prisma.scheduleEvent.findFirst({
    where: { subjectType: "cameras", reason: "phone_home" },
    orderBy: { occurredAt: "desc" },
  });
  const camerasAppliedAt = camEvent?.occurredAt ?? null;
  // What the reconciler drives cameras to (master gates the camera scope).
  const camerasPending = (masterDesired && camerasDesired) !== camerasApplied;

  const devices = await prisma.networkDevice.findMany({ include: { groups: true } });
  const groups = await prisma.deviceGroup.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { devices: true } } },
  });

  // Per-device convergence: desired egress (given the master + group flags)
  // vs what the reconciler last applied.
  const pendingMacs = new Set<string>();
  for (const d of devices) {
    const desired = computeDesiredEgress({
      masterEnabled: masterDesired,
      device: d,
      fullBlocked: d.lastAppliedBlocked === true,
    });
    if (desired !== d.lastAppliedEgress) pendingMacs.add(d.mac);
  }

  // Most-recent applied timestamp per device (bounded scan of recent events).
  // The cap feeds the cosmetic `appliedAt` ONLY — convergence (`applied` /
  // `pending`) is computed from `lastAppliedEgress` above, unaffected by it.
  const devEvents = await prisma.scheduleEvent.findMany({
    where: { subjectType: "device", reason: "phone_home" },
    orderBy: { occurredAt: "desc" },
    take: MAX_EVENT_SCAN,
  });
  const appliedAtByMac = new Map<string, Date>();
  for (const e of devEvents) {
    if (e.deviceMac && !appliedAtByMac.has(e.deviceMac)) {
      appliedAtByMac.set(e.deviceMac, e.occurredAt);
    }
  }

  const groupViews: PhoneHomeGroupView[] = groups.map((g) => {
    const members = devices.filter((d) => d.groups.some((gg) => gg.id === g.id));
    const memberPending = members.some((m) => pendingMacs.has(m.mac));
    const times = members
      .map((m) => appliedAtByMac.get(m.mac))
      .filter((x): x is Date => x != null)
      .map((t) => t.getTime());
    const appliedAt = times.length ? new Date(Math.max(...times)).toISOString() : null;
    return {
      id: g.id,
      name: g.name,
      desired: g.blockPhoneHome,
      applied: !memberPending,
      appliedAt,
      deviceCount: g._count.devices,
    };
  });

  const groupPending = groupViews.filter((g) => !g.applied).length;
  const pending = (camerasPending ? 1 : 0) + groupPending;

  const allTimes = [
    ...(camerasAppliedAt ? [camerasAppliedAt.getTime()] : []),
    ...Array.from(appliedAtByMac.values()).map((t) => t.getTime()),
  ];
  const lastSync = allTimes.length ? new Date(Math.max(...allTimes)).toISOString() : null;

  return {
    enabled: { desired: masterDesired, applied: pending === 0, appliedAt: lastSync },
    cameras: {
      desired: camerasDesired,
      applied: camerasApplied,
      appliedAt: camerasAppliedAt ? camerasAppliedAt.toISOString() : null,
      count: null,
    },
    groups: groupViews,
    lastSync,
    pending,
  };
}
