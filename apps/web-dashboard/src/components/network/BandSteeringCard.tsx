"use client";

import { useState } from "react";
import useSWR from "swr";
import { RadioTower, AlertTriangle } from "lucide-react";
import {
  fetchBandSteering,
  fetchNetworkOperation,
  setBandSteering,
  type BandSteeringStatus,
} from "@/lib/api";
import { ToggleSwitch } from "@/components/smart-home/ToggleSwitch";

/**
 * Band steering (WARP-1703 · Droplet Design System · Network · Wi-Fi).
 *
 * The external Droplet AP's 802.11k/v steering master switch
 * (`droplet.wifi.band_steering`): on, the AP unifies its bands under one
 * network name and nudges each device to the best band; off, the bands stay
 * split and devices park where they first joined. The card reflects the AP's
 * REAL state (GET /api/network/wifi/band-steering): with no approved Droplet
 * AP online it shows a calm read-only "not available" line rather than a fake
 * toggle (the UpnpCard honesty contract). Toggling is Tier 1 — it applies
 * immediately and the card polls the routing operation for the
 * apply-vs-rollback outcome.
 */
export function BandSteeringCard() {
  const { data, isLoading, mutate } = useSWR<BandSteeringStatus>(
    "/api/network/wifi/band-steering",
    fetchBandSteering,
    { refreshInterval: 30000 },
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const supported = data?.supported ?? false;
  const enabled = data?.enabled ?? false;

  async function pollOperation(operationId: string): Promise<void> {
    const startedAt = Date.now();
    for (;;) {
      const op = await fetchNetworkOperation(operationId);
      if (op.state === "applied") return;
      if (op.state === "rejected" || op.state === "rolled_back" || op.state === "unknown") {
        throw new Error(op.reason ?? "The change didn't take.");
      }
      if (Date.now() - startedAt > 70_000) {
        throw new Error("Timed out waiting for the access point.");
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }

  async function onToggle() {
    if (!data || !supported) return;
    const next = !enabled;
    setSaving(true);
    setError(null);
    try {
      const result = await setBandSteering(next);
      if (result.operationId) await pollOperation(result.operationId);
      await mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't update band steering.");
      await mutate();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card">
      <div className="flex items-start gap-3">
        <div
          className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ background: "var(--card-inner)", color: "var(--text-muted)" }}
        >
          <RadioTower size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="type-headline" style={{ color: "var(--text)" }}>Band steering</h3>
          {supported ? (
            <p className="type-caption-1 mt-0.5" style={{ color: "var(--text-muted)" }}>
              {enabled
                ? "Devices are steered to the best band automatically as you move around."
                : "Off — devices stay on whichever band they first joined."}
            </p>
          ) : (
            <p className="type-caption-1 mt-0.5" style={{ color: "var(--text-muted)" }}>
              Not available — band steering needs an approved Droplet access point.
            </p>
          )}
        </div>
        {supported ? (
          <ToggleSwitch
            on={enabled}
            onToggle={onToggle}
            disabled={isLoading || saving}
            ariaLabel="Band steering"
          />
        ) : (
          <span className="badge muted">
            Off
          </span>
        )}
      </div>

      {error && (
        <div
          role="alert"
          className="mt-3 flex items-start gap-2 type-caption-1 text-system-red bg-system-red/10 rounded-sm px-3 py-2"
        >
          <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
