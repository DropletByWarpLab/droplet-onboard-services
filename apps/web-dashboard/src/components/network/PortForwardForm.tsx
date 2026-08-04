"use client";

import { useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Loader2,
  Plus,
} from "lucide-react";
import {
  addNetworkPortForward,
  confirmNetworkCommand,
  fetchNetworkOperation,
  RouterStatusError,
  routerUnreachableNotice,
} from "@/lib/api";

/**
 * WARP-871 — "Add port forward" for the Network → Firewall tab.
 *
 * The Firewall tab listed existing port forwards read-only; the only ways to
 * CREATE one were the LLM tool or curl, even though the orchestrator route
 * (POST /api/network/firewall/port-forward) and routing-service validator have
 * shipped since NET-09. This form gives the tab the same write path:
 *
 *   addNetworkPortForward (Tier 2 — exposing a LAN service to WAN ingress, so
 *     the orchestrator answers 202 `confirmation_required`)
 *   → confirmNetworkCommand (the Add click IS the consent — auto-confirmed)
 *   → poll the operation until it leaves `pending` (applied / rolled_back).
 *
 * Validation mirrors services/routing/schemas.py PortForwardRequest (name 1–63,
 * ports a single value or `lo-hi` range each in 1–65535, dest_ip a literal IPv4,
 * proto ∈ {tcp,udp,tcpudp}) so the box never sees a payload the routing service
 * would reject with a 422. Error classification reuses WifiSettingsForm's calm
 * ladder: unreachable router → soft amber notice; a 4xx validation refusal with
 * an actionable message → that message in red; a safe-apply revert → the reason
 * in red; anything else → a calm generic failure line.
 */

// Mirrors services/routing/schemas.py PortForwardRequest.
const NAME_MAX = 63;
const PROTOS = ["tcp", "udp", "tcpudp"] as const;
type Proto = (typeof PROTOS)[number];

const PROTO_LABEL: Record<Proto, string> = {
  tcp: "TCP",
  udp: "UDP",
  tcpudp: "TCP + UDP",
};

type Status =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "applied" }
  | { kind: "error"; message: string }
  | { kind: "notice"; message: string };

/** A single port (1–65535) or a `lo-hi` range with lo ≤ hi, both in range. */
function validatePortOrRange(value: string): boolean {
  if (!/^\d{1,5}(-\d{1,5})?$/.test(value)) return false;
  const parts = value.split("-").map((p) => parseInt(p, 10));
  if (parts.some((n) => n < 1 || n > 65535)) return false;
  if (parts.length === 2 && parts[0] > parts[1]) return false;
  return true;
}

/** A literal IPv4 dotted quad — mirrors schemas.py `_IPV4_PATTERN`. */
function validateIpv4(value: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (!m) return false;
  return m.slice(1).every((o) => {
    const n = parseInt(o, 10);
    return n >= 0 && n <= 255;
  });
}

export function PortForwardForm({ onApplied }: { onApplied?: () => void }) {
  const [name, setName] = useState("");
  const [srcPort, setSrcPort] = useState("");
  const [destIp, setDestIp] = useState("");
  const [destPort, setDestPort] = useState("");
  const [proto, setProto] = useState<Proto>("tcp");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  function validate(): string | null {
    const n = name.trim();
    if (!n) return "Enter a name for this port forward.";
    if (n.length > NAME_MAX)
      return `Name must be ${NAME_MAX} characters or fewer.`;
    if (!srcPort.trim()) return "Enter the external port to forward.";
    if (!validatePortOrRange(srcPort.trim()))
      return "External port must be 1–65535, or a range like 8000-8100.";
    if (!destIp.trim()) return "Enter the internal device IP address.";
    if (!validateIpv4(destIp.trim()))
      return "Internal IP must be a valid address, e.g. 192.168.50.20.";
    if (!destPort.trim()) return "Enter the internal port to forward to.";
    if (!validatePortOrRange(destPort.trim()))
      return "Internal port must be 1–65535, or a range like 8000-8100.";
    return null;
  }

  /** Poll the operation record until terminal. ~70s cap (safe-apply 60s + slack),
   *  matching WifiSettingsForm.pollOperation / the page's WARP-40 loop. */
  async function pollOperation(operationId: string): Promise<void> {
    const startedAt = Date.now();
    for (;;) {
      const op = await fetchNetworkOperation(operationId);
      if (op.state === "applied") return;
      if (op.state === "rejected") {
        throw new Error(
          op.reason ??
            "The router didn't accept that port forward, so nothing was changed.",
        );
      }
      if (op.state === "rolled_back" || op.state === "unknown") {
        throw new Error(
          op.reason ??
            "The port forward didn't take. Re-check the details and try again.",
        );
      }
      if (Date.now() - startedAt > 70_000) {
        throw new Error(
          "Timed out waiting for the router to add the port forward.",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  async function apply() {
    const result = await addNetworkPortForward(
      name.trim(),
      srcPort.trim(),
      destIp.trim(),
      destPort.trim(),
      proto,
    );
    // Tier 2: the POST answers 202 `confirmation_required`; the Add click is the
    // consent, so we echo the token straight back, then poll for apply/rollback.
    if (
      result.status === "confirmation_required" &&
      result.confirmationToken &&
      result.operation
    ) {
      const { operationId } = await confirmNetworkCommand(
        result.confirmationToken,
        result.operation,
      );
      if (operationId) {
        await pollOperation(operationId);
      }
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
      await apply();
      setStatus({ kind: "applied" });
      setName("");
      setSrcPort("");
      setDestIp("");
      setDestPort("");
      setProto("tcp");
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
            "Couldn't add the port forward right now. Please try again in a moment.",
        });
      }
    }
  }

  const saving = status.kind === "saving";

  return (
    <div className="card">
      <h3 className="type-headline text-[color:var(--text)] mb-1">Add port forward</h3>
      <p className="type-subheadline text-[color:var(--text-muted)] mb-4">
        Send traffic that arrives on an external port straight to a device on
        your network — for example to reach a camera or game server from
        outside. Only forward ports you understand; each one opens a path from
        the internet to that device.
      </p>

      <div className="space-y-4 max-w-md">
        <div>
          <label
            htmlFor="pf-name"
            className="type-subheadline text-[color:var(--text-muted)] block mb-1.5"
          >
            Name
          </label>
          <input
            id="pf-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Front-door camera"
            className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors"
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-input)",
              color: "var(--text)",
            }}
            maxLength={NAME_MAX}
            autoComplete="off"
            spellCheck={false}
            disabled={saving}
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label
              htmlFor="pf-src-port"
              className="type-subheadline text-[color:var(--text-muted)] block mb-1.5"
            >
              External port
            </label>
            <input
              id="pf-src-port"
              type="text"
              inputMode="numeric"
              value={srcPort}
              onChange={(e) => setSrcPort(e.target.value)}
              placeholder="8080"
              className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors"
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-input)",
                color: "var(--text)",
              }}
              autoComplete="off"
              disabled={saving}
            />
          </div>
          <div>
            <label
              htmlFor="pf-proto"
              className="type-subheadline text-[color:var(--text-muted)] block mb-1.5"
            >
              Protocol
            </label>
            <select
              id="pf-proto"
              value={proto}
              onChange={(e) => setProto(e.target.value as Proto)}
              className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] transition-colors"
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-input)",
                color: "var(--text)",
              }}
              disabled={saving}
            >
              {PROTOS.map((p) => (
                <option key={p} value={p}>
                  {PROTO_LABEL[p]}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label
              htmlFor="pf-dest-ip"
              className="type-subheadline text-[color:var(--text-muted)] block mb-1.5"
            >
              Internal device IP
            </label>
            <input
              id="pf-dest-ip"
              type="text"
              inputMode="decimal"
              value={destIp}
              onChange={(e) => setDestIp(e.target.value)}
              placeholder="192.168.50.20"
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
          <div>
            <label
              htmlFor="pf-dest-port"
              className="type-subheadline text-[color:var(--text-muted)] block mb-1.5"
            >
              Internal port
            </label>
            <input
              id="pf-dest-port"
              type="text"
              inputMode="numeric"
              value={destPort}
              onChange={(e) => setDestPort(e.target.value)}
              placeholder="80"
              className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors"
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-input)",
                color: "var(--text)",
              }}
              autoComplete="off"
              disabled={saving}
            />
          </div>
        </div>

        {/* Plain-language preview of the rule being created. */}
        {(srcPort.trim() || destIp.trim() || destPort.trim()) && (
          <div className="flex items-center gap-2 type-footnote text-[color:var(--text-muted)]">
            <span className="font-mono text-[color:var(--text-muted)]">
              :{srcPort.trim() || "?"} ({PROTO_LABEL[proto]})
            </span>
            <ArrowRight size={14} aria-hidden="true" />
            <span className="font-mono text-[color:var(--text-muted)]">
              {destIp.trim() || "?"}:{destPort.trim() || "?"}
            </span>
          </div>
        )}

        <button
          type="button"
          onClick={handleAdd}
          disabled={saving}
          className="btn primary"
        >
          {saving ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            <Plus size={16} />
          )}
          {saving ? "Adding…" : "Add port forward"}
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
          <span>Port forward added.</span>
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
