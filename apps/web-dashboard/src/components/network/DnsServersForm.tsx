"use client";

import { useState } from "react";
import { AlertCircle, CheckCircle2, Globe, Loader2 } from "lucide-react";
import {
  setDnsServers,
  fetchNetworkOperation,
  RouterStatusError,
  routerUnreachableNotice,
} from "@/lib/api";
import type { NetworkCommandResult } from "@/lib/types";

/**
 * WARP-871 — upstream/custom DNS resolvers for the Network → System tab.
 *
 * The routing POST /dhcp/dns + the orchestrator openwrt.client.setDnsServers
 * already existed; this PR adds the thin orchestrator route (POST /api/network/
 * dns, Tier 1, owner/admin) and this form so a customer can point the router at
 * Pi-hole / NextDNS / 1.1.1.1 instead of the ISP's resolver.
 *
 * Write-only: the routing layer has no read endpoint for the current upstream
 * servers, so the form sets them rather than pre-filling. Each entry is
 * validated client-side as an IPv4 dotted-quad or an IPv6 literal (the routing
 * validator only enforces a non-empty list). Tier 1 applies immediately; we
 * poll the operation and reuse the shared calm error ladder.
 */

function isIpAddress(value: string): boolean {
  const v = value.trim();
  // IPv4 dotted-quad.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v);
  if (v4) {
    return v4.slice(1).every((o) => {
      const n = parseInt(o, 10);
      return n >= 0 && n <= 255;
    });
  }
  // IPv6: hex groups separated by colons (accepts :: compression). Pragmatic —
  // the routing layer accepts any non-empty string, so this only catches typos.
  if (/:/.test(v) && /^[0-9a-fA-F:]+$/.test(v) && v.split(":").length >= 3) {
    return true;
  }
  return false;
}

type Status =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "applied" }
  | { kind: "error"; message: string }
  | { kind: "notice"; message: string };

export function DnsServersForm({ onApplied }: { onApplied?: () => void }) {
  const [primary, setPrimary] = useState("");
  const [secondary, setSecondary] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  function collectServers(): string[] {
    return [primary, secondary].map((s) => s.trim()).filter(Boolean);
  }

  function validate(): string | null {
    const servers = collectServers();
    if (servers.length === 0) return "Enter at least one DNS server.";
    const bad = servers.find((s) => !isIpAddress(s));
    if (bad) return `"${bad}" isn't a valid IP address.`;
    return null;
  }

  async function pollOperation(operationId: string): Promise<void> {
    const startedAt = Date.now();
    for (;;) {
      const op = await fetchNetworkOperation(operationId);
      if (op.state === "applied") return;
      if (op.state === "rejected") {
        throw new Error(
          op.reason ?? "The router didn't accept those DNS servers.",
        );
      }
      if (op.state === "rolled_back" || op.state === "unknown") {
        throw new Error(
          op.reason ?? "The DNS change didn't take. The previous servers are still in use.",
        );
      }
      if (Date.now() - startedAt > 70_000) {
        throw new Error("Timed out waiting for the router to apply the DNS change.");
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  async function handleSave() {
    const v = validate();
    if (v) {
      setStatus({ kind: "error", message: v });
      return;
    }
    setStatus({ kind: "saving" });
    try {
      const result: NetworkCommandResult = await setDnsServers(collectServers());
      if (result.operationId) {
        await pollOperation(result.operationId);
      }
      setStatus({ kind: "applied" });
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
          message: "Couldn't update DNS right now. Please try again in a moment.",
        });
      }
    }
  }

  const saving = status.kind === "saving";

  return (
    <div className="card">
      <h3 className="type-headline text-[color:var(--text)] mb-1">DNS servers</h3>
      <p className="type-subheadline text-[color:var(--text-muted)] mb-4">
        Choose which DNS servers the network uses to look up website addresses.
        Point these at a service like Cloudflare (1.1.1.1), a privacy resolver,
        or your own Pi-hole. Leave blank to keep using your provider&apos;s.
      </p>

      <div className="space-y-4 max-w-md">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label
              htmlFor="dns-primary"
              className="type-subheadline text-[color:var(--text-muted)] block mb-1.5"
            >
              Primary DNS
            </label>
            <div className="relative">
              <Globe
                size={16}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-[color:var(--text-muted)]"
                aria-hidden="true"
              />
              <input
                id="dns-primary"
                type="text"
                inputMode="decimal"
                value={primary}
                onChange={(e) => setPrimary(e.target.value)}
                placeholder="1.1.1.1"
                className="w-full px-3 py-2.5 pl-10 outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors font-mono"
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
          <div>
            <label
              htmlFor="dns-secondary"
              className="type-subheadline text-[color:var(--text-muted)] block mb-1.5"
            >
              Secondary DNS{" "}
              <span className="text-[color:var(--text-muted)]">(optional)</span>
            </label>
            <input
              id="dns-secondary"
              type="text"
              inputMode="decimal"
              value={secondary}
              onChange={(e) => setSecondary(e.target.value)}
              placeholder="1.0.0.1"
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
          onClick={handleSave}
          disabled={saving}
          className="btn primary"
        >
          {saving && <Loader2 size={16} className="animate-spin" />}
          {saving ? "Saving…" : "Save DNS servers"}
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
          <span>DNS servers updated.</span>
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
