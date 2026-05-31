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
