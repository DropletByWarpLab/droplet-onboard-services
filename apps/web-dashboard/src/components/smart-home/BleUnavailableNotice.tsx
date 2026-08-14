import { Info } from "lucide-react";

/**
 * WARP-851 — honest commissioning-capability notice.
 *
 * Shown near the Matter pairing-code entry (setup wizard DiscoveryStep
 * and /devices/add-matter) when GET /api/matter/capabilities reports a
 * commissioning path that can't work on this box:
 *
 *  - `no-ble` (default): `bleCommissioning: false` — the box can only
 *    commission devices already reachable on the home network; a device
 *    that needs Bluetooth for first-time setup will never pair, and
 *    retrying or factory-resetting it cannot help.
 *  - `no-wifi-provisioning` (WARP-1035): BLE works, but the box can't
 *    hand a BLE-paired device the Droplet AP's Wi-Fi credentials
 *    (`wifiProvisioning: false`) — commissioning is effectively
 *    on-network-only, so say so instead of letting a BLE-first device
 *    time out with misleading copy.
 *
 * Static and unanimated by design: it's ambient information, not an
 * error. Parents render it conditionally; capability-unknown shows
 * nothing (we don't warn on a guess).
 */
export function BleUnavailableNotice({
  className,
  variant = "no-ble",
}: {
  className?: string;
  variant?: "no-ble" | "no-wifi-provisioning";
}) {
  const testId =
    variant === "no-wifi-provisioning"
      ? "wifi-provisioning-unavailable-notice"
      : "ble-unavailable-notice";
  return (
    <div
      role="note"
      data-testid={testId}
      className={`flex items-start gap-2 px-3 py-2.5 rounded-lg ${className ?? ""}`}
      style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}
    >
      <Info
        size={14}
        className="mt-0.5 flex-shrink-0"
        style={{ color: "var(--text-muted)" }}
        aria-hidden="true"
      />
      <p className="type-footnote" style={{ color: "var(--text-muted)" }}>
        {variant === "no-wifi-provisioning"
          ? "This Droplet can see Bluetooth devices but can't hand them Wi-Fi yet — add devices that are already on your Wi-Fi."
          : "This Droplet can add devices that are already on your workspace Wi-Fi. Devices that need Bluetooth for first-time setup aren't supported yet."}
      </p>
    </div>
  );
}
