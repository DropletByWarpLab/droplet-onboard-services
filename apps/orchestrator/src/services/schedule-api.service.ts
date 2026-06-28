/**
 * WARP-94: schedule-API service — CRUD for Schedule / ScheduleOverride,
 * queries for ScheduleEvent, and the manualBlock write-through for
 * NetworkDevice.
 *
 * Business invariants enforced here (not in the route layer):
 *   - subject rule: exactly one of {deviceMac, groupId} must be set, and
 *     must match `subjectType`. Violations → SCHEDULE_SUBJECT_MISMATCH.
 *   - subject immutability: updateSchedule rejects any attempt to change
 *     subjectType / deviceMac / groupId — even when the incoming value
 *     matches the current row. Callers delete + recreate for a re-target.
 *   - window validity: daysOfWeek ∈ [1, 127], startMin/endMin ∈ [0, 1439],
 *     startMin !== endMin (zero-length windows rejected — wrap past
 *     midnight is fine, just not a true zero). Max 7 windows per schedule.
 *     Violations → SCHEDULE_INVALID_WINDOW.
 *   - override range: endAt > startAt, action ∈ {"allow", "block"}.
 *     Violations → OVERRIDE_INVALID_RANGE.
 *
 * Error mapping: Prisma P2025 (row not found on update/delete) is
 * translated via `mapPrismaNotFound` to the right DeviceRegistryError
 * factory (scheduleNotFound / overrideNotFound / notFound("Device")) so
 * the route layer hands clients a clean 404 — the same pattern WARP-82's
 * network-device service uses.
 *
 * NOTE: `manualBlock` lives on NetworkDevice. Toggling it here does not
 * fire a firewall write directly — the Phase 2 ticker (WARP-93) picks up
 * the change on its next tick and issues the actual block/unblock. This
 * keeps the REST layer synchronous + idempotent and lets the ticker stay
 * the single writer to the router.
 */

import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { DeviceRegistryError } from "../types/device-registry-error.js";

function mapPrismaNotFound<T>(
  what: "Schedule" | "Override" | "Device",
  id: string,
  fn: () => Promise<T>,
): Promise<T> {
  return fn().catch((err) => {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2025"
    ) {
      if (what === "Schedule") {
        throw DeviceRegistryError.scheduleNotFound(id);
      }
      if (what === "Override") {
        throw DeviceRegistryError.overrideNotFound(id);
      }
      throw DeviceRegistryError.notFound(`${what} ${id}`);
    }
    throw err;
  });
}

function validateSubject(p: {
  subjectType: string;
  deviceMac?: string | null;
  groupId?: string | null;
}): void {
  if (p.subjectType === "device") {
    if (!p.deviceMac || p.groupId) {
      throw DeviceRegistryError.scheduleSubjectMismatch(
        "device subject requires deviceMac only",
      );
    }
  } else if (p.subjectType === "group") {
    if (!p.groupId || p.deviceMac) {
      throw DeviceRegistryError.scheduleSubjectMismatch(
        "group subject requires groupId only",
      );
    }
  } else {
    throw DeviceRegistryError.scheduleSubjectMismatch(
      `unknown subjectType: ${p.subjectType}`,
    );
  }
}

function validateWindows(
  windows: Array<{ daysOfWeek: number; startMin: number; endMin: number }>,
): void {
  if (windows.length > 7) {
    throw DeviceRegistryError.scheduleInvalidWindow(
      "max 7 windows per schedule",
    );
  }
  for (const w of windows) {
    if (
      !Number.isInteger(w.daysOfWeek) ||
      w.daysOfWeek < 1 ||
      w.daysOfWeek > 127
    ) {
      throw DeviceRegistryError.scheduleInvalidWindow(
        "daysOfWeek bitmask out of range (expected 1..127)",
      );
    }
    if (
      !Number.isInteger(w.startMin) ||
      w.startMin < 0 ||
      w.startMin >= 1440
    ) {
      throw DeviceRegistryError.scheduleInvalidWindow(
        "startMin out of range (expected 0..1439)",
      );
    }
    if (!Number.isInteger(w.endMin) || w.endMin < 0 || w.endMin >= 1440) {
      throw DeviceRegistryError.scheduleInvalidWindow(
        "endMin out of range (expected 0..1439)",
      );
    }
    if (w.startMin === w.endMin) {
      throw DeviceRegistryError.scheduleInvalidWindow(
        "window cannot be zero-length",
      );
    }
  }
}

export interface CreateScheduleInput {
  name: string;
  enabled?: boolean;
  subjectType: "device" | "group";
  deviceMac?: string;
  groupId?: string;
  windows: Array<{ daysOfWeek: number; startMin: number; endMin: number }>;
}

export interface UpdateSchedulePatch {
  name?: string;
  enabled?: boolean;
  windows?: Array<{ daysOfWeek: number; startMin: number; endMin: number }>;
  // Present in the type only so we can reject them explicitly — setting
  // any of these on a PATCH must return SCHEDULE_SUBJECT_MISMATCH.
  subjectType?: unknown;
  deviceMac?: unknown;
  groupId?: unknown;
}

export interface CreateOverrideInput {
  subjectType: "device" | "group";
  deviceMac?: string;
  groupId?: string;
  action: "allow" | "block";
  startAt?: Date;
  endAt: Date;
  note?: string;
}

export interface ListOverridesOpts {
  active?: boolean;
  deviceMac?: string;
  groupId?: string;
}

export interface ListScheduleEventsOpts {
  since?: Date;
  limit?: number;
}

export function createScheduleApiService(prisma: PrismaClient) {
  // Prisma's generated types for Schedule / ScheduleOverride / ScheduleEvent
  // exist — we take `any` here only to keep the route layer ergonomic and
  // avoid dragging model-level types through every test. The invariants we
  // care about are enforced above.
  const p = prisma as unknown as {
    schedule: any;
    scheduleWindow: any;
    scheduleOverride: any;
    scheduleEvent: any;
    networkDevice: any;
    $transaction: (fn: (tx: any) => Promise<any>) => Promise<any>;
  };

  async function listSchedules() {
    return p.schedule.findMany({
      include: { windows: true },
      orderBy: [{ enabled: "desc" }, { name: "asc" }],
    });
  }

  async function getSchedule(id: string) {
    const s = await p.schedule.findUnique({
      where: { id },
      include: { windows: true },
    });
    if (!s) throw DeviceRegistryError.scheduleNotFound(id);
    return s;
  }

  async function createSchedule(input: CreateScheduleInput) {
    validateSubject(input);
    validateWindows(input.windows);
    return p.schedule.create({
      data: {
        name: input.name,
        enabled: input.enabled ?? true,
        subjectType: input.subjectType,
        deviceMac: input.deviceMac ?? null,
        groupId: input.groupId ?? null,
        windows: { create: input.windows },
      },
      include: { windows: true },
    });
  }

  async function updateSchedule(id: string, patch: UpdateSchedulePatch) {
    // WARP-110: subject immutability is value-equality, not presence.
    // Re-sending subjectType / deviceMac / groupId with their CURRENT
    // value is a no-op (the dashboard PATCHes back the full shape) and
    // must succeed; only a real change is rejected. Load the existing
    // row, compare each immutable field, then strip them so they never
    // reach the update query.
    const existing = await getSchedule(id);
    for (const field of ["subjectType", "deviceMac", "groupId"] as const) {
      const incoming = (patch as Record<string, unknown>)[field];
      if (incoming !== undefined && incoming !== existing[field]) {
        throw DeviceRegistryError.scheduleSubjectMismatch(
          `${field} is immutable after creation — delete + recreate to re-target`,
        );
      }
    }
    delete (patch as Record<string, unknown>).subjectType;
    delete (patch as Record<string, unknown>).deviceMac;
    delete (patch as Record<string, unknown>).groupId;

    if (patch.windows) validateWindows(patch.windows);

    return mapPrismaNotFound("Schedule", id, () =>
      p.$transaction(async (tx: any) => {
        if (patch.windows) {
          await tx.scheduleWindow.deleteMany({ where: { scheduleId: id } });
        }
        return tx.schedule.update({
          where: { id },
          data: {
            name: patch.name,
            enabled: patch.enabled,
            windows: patch.windows ? { create: patch.windows } : undefined,
          },
          include: { windows: true },
        });
      }),
    );
  }

  async function deleteSchedule(id: string) {
    return mapPrismaNotFound("Schedule", id, () =>
      p.schedule.delete({ where: { id } }),
    );
  }

  async function listOverrides(opts: ListOverridesOpts) {
    const now = new Date();
    const where: Record<string, unknown> = {};
    if (opts.deviceMac) where.deviceMac = opts.deviceMac;
    if (opts.groupId) where.groupId = opts.groupId;
    if (opts.active) {
      where.AND = [{ startAt: { lte: now } }, { endAt: { gt: now } }];
    }
    return p.scheduleOverride.findMany({
      where,
      orderBy: { startAt: "desc" },
    });
  }

  async function createOverride(input: CreateOverrideInput) {
    validateSubject(input);
    if (input.action !== "allow" && input.action !== "block") {
      throw DeviceRegistryError.overrideInvalidRange(
        "action must be 'allow' or 'block'",
      );
    }
    const startAt = input.startAt ?? new Date();
    if (input.endAt.getTime() <= startAt.getTime()) {
      throw DeviceRegistryError.overrideInvalidRange(
        "endAt must be after startAt",
      );
    }
    return p.scheduleOverride.create({
      data: {
        subjectType: input.subjectType,
        deviceMac: input.deviceMac ?? null,
        groupId: input.groupId ?? null,
        action: input.action,
        startAt,
        endAt: input.endAt,
        note: input.note ?? null,
      },
    });
  }

  async function cancelOverride(id: string) {
    return mapPrismaNotFound("Override", id, () =>
      p.scheduleOverride.delete({ where: { id } }),
    );
  }

  async function listScheduleEvents(opts: ListScheduleEventsOpts) {
    const take = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    return p.scheduleEvent.findMany({
      where: opts.since ? { occurredAt: { gte: opts.since } } : undefined,
      orderBy: { occurredAt: "desc" },
      take,
    });
  }

  async function setManualBlock(mac: string, blocked: boolean) {
    return mapPrismaNotFound("Device", mac, () =>
      p.networkDevice.update({
        where: { mac },
        data: { manualBlock: blocked },
        select: { mac: true, manualBlock: true },
      }),
    );
  }

  return {
    listSchedules,
    getSchedule,
    createSchedule,
    updateSchedule,
    deleteSchedule,
    listOverrides,
    createOverride,
    cancelOverride,
    listScheduleEvents,
    setManualBlock,
  };
}

export type ScheduleApiService = ReturnType<typeof createScheduleApiService>;
