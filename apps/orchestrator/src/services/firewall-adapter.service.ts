/**
 * Firewall adapter (WARP-101).
 *
 * Extracted from the inline object literal in `index.ts`'s lifespan block
 * (flagged in the WARP-93 code review). The schedule ticker consumes a
 * `FirewallClient` — a `block`/`unblock` pair returning `Promise<void>`.
 * The concrete dispatcher is the `openwrt` client (a namespace module of
 * functions), whose `blockDevice`/`unblockDevice` return a `WriteResult`.
 * This adapter is the seam between the two: it narrows the openwrt
 * `WriteResult`-returning calls down to the `void`-returning `FirewallClient`
 * shape the ticker expects.
 *
 * `FirewallClient` itself stays defined in `schedule-ticker.ts` (its
 * consumer) — we import it here so `createFirewallAdapter` returns exactly
 * that type, keeping a single source of truth and zero churn in the ticker.
 */
import type { FirewallClient } from "./schedule-ticker.js";

/**
 * The minimal structural slice of the `openwrt` client this adapter needs.
 * The `openwrt` namespace module has no exported aggregate type, so we type
 * the param to just the two methods we call. The real namespace functions
 * return `Promise<WriteResult>`; we accept any resolved value and discard it.
 */
export interface OpenwrtFirewallClient {
  blockDevice(mac: string): Promise<unknown>;
  unblockDevice(mac: string): Promise<unknown>;
}

export function createFirewallAdapter(
  openwrt: OpenwrtFirewallClient,
): FirewallClient {
  return {
    async block(mac) {
      await openwrt.blockDevice(mac);
    },
    async unblock(mac) {
      await openwrt.unblockDevice(mac);
    },
  };
}
