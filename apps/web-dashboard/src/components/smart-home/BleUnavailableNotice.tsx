import { Info } from "lucide-react";

/**
 * WARP-851 — honest commissioning-capability notice.
 *
 * Shown near the Matter pairing-code entry (setup wizard DiscoveryStep
 * and /devices/add-matter) when GET /api/matter/capabilities reports
 * `bleCommissioning: false`. Until WARP-850 lands, the box can only
 * commission devices that are already reachable on the home network —
 * a device that needs Bluetooth for first-time setup will never pair,
 * and retrying or factory-resetting it cannot help.
 *
 * Static and unanimated by design: it's ambient information, not an
 * error. Parents render it conditionally; capability-unknown shows
 * nothing (we don't warn on a guess).
 */
export function BleUnavailableNotice({ className }: { className?: string }) {
  return (
    <div
      role="note"
      data-testid="ble-unavailable-notice"
      className={`flex items-start gap-2 px-3 py-2.5 bg-surface-secondary border border-separator rounded-lg ${className ?? ""}`}
    >
      <Info
        size={14}
        className="mt-0.5 flex-shrink-0 text-label-tertiary"
        aria-hidden="true"
      />
      <p className="type-footnote text-label-secondary">
        This Droplet can add devices that are already on your home Wi-Fi.
        Devices that need Bluetooth for first-time setup aren&apos;t supported
        yet.
      </p>
    </div>
  );
}
