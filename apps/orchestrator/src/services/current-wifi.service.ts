/**
 * WARP-1714 — resolve the household Wi-Fi the box is actually broadcasting.
 *
 * The dashboard's Wi-Fi card opened with empty SSID/password fields and no way
 * to read back what you'd set. Reading the router alone does not fix that on
 * every shape:
 *
 *   • single-box / legacy — the router runs the household AP itself, so its
 *     netifd wireless status carries the ssid + key.
 *   • edge-router (what the lab box runs) — the Pi's `radio0` reports
 *     `interfaces: []` and its uci holds only a DISABLED `ssid='OpenWrt'`
 *     placeholder with no key. The real Wi-Fi is on the standalone AP. Reading
 *     the router here yields nothing, and reading its uci would yield the
 *     placeholder — an answer that is worse than none, because it looks real.
 *
 * So: prefer a live router AP-mode interface, fall back to an approved AP, and
 * when neither can answer say WHY. A blank card that means "we couldn't ask"
 * must never be indistinguishable from one that means "no Wi-Fi is set".
 */

import type { PrismaClient } from "@prisma/client";
import * as openwrt from "./openwrt.client.js";

export type CurrentWifiSource = "router" | "ap" | null;

export interface CurrentWifi {
  ssid: string | null;
  key: string | null;
  /** Where the answer came from — null when nothing could be resolved. */
  source: CurrentWifiSource;
  /** Operator-facing explanation, always populated. */
  detail: string;
  /** The AP section/radio the write path should target, when known. */
  section: string | null;
  radio: string | null;
}

/** The section the orchestrator's Wi-Fi writes default to. */
const PRIMARY_SECTION = "default_radio0";
const GUEST_NETWORK = "guest";

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function networkNames(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return typeof v === "string" ? v.split(/\s+/).filter(Boolean) : [];
}

interface RouterCandidate {
  radio: string;
  section: string;
  ssid: string;
  key: string;
  isPrimarySection: boolean;
  disabled: boolean;
}

/**
 * Pick the household AP-mode interface out of a netifd wireless status blob.
 *
 * Deliberately reads the RUNTIME status, not uci: a uci section can be present
 * and disabled (exactly the Pi's `default_radio0`), and showing a disabled
 * placeholder as the household Wi-Fi is a confident wrong answer.
 */
export function findRouterWifi(wireless: unknown): RouterCandidate | null {
  const radios = asRecord(wireless);
  if (!radios) return null;

  const candidates: RouterCandidate[] = [];
  for (const [radioName, radioValue] of Object.entries(radios)) {
    const radio = asRecord(radioValue);
    const interfaces = radio?.interfaces;
    if (!Array.isArray(interfaces)) continue;

    for (const ifaceValue of interfaces) {
      const iface = asRecord(ifaceValue);
      const config = asRecord(iface?.config);
      if (!config) continue;
      if (asString(config.mode).toLowerCase() !== "ap") continue;
      if (networkNames(config.network).includes(GUEST_NETWORK)) continue;
      const ssid = asString(config.ssid);
      if (!ssid) continue;
      const section = asString(iface?.section);
      candidates.push({
        radio: radioName,
        section,
        ssid,
        key: asString(config.key),
        isPrimarySection: section === PRIMARY_SECTION,
        disabled: config.disabled === true || config.disabled === "1",
      });
    }
  }
  if (candidates.length === 0) return null;
  return (
    candidates.find((c) => c.isPrimarySection) ??
    candidates.find((c) => !c.disabled) ??
    candidates[0]
  );
}

/**
 * Resolve the current household Wi-Fi. Never throws — every failure becomes an
 * honest `source: null` with a `detail` the operator can act on.
 */
export async function getCurrentWifi(
  prisma: PrismaClient,
  wirelessStatus: unknown,
): Promise<CurrentWifi> {
  const fromRouter = findRouterWifi(wirelessStatus);
  if (fromRouter) {
    return {
      ssid: fromRouter.ssid,
      key: fromRouter.key,
      source: "router",
      detail: "Broadcast by this Droplet.",
      section: fromRouter.section,
      radio: fromRouter.radio,
    };
  }

  const aps = await prisma.apDevice
    .findMany({
      where: { status: "ONLINE" },
      select: { mac: true, displayName: true },
    })
    .catch(() => [] as Array<{ mac: string; displayName: string | null }>);

  if (aps.length === 0) {
    return {
      ssid: null,
      key: null,
      source: null,
      detail:
        "No Wi-Fi is being broadcast yet — this Droplet's radio isn't hosting a network and no access point has been approved.",
      section: null,
      radio: null,
    };
  }

  // A credential gap is the single most likely reason we can't read the AP, and
  // it's operator-fixable — so report it rather than showing empty fields.
  let sawUnsupported = false;
  for (const ap of aps) {
    const result = await openwrt
      .fetchApWireless(ap.mac)
      .catch(() => ({ supported: true, wireless: null }));
    if (!result.supported) {
      sawUnsupported = true;
      continue;
    }
    if (result.wireless?.ssid) {
      const name = ap.displayName?.trim() || "the access point";
      return {
        ssid: result.wireless.ssid,
        key: result.wireless.key || null,
        source: "ap",
        detail: `Broadcast by ${name}.`,
        section: result.wireless.section || null,
        radio: null,
      };
    }
  }

  return {
    ssid: null,
    key: null,
    source: null,
    detail: sawUnsupported
      ? "Can't read the current Wi-Fi: this Droplet has no access-point credential configured. Run ./scripts/setup.sh --sync-secrets and restart the routing container."
      : "Can't read the current Wi-Fi from the access point right now — it may be offline.",
    section: null,
    radio: null,
  };
}
