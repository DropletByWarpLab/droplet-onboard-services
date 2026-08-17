"use client";

import { useState } from "react";
import useSWR from "swr";
import { TerminalSquare, AlertTriangle } from "lucide-react";
import {
  confirmNetworkCommand,
  fetchSshAccess,
  setSshAccess,
  type SshAccessStatus,
} from "@/lib/api";
import { ToggleSwitch } from "@/components/smart-home/ToggleSwitch";

/**
 * SSH access (Droplet Design System · Network · System) — WARP-1984.
 *
 * The support-troubleshooting door. Off by default, and off again after every
 * restart: a boot oneshot (droplet-ssh-access-boot-reset) rewrites the host
 * intent to off, so this toggle can never read green over a box that came
 * back up with sshd down. LAN-only: this never opens anything on the
 * internet side.
 *
 * COPY POSTURE (ADR-002, home-user persona). The audience for this card is not
 * a sysadmin — it is whoever owns the business. So it says "command-line login
 * to this Droplet from your local network" rather than "sshd", explains what
 * being on means in terms of consequence, and never uses "SSH" alone as though
 * the word carried its own explanation. The heading keeps the term because
 * that IS what a support engineer will ask them to turn on, by name.
 *
 * The three-state readback matters more than it looks. `pending` and `unknown`
 * both render distinctly from `off` because "we can't confirm the box opened
 * the door" and "the door is shut" send someone down completely different
 * paths during an incident.
 */
export function SshAccessCard() {
  const { data, isLoading, mutate } = useSWR<SshAccessStatus>(
    "/api/network/ssh",
    fetchSshAccess,
    { refreshInterval: 15000 },
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enabled = data?.enabled ?? false;
  const status = data?.status ?? "unknown";
  // No host units on this deployment shape — render honestly read-only rather
  // than a toggle that would write an intent nothing will ever pick up.
  const unavailable = status === "unknown";

  async function onToggle() {
    if (!data || unavailable) return;
    const next = !enabled;
    setSaving(true);
    setError(null);
    try {
      const result = await setSshAccess(next);
      if (
        result.status === "confirmation_required" &&
        result.confirmationToken &&
        result.operation
      ) {
        // Tier 3 — the toggle itself is the consent, same two-step the
        // reboot and VPN controls already use.
        await confirmNetworkCommand(result.confirmationToken, result.operation);
      }
      await mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't change SSH access.");
      await mutate();
    } finally {
      setSaving(false);
    }
  }

  function description(): string {
    if (unavailable) {
      return "Not available on this Droplet — no command-line login is offered.";
    }
    if (status === "pending") {
      return enabled
        ? "Turning off — waiting for the Droplet to confirm."
        : "Turning on — waiting for the Droplet to confirm.";
    }
    return enabled
      ? "On — someone with the login can reach this Droplet from your local network."
      : "Off — no command-line login to this Droplet.";
  }

  return (
    <div className="card">
      <div className="flex items-start gap-3">
        <div
          className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ background: "var(--card-inner)", color: "var(--text-muted)" }}
        >
          <TerminalSquare size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="type-headline" style={{ color: "var(--text)" }}>
            SSH access
          </h3>
          <p className="type-caption-1 mt-0.5" style={{ color: "var(--text-muted)" }}>
            {description()}
          </p>
        </div>
        {unavailable ? (
          <span className="badge muted">Off</span>
        ) : (
          <ToggleSwitch
            on={enabled}
            onToggle={onToggle}
            disabled={isLoading || saving || status === "pending"}
            ariaLabel="SSH access for troubleshooting"
          />
        )}
      </div>

      {enabled && status === "applied" && (
        <div className="mt-3 flex items-start gap-2 type-caption-1 text-system-orange bg-system-orange/10 rounded-sm px-3 py-2">
          <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
          <span>
            Leave this on only while someone is troubleshooting, then turn it
            back off. If you forget, it turns itself off the next time this
            Droplet restarts.
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
