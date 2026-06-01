"use client";

import useSWR from "swr";
import { Globe, Cpu, Wifi, ArrowRight, AlertTriangle } from "lucide-react";
import { fetchApDevices } from "@/lib/api";
import type { NetworkOverview } from "@/lib/types";

function fmtUptime(sec: number): string {
  if (!sec || sec <= 0) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  if (d > 0) return `${d}d ${h}h`;
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// Role-based, hardware-agnostic connection label (ADR-011) — no NIC/device name.
function protoLabel(proto: string): string {
  switch ((proto || "").toLowerCase()) {
    case "dhcp":
    case "dhcpv6":
      return "Automatic (DHCP)";
    case "static":
      return "Static IP";
    case "pppoe":
      return "PPPoE";
    case "":
      return "—";
    default:
      return proto.toUpperCase();
  }
}

interface Props {
  overview: NetworkOverview | undefined;
  onOpenAdvanced: () => void;
}

/** WARP-612: the everyday "is the internet up?" glance for Home installs —
 *  the Droplet Design System's Simple-mode internet hero, device count, and a
 *  read-out of the auto-managed coverage access points (ADR-005: APs
 *  auto-discover + auto band-steer; one approval tap is the only manual gate).
 *  Built on real /api/network + /api/aps data; hardware-agnostic (no NIC/board
 *  names). Wi-Fi name/password, guest Wi-Fi, and camera privacy are a
 *  follow-up (they need the wifi-config + VLAN backends). */
export function NetworkSimple({ overview, onOpenAdvanced }: Props) {
  const wan = overview?.interfaces?.wan;
  const online = !!wan?.up;
  const wanIp = wan?.["ipv4-address"]?.[0]?.address ?? "—";
  const uptime = fmtUptime(overview?.system?.resources?.uptime ?? 0);
  const deviceCount = overview?.connectedDeviceCount ?? 0;

  // Coverage access points (extenders). Read-only for every role (ADR-005
  // RBAC). On error/absent the hook yields no data and the section hides.
  // 10s to match the orchestrator AP-discovery poller (DROPLET_AP_DISCOVERY_INTERVAL=10)
  // and CoverageExtendersPanel — otherwise, with only Simple mode mounted, an
  // AWAITING_APPROVAL extender would surface up to ~20s late.
  const { data: apData } = useSWR("/api/aps", fetchApDevices, { refreshInterval: 10_000 });
  const aps = apData?.aps ?? [];
  const hasExtenders = aps.length > 0;
  const apsOnline = aps.filter((a) => a.status === "ONLINE").length;
  const apsAwaiting = aps.filter((a) => a.status === "AWAITING_APPROVAL").length;

  return (
    <div className="flex flex-col gap-4">
      {/* Internet hero */}
      <section className="dp-card p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <span
              className={`flex-none h-10 w-10 rounded-[10px] flex items-center justify-center ${
                online ? "bg-system-green/10 text-system-green" : "bg-system-red/10 text-system-red"
              }`}
            >
              <Globe className="h-5 w-5" />
            </span>
            <div>
              <h2 className="type-title-3 text-label-primary">Internet</h2>
              <p className="type-subheadline text-label-secondary">
                {online ? "Connected" : "Offline"}
                {online && uptime !== "—" ? ` · up ${uptime}` : ""}
              </p>
            </div>
          </div>
          <span
            className={`type-caption-1 px-2.5 py-1 rounded-full ${
              online ? "bg-system-green/10 text-system-green" : "bg-system-red/10 text-system-red"
            }`}
          >
            {online ? "Online" : "Offline"}
          </span>
        </div>

        <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 gap-4">
          <div>
            <p className="type-caption-2 uppercase tracking-wide text-label-tertiary mb-0.5">Public IP</p>
            <p className="type-subheadline font-mono text-label-primary">{wanIp}</p>
          </div>
          <div>
            <p className="type-caption-2 uppercase tracking-wide text-label-tertiary mb-0.5">Connection</p>
            <p className="type-subheadline text-label-primary">{protoLabel(wan?.proto ?? "")}</p>
          </div>
          <div>
            <p className="type-caption-2 uppercase tracking-wide text-label-tertiary mb-0.5">Uptime</p>
            <p className="type-subheadline text-label-primary tabular-nums">{uptime}</p>
          </div>
        </div>
      </section>

      {/* Devices + auto-managed coverage + escape hatch to Advanced */}
      <section className="dp-card p-5">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-8">
            <div className="flex items-center gap-3">
              <span className="flex-none h-10 w-10 rounded-[10px] bg-surface-secondary text-label-secondary flex items-center justify-center">
                <Cpu className="h-5 w-5" />
              </span>
              <div>
                <p className="type-title-3 text-label-primary tabular-nums">{deviceCount}</p>
                <p className="type-subheadline text-label-secondary">
                  device{deviceCount === 1 ? "" : "s"} on your network
                </p>
              </div>
            </div>

            {hasExtenders && (
              <div className="flex items-center gap-3">
                <span className="flex-none h-10 w-10 rounded-[10px] bg-surface-secondary text-label-secondary flex items-center justify-center">
                  <Wifi className="h-5 w-5" />
                </span>
                <div>
                  <p className="type-title-3 text-label-primary tabular-nums">{apsOnline}</p>
                  <p className="type-subheadline text-label-secondary">
                    access point{apsOnline === 1 ? "" : "s"} · auto-managed
                  </p>
                </div>
              </div>
            )}
          </div>

          <button
            onClick={onOpenAdvanced}
            className="dp-btn-secondary inline-flex items-center gap-1.5 px-3 h-9 rounded-md"
          >
            <span className="type-subheadline">All network controls</span>
            <ArrowRight size={15} />
          </button>
        </div>

        {apsAwaiting > 0 && (
          <button
            onClick={onOpenAdvanced}
            className="mt-3 w-full flex items-center gap-2 rounded-md bg-system-orange/10 text-system-orange px-3 py-2 text-left transition-colors hover:bg-system-orange/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <AlertTriangle size={15} className="flex-none" />
            <span className="type-subheadline">
              {apsAwaiting} access point{apsAwaiting === 1 ? "" : "s"} awaiting approval — review in
              Advanced
            </span>
          </button>
        )}
      </section>
    </div>
  );
}
