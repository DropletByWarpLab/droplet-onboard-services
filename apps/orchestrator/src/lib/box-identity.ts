/**
 * WARP-992 — canonical box-identity resolution.
 *
 * Inside a container `os.hostname()` / `$HOSTNAME` is the docker container
 * id (e.g. `5639146fdc76`) — meaningless to a customer and leaky on every
 * user-facing surface. The live box rendered "Go to 5639146fdc76/setup" on
 * the OLED first-boot frame and "5639146fdc76 · Status unavailable" in the
 * dashboard Home header because both surfaces ultimately derived the box's
 * name from the orchestrator container's hostname. A container hostname must
 * NEVER escape to a user-facing surface.
 *
 * This module is the single source of truth for "what is this box called".
 * Two resolutions, because the two surfaces have different constraints:
 *
 *   - `boxDisplayName()` — what the box is CALLED (dashboard identity chip,
 *     Settings → Device information, the factory-reset type-to-confirm
 *     target, the self-registered Device row). Owner-chosen name
 *     (`DROPLET_BOX_NAME`, WARP-979) → per-device public FQDN
 *     (`DROPLET_PUBLIC_FQDN`, ADR-023) → the stable LAN name.
 *
 *   - `lanSetupHost()` — what a PRE-CLAIM phone can actually reach for the
 *     OLED `https://<host>/setup` frame. Neither the owner name nor the FQDN
 *     necessarily exists before setup, so: explicit deployment override
 *     (`SCREEN_QR_HOST`) → first routable LAN IPv4 → the stable LAN name.
 *
 * Related but distinct: `trusted-origin.ts` resolves which HOST may be
 * embedded in a request-derived URL (canonical origin + allowlist); this
 * module needs no request and answers the box's NAME.
 *
 * Env vars are read per-call (same pattern as screen-qr's SCREEN_QR_HOST and
 * storage.ts's bridge token) so a value injected after boot is picked up and
 * unit tests can drive the fallback order without re-importing modules.
 */
import { networkInterfaces } from "node:os";
import { validateBoxName } from "@droplet/shared-types";

/**
 * The stable customer-facing LAN name. Advertised via Avahi mDNS and the
 * single-box AP dnsmasq (scripts/lib/local-dns.sh), and present in the
 * self-signed TLS cert SANs (scripts/lib/secrets.sh) — so it both resolves
 * and serves TLS on a factory-fresh box.
 */
export const LAN_FALLBACK_HOST = "droplet.local";

/**
 * The canonical human-facing name of this box.
 *
 *   1. `DROPLET_BOX_NAME` — the owner-chosen name (WARP-979). Validated with
 *      the shared ruleset before use (defense-in-depth against a hand-edited
 *      .env — same posture as tls-issuance's `requested_name`).
 *   2. `DROPLET_PUBLIC_FQDN` — the per-device public address (ADR-023).
 *   3. `LAN_FALLBACK_HOST` — the stable LAN name.
 *
 * NEVER `os.hostname()` / `$HOSTNAME`: inside the container that is the
 * docker container id.
 */
export function boxDisplayName(env: NodeJS.ProcessEnv = process.env): string {
  const name = (env.DROPLET_BOX_NAME || "").trim();
  if (name) {
    const v = validateBoxName(name);
    if (v.ok) return v.slug;
  }
  const fqdn = (env.DROPLET_PUBLIC_FQDN || "").trim();
  if (fqdn) return fqdn;
  return LAN_FALLBACK_HOST;
}

/**
 * The host a PRE-CLAIM phone points at for the setup wizard
 * (`https://<host>/setup` on the OLED first-boot frame).
 *
 *   1. `SCREEN_QR_HOST` — explicit deployment override (a pinned DNS name).
 *   2. First non-loopback, non-docker-bridge, non-link-local IPv4 — only
 *      useful when the process runs on the host network (dev); inside the
 *      bridge-networked container every interface is 172.x and is skipped.
 *   3. `LAN_FALLBACK_HOST` — resolves on the box's AP (dnsmasq) and via mDNS
 *      on the home LAN, and is in the TLS cert SANs.
 *
 * The owner name / public FQDN are deliberately NOT in this chain: neither
 * necessarily exists before setup, and this URL must work on a factory-fresh
 * box. NEVER `$HOSTNAME` — inside the container that is the docker container
 * id (the WARP-992 leak: "Go to 5639146fdc76/setup").
 */
export function lanSetupHost(env: NodeJS.ProcessEnv = process.env): string {
  const override = (env.SCREEN_QR_HOST || "").trim();
  if (override) return override;

  const nets = networkInterfaces();
  for (const ifaces of Object.values(nets)) {
    if (!ifaces) continue;
    for (const iface of ifaces) {
      // IPv4, non-loopback, non-docker-bridge, non-link-local.
      if (
        iface.family === "IPv4" &&
        !iface.internal &&
        !iface.address.startsWith("172.") &&
        !iface.address.startsWith("169.254.")
      ) {
        return iface.address;
      }
    }
  }
  return LAN_FALLBACK_HOST;
}
