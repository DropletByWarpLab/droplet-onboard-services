/**
 * Schedule ticker (WARP-93).
 *
 * Runs every 30s (configurable via SCHEDULE_TICK_MS): fetches every
 * NetworkDevice + its relevant enabled schedules + currently-active
 * overrides, computes the desired firewall state via
 * `computeDesiredBlocked`, diffs against what the firewall reports, and
 * dispatches block/unblock via the injected FirewallClient. Every
 * successful transition writes a ScheduleEvent row for the audit log.
 *
 * Error handling: if the firewall call throws RouterError (router
 * unreachable, auth, disabled, etc.) we log at `warn` and skip the
 * event emission — the prior state stands and we'll try again on the
 * next tick. Unexpected errors are logged at `error` but also don't
 * emit an event (since the transition didn't happen).
 *
 * The FirewallClient's `isBlocked` is best-effort — see the adapter in
 * `index.ts`. Over-attempting on stale state is fine because the
 * routing service's block/unblock endpoints are idempotent.
 */
import type { PrismaClient } from "@prisma/client";
import pino from "pino";
import { computeDesiredBlocked } from "./schedule.service.js";
import { RouterError } from "../types/router-error.js";

const log = pino({ name: "schedule-ticker" });

export interface FirewallClient {
  block(mac: string): Promise<void>;
  unblock(mac: string): Promise<void>;
  /**
   * Best-effort lookup of the live firewall state for `mac`. The ticker
   * uses this to skip no-op dispatches. Returning a stale value is
   * acceptable since the routing service's block/unblock endpoints are
   * idempotent.
   */
  isBlocked(mac: string): boolean;
}

export interface ScheduleTicker {
  tickOnce(): Promise<void>;
}

export function createScheduleTicker(
  prisma: PrismaClient,
  firewall: FirewallClient,
): ScheduleTicker {
  async function tickOnce() {
    const now = new Date();
    const devices = await (prisma as any).networkDevice.findMany({
      include: { groups: true },
    });
    const schedules = await (prisma as any).schedule.findMany({
      where: { enabled: true },
      include: { windows: true },
    });
    const overrides = await (prisma as any).scheduleOverride.findMany({
      where: { AND: [{ startAt: { lte: now } }, { endAt: { gt: now } }] },
    });

    const deviceSchedulesByMac = new Map<string, any[]>();
    const groupSchedulesByGroupId = new Map<string, any[]>();
    for (const s of schedules) {
      if (s.subjectType === "device" && s.deviceMac) {
        const arr = deviceSchedulesByMac.get(s.deviceMac) ?? [];
        arr.push(s);
        deviceSchedulesByMac.set(s.deviceMac, arr);
      } else if (s.subjectType === "group" && s.groupId) {
        const arr = groupSchedulesByGroupId.get(s.groupId) ?? [];
        arr.push(s);
        groupSchedulesByGroupId.set(s.groupId, arr);
      }
    }

    const overridesByMac = new Map<string, any[]>();
    const overridesByGroupId = new Map<string, any[]>();
    for (const o of overrides) {
      if (o.subjectType === "device" && o.deviceMac) {
        const arr = overridesByMac.get(o.deviceMac) ?? [];
        arr.push(o);
        overridesByMac.set(o.deviceMac, arr);
      } else if (o.subjectType === "group" && o.groupId) {
        const arr = overridesByGroupId.get(o.groupId) ?? [];
        arr.push(o);
        overridesByGroupId.set(o.groupId, arr);
      }
    }

    for (const device of devices) {
      const groupIds: string[] = (device.groups ?? []).map((g: any) => g.id);
      const deviceSchedules = deviceSchedulesByMac.get(device.mac) ?? [];
      const groupSchedules = groupIds.flatMap(
        (gid) => groupSchedulesByGroupId.get(gid) ?? [],
      );
      const activeOverrides = [
        ...(overridesByMac.get(device.mac) ?? []),
        ...groupIds.flatMap((gid) => overridesByGroupId.get(gid) ?? []),
      ];

      const { blocked: desired, reason } = computeDesiredBlocked({
        device,
        deviceSchedules,
        groupSchedules,
        activeOverrides,
        now,
      });

      const current = firewall.isBlocked(device.mac);
      if (desired === current) continue;

      try {
        if (desired) await firewall.block(device.mac);
        else await firewall.unblock(device.mac);

        await (prisma as any).scheduleEvent.create({
          data: {
            subjectType: "device",
            deviceMac: device.mac,
            transition: desired ? "blocked" : "unblocked",
            reason,
            occurredAt: now,
          },
        });
      } catch (err) {
        if (err instanceof RouterError) {
          log.warn(
            { mac: device.mac, code: err.code },
            "firewall error; preserving state",
          );
        } else {
          log.error({ err, mac: device.mac }, "ticker dispatch failed");
        }
      }
    }
  }

  return { tickOnce };
}
