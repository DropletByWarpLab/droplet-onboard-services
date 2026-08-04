"use client";

import { useState } from "react";
import useSWR from "swr";
import { Network, AlertTriangle } from "lucide-react";
import {
  confirmNetworkCommand,
  fetchNetworkOperation,
  fetchUpnp,
  setUpnp,
  type UpnpStatus,
} from "@/lib/api";
import { ToggleSwitch } from "@/components/smart-home/ToggleSwitch";

/**
 * UPnP / NAT-PMP (Droplet Design System · Network · Firewall).
 *
 * Automatic port opening, off by default — a privacy appliance shouldn't open
 * holes in its own firewall without being asked. The card reflects the box's
 * REAL state (GET /api/network/upnp): when miniupnpd isn't installed it shows a
 * calm read-only "not available" line rather than a fake toggle. When it IS
 * available, toggling is Tier 2 (the orchestrator answers 202 + token; the
 * toggle is the consent) — turning it on can expose LAN services to the
 * internet, so we say so.
 */
export function UpnpCard() {
  const { data, isLoading, mutate } = useSWR<UpnpStatus>(
    "/api/network/upnp",
    fetchUpnp,
    { refreshInterval: 30000 },
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const available = data?.available ?? false;
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
        throw new Error("Timed out waiting for the router.");
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }

  async function onToggle() {
    if (!data || !available) return;
    const next = !enabled;
    setSaving(true);
    setError(null);
    try {
      const result = await setUpnp(next);
      if (
        result.status === "confirmation_required" &&
        result.confirmationToken &&
        result.operation
      ) {
        const { operationId } = await confirmNetworkCommand(
          result.confirmationToken,
          result.operation,
        );
        if (operationId) await pollOperation(operationId);
      }
      await mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't update UPnP.");
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
          <Network size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="type-headline" style={{ color: "var(--text)" }}>UPnP &amp; NAT-PMP</h3>
          {available ? (
            <p className="type-caption-1 mt-0.5" style={{ color: "var(--text-muted)" }}>
              {enabled
                ? "Apps can open ports automatically. Turning this off keeps your firewall closed."
                : "Off — Droplet never opens ports automatically."}
            </p>
          ) : (
            <p className="type-caption-1 mt-0.5" style={{ color: "var(--text-muted)" }}>
              Not available on this Droplet — it never opens ports automatically.
            </p>
          )}
        </div>
        {available ? (
          <ToggleSwitch
            on={enabled}
            onToggle={onToggle}
            disabled={isLoading || saving}
            ariaLabel="UPnP and NAT-PMP"
          />
        ) : (
          <span className="badge muted">
            Off
          </span>
        )}
      </div>

      {available && enabled && (
        <div className="mt-3 flex items-start gap-2 type-caption-1 text-system-orange bg-system-orange/10 rounded-sm px-3 py-2">
          <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
          <span>
            Automatic port opening can expose devices on your network to the
            internet.
          </span>
        </div>
      )}

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
