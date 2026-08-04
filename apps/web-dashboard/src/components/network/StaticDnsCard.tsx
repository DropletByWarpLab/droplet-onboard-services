"use client";

import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, Plus, Trash2 } from "lucide-react";
import {
  fetchDnsHostnames,
  addDnsHostname,
  deleteDnsHostname,
  RouterStatusError,
  routerUnreachableNotice,
  type DnsHostRecord,
} from "@/lib/api";

/**
 * WARP-871 — local DNS names (static host-records) for the Network → System tab.
 *
 * The routing /dhcp/hostnames endpoints (GET/POST/DELETE) shipped fully; this PR
 * adds the orchestrator routes (/api/network/dhcp/hostnames, owner/admin writes,
 * Tier 1) and this card so a customer can reach a device by name — e.g.
 * nas.lan → 192.168.50.20 — from any device using the router for DNS.
 *
 * Host-record changes can't partition the router (the routing layer applies them
 * with rollback disabled), so rather than poll an operation we re-fetch the list
 * after each mutation to confirm it landed. Validation mirrors schemas.py
 * DnsHostnameRequest (lowercase RFC-1123 hostname, literal IPv4).
 */

const HOSTNAME_RE =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

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

export function StaticDnsCard() {
  const [entries, setEntries] = useState<DnsHostRecord[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [hostname, setHostname] = useState("");
  const [ip, setIp] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [busyHost, setBusyHost] = useState<string | null>(null);

  async function refresh() {
    try {
      const list = await fetchDnsHostnames();
      setEntries(list);
    } catch {
      // Non-fatal: the add/delete still surface their own errors.
    } finally {
      setListLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await fetchDnsHostnames();
        if (!cancelled) setEntries(list);
      } catch {
        /* leave empty; the add form still works */
      } finally {
        if (!cancelled) setListLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function validate(): string | null {
    const h = hostname.trim();
    if (!h) return "Enter a name (e.g. nas.lan).";
    if (h !== h.toLowerCase()) return "Use lowercase letters for the name.";
    if (h.length > 253 || !HOSTNAME_RE.test(h))
      return "That isn't a valid name. Use letters, numbers, hyphens and dots.";
    if (!ip.trim()) return "Enter the IP address this name should point to.";
    if (!validateIpv4(ip.trim()))
      return "IP address must be a valid address, e.g. 192.168.50.20.";
    return null;
  }

  function classifyError(e: unknown): Status {
    if (routerUnreachableNotice(e, "Network")) {
      return {
        kind: "notice",
        message: "Your router isn't reachable right now — try again in a moment.",
      };
    }
    if (
      e instanceof RouterStatusError &&
      (e.status === 400 || e.status === 422) &&
      e.message.trim().length > 0
    ) {
      return { kind: "error", message: e.message };
    }
    if (
      !(e instanceof RouterStatusError) &&
      e instanceof Error &&
      e.message.trim().length > 0
    ) {
      return { kind: "error", message: e.message };
    }
    return {
      kind: "notice",
      message: "Couldn't update DNS names right now. Try again shortly.",
    };
  }

  async function handleAdd() {
    const v = validate();
    if (v) {
      setStatus({ kind: "error", message: v });
      return;
    }
    setStatus({ kind: "saving" });
    try {
      await addDnsHostname(hostname.trim(), ip.trim());
      await refresh();
      setStatus({ kind: "applied" });
      setHostname("");
      setIp("");
    } catch (e) {
      setStatus(classifyError(e));
    }
  }

  async function handleDelete(name: string) {
    setBusyHost(name);
    setStatus({ kind: "idle" });
    try {
      await deleteDnsHostname(name);
      await refresh();
    } catch (e) {
      setStatus(classifyError(e));
    } finally {
      setBusyHost(null);
    }
  }

  const saving = status.kind === "saving";

  return (
    <div className="card">
      <h3 className="type-headline mb-1" style={{ color: "var(--text)" }}>Local DNS names</h3>
      <p className="type-subheadline mb-4" style={{ color: "var(--text-muted)" }}>
        Give a device a friendly name on your network — e.g. reach your NAS at{" "}
        <span className="font-mono" style={{ color: "var(--text-muted)" }}>nas.lan</span> instead of
        its IP. These resolve for any device using the Droplet for DNS.
      </p>

      {/* Existing entries */}
      {listLoading ? (
        <div className="flex items-center gap-2 type-subheadline mb-4" style={{ color: "var(--text-muted)" }}>
          <Loader2 size={16} className="animate-spin" />
          Loading names…
        </div>
      ) : entries.length > 0 ? (
        <div className="space-y-2 mb-4">
          {entries.map((e) => (
            <div
              key={e.section}
              className="flex items-center justify-between px-3 py-2 rounded-sm"
              style={{ background: "var(--inset)" }}
            >
              <p className="type-subheadline font-mono" style={{ color: "var(--text)" }}>
                {e.hostname}{" "}
                <span style={{ color: "var(--text-muted)" }}>→ {e.ip}</span>
              </p>
              <button
                type="button"
                onClick={() => handleDelete(e.hostname)}
                disabled={busyHost === e.hostname}
                aria-label={`Remove ${e.hostname}`}
                className="text-[color:var(--text-muted)] transition-colors duration-200 hover:text-system-red disabled:opacity-50"
              >
                {busyHost === e.hostname ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <Trash2 size={16} />
                )}
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="type-subheadline mb-4" style={{ color: "var(--text-muted)" }}>
          No local DNS names yet.
        </p>
      )}

      {/* Add form */}
      <div className="space-y-4 max-w-md">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label
              htmlFor="dns-hostname"
              className="type-subheadline block mb-1.5"
              style={{ color: "var(--text-muted)" }}
            >
              Name
            </label>
            <input
              id="dns-hostname"
              type="text"
              value={hostname}
              onChange={(e) => setHostname(e.target.value)}
              placeholder="nas.lan"
              className="w-full px-3 py-2.5 font-mono outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors"
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
              htmlFor="dns-host-ip"
              className="type-subheadline block mb-1.5"
              style={{ color: "var(--text-muted)" }}
            >
              Points to (IP)
            </label>
            <input
              id="dns-host-ip"
              type="text"
              inputMode="decimal"
              value={ip}
              onChange={(e) => setIp(e.target.value)}
              placeholder="192.168.50.20"
              className="w-full px-3 py-2.5 font-mono outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors"
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
            <Plus size={16} />
          )}
          {saving ? "Adding…" : "Add name"}
        </button>
      </div>

      {status.kind === "applied" && (
        <div
          role="status"
          className="mt-4 flex items-start gap-2 type-footnote bg-system-green/10 rounded-sm px-3 py-2"
          style={{ color: "var(--text)" }}
        >
          <CheckCircle2
            size={14}
            className="mt-0.5 flex-shrink-0 text-system-green"
            aria-hidden="true"
          />
          <span>DNS name added.</span>
        </div>
      )}

      {status.kind === "notice" && (
        <div
          role="status"
          aria-live="polite"
          className="mt-4 flex items-start gap-2 type-footnote bg-system-orange/10 rounded-sm px-3 py-2"
          style={{ color: "var(--text)" }}
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
