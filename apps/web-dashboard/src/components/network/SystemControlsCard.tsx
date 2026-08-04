"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { AlertCircle, CheckCircle2, Clock, Globe, Lightbulb, Loader2, Server } from "lucide-react";
import {
  confirmNetworkCommand,
  fetchNetworkOperation,
  fetchSystemControls,
  setHostname,
  setNtp,
  type SystemControls,
} from "@/lib/api";
import { ToggleSwitch } from "@/components/smart-home/ToggleSwitch";

/**
 * System controls (Droplet Design System · Network · System).
 *
 * Hostname (Tier 2 — re-keys mDNS/.local, so the save confirms) and the OpenWrt
 * time-sync daemon (Tier 1 — applies immediately) are real, editable controls
 * on the in-container OpenWrt. Status-LED and regulatory domain are HONEST GATES
 * on the single-box shape: the front-panel LEDs are physical on the host SBC
 * (no in-container surface) and the AP country is pinned in host hostapd — so
 * they render an inert "not available on this appliance" row (the live country
 * value is still shown read-only) rather than a control that no-ops. The gate is
 * driven by the supported/editable flags from the API, so a multi-box shape with
 * a live radio lights the same UI up without a rewrite.
 */
type HostnameStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

export function SystemControlsCard() {
  const { data, mutate } = useSWR<SystemControls>(
    "/api/network/system/controls",
    fetchSystemControls,
  );

  const [hostname, setHostnameValue] = useState("");
  const [hostnameStatus, setHostnameStatus] = useState<HostnameStatus>({ kind: "idle" });
  const [ntpSaving, setNtpSaving] = useState(false);
  const [ntpError, setNtpError] = useState<string | null>(null);

  useEffect(() => {
    if (data?.hostname != null) setHostnameValue(data.hostname);
  }, [data?.hostname]);

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

  async function saveHostname() {
    if (!HOSTNAME_RE.test(hostname) || hostname.length > 63) {
      setHostnameStatus({
        kind: "error",
        message: "Use lowercase letters, digits and hyphens — no spaces.",
      });
      return;
    }
    setHostnameStatus({ kind: "saving" });
    try {
      const result = await setHostname(hostname);
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
      setHostnameStatus({ kind: "saved" });
    } catch (e) {
      setHostnameStatus({
        kind: "error",
        message: e instanceof Error ? e.message : "Couldn't change the hostname.",
      });
    }
  }

  async function toggleNtp() {
    if (!data) return;
    const next = !data.ntpEnabled;
    setNtpSaving(true);
    setNtpError(null);
    try {
      await setNtp(next);
      await mutate();
    } catch (e) {
      setNtpError(e instanceof Error ? e.message : "Couldn't update time sync.");
      await mutate();
    } finally {
      setNtpSaving(false);
    }
  }

  const savingHostname = hostnameStatus.kind === "saving";
  const ntpEnabled = data?.ntpEnabled ?? false;
  const ledSupported = data?.statusLed.supported ?? false;
  const countryEditable = data?.country.editable ?? false;
  const countryValue = data?.country.value ?? null;

  return (
    <div className="card">
      <div className="flex items-center gap-2 mb-1">
        <Server size={18} style={{ color: "var(--text-muted)" }} aria-hidden="true" />
        <h3 className="type-headline" style={{ color: "var(--text)" }}>System</h3>
      </div>
      <p className="type-subheadline mb-4" style={{ color: "var(--text-muted)" }}>
        The appliance&apos;s name on your network and its time-sync settings.
      </p>

      <div className="space-y-5 max-w-md">
        {/* Hostname — Tier 2 */}
        <div>
          <label
            htmlFor="system-hostname"
            className="type-subheadline block mb-1.5"
            style={{ color: "var(--text-muted)" }}
          >
            Hostname
          </label>
          <p className="type-caption-1 mb-1.5" style={{ color: "var(--text-muted)" }}>
            Changing this renames the appliance on your network — devices may
            briefly lose its address, so we ask you to confirm.
          </p>
          <div className="flex items-center gap-2">
            <input
              id="system-hostname"
              type="text"
              value={hostname}
              onChange={(e) => setHostnameValue(e.target.value)}
              className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] transition-colors"
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-input)",
                color: "var(--text)",
              }}
              maxLength={63}
              autoComplete="off"
              spellCheck={false}
              disabled={savingHostname}
            />
            <button
              type="button"
              onClick={saveHostname}
              disabled={savingHostname}
              className="btn flex-shrink-0"
            >
              {savingHostname && <Loader2 size={16} className="animate-spin" />}
              Save hostname
            </button>
          </div>
          {hostnameStatus.kind === "saved" && (
            <div
              role="status"
              className="mt-2 flex items-start gap-2 type-footnote bg-system-green/10 rounded-sm px-3 py-2"
              style={{ color: "var(--text)" }}
            >
              <CheckCircle2 size={14} className="mt-0.5 flex-shrink-0 text-system-green" aria-hidden="true" />
              <span>Hostname updated.</span>
            </div>
          )}
          {hostnameStatus.kind === "error" && (
            <div
              role="alert"
              className="mt-2 flex items-start gap-2 type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2"
            >
              <AlertCircle size={14} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
              <span>{hostnameStatus.message}</span>
            </div>
          )}
        </div>

        {/* NTP / time-sync — Tier 1 */}
        <div className="flex items-start gap-3 pt-1">
          <Clock size={16} className="mt-0.5 flex-shrink-0" style={{ color: "var(--text-muted)" }} aria-hidden="true" />
          <div className="flex-1 min-w-0">
            <p className="type-subheadline" style={{ color: "var(--text)" }}>Time sync</p>
            <p className="type-caption-1 mt-0.5" style={{ color: "var(--text-muted)" }}>
              Keeps the appliance&apos;s OpenWrt clock accurate over the internet.
            </p>
          </div>
          <ToggleSwitch
            on={ntpEnabled}
            onToggle={toggleNtp}
            disabled={!data || ntpSaving}
            ariaLabel="Time sync (NTP)"
          />
        </div>
        {ntpError && (
          <div
            role="alert"
            className="flex items-start gap-2 type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2"
          >
            <AlertCircle size={14} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
            <span>{ntpError}</span>
          </div>
        )}

        {/* Status light — honest gate on the single-box shape */}
        <div className="flex items-start gap-3 pt-1">
          <Lightbulb size={16} className="mt-0.5 flex-shrink-0" style={{ color: "var(--text-muted)" }} aria-hidden="true" />
          <div className="flex-1 min-w-0">
            <p className="type-subheadline" style={{ color: "var(--text)" }}>Status light</p>
            <p className="type-caption-1 mt-0.5" style={{ color: "var(--text-muted)" }}>
              {ledSupported
                ? "The front-panel activity light."
                : "Not available on this appliance — the status light is on the appliance itself, not the network software."}
            </p>
          </div>
          {ledSupported ? (
            <ToggleSwitch
              on={data?.statusLed.enabled ?? false}
              onToggle={() => {}}
              disabled
              ariaLabel="Status light"
            />
          ) : (
            <span className="badge muted">
              n/a
            </span>
          )}
        </div>

        {/* Regulatory domain — read-only value + honest gate on single-box */}
        <div className="flex items-start gap-3 pt-1">
          <Globe size={16} className="mt-0.5 flex-shrink-0" style={{ color: "var(--text-muted)" }} aria-hidden="true" />
          <div className="flex-1 min-w-0">
            <p className="type-subheadline" style={{ color: "var(--text)" }}>Wi-Fi country</p>
            <p className="type-caption-1 mt-0.5" style={{ color: "var(--text-muted)" }}>
              {countryEditable
                ? "The regulatory domain your Wi-Fi follows."
                : "Not available on this appliance — the Wi-Fi country is set when the appliance is built and can't be changed here."}
            </p>
          </div>
          <span
            className="type-caption-1 font-mono px-2 py-0.5 rounded-sm flex-shrink-0"
            style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}
          >
            {countryValue ?? "—"}
          </span>
        </div>
      </div>
    </div>
  );
}
