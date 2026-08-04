"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { CheckCircle2, Loader2, Network, AlertCircle } from "lucide-react";
import {
  confirmNetworkCommand,
  fetchDhcpPool,
  fetchNetworkOperation,
  setDhcpPool,
  type DhcpPool,
} from "@/lib/api";

/**
 * DHCP pool — the LAN address range Droplet hands out + how long each lease
 * lasts (Droplet Design System · Network · System).
 *
 * Reshaping the pool is Tier 2: shrinking it can strand devices that already
 * hold a lease, so the orchestrator answers the save with 202 + a token; the
 * Save click IS the consent, which the form echoes back through
 * confirmNetworkCommand and then polls the operation for the apply-vs-rollback
 * outcome. Mirrors the WifiSettingsForm / UpnpCard write idiom.
 */
const LEASE_OPTIONS = [
  { value: "1h", label: "1 hour" },
  { value: "12h", label: "12 hours" },
  { value: "24h", label: "24 hours" },
  { value: "infinite", label: "Never expires" },
] as const;

type Status =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

export function DhcpPoolForm() {
  const { data, isLoading, mutate } = useSWR<DhcpPool>(
    "/api/network/dhcp/pool",
    fetchDhcpPool,
  );

  const [start, setStart] = useState("");
  const [limit, setLimit] = useState("");
  const [leasetime, setLeasetime] = useState("12h");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  // Hydrate the editable fields from the live pool once it loads. A null field
  // means the box uses a default, so we fall back to the dnsmasq-typical values
  // rather than render an empty input.
  useEffect(() => {
    if (!data) return;
    setStart(data.start ?? "100");
    setLimit(data.limit ?? "150");
    // Always seed from the server value so a save never silently overwrites an
    // unlisted leasetime (e.g. "2h", "30m") with the form default. If the
    // value isn't in LEASE_OPTIONS the dropdown will show no selection,
    // making the mismatch visible rather than transparent.
    if (data.leasetime) {
      setLeasetime(data.leasetime);
    }
  }, [data]);

  async function pollOperation(operationId: string): Promise<void> {
    const startedAt = Date.now();
    for (;;) {
      const op = await fetchNetworkOperation(operationId);
      if (op.state === "applied") return;
      if (op.state === "rejected" || op.state === "rolled_back" || op.state === "unknown") {
        throw new Error(op.reason ?? "The change didn't take, so nothing was changed.");
      }
      if (Date.now() - startedAt > 70_000) {
        throw new Error("Timed out waiting for the router.");
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }

  function validate(): string | null {
    const s = Number(start);
    const l = Number(limit);
    if (!Number.isInteger(s) || s < 2 || s > 254) {
      return "Start must be between 2 and 254.";
    }
    if (!Number.isInteger(l) || l < 1 || l > 253) {
      return "Pool size must be between 1 and 253.";
    }
    return null;
  }

  async function handleSave() {
    const v = validate();
    if (v) {
      setStatus({ kind: "error", message: v });
      return;
    }
    setStatus({ kind: "saving" });
    try {
      const result = await setDhcpPool(Number(start), Number(limit), leasetime);
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
      setStatus({ kind: "saved" });
    } catch (e) {
      setStatus({
        kind: "error",
        message: e instanceof Error ? e.message : "Couldn't update the DHCP pool.",
      });
      await mutate();
    }
  }

  const saving = status.kind === "saving";

  return (
    <div className="card">
      <div className="flex items-center gap-2 mb-1">
        <Network size={18} className="text-[color:var(--text-muted)]" aria-hidden="true" />
        <h3 className="type-headline text-[color:var(--text)]">DHCP pool</h3>
      </div>
      <p className="type-subheadline text-[color:var(--text-muted)] mb-4">
        The range of addresses Droplet hands out to devices on your network, and
        how long each one lasts. Shrinking the range can disconnect devices that
        already have an address, so we ask you to confirm.
      </p>

      <div className="space-y-4 max-w-md">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label
              htmlFor="dhcp-pool-start"
              className="type-subheadline text-[color:var(--text-muted)] block mb-1.5"
            >
              Start
            </label>
            <input
              id="dhcp-pool-start"
              type="number"
              inputMode="numeric"
              min={2}
              max={254}
              value={start}
              onChange={(e) => setStart(e.target.value)}
              className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors"
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-input)",
                color: "var(--text)",
              }}
              disabled={saving || isLoading}
            />
          </div>
          <div>
            <label
              htmlFor="dhcp-pool-limit"
              className="type-subheadline text-[color:var(--text-muted)] block mb-1.5"
            >
              Pool size
            </label>
            <input
              id="dhcp-pool-limit"
              type="number"
              inputMode="numeric"
              min={1}
              max={253}
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors"
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-input)",
                color: "var(--text)",
              }}
              disabled={saving || isLoading}
            />
          </div>
        </div>

        <div>
          <label
            htmlFor="dhcp-pool-leasetime"
            className="type-subheadline text-[color:var(--text-muted)] block mb-1.5"
          >
            Lease time
          </label>
          <select
            id="dhcp-pool-leasetime"
            value={leasetime}
            onChange={(e) => setLeasetime(e.target.value)}
            className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] transition-colors"
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-input)",
              color: "var(--text)",
            }}
            disabled={saving || isLoading}
          >
            {LEASE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        <button
          type="button"
          onClick={handleSave}
          disabled={saving || isLoading}
          className="btn primary"
        >
          {saving && <Loader2 size={16} className="animate-spin" />}
          {saving ? "Saving…" : "Save pool"}
        </button>
      </div>

      {status.kind === "saved" && (
        <div
          role="status"
          className="mt-4 flex items-start gap-2 type-footnote text-[color:var(--text)] bg-system-green/10 rounded-sm px-3 py-2"
        >
          <CheckCircle2 size={14} className="mt-0.5 flex-shrink-0 text-system-green" aria-hidden="true" />
          <span>DHCP pool updated.</span>
        </div>
      )}

      {status.kind === "error" && (
        <div
          role="alert"
          className="mt-4 flex items-start gap-2 type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2"
        >
          <AlertCircle size={14} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
          <span>{status.message}</span>
        </div>
      )}
    </div>
  );
}
