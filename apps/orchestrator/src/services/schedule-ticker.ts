/**
 * Schedule ticker (WARP-93).
 *
 * Runs every 30s (configurable via SCHEDULE_TICK_MS): fetches every
 * NetworkDevice + its relevant enabled schedules + currently-active
 * overrides, computes the desired firewall state via
 * `computeDesiredBlocked`, diffs against the last-applied state
 * persisted on the NetworkDevice row, and dispatches block/unblock via
 * the injected FirewallClient. Every successful transition writes a
 * ScheduleEvent row for the audit log AND updates
 * `NetworkDevice.lastAppliedBlocked` — atomically, inside one
 * `prisma.$transaction`, so we can't log an event without also recording
 * the state update (and vice-versa).
 *
 * ── Critical fix #2: state persistence ──
 * Previously this module held a closure-local `Map<mac, boolean>`. That
 * worked for a single long-running process, but lost all state on
 * restart — first tick after restart re-dispatched every device (~40
 * redundant router writes at home scale), and worse, if an override had
 * expired during an orchestrator outage the first tick could re-apply
 * the wrong state with no memory of the prior "unblock." We now read
 * and write `NetworkDevice.lastAppliedBlocked` instead. NULL means
 * "ticker has never touched this device" — bootstrap dispatches once.
 *
 * Error handling: if the firewall call throws RouterError (router
 * unreachable, auth, disabled, etc.) we log at `warn` and skip BOTH the
 * event emission and the state update — the prior state (in-DB) stands
 * and we'll try again on the next tick. Unexpected errors are logged at
 * `error` but also don't touch state (since the transition didn't
 * happen).
 */
import type { PrismaClient } from "@prisma/client";
import { computeDesiredBlocked } from "./schedule.service.js";
import { RouterError } from "../types/router-error.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("schedule-ticker");

export interface FirewallClient {
  block(mac: string): Promise<void>;
  unblock(mac: string): Promise<void>;
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
    const devices = await prisma.networkDevice.findMany({
      include: { groups: true },
    });
    const schedules = await prisma.schedule.findMany({
      where: { enabled: true },
      include: { windows: true },
    });
    const overrides = await prisma.scheduleOverride.findMany({
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

      // Previous dispatched state lives on the device row (null = never
      // dispatched). Any mismatch — including null !== true/false —
      // triggers a dispatch, which matches the "ticker hasn't touched
      // this yet" bootstrap semantics from the original in-memory cache.
      const previous: boolean | null = (device as any).lastAppliedBlocked ?? null;
      if (previous === desired) continue;

      try {
        if (desired) await firewall.block(device.mac);
        else await firewall.unblock(device.mac);

        // Atomically record the event and flip `lastAppliedBlocked`. If
        // either statement fails, both roll back — so we never log a
        // transition we can't also remember.
        await prisma.$transaction([
          prisma.scheduleEvent.create({
            data: {
              subjectType: "device",
              deviceMac: device.mac,
              transition: desired ? "blocked" : "unblocked",
              reason,
              occurredAt: now,
            },
          }),
          prisma.networkDevice.update({
            where: { mac: device.mac },
            data: { lastAppliedBlocked: desired },
          }),
        ]);
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
