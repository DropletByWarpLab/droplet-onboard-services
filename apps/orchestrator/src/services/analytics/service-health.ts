/**
 * WARP-618 — health-monitor → fleet-analytics bridge.
 *
 * The health monitor exposes a generic `onHealthSnapshot` observer hook and
 * knows nothing about analytics (hard constraint of the story). This module
 * is the analytics side of that seam: boot (src/index.ts) subscribes
 * `forwardHealthSnapshot` BEFORE starting the monitor, so the seeded first
 * snapshot is observed and becomes the transition baseline.
 *
 * The bridge is a pure fan-out — one `recordService` observation per
 * component per poll, for WHATEVER components the snapshot contains. No
 * hardcoded component list: services the monitor gains later (file-indexer
 * per WARP-598, storage per WARP-1146, the next one) flow through untouched.
 * All derivation (per-poll `service.health` metric, transition-only
 * `service.*` events) lives in AnalyticsAgent.recordService; everything
 * lands on the fail-open façade, so a broken portal can never disturb
 * health polling.
 *
 * The dependency is one-directional: this module type-imports the monitor's
 * `ComponentHealth` (erased at runtime); the monitor never imports analytics.
 */
import type { ComponentHealth } from "../health-monitor.service.js";
import { analytics } from "./index.js";
import type { Analytics } from "./types.js";

/**
 * Forward one health snapshot to the analytics façade — exactly one
 * `recordService` per component. `sink` is injectable for tests; production
 * wiring uses the process-wide fail-open façade.
 */
export function forwardHealthSnapshot(
  components: ReadonlyArray<ComponentHealth>,
  sink: Analytics = analytics,
): void {
  for (const c of components) {
    sink.recordService({
      service: c.name,
      status: c.status,
      latencyMs: c.latencyMs,
      // D4: the component error SUMMARY only (probe/timeout messages) —
      // ComponentHealth carries nothing content- or user-derived.
      error: c.error,
    });
  }
}
