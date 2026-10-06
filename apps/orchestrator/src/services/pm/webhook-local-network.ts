/**
 * "Which addresses are THIS box?" for the webhook SSRF guard (WARP-3532).
 *
 * `localNetworkFacts()` in the guard reads the interfaces the process can see.
 * Inside the orchestrator's container that is the compose bridge and
 * `droplet-internal` — which refuses the bridge gateway (`host.docker.internal`)
 * and every sibling container, the targets that matter most — but NOT the host's
 * own LAN address. That address is a different one, and the host-network
 * services (routing, switch, the device bridge) answer on it. The device bridge
 * knows it: it reports the uplink IP the host reaches the LAN with.
 *
 * So the worker adds it. The answer is cached for a minute (it changes when DHCP
 * does, not per request). The probe is best-effort by its own contract — no bridge
 * token, an unreachable bridge, or a placeholder address all give `null` — and
 * when it gives `null` the guard still has the container's networks. That is a
 * stated limit, not a silent one: a box whose bridge is down can be pointed at its
 * own LAN address by an owner or admin, who can already reconfigure the network.
 */
import { localNetworkFacts, type LocalNetworkFacts } from "../../lib/outbound-url-guard.js";
import { fetchBridgeUplinkIp } from "../../lib/vpn-home-endpoint.js";

const UPLINK_TTL_MS = 60_000;

let cached: { at: number; ip: string | null } | null = null;

export async function webhookLocalNetworkFacts(now: number = Date.now()): Promise<LocalNetworkFacts> {
  const base = localNetworkFacts();
  if (!cached || now - cached.at >= UPLINK_TTL_MS) {
    cached = { at: now, ip: await fetchBridgeUplinkIp().catch(() => null) };
  }
  return cached.ip ? { addresses: [...base.addresses, cached.ip], cidrs: base.cidrs } : base;
}

/** Test seam: forget the cached uplink address. */
export function resetWebhookLocalNetworkCacheForTests(): void {
  cached = null;
}
