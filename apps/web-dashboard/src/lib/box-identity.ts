/**
 * WARP-992 — canonical box display identity for dashboard chrome.
 *
 * The Home header + ShellPage status chip and Settings → Device information
 * all name the appliance from `useDevice().device.hostname` (the
 * orchestrator's self-registered Device row). Before WARP-992 that row held
 * `os.hostname()` — the docker CONTAINER ID inside the orchestrator container
 * — so the chip read "5639146fdc76 · Status unavailable".
 *
 * The orchestrator now registers the canonical box name
 * (apps/orchestrator/src/lib/box-identity.ts: owner-chosen DROPLET_BOX_NAME →
 * DROPLET_PUBLIC_FQDN → `droplet.local`). This client-side resolver is the
 * belt-and-braces half: already-deployed boxes keep their STALE Device rows
 * (container-id hostnames) in the DB and in the 60s devices:list cache, and a
 * dashboard can be upgraded ahead of its orchestrator — so a hostname that
 * still looks like a bare container id is masked to the stable LAN name
 * rather than shown to the customer. A container id must NEVER render as the
 * box's identity.
 */

/** The stable customer-facing LAN name — mirrors the orchestrator's
 *  `LAN_FALLBACK_HOST` (advertised via mDNS + the box AP's dnsmasq). */
export const LAN_FALLBACK_HOST = "droplet.local";

/**
 * A bare docker container id: 12 (short) to 64 (full) lowercase hex chars —
 * what `os.hostname()` returns inside a container. A legitimate identity
 * (owner name with hyphens, an FQDN with dots, an IP with dots) never matches;
 * the shared box-name ruleset makes an all-hex 12+-char owner name vanishingly
 * unlikely, and masking it to the LAN name is the safe direction.
 */
const CONTAINER_ID_RE = /^[0-9a-f]{12,64}$/;

/**
 * Resolve the display host for the appliance identity chip. Returns the
 * device's registered hostname unless it is missing, blank, or looks like a
 * bare container id — those all resolve to the stable LAN name.
 */
export function boxDisplayHost(hostname: string | null | undefined): string {
  const h = (hostname ?? "").trim();
  if (!h || CONTAINER_ID_RE.test(h)) return LAN_FALLBACK_HOST;
  return h;
}
