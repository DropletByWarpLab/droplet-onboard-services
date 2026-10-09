"use client";

import { DevicePairingCard } from "./DevicePairingCard";
import type { RouterErrorCode } from "@/lib/api";

/**
 * Router pairing card (ADR-071 slice B, WARP-3739): the router's use of the
 * shared `DevicePairingCard` (slice C), which holds the three states (PAIR,
 * ELSEWHERE, RETRY) and their copy for the router, the switch and the APs.
 *
 * `routerErrorCode` comes from the page's own status read (it already knows
 * AUTH vs PAIRED_ELSEWHERE); pass null from the healthy page, where only the
 * RETRY state can apply.
 */
export interface RouterPairingCardProps {
  routerErrorCode: RouterErrorCode | null;
  /** Called after a successful pair/retry so the page re-reads its own status. */
  onChanged?: () => void;
}

export function RouterPairingCard({ routerErrorCode, onChanged }: RouterPairingCardProps) {
  return <DevicePairingCard role="router" errorCode={routerErrorCode} onChanged={onChanged} />;
}
