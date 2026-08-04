"use client";

import { useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, Pin } from "lucide-react";
import {
  addStaticDhcpLease,
  fetchNetworkOperation,
  RouterStatusError,
  routerUnreachableNotice,
} from "@/lib/api";
import type { NetworkCommandResult } from "@/lib/types";

/**
 * WARP-871 — "Add reservation" (static DHCP lease) for the Network → System tab.
 *
 * The orchestrator route (POST /api/network/dhcp/static-lease, Tier 1,
 * owner/admin) and the routing POST /dhcp/static-lease have shipped, but there
 * was no UI anywhere — a customer who wanted their NAS or a camera to always
 * get the same IP had to use the LLM tool or curl. This form pins a MAC to a
 * fixed IP so DHCP always hands that device the same address.
 *
 * Validation mirrors services/routing/schemas.py StaticLeaseRequest (name ≥ 1,
 * MAC AA:BB:CC:DD:EE:FF). The IP has no server-side pattern, so we validate a
 * literal IPv4 client-side for a clean UX. add_static_lease is Tier 1 (applies
 * immediately, no confirmation); we poll the operation for the safe-apply
 * outcome and reuse the calm error ladder from the other network forms.
 *
 * Add-only by design — the list/delete path (full-stack) is not built yet, so
 * the copy avoids implying you can manage reservations from here.
 */

const MAC_RE = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;

function validateIpv4(value: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (!m) return false;
  return m.slice(1).every((o) => {
    const n = parseInt(o, 10);
    return n >= 0 && n <= 255;
  });
}

type Status =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "applied" }
  | { kind: "error"; message: string }
  | { kind: "notice"; message: string };

export function DhcpReservationForm({ onApplied }: { onApplied?: () => void }) {
  const [name, setName] = useState("");
  const [mac, setMac] = useState("");
  const [ip, setIp] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  function validate(): string | null {
    if (!name.trim()) return "Enter a name for this device.";
    if (!mac.trim()) return "Enter the device's MAC address.";
    if (!MAC_RE.test(mac.trim()))
      return "MAC address must look like AA:BB:CC:DD:EE:FF.";
    if (!ip.trim()) return "Enter the IP address to reserve.";
    if (!validateIpv4(ip.trim()))
      return "IP address must be a valid address, e.g. 192.168.50.20.";
    return null;
  }

  async function pollOperation(operationId: string): Promise<void> {
    const startedAt = Date.now();
    for (;;) {
      const op = await fetchNetworkOperation(operationId);
      if (op.state === "applied") return;
      if (op.state === "rejected") {
        throw new Error(
          op.reason ??
            "The router didn't accept that reservation, so nothing was changed.",
        );
      }
      if (op.state === "rolled_back" || op.state === "unknown") {
        throw new Error(
          op.reason ??
            "The reservation didn't take. Re-check the details and try again.",
        );
      }
      if (Date.now() - startedAt > 70_000) {
        throw new Error("Timed out waiting for the router to add the reservation.");
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  async function handleAdd() {
    const v = validate();
    if (v) {
      setStatus({ kind: "error", message: v });
      return;
    }
    setStatus({ kind: "saving" });
    try {
      const result: NetworkCommandResult = await addStaticDhcpLease(
        name.trim(),
        mac.trim(),
        ip.trim(),
      );
      if (result.operationId) {
        await pollOperation(result.operationId);
      }
      setStatus({ kind: "applied" });
      setName("");
      setMac("");
      setIp("");
      onApplied?.();
    } catch (e) {
      if (routerUnreachableNotice(e, "Network")) {
        setStatus({
          kind: "notice",
          message:
            "Your router isn't reachable right now — try again in a moment.",
        });
      } else if (
        e instanceof RouterStatusError &&
        (e.status === 400 || e.status === 422) &&
        e.message.trim().length > 0
      ) {
        setStatus({ kind: "error", message: e.message });
      } else if (
        !(e instanceof RouterStatusError) &&
        e instanceof Error &&
        e.message.trim().length > 0
      ) {
        setStatus({ kind: "error", message: e.message });
      } else {
        setStatus({
          kind: "notice",
          message:
            "Couldn't add the reservation right now. Please try again in a moment.",
        });
      }
    }
  }

  const saving = status.kind === "saving";

  return (
    <div className="card">
      <h3 className="type-headline text-[color:var(--text)] mb-1">Add IP reservation</h3>
      <p className="type-subheadline text-[color:var(--text-muted)] mb-4">
        Pin a device to a fixed address so it always gets the same IP — handy for
        a NAS, printer, or camera you connect to by address. Find the device's
        MAC address on the Devices tab.
      </p>

      <div className="space-y-4 max-w-md">
        <div>
          <label
            htmlFor="lease-name"
            className="type-subheadline text-[color:var(--text-muted)] block mb-1.5"
          >
            Device name
          </label>
          <input
            id="lease-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Office NAS"
            className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors"
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-input)",
              color: "var(--text)",
            }}
            autoComplete="off"
            spellCheck={false}
            disabled={saving}
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label
              htmlFor="lease-mac"
              className="type-subheadline text-[color:var(--text-muted)] block mb-1.5"
            >
              MAC address
            </label>
            <input
              id="lease-mac"
              type="text"
              value={mac}
              onChange={(e) => setMac(e.target.value)}
              placeholder="AA:BB:CC:DD:EE:FF"
              className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors font-mono"
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-input)",
                color: "var(--text)",
              }}
              autoComplete="off"
              spellCheck={false}
              disabled={saving}
            />
          </div>
          <div>
            <label
              htmlFor="lease-ip"
              className="type-subheadline text-[color:var(--text-muted)] block mb-1.5"
            >
              Reserved IP
            </label>
            <input
              id="lease-ip"
              type="text"
              inputMode="decimal"
              value={ip}
              onChange={(e) => setIp(e.target.value)}
              placeholder="192.168.50.20"
              className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors font-mono"
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-input)",
                color: "var(--text)",
              }}
              autoComplete="off"
              spellCheck={false}
              disabled={saving}
            />
          </div>
        </div>

        <button
          type="button"
          onClick={handleAdd}
          disabled={saving}
          className="btn primary"
        >
          {saving ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            <Pin size={16} />
          )}
          {saving ? "Adding…" : "Add reservation"}
        </button>
      </div>

      {status.kind === "applied" && (
        <div
          role="status"
          className="mt-4 flex items-start gap-2 type-footnote text-[color:var(--text)] bg-system-green/10 rounded-sm px-3 py-2"
        >
          <CheckCircle2
            size={14}
            className="mt-0.5 flex-shrink-0 text-system-green"
            aria-hidden="true"
          />
          <span>Reservation added. The device gets this IP on its next renewal.</span>
        </div>
      )}

      {status.kind === "notice" && (
        <div
          role="status"
          aria-live="polite"
          className="mt-4 flex items-start gap-2 type-footnote text-[color:var(--text)] bg-system-orange/10 rounded-sm px-3 py-2"
        >
          <AlertCircle
            size={14}
            className="mt-0.5 flex-shrink-0 text-system-orange"
            aria-hidden="true"
          />
          <span>{status.message}</span>
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
