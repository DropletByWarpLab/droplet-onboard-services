/**
 * Egress reconciler (WARP-613, ADR-012).
 *
 * Additive sibling to the schedule ticker (WARP-93). Runs on the same
 * cron-runtime; every tick it:
 *
 *   1. Camera pass — dispatches the camera-VLAN phone-home state
 *      (master ∧ cameras setting) when it changes.
 *   2. Per-device pass — computes the desired egress policy for each
 *      NetworkDevice via `computeDesiredEgress`, diffs against
 *      `lastAppliedEgress`, and dispatches block/unblock-phone-home.
 *
 * The schedule ticker and `computeDesiredBlocked` are left untouched: this
 * reconciler only ever adds/removes `phonehome-<mac>` rules (distinct names
 * from the ticker's `block-<mac>` rules) and YIELDS to a full block (when
 * `lastAppliedBlocked === true` the desired egress is `full_blocked`, which
 * removes any phone-home rule so the NTP carve-out can't leak past a full WAN
 * block).
 *
 * State: per-device applied egress persists in `lastAppliedEgress` (survives
 * restart cleanly, same rationale as the schedule ticker's
 * `lastAppliedBlocked`). The single global camera bit is kept in memory — one
 * idempotent re-assert of the zone on restart is harmless.
 *
 * Errors: a RouterError (router unreachable / auth / disabled) is logged at
 * `warn` and BOTH the audit event and the state update are skipped, so the
 * prior state stands and we retry next tick — identical discipline to the
 * schedule ticker.
 */
import type { PrismaClient } from "@prisma/client";
import pino from "pino";
import { computeDesiredEgress, getPhoneHomeSettings } from "./egress.service.js";
import { RouterError } from "../types/router-error.js";

const log = pino({ name: "egress-reconciler" });

export interface EgressClient {
  blockPhoneHome(mac: string): Promise<void>;
  unblockPhoneHome(mac: string): Promise<void>;
  setCameraPhoneHome(blocked: boolean): Promise<void>;
}

export interface EgressReconciler {
  tickOnce(): Promise<void>;
}

export function createEgressReconciler(
  prisma: PrismaClient,
  egress: EgressClient,
): EgressReconciler {
  // null = "never dispatched this process" → dispatch once on the first tick.
  let lastCameraApplied: boolean | null = null;

  async function tickOnce() {
    const now = new Date();
    const { enabled, cameras } = await getPhoneHomeSettings(prisma);

    // --- Camera-zone pass ---
    const desiredCamera = enabled && cameras;
    if (desiredCamera !== lastCameraApplied) {
      try {
        await egress.setCameraPhoneHome(desiredCamera);
        lastCameraApplied = desiredCamera;
      } catch (err) {
        if (err instanceof RouterError) {
          log.warn({ code: err.code }, "camera egress dispatch failed; will retry next tick");
        } else {
          log.error({ err }, "camera egress dispatch failed");
        }
      }
    }

    // --- Per-device pass ---
    const devices = await prisma.networkDevice.findMany({ include: { groups: true } });
    for (const device of devices) {
      const fullBlocked = device.lastAppliedBlocked === true;
      const desired = computeDesiredEgress({ masterEnabled: enabled, device, fullBlocked });
      if (device.lastAppliedEgress === desired) continue;

      try {
        // "phone_home_blocked" → install the rule; "open" / "full_blocked"
        // both mean "no phone-home rule present".
        if (desired === "phone_home_blocked") await egress.blockPhoneHome(device.mac);
        else await egress.unblockPhoneHome(device.mac);

        // Atomically record the audit event and flip lastAppliedEgress — never
        // log a transition we can't also remember (mirrors the schedule ticker).
        await prisma.$transaction([
          prisma.scheduleEvent.create({
            data: {
              subjectType: "device",
              deviceMac: device.mac,
              transition: desired === "phone_home_blocked" ? "blocked" : "unblocked",
              reason: "phone_home",
              occurredAt: now,
            },
          }),
          prisma.networkDevice.update({
            where: { mac: device.mac },
            data: { lastAppliedEgress: desired },
          }),
        ]);
      } catch (err) {
        if (err instanceof RouterError) {
          log.warn({ mac: device.mac, code: err.code }, "egress dispatch failed; preserving state");
        } else {
          log.error({ err, mac: device.mac }, "egress reconciler dispatch failed");
        }
      }
    }
  }

  return { tickOnce };
}
