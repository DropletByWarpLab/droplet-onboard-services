/**
 * WARP-1732 — fabric-member reconciler (ADR-035 §2/§5/§6).
 *
 * Polls the routing service's `GET /fabric/members` (shipped by WARP-1731)
 * and upserts every announcing device into `FabricMember`. That is the
 * whole job.
 *
 * **What this is not**, deliberately:
 *   - It performs NO device writes. The endpoint it reads is itself
 *     read-only; nothing here can change a router, switch, or AP.
 *   - It owns NO lifecycle state machine. `ApDevice` keeps owning AP
 *     lifecycle (ADR-005) and is not touched by this module. A
 *     `FabricMember` row for an AP MAC means "something announced with
 *     that anchor MAC", never "approved" — the two tables answer
 *     different questions and neither derives the other's state.
 *   - It NEVER deletes a row. There is no `delete` / `deleteMany` call in
 *     this file, and that is the point: ADR-035 §6's staleness discipline
 *     says stale observations dim, they do not silently vanish. A member
 *     that stops announcing keeps its row with `lastSeen` frozen at the
 *     last real observation, so "the switch dropped off at 10:05" stays
 *     answerable instead of collapsing into "the switch was never here".
 *     A umdns restart, a PoE blip, or one unlucky poll must not be able to
 *     erase inventory.
 *
 * Same house pattern as `ap-discovery-poller.ts`: a narrow injected client
 * surface so tests need no HTTP, one `pollOnce()` per tick, scheduling via
 * `createCronRuntime(...).scheduleInterval(...)` with a pg advisory
 * `lockKey` so a multi-instance deploy runs the sweep on exactly one node.
 * No `while True`, no second scheduler.
 *
 * Failure posture is degrade-to-no-op at two granularities: an unreachable
 * routing service logs through the shared cold-start-aware helper and
 * writes nothing (the next tick recovers — missing one window of inventory
 * is harmless), and a single row's write failure is contained so it cannot
 * cost the sweep the other members.
 */
import type { PrismaClient } from "@prisma/client";
import { logRouterError } from "./openwrt.client.js";
import type { FabricMemberInfo } from "./openwrt.client.js";
import type { CronRuntime } from "./cron-runtime.service.js";
import { normalizeMac } from "../lib/mac.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("fabric-member-reconciler");

/**
 * Narrow surface of the routing client the reconciler needs — mirrors the
 * `ApDiscoveryOpenwrtClient` idiom so tests can inject an in-memory stub
 * without pulling the whole openwrt client module.
 */
export interface FabricMemberRoutingClient {
  listFabricMembers(): Promise<FabricMemberInfo[]>;
}

/** Per-tick outcome, logged and returned so tests can assert the sweep. */
export interface FabricReconcileResult {
  /** Members the routing service reported this tick. */
  observed: number;
  /** Rows successfully created or refreshed. */
  upserted: number;
  /** Records dropped before any write (no MAC / unparseable MAC). */
  skipped: number;
  /** Rows whose individual write threw. Contained, not fatal. */
  failed: number;
}

export interface FabricMemberReconciler {
  /**
   * Pull the fabric inventory once and reconcile it against
   * `FabricMember`. Never throws — same belt-and-suspenders contract as
   * `ap-discovery-poller.pollOnce()`.
   */
  pollOnce(): Promise<FabricReconcileResult>;
}

/**
 * Coerce an mDNS TXT value into a non-negative integer, or null.
 *
 * TXT values are text, so `poe_ports` arrives as `"8"`. `Number("")` is 0
 * and `parseInt("eight")` is NaN — both would be lies in a column where
 * null means "not advertised" and 0 would mean "a switch with zero PoE
 * ports". Anything that isn't a clean non-negative integer becomes null.
 */
function toOptionalInt(value: string | number | undefined): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Drop `undefined` keys so an absent fact never overwrites a known one. */
function definedOnly<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

export function createFabricMemberReconciler(
  prisma: PrismaClient,
  routing: FabricMemberRoutingClient,
): FabricMemberReconciler {
  return {
    async pollOnce(): Promise<FabricReconcileResult> {
      const result: FabricReconcileResult = {
        observed: 0,
        upserted: 0,
        skipped: 0,
        failed: 0,
      };

      let members: FabricMemberInfo[];
      try {
        members = await routing.listFabricMembers();
      } catch (err) {
        // Routing service down, endpoint absent on an older build, schema
        // drift — degrade to a logged no-op rather than letting the
        // cron-runtime slide into its consecutive-failures backoff for a
        // transient outage. Nothing is written, and crucially nothing is
        // removed: an unreachable routing service must never be mistaken
        // for "the fabric is empty". Cold-start-aware: an UNREACHABLE
        // during the boot grace window logs at debug instead of flooding
        // warn on every fresh boot.
        logRouterError(logger, err, "fabric-member: pollOnce failed");
        return result;
      }

      result.observed = members.length;

      for (const member of members) {
        // ADR-035 §2: the anchor MAC is the identity, and it is mandatory.
        // A record without a usable one is dropped — never invent an
        // identity, and never fall back to hostname/IP (each was observed
        // failing on the lab unit).
        let anchorMac: string;
        try {
          anchorMac = normalizeMac(member.mac as string);
        } catch {
          result.skipped += 1;
          logger.warn(
            { mac: member.mac, role: member.role },
            "fabric-member: skipping record with no usable anchor MAC",
          );
          continue;
        }

        const extra = member.extra ?? {};
        // Facts as observed. `undefined` (key absent from this announce)
        // is stripped below so a member that stops advertising its model
        // keeps the model we already learned — dim, don't erase. An
        // explicitly-null PoE value, by contrast, IS written: the parse
        // above already distinguishes "not advertised" from "advertised
        // as junk", and both are honestly null.
        const facts = definedOnly({
          role: member.role,
          model: member.model,
          version: member.version,
          lastIp: member.last_ip,
          hostname: member.hostname,
        });
        const poe = {
          poePorts: toOptionalInt(extra.poe_ports),
          poeBudget: toOptionalInt(extra.poe_budget),
        };
        const now = new Date();

        try {
          await prisma.fabricMember.upsert({
            where: { anchorMac },
            create: {
              anchorMac,
              // `role` is the only non-key column the contract guarantees;
              // the spread above supplies it, this is the type-level floor.
              role: member.role,
              ...facts,
              ...poe,
              firstSeen: now,
              lastSeen: now,
            },
            // `firstSeen` is intentionally absent from the update: it is
            // write-once, so re-observing a member can never rewrite when
            // the fabric first met it.
            update: { ...facts, ...poe, lastSeen: now },
          });
          result.upserted += 1;
        } catch (err) {
          // One row's write failure (deadlock, constraint, a column the
          // client hasn't been regenerated for) must not cost the sweep
          // the rest of the fabric.
          result.failed += 1;
          logger.warn(
            { err, anchorMac },
            "fabric-member: upsert failed for one member",
          );
        }
      }

      if (result.failed > 0 || result.skipped > 0) {
        logger.warn(result, "fabric-member reconcile tick complete with drops");
      } else {
        logger.debug(result, "fabric-member reconcile tick complete");
      }
      return result;
    },
  };
}

/**
 * Register the fabric-member reconciler with the orchestrator's cron
 * runtime. `index.ts` calls this once at boot with the shared
 * `cronRuntime`, so the same Postgres advisory-lock infrastructure that
 * covers the schedule ticker, device reconciler, and AP-discovery poller
 * covers this tick too — on a warm-standby deploy only the instance that
 * wins the lock sweeps, the others skip silently.
 *
 * Lock key follows the `droplet:<job-name>` convention. There is exactly
 * ONE scheduler for fabric inventory.
 */
export function startFabricMemberReconciler(
  cronRuntime: CronRuntime,
  prisma: PrismaClient,
  routing: FabricMemberRoutingClient,
  intervalMs: number,
): FabricMemberReconciler {
  const reconciler = createFabricMemberReconciler(prisma, routing);
  cronRuntime.scheduleInterval(
    intervalMs,
    // The per-tick counters are for logs and tests; the scheduler's handler
    // contract is `void`, so swallow the value rather than widen the seam.
    async () => {
      await reconciler.pollOnce();
    },
    { lockKey: "droplet:fabric-member-reconciler" },
  );
  logger.info({ intervalMs }, "fabric-member reconciler started");
  return reconciler;
}
