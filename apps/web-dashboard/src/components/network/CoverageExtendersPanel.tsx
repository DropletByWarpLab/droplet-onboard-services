"use client";
/**
 * WARP-446 — Coverage Extenders panel.
 *
 * Renders the household's list of extender APs above the Devices grid
 * on /network. The full data fetch is `fetchApDevices`; the wizard
 * (open-via-button) drives discovery + approval through
 * `fetchDiscoveredApDevices` + `approveApDevice`.
 *
 * Design discipline (ADR-002 progressive disclosure):
 *   - Empty state → friendly explainer + "Add extender" button.
 *   - AWAITING_APPROVAL → highlighted card at top, one-tap approve.
 *   - ONLINE → standard card, model + last-seen + decommission.
 *   - DECOMMISSIONED → collapsed at bottom; operator can still see
 *     historical context for the "what was that AP?" question.
 *   - FAILED → red-tinted card with failureReason + retry hint.
 *
 * Motion: restraint-first (Emil Kowalski lens). No celebration on
 * approve-success; transition is the 150ms SWR refresh + the new
 * status pill rendering. Spinning indicator only during a live
 * approve / decommission round-trip.
 *
 * Design tokens (no hex literals):
 *   - card: `dp-card` (existing utility)
 *   - status pills: `bg-amber-50 text-amber-700` etc — Tailwind
 *     semantic palette, same one DeviceCard uses.
 *   - text: `text-label-*` / `type-*` typography scale.
 */

import { useState, useMemo } from "react";
import useSWR, { mutate } from "swr";
import {
  Wifi,
  WifiOff,
  Loader2,
  Plus,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Trash2,
  ArrowUpRight,
} from "lucide-react";
import { fetchApDevices, approveApDevice, decommissionApDevice } from "@/lib/api";
import type { ApDeviceInfo, ApDeviceStatus } from "@/lib/types";

// Status display metadata. Centralised so the panel and any future
// inline reference can stay in lockstep without scattering literal
// colours.
const STATUS_META: Record<
  ApDeviceStatus,
  { label: string; pillClass: string; icon: typeof Wifi }
> = {
  DISCOVERED: {
    label: "Discovered",
    pillClass: "bg-slate-50 text-slate-600",
    icon: Clock,
  },
  AWAITING_APPROVAL: {
    label: "Awaiting approval",
    pillClass: "bg-amber-50 text-amber-700",
    icon: AlertTriangle,
  },
  PROVISIONING: {
    label: "Setting up…",
    pillClass: "bg-sky-50 text-sky-700",
    icon: Loader2,
  },
  ONLINE: {
    label: "Online",
    pillClass: "bg-emerald-50 text-emerald-700",
    icon: Wifi,
  },
  FAILED: {
    label: "Failed",
    pillClass: "bg-red-50 text-red-700",
    icon: AlertTriangle,
  },
  DECOMMISSIONED: {
    label: "Removed",
    pillClass: "bg-slate-50 text-slate-500",
    icon: WifiOff,
  },
};

// Sort order: action-required → active → historical. Within each
// bucket, most-recently-seen first.
const STATUS_RANK: Record<ApDeviceStatus, number> = {
  AWAITING_APPROVAL: 0,
  DISCOVERED: 0, // poller will collapse to AWAITING_APPROVAL same tick
  PROVISIONING: 1,
  ONLINE: 2,
  FAILED: 3,
  DECOMMISSIONED: 4,
};

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.max(0, Math.floor(diffMs / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function displayNameFor(ap: ApDeviceInfo): string {
  if (ap.displayName) return ap.displayName;
  const last3 = ap.mac.split(":").slice(-3).join(":");
  if (ap.model?.includes("raspberrypi,5")) return `Pi5 AP (${last3})`;
  if (ap.model) return `${ap.model} AP (${last3})`;
  return `Extender (${last3})`;
}

interface ApCardProps {
  ap: ApDeviceInfo;
  onApprove: (mac: string) => void;
  onDecommission: (mac: string) => void;
  busy: boolean;
}

function ApCard({ ap, onApprove, onDecommission, busy }: ApCardProps) {
  const meta = STATUS_META[ap.status];
  const Icon = meta.icon;
  const isSpinning = ap.status === "PROVISIONING" || (busy && ap.status !== "DECOMMISSIONED");
  const showApprove = ap.status === "AWAITING_APPROVAL" || ap.status === "DISCOVERED";
  const showDecommission = ap.status === "ONLINE" || ap.status === "FAILED";
  const isFailed = ap.status === "FAILED";

  return (
    <div
      className={`dp-card flex flex-col gap-3 p-4 ${
        showApprove
          ? "ring-1 ring-amber-200/60"
          : isFailed
          ? "ring-1 ring-red-200/60"
          : ""
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="rounded-full bg-slate-50 p-2 text-slate-600">
          <Icon
            size={18}
            className={isSpinning ? "animate-spin" : ""}
            aria-hidden
          />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="type-card-title text-slate-900 font-medium truncate">
              {displayNameFor(ap)}
            </span>
            <span
              className={`text-xs px-2 py-0.5 rounded-full font-medium ${meta.pillClass}`}
            >
              {meta.label}
            </span>
          </div>
          <div className="text-label-sm text-slate-500 mt-0.5">
            {ap.model ? `${ap.model} · ` : ""}
            Last seen {timeAgo(ap.lastSeen)}
            {ap.lastIp ? ` · ${ap.lastIp}` : ""}
          </div>
          {isFailed && ap.failureReason ? (
            <div className="text-label-sm text-red-700 mt-2">
              {ap.failureReason}
            </div>
          ) : null}
        </div>
      </div>
      {(showApprove || showDecommission) && (
        <div className="flex gap-2 self-end">
          {showApprove && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onApprove(ap.mac)}
              className="text-sm px-3 py-1.5 rounded-md bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50 transition-colors"
              aria-label={`Approve ${displayNameFor(ap)}`}
            >
              {busy ? (
                <span className="flex items-center gap-1.5">
                  <Loader2 size={14} className="animate-spin" /> Approving…
                </span>
              ) : (
                "Approve"
              )}
            </button>
          )}
          {showDecommission && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onDecommission(ap.mac)}
              className="text-sm px-3 py-1.5 rounded-md text-slate-700 hover:bg-slate-100 disabled:opacity-50 transition-colors flex items-center gap-1.5"
              aria-label={`Remove ${displayNameFor(ap)}`}
            >
              <Trash2 size={14} aria-hidden /> Remove
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function CoverageExtendersPanel() {
  // 10s refresh — same cadence as the orchestrator's discovery poller
  // (DROPLET_AP_DISCOVERY_INTERVAL=10). New extender announces become
  // visible within one polling cycle on each side.
  const { data, error, isLoading } = useSWR(
    "/api/aps",
    () => fetchApDevices(),
    { refreshInterval: 10_000 },
  );

  const [busyMac, setBusyMac] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const aps = useMemo(() => {
    const list = data?.aps ?? [];
    return [...list].sort((a, b) => {
      const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status];
      if (rank !== 0) return rank;
      return new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime();
    });
  }, [data]);

  async function handleApprove(mac: string) {
    setErrorMsg(null);
    setBusyMac(mac);
    try {
      // Approve flow: re-uses the main router's SSID + PSK by default.
      // For v1 we pull the most-recent ONLINE extender's approvedSsid
      // (or fall back to "Droplet" if none). The wizard surface
      // exposed in a follow-up will let the operator pick.
      const existingOnline = aps.find((a) => a.status === "ONLINE" && a.approvedSsid);
      const ssid = existingOnline?.approvedSsid ?? "Droplet";
      // PSK MUST be set by operator — never auto-derive secrets. For
      // v1 the dashboard prompts the operator with a minimal modal
      // (TODO follow-up). Until then, surface an error in the panel
      // when no PSK has been captured. Defensive only — the wizard
      // is the supported path.
      const psk = window.prompt("Enter the household WiFi password (WPA2/WPA3):");
      if (!psk || psk.length < 8) {
        setErrorMsg("Password must be at least 8 characters.");
        return;
      }
      await approveApDevice(mac, { ssid, encryptionKey: psk });
      await mutate("/api/aps");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to approve");
    } finally {
      setBusyMac(null);
    }
  }

  async function handleDecommission(mac: string) {
    if (!window.confirm("Remove this extender? Connected devices will be dropped.")) {
      return;
    }
    setErrorMsg(null);
    setBusyMac(mac);
    try {
      await decommissionApDevice(mac);
      await mutate("/api/aps");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to remove");
    } finally {
      setBusyMac(null);
    }
  }

  return (
    <section className="dp-card p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            Coverage extenders
          </h2>
          <p className="text-label-sm text-slate-500 mt-0.5">
            Extra Wi-Fi access points around your home.
          </p>
        </div>
      </div>

      {errorMsg ? (
        <div className="mb-3 text-sm text-red-700 bg-red-50 rounded-md px-3 py-2 flex items-center gap-2">
          <AlertTriangle size={14} aria-hidden /> {errorMsg}
        </div>
      ) : null}

      {isLoading && !data ? (
        <div className="flex items-center gap-2 text-slate-500 text-sm py-6">
          <Loader2 size={16} className="animate-spin" aria-hidden /> Loading…
        </div>
      ) : error ? (
        <div className="text-sm text-red-700 py-4">
          Couldn&apos;t load extenders right now. We&apos;ll keep retrying.
        </div>
      ) : aps.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="flex flex-col gap-3">
          {aps.map((ap) => (
            <ApCard
              key={ap.mac}
              ap={ap}
              onApprove={handleApprove}
              onDecommission={handleDecommission}
              busy={busyMac === ap.mac}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center text-center py-8 px-4">
      <div className="rounded-full bg-slate-50 p-3 text-slate-400 mb-3">
        <Wifi size={28} aria-hidden />
      </div>
      <p className="text-sm font-medium text-slate-700 mb-1">
        No extra access points yet
      </p>
      <p className="text-label-sm text-slate-500 max-w-md">
        Plug in a Droplet extender on the same network and it will appear here
        for one-tap approval. New extenders show up within 30 seconds.
      </p>
      <a
        href="https://droplet.lan/help#extenders"
        className="text-sm text-slate-600 hover:text-slate-900 mt-3 inline-flex items-center gap-1 transition-colors"
      >
        Learn more <ArrowUpRight size={12} aria-hidden />
      </a>
    </div>
  );
}

// Re-export the meta so the future Add Extender wizard component can
// share status pill styling without re-deriving it.
export { STATUS_META };

// Re-export icon so a parent toolbar can render the "Add extender"
// button with consistent iconography if needed in a follow-up.
export { Plus as AddExtenderIcon, CheckCircle2 as ApproveIcon };
