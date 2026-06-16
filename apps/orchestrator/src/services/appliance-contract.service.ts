/**
 * Appliance hardware contract (PR #373 / docs/ONBOARDING_CLAIM.md +
 * #371 handoff §2 + FEATURES.md §9).
 *
 * Assembles the read-only `{ appliance_id, compute, storage, network, display,
 * supply_chain }` object the onboarding Claim step renders.
 *
 * ⚠️ DOCUMENTED STUB. There is NO orchestrator facility today that produces
 * this exact shape end-to-end:
 *   - `appliance_id` is the stable device identity (here a config/env-derived
 *     value; the device-identity service owns the real serial-bound id).
 *   - `compute` / `storage` / `display` are PLACEHOLDER descriptors. The real
 *     sources are the device-bridge inventory (drives), the model-readiness
 *     service (compute), and the status-display service — none of which
 *     expose a claim-time summary yet. They are FOLLOW-UPS.
 *   - `network` is the ONLY field with a live source: the routing service's
 *     `/system/info` is router-only, so we BEST-EFFORT enrich it via
 *     `fetchNetworkSummary()` and fall back to the placeholder when the router
 *     is offline (the single-box deployment shape has no separate router).
 *   - `supply_chain` (TAA / NDAA §889) is a static compliance attestation the
 *     UI renders as a reassurance chip.
 *
 * The shape is the contract; the per-field SOURCES harden in later PRs. Keeping
 * this in one service (rather than inline in the route) gives the dashboard a
 * stable thing to build against and a single place to wire real sources into.
 */
import pino from "pino";
import { fetchNetworkSummary } from "./openwrt.client.js";

const logger = pino({ name: "appliance-contract" });

export interface ApplianceSpec {
  /** Short human label, e.g. "Compute". */
  label: string;
  /** One-line value, e.g. "inference host + router host control plane". */
  value: string;
  /** Whether this subsystem is reporting healthy (drives the UI dot). */
  online: boolean;
}

export interface ApplianceContract {
  /** Stable device identity, rendered mono on the appliance card. */
  appliance_id: string;
  compute: ApplianceSpec;
  storage: ApplianceSpec;
  network: ApplianceSpec;
  display: ApplianceSpec;
  supply_chain: {
    taa_compliant: boolean;
    ndaa_889_clear: boolean;
    /** Short attestation line the UI shows in the success chip. */
    summary: string;
  };
}

/**
 * Resolve the appliance id. STUB: prefer an explicit `APPLIANCE_ID` env, else
 * derive a stable-looking id so the card renders a mono value during
 * onboarding. The device-identity service owns the real serial-bound id (a
 * follow-up wires it here).
 */
function resolveApplianceId(): string {
  return process.env.APPLIANCE_ID?.trim() || "droplet-appliance";
}

/**
 * Best-effort live `network` descriptor from the routing service. The routing
 * `/system/info` (and the summary endpoint) is ROUTER-ONLY; on the single-box
 * deployment shape there is no separate router, so this throws and we fall back
 * to the placeholder. NEVER lets a router error fail the contract — the Claim
 * card must render even when the router is offline.
 */
async function networkSpec(): Promise<ApplianceSpec> {
  try {
    const summary = await fetchNetworkSummary();
    // `fetchNetworkSummary` shape is router-defined; render a compact line and
    // treat a successful fetch as "online". We read defensively so a partial
    // payload can't throw here.
    const wan = (summary as { wan?: { proto?: string; up?: boolean } }).wan;
    const detail = wan?.proto ? `WAN · ${wan.proto}` : "Router reachable";
    return {
      label: "Network",
      value: detail,
      online: wan?.up ?? true,
    };
  } catch (err) {
    // Router offline / disabled (single-box) — placeholder, not an error.
    logger.debug(
      { err },
      "Router /system/info unavailable; using placeholder network spec",
    );
    return {
      label: "Network",
      value: "On your local network",
      online: true,
    };
  }
}

/**
 * Assemble the full hardware contract for the Claim step. The router-derived
 * `network` is best-effort; every other field is a documented placeholder
 * pending its real source.
 */
export async function getApplianceContract(): Promise<ApplianceContract> {
  const network = await networkSpec();
  return {
    appliance_id: resolveApplianceId(),
    compute: {
      label: "Compute",
      value: "Local AI compute + control plane",
      online: true,
    },
    storage: {
      label: "Storage",
      value: "Encrypted at rest",
      online: true,
    },
    network,
    display: {
      label: "Display",
      value: "Front-panel display",
      online: true,
    },
    supply_chain: {
      taa_compliant: true,
      ndaa_889_clear: true,
      summary: "Supply chain verified · TAA compliant · NDAA §889 clear",
    },
  };
}
