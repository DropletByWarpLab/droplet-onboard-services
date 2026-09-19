/**
 * Detector registry (WARP-2754, ADR-051).
 *
 * Adding a detector is adding one entry here. Keep the list SHORT and the bar
 * high: the realistic failure mode of this feature is not "no findings", it is
 * "three hundred findings, mostly from one detector", after which the operator
 * mutes /brief and the whole thing is dead. A detector earns its place by being
 * right about something a human would have wanted to know.
 */
import type { Detector } from "./types";
import { overdueReceivables, overduePayables } from "./money-overdue";
import { dealsSlipping } from "./deals-slipping";
import { receivablesAgeing } from "./receivables-ageing";

export const DETECTORS: readonly Detector[] = [
  overdueReceivables,
  overduePayables,
  dealsSlipping,
  // WARP-2825 — the first detector that reads HISTORY. It reports direction,
  // which the three above cannot: they see only the present tense. It earns
  // its place by refusing to speak on a short series rather than by finding
  // more things.
  receivablesAgeing,
] as const;

export type { Detector, DetectedFinding } from "./types";
