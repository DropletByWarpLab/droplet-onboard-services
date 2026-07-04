/**
 * WARP-1035: elapsed-time spinner copy for the commissioning wait.
 *
 * We have no real progress signal (matter.js emits state events, not a
 * percentage), so the page shows what's *likely* happening based on
 * elapsed time. The 15-25s phase used to claim "Sharing Wi-Fi
 * credentials with the device…" unconditionally — a literal lie on a
 * box whose per-box AP PSK isn't plumbed to the matter-controller
 * (commissioning is then on-network-only and no credentials are ever
 * exchanged). The claim is now gated on the wifiProvisioning
 * capability (GET /api/matter/capabilities).
 *
 * Pure and exported so the gate is unit-testable without fake-timer
 * gymnastics; the page's CommissioningProgress consumes it.
 */
export function commissioningPhaseCopy(
  elapsedS: number,
  wifiProvisioning: boolean,
): string {
  if (elapsedS < 5) return "Finding the device on your network…";
  if (elapsedS < 15) return "Setting up secure pairing…";
  if (elapsedS < 25) {
    return wifiProvisioning
      ? "Sharing Wi-Fi credentials with the device…"
      : "Waiting for the device to respond…";
  }
  return "Almost done — installing the device certificate…";
}
