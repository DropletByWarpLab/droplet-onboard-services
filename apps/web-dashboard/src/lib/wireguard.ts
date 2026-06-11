/** The single-box tunnel gateway — the address the dashboard answers on
 * for VPN clients when the conf has no usable DNS line. */
const FALLBACK_DASHBOARD_IP = "192.168.20.1";

/**
 * The dashboard address a WireGuard client should browse to, parsed from
 * the peer conf's `DNS =` line (the box-side gateway the tunnel routes
 * to — 192.168.20.1 on single-box, 192.168.50.1 on multi-box). Parsing
 * beats pinning a deployment shape; mDNS names (droplet.local) can NOT
 * be used here because phones resolve .local via multicast only, which
 * never crosses the tunnel.
 *
 * The captured value is validated as a structural IPv4 dotted quad
 * before use: WIREGUARD_DNS reaches the conf unvalidated (the
 * orchestrator schema is a bare `z.string()`), so a mistyped env var
 * like `192.168.50.` would otherwise surface as a dead
 * `https://192.168.50.` link with no hint why the browser can't
 * connect. Malformed values fall back to the single-box gateway.
 */
export function dashboardIpFromConf(conf: string): string {
  const candidate = conf.match(/^DNS\s*=\s*([0-9.]+)/m)?.[1];
  if (!candidate) return FALLBACK_DASHBOARD_IP;
  const octets = candidate.split(".");
  const isValidIpv4 =
    octets.length === 4 &&
    octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255);
  return isValidIpv4 ? candidate : FALLBACK_DASHBOARD_IP;
}
