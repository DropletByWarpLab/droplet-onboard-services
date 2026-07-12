/**
 * Host-side deployment-topology probe (WARP-817).
 *
 * The routing service's GET /network/topology (ADR-018,
 * `network.service.ts`'s `getTopology()` → `openwrt.fetchTopology()`)
 * determines the deployment posture by probing the CONTAINERISED OpenWrt's
 * "wan" ubus interface. On the single-box shape that interface is never
 * configured — WAN is HOST-owned, not the container's — so the
 * routing-service probe always reports `UNKNOWN`, and the onboarding wizard
 * can never tell "downstream of an existing home router" (the common case)
 * apart from "this box IS the primary router".
 *
 * The host device-bridge (which runs in the host's network namespace) exposes
 * a READ-ONLY GET /host/topology answering the SAME question from the host's
 * own default route, mirroring `detect_deployment_topology()`'s posture
 * semantics exactly (see `services/oled-display/device-bridge.py`,
 * `host_topology_snapshot()`). `fetchHostTopology()` queries it and degrades
 * to `null` on ANY failure — no token configured, bridge unreachable, timeout,
 * non-2xx, malformed body — never throws, mirroring the bridge-caller posture
 * in `lib/vpn-home-endpoint.ts`'s `fetchBridgeUplinkIp()`.
 *
 * This is a UX-level signal ONLY (auto-collapsing the onboarding Wi-Fi step).
 * It must never be substituted for `assertPrimaryRouterPosture()` — the
 * brick-risk KAN-8 firmware gate, which intentionally stays on the
 * routing-service-only signal (`openwrt.fetchTopology()`) and is untouched by
 * this module.
 */

import type { NetworkTopology } from "../services/openwrt.client.js";
import { config } from "../config.js";
import { bridgeAuthToken, isBridgeConnectionError, isTimeoutOrAbort } from "./bridge-errors.js";
import { createLogger } from "./logger.js";

const logger = createLogger("host-topology");

/** Bounded so a slow/unreachable bridge never stalls /network/topology. */
const BRIDGE_TOPOLOGY_TIMEOUT_MS = 3_000;

/**
 * Query the host device-bridge's READ-ONLY GET /host/topology for the box's
 * uplink posture. Best-effort: any failure degrades to `null`, never throws —
 * callers fall back to the routing-service topology.
 */
export async function fetchHostTopology(): Promise<NetworkTopology | null> {
  const token = bridgeAuthToken();
  if (!token) {
    logger.debug({}, "topology: bridge auth token not configured — skipping host-topology probe");
    return null;
  }
  let res: Response;
  try {
    res = await fetch(`${config.DEVICE_BRIDGE_URL}/host/topology`, {
      method: "GET",
      headers: { "X-Droplet-Auth": token },
      signal: AbortSignal.timeout(BRIDGE_TOPOLOGY_TIMEOUT_MS),
    });
  } catch (err) {
    if (isBridgeConnectionError(err) || isTimeoutOrAbort(err)) {
      logger.debug({ err }, "topology: device-bridge not reachable for host-topology probe");
    } else {
      logger.warn({ err }, "topology: device-bridge host-topology probe failed");
    }
    return null;
  }
  if (!res.ok) {
    logger.warn({ status: res.status }, "topology: device-bridge host-topology probe non-2xx");
    return null;
  }
  const body = (await res.json().catch(() => null)) as NetworkTopology | null;
  if (!body || typeof body.posture !== "string") return null;
  return body;
}
