/**
 * WARP-1761 — the `wifi.primary` converger (ADR-035 §1/§7).
 *
 * The second failure this ticket removes: the AP ships LuCI, so a change made
 * on the device is read back by the box and DISPLAYED AS CORRECT. Drift is
 * currently promoted to truth. ADR-035 §7 says intent wins for a fabric-owned
 * domain and drift is repaired *visibly* — this is that repair loop for the
 * one domain stage 4 covers.
 *
 * Per tick, for every fabric member that is an AP:
 *   read the device's live wireless → compare to intent → if they disagree,
 *   stamp `driftDetectedAt` and re-push → on success stamp
 *   `appliedGeneration` + `lastVerifiedAt`.
 *
 * **What this is not**, deliberately:
 *   - It is NOT a second transport. It reads and writes through the SAME
 *     `openwrt.client` AP-wireless hop that `GET /network/wifi/ap` uses, via
 *     a narrow injected interface so tests need no HTTP.
 *   - It NEVER writes any domain but `wifi.primary`, and never to any device
 *     role but `ap` — the fabric-member query is filtered `role: "ap"` at the
 *     database, not in a conditional a later edit could slip past.
 *   - It NEVER carries a passphrase. `NetworkIntent` holds none (see
 *     `network-intent.service.ts` for why), so the push is `{ mac, ssid }`
 *     and can be nothing else. A converger that holds no secret leaks none.
 *   - It NEVER writes intent. Intent is the operator's; this loop only reads
 *     it and stamps per-device bookkeeping.
 *   - It NEVER deletes a row (ADR-035 §6), same discipline as
 *     `fabric-member-reconciler`.
 *
 * **The approval gate is respected, not bypassed.** A `FabricMember` row with
 * role='ap' means only "something announced as an AP" — ADR-005 approval is
 * `ApDevice`'s to grant. Pushing the household SSID at an unapproved radio
 * would put the home network on the air from a device nobody admitted, so the
 * candidate set is the INTERSECTION of role='ap' members and ApDevice rows
 * that are ONLINE + DROPLET_IMAGE. The backend filter matters independently:
 * a UNIFI / EASYMESH AP's SSID belongs to its own controller and there is no
 * uci to write (`getApWirelessForMac` 422s for exactly this reason).
 *
 * Same house pattern as `fabric-member-reconciler.ts`: narrow injected client,
 * one `pollOnce()` per tick, scheduled through
 * `createCronRuntime(...).scheduleInterval(...)` with its OWN pg advisory
 * `lockKey` so a multi-instance deploy converges from exactly one node and
 * the two sweeps cannot serialise behind one another. No `while True`, no
 * second scheduler.
 *
 * Failure posture is degrade-to-no-op at two granularities, matching the
 * reconciler: no readable intent means the whole tick stands down (an intent
 * layer that cannot read itself must never push guesses at radios), and one
 * AP's read/write failure is contained so it cannot cost the sweep the other
 * APs.
 */
import type { PrismaClient } from "@prisma/client";
import { logRouterError } from "./openwrt.client.js";
import type { ApWireless, ApWirelessWriteResponse } from "./openwrt.client.js";
import type { CronRuntime } from "./cron-runtime.service.js";
import { createLogger } from "../lib/logger.js";
import { normalizeMac } from "../lib/mac.js";
import {
  WIFI_PRIMARY_INTENT_KEY,
  readWifiPrimaryIntent,
} from "./network-intent.service.js";

const logger = createLogger("wifi-intent-converger");

/**
 * Narrow surface of the routing client the converger needs — the exact two
 * calls the AP-Wi-Fi read and write paths already make, so there is one
 * transport to the AP, not two.
 */
export interface WifiIntentRoutingClient {
  getApWireless(opts: { mac: string }): Promise<ApWireless>;
  setApWireless(opts: {
    mac: string;
    ssid?: string;
    key?: string;
  }): Promise<ApWirelessWriteResponse>;
}

/** Per-tick outcome, logged and returned so tests can assert the sweep. */
export interface WifiConvergeResult {
  /** APs eligible this tick (role='ap' ∩ approved Droplet-image ONLINE). */
  candidates: number;
  /** Already matched intent; stamped verified, nothing written. */
  converged: number;
  /** Disagreed with intent and were successfully re-pushed. */
  repushed: number;
  /** Members dropped before any device dial (not approved, unreadable, …). */
  skipped: number;
  /** APs whose read or write threw. Contained, not fatal. */
  failed: number;
}

export interface WifiIntentConverger {
  /**
   * Converge `wifi.primary` once. Never throws — same belt-and-suspenders
   * contract as `fabric-member-reconciler.pollOnce()`.
   */
  pollOnce(): Promise<WifiConvergeResult>;
}

export function createWifiIntentConverger(
  prisma: PrismaClient,
  routing: WifiIntentRoutingClient,
): WifiIntentConverger {
  /**
   * Stamp this device's bookkeeping. Contained: a failed stamp costs the
   * sweep visibility into one AP, never the convergence itself.
   */
  async function stamp(
    anchorMac: string,
    fields: {
      appliedGeneration?: number;
      lastVerifiedAt?: Date;
      driftDetectedAt?: Date;
    },
  ): Promise<void> {
    try {
      await prisma.deviceIntentState.upsert({
        where: {
          anchorMac_key: { anchorMac, key: WIFI_PRIMARY_INTENT_KEY },
        },
        create: {
          anchorMac,
          key: WIFI_PRIMARY_INTENT_KEY,
          // Spelled out rather than left off: for a brand-new row "never
          // verified" / "never seen drifting" IS null, and writing it keeps
          // the created row's shape identical to the table's.
          appliedGeneration: null,
          lastVerifiedAt: null,
          driftDetectedAt: null,
          ...fields,
        },
        // `driftDetectedAt` is only ever present in `fields` when drift was
        // actually observed, so a clean tick cannot erase the last drift
        // timestamp — ADR-035 §6's "observations dim, they do not vanish".
        update: fields,
      });
    } catch (err) {
      logger.warn({ err, anchorMac }, "wifi-intent: state stamp failed");
    }
  }

  return {
    async pollOnce(): Promise<WifiConvergeResult> {
      const result: WifiConvergeResult = {
        candidates: 0,
        converged: 0,
        repushed: 0,
        skipped: 0,
        failed: 0,
      };

      // No opinion, no convergence. Stands down on a missing row, an
      // unusable value, or a failed read (readWifiPrimaryIntent never
      // throws) — the safe direction for a loop that writes to radios.
      const intent = await readWifiPrimaryIntent(prisma);
      if (!intent) return result;

      let members: { anchorMac: string }[];
      let approvedMacs: Set<string>;
      try {
        // ADR-035 §7: this converger owns ONE domain on ONE role. The role
        // filter lives in the query, not in a later conditional.
        const [memberRows, apRows] = await Promise.all([
          prisma.fabricMember.findMany({
            where: { role: "ap" },
            select: { anchorMac: true },
          }),
          // ADR-005 approval gate + ADR-024 backend discriminator. Never
          // inferred — both are explicit columns.
          prisma.apDevice.findMany({
            where: { status: "ONLINE", backend: "DROPLET_IMAGE" },
            select: { mac: true },
          }),
        ]);
        members = memberRows;
        approvedMacs = new Set(apRows.map((row) => row.mac));
      } catch (err) {
        logger.warn({ err }, "wifi-intent: candidate lookup failed");
        return result;
      }

      for (const member of members) {
        // Every MAC crosses this boundary through the shared normalizer, so
        // the FabricMember key and the ApDevice key cannot miss each other
        // over two spellings of one address.
        let anchorMac: string;
        try {
          anchorMac = normalizeMac(member.anchorMac);
        } catch {
          result.skipped += 1;
          continue;
        }

        if (!approvedMacs.has(anchorMac)) {
          // Announced as an AP but not an approved Droplet-image radio:
          // awaiting approval, decommissioned, offline, or vendor-managed.
          // Fails CLOSED — an unapproved radio never gets the household name.
          result.skipped += 1;
          continue;
        }

        result.candidates += 1;

        let live: ApWireless;
        try {
          live = await routing.getApWireless({ mac: anchorMac });
        } catch (err) {
          // Cold-start-aware: an UNREACHABLE during the boot grace window
          // logs at debug instead of flooding warn on every fresh boot.
          result.failed += 1;
          logRouterError(logger, err, "wifi-intent: AP wireless read failed");
          continue;
        }

        if (!live.supported) {
          // The AP answered but cannot report wireless (image predates the
          // surface, no credential). Unjudgeable is NOT drifted — pushing at
          // a device we cannot read back would be writing blind.
          result.skipped += 1;
          continue;
        }

        if (live.ssid === intent.ssid) {
          result.converged += 1;
          await stamp(anchorMac, {
            appliedGeneration: intent.generation,
            lastVerifiedAt: new Date(),
          });
          continue;
        }

        // Drift. Stamp it BEFORE attempting the repair: drift is an
        // observation and is true whether or not the repair lands, and a
        // repair that fails must still leave the operator able to see that
        // someone edited the AP behind the fabric's back.
        await stamp(anchorMac, { driftDetectedAt: new Date() });
        logger.warn(
          { anchorMac, intended: intent.ssid, observed: live.ssid },
          "wifi-intent: AP drifted from intent — re-pushing",
        );

        try {
          // SSID only. There is no passphrase in intent to push, by design.
          await routing.setApWireless({ mac: anchorMac, ssid: intent.ssid });
        } catch (err) {
          result.failed += 1;
          logRouterError(logger, err, "wifi-intent: AP re-push failed");
          continue;
        }

        result.repushed += 1;
        await stamp(anchorMac, {
          appliedGeneration: intent.generation,
          lastVerifiedAt: new Date(),
        });
      }

      if (result.failed > 0 || result.repushed > 0) {
        logger.warn(result, "wifi-intent converge tick complete");
      } else {
        logger.debug(result, "wifi-intent converge tick complete");
      }
      return result;
    },
  };
}

/**
 * Register the `wifi.primary` converger with the orchestrator's cron runtime.
 * `index.ts` calls this once at boot with the shared `cronRuntime`, so the
 * same Postgres advisory-lock infrastructure that covers the schedule ticker,
 * device reconciler, AP-discovery poller, and fabric-member reconciler covers
 * this tick too — on a warm-standby deploy only the instance that wins the
 * lock converges, the others skip silently.
 *
 * Lock key follows the `droplet:<job-name>` convention and is deliberately
 * DISTINCT from the fabric reconciler's: two sweeps sharing a key would
 * serialise behind one another for no reason. There is exactly ONE scheduler
 * for Wi-Fi convergence.
 */
export function startWifiIntentConverger(
  cronRuntime: CronRuntime,
  prisma: PrismaClient,
  routing: WifiIntentRoutingClient,
  intervalMs: number,
): WifiIntentConverger {
  const converger = createWifiIntentConverger(prisma, routing);
  cronRuntime.scheduleInterval(
    intervalMs,
    // The per-tick counters are for logs and tests; the scheduler's handler
    // contract is `void`, so swallow the value rather than widen the seam.
    async () => {
      await converger.pollOnce();
    },
    { lockKey: "droplet:wifi-intent-converger" },
  );
  logger.info({ intervalMs }, "wifi.primary converger started");
  return converger;
}
