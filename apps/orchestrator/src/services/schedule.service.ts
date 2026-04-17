/**
 * Pure decision function for Phase 2 scheduling (WARP-93).
 *
 * Given a device + its relevant schedules/overrides + "now", return the
 * desired firewall state. The ticker calls this once per device per tick
 * and diffs against the live firewall state to decide whether to dispatch
 * a block/unblock.
 *
 * Priority (highest first):
 *   1. Override action="block"  → blocked, reason="override_applied"
 *   2. Override action="allow"  → unblocked, reason="override_applied"
 *   3. device.manualBlock       → blocked, reason="manual_block"
 *   4. Device-level schedule active → blocked, reason="schedule_window_start"
 *      (device-level PRECEDES group-level — if a device has ANY enabled
 *      schedules, group schedules are ignored for that device, even if
 *      the device's own schedules are all inactive right now.)
 *   5. Group-level schedule active (only when device has no device-level
 *      schedules) → blocked, reason="schedule_window_start"
 *   6. Otherwise → unblocked, reason="schedule_window_end"
 *
 * Disabled schedules (enabled=false) are filtered out entirely — they
 * don't count toward device-level precedence either. The `activeOverrides`
 * list is assumed to already be filtered to overrides whose [startAt, endAt)
 * covers `now`; the ticker does that filter via a Prisma `where` clause so
 * this function can stay pure and deterministic.
 */
import { isWindowActive, type ScheduleWindowLike } from "../lib/schedule-window.js";

interface DeviceLike {
  mac: string;
  manualBlock: boolean;
  groups: Array<{ id: string }>;
}
interface ScheduleLike {
  id: string;
  enabled: boolean;
  subjectType: "device" | "group";
  windows: ScheduleWindowLike[];
}
interface OverrideLike {
  id: string;
  action: "allow" | "block";
  startAt: Date;
  endAt: Date;
}

export interface ComputeInput {
  device: DeviceLike;
  deviceSchedules: ScheduleLike[];
  groupSchedules: ScheduleLike[];
  activeOverrides: OverrideLike[];
  now: Date;
}

export type ComputeReason =
  | "override_applied"
  | "manual_block"
  | "schedule_window_start"
  | "schedule_window_end";

export interface ComputeResult {
  blocked: boolean;
  reason: ComputeReason;
}

export function computeDesiredBlocked(input: ComputeInput): ComputeResult {
  // Priority 1: active overrides — block wins if both present.
  const activeBlock = input.activeOverrides.some((o) => o.action === "block");
  if (activeBlock) return { blocked: true, reason: "override_applied" };
  const activeAllow = input.activeOverrides.some((o) => o.action === "allow");
  if (activeAllow) return { blocked: false, reason: "override_applied" };

  // Priority 2: manual block.
  if (input.device.manualBlock) return { blocked: true, reason: "manual_block" };

  // Priority 3: schedules (device-level precedence).
  // If device has ANY enabled device-level schedule, we evaluate ONLY those.
  // Otherwise fall through to enabled group-level schedules.
  const enabledDeviceSchedules = input.deviceSchedules.filter((s) => s.enabled);
  const enabledGroupSchedules = input.groupSchedules.filter((s) => s.enabled);
  const pool =
    enabledDeviceSchedules.length > 0 ? enabledDeviceSchedules : enabledGroupSchedules;

  for (const s of pool) {
    for (const w of s.windows) {
      if (isWindowActive(w, input.now)) {
        return { blocked: true, reason: "schedule_window_start" };
      }
    }
  }
  return { blocked: false, reason: "schedule_window_end" };
}
