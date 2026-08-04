"use client";

import { useState } from "react";
import { Signal, Wifi, WifiOff } from "lucide-react";
import { scanWifiNetworks, RouterStatusError } from "@/lib/api";
import type { WirelessScanResult } from "@/lib/types";

/**
 * WARP-816 — "Nearby Networks" scanner for the Network → WiFi tab.
 *
 * Extracted from network/page.tsx so the scan state machine is unit-testable in
 * isolation. The states are:
 *
 *   idle        → prompt the user to Scan.
 *   scanning    → the Scan control shows progress.
 *   results     → the discovered networks list.
 *   empty       → a scannable radio genuinely found nothing ("No networks found").
 *   unsupported → the radio is broadcasting the Droplet's own Wi-Fi on its only
 *                 radio and physically can't station-scan. The orchestrator
 *                 signals this with a typed RouterStatusError (code
 *                 SCAN_UNSUPPORTED); we render calm, explanatory copy and REMOVE
 *                 the Scan control (re-scanning can't change a hardware fact) —
 *                 never the empty list, and never the raw code (WARP-807).
 *   error       → a transient/unknown failure: a calm, retryable message with
 *                 the Scan control kept enabled.
 *
 * "unsupported" is deliberately distinct from "empty": the former is a stable
 * capability fact about this deployment shape, the latter is a normal result.
 */
type ScanState =
  | { kind: "idle" }
  | { kind: "results"; networks: WirelessScanResult[] }
  | { kind: "unsupported"; message: string }
  | { kind: "error" };

export function WifiScanPanel() {
  const [state, setState] = useState<ScanState>({ kind: "idle" });
  const [scanning, setScanning] = useState(false);

  async function handleScan() {
    setScanning(true);
    try {
      const networks = await scanWifiNetworks();
      setState({ kind: "results", networks });
    } catch (e) {
      if (e instanceof RouterStatusError && e.code === "SCAN_UNSUPPORTED") {
        // The friendly message is authored upstream (orchestrator) and is safe
        // to surface verbatim — it carries no code/status.
        setState({ kind: "unsupported", message: e.message });
      } else {
        setState({ kind: "error" });
      }
    } finally {
      setScanning(false);
    }
  }

  const unsupported = state.kind === "unsupported";

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <h3 className="type-headline text-[color:var(--text)]">Nearby Networks</h3>
        {/* When scanning is unsupported on this radio, re-running can't help —
            remove the control rather than leave a dead, disabled button. */}
        {!unsupported && (
          <button
            onClick={handleScan}
            disabled={scanning}
            className="btn ghost sm"
          >
            <Signal size={14} className={scanning ? "animate-pulse" : ""} />
            {scanning ? "Scanning…" : "Scan"}
          </button>
        )}
      </div>

      {state.kind === "unsupported" ? (
        // Informational, not alarming: this is expected on a single-radio box
        // that's broadcasting its own Wi-Fi. role="status" (not "alert"), muted
        // tone — mirrors how the page treats the DISABLED router state.
        <div role="status" className="flex flex-col items-center text-center py-8">
          <WifiOff size={28} className="text-[color:var(--text-faint)] mb-3" aria-hidden="true" />
          <p className="type-subheadline text-[color:var(--text-muted)] max-w-sm">{state.message}</p>
        </div>
      ) : state.kind === "results" && state.networks.length > 0 ? (
        <div className="space-y-2">
          {state.networks.map((network, i) => (
            <div
              key={`${network.bssid}-${i}`}
              className="flex items-center justify-between px-3 py-2 rounded-sm bg-[var(--inset)]"
            >
              <div className="flex items-center gap-3">
                <Wifi
                  size={16}
                  className={
                    network.signal > -50
                      ? "text-system-green"
                      : network.signal > -70
                      ? "text-system-orange"
                      : "text-system-red"
                  }
                  aria-hidden="true"
                />
                <div>
                  <p className="type-subheadline text-[color:var(--text)]">
                    {network.ssid || "(Hidden)"}
                  </p>
                  <p className="type-caption-2 text-[color:var(--text-muted)]">
                    Ch {network.channel} | {network.encryption.enabled ? "Encrypted" : "Open"}
                  </p>
                </div>
              </div>
              <span className="type-caption-1 text-[color:var(--text-muted)]">{network.signal} dBm</span>
            </div>
          ))}
        </div>
      ) : state.kind === "results" ? (
        <p className="type-subheadline text-[color:var(--text-muted)]">No networks found.</p>
      ) : state.kind === "error" ? (
        <p role="status" className="type-subheadline text-[color:var(--text-muted)]">
          We couldn&apos;t scan just now. Please try again.
        </p>
      ) : (
        <p className="type-subheadline text-[color:var(--text-muted)]">
          Click Scan to search for nearby WiFi networks.
        </p>
      )}
    </div>
  );
}
