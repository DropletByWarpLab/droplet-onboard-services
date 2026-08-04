/**
 * WARP-1714 — read the household's current Wi-Fi name + password out of the
 * netifd wireless status that `/api/network/status` already ships.
 *
 * `NetworkOverview.wireless` is the raw `network.wireless status` payload
 * (or its `luci-rpc getWirelessDevices` stand-in on strict-netifd builds —
 * WARP-1681 keeps both paths to one shape). Per radio:
 *
 *   radio0: {
 *     config: { channel, band, ... },
 *     interfaces: [
 *       { section: "default_radio0",
 *         config: { mode: "ap", ssid: "...", key: "...", network: ["lan"] } },
 *     ],
 *   }
 *
 * The picker must resolve the SAME interface the Save button writes to,
 * otherwise the card would display one network while editing another. The
 * orchestrator defaults those writes to radio `radio0` / section
 * `default_radio0` (routes/network-wifi.routes.ts), so that section wins when
 * present; the fallback keeps the card working on shapes that name their
 * sections differently rather than showing an empty form.
 *
 * Guest Wi-Fi is deliberately excluded — it is a separate iface bound to the
 * `guest` network with its own card (GuestWifiCard), and surfacing its PSK here
 * would mislabel the guest password as the household one.
 */

/** The interface the Wi-Fi card reads from and writes to. */
export interface PrimaryWifi {
  /** Radio the interface sits on, e.g. `radio0`. */
  radio: string;
  /** UCI section name, e.g. `default_radio0`. */
  section: string;
  ssid: string;
  /** Pre-shared key. Empty string when the network is open or the build
   *  doesn't report a key — never a fabricated placeholder. */
  key: string;
}

/** The section the orchestrator's Wi-Fi writes default to. */
const PRIMARY_SECTION = "default_radio0";
const GUEST_NETWORK = "guest";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** netifd reports `network` as a list, but some builds emit a bare string. */
function networkNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return typeof value === "string" ? value.split(/\s+/).filter(Boolean) : [];
}

interface Candidate extends PrimaryWifi {
  isPrimarySection: boolean;
  disabled: boolean;
}

/**
 * Pick the household Wi-Fi interface out of a netifd wireless status blob.
 * Returns `null` when the box exposes no AP-mode interface — an honest
 * "nothing to prefill" rather than a guess (CLAUDE.md no-guessing rule).
 */
export function findPrimaryWifi(wireless: unknown): PrimaryWifi | null {
  const radios = asRecord(wireless);
  if (!radios) return null;

  const candidates: Candidate[] = [];

  for (const [radioName, radioValue] of Object.entries(radios)) {
    const radio = asRecord(radioValue);
    const interfaces = radio?.interfaces;
    if (!Array.isArray(interfaces)) continue;

    for (const ifaceValue of interfaces) {
      const iface = asRecord(ifaceValue);
      const config = asRecord(iface?.config);
      if (!config) continue;

      // Only an AP-mode iface broadcasts a network name a household joins.
      if (asString(config.mode).toLowerCase() !== "ap") continue;
      if (networkNames(config.network).includes(GUEST_NETWORK)) continue;

      const ssid = asString(config.ssid);
      if (!ssid) continue;

      const section = asString(iface?.section);
      candidates.push({
        // The status blob is keyed BY radio device name — that key is the
        // `radio` the write path wants, not anything inside the config.
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

  // The write target wins outright; otherwise prefer an enabled radio over a
  // disabled one, then fall back to declaration order.
  const chosen =
    candidates.find((c) => c.isPrimarySection) ??
    candidates.find((c) => !c.disabled) ??
    candidates[0];

  return { radio: chosen.radio, section: chosen.section, ssid: chosen.ssid, key: chosen.key };
}
