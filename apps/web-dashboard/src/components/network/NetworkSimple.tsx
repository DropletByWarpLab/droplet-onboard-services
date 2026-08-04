"use client";

import useSWR from "swr";
import { Globe, Cpu, Wifi, ArrowRight, AlertTriangle, Router } from "lucide-react";
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
  // The single-box hands its WAN uplink to the appliance host, so the in-box
  // OpenWrt reports the wan interface as `present:false`. That absence must NOT
  // read as "internet down" — it's the same honest signal the page-level
  // `routerConnected` gate already trusts (network.service.getNetworkOverview:
  // "WAN-absence must never read as offline"). Only a WAN that is genuinely
  // configured-but-down (`present:true, up:false`) is offline. When no WAN
  // interface is exposed on this shape, fall back to `routerConnected` — the
  // box's real connectivity signal — instead of the missing up-flag.
  const routerConnected = overview?.routerConnected ?? false;
  const wanPresent = wan?.present !== false;
  const online = wanPresent ? !!wan?.up : routerConnected;
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
      <section className="card">
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
              <h2 className="type-title-3" style={{ color: "var(--text)" }}>Internet</h2>
              <p className="type-subheadline" style={{ color: "var(--text-muted)" }}>
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
            <p className="type-caption-2 uppercase tracking-wide mb-0.5" style={{ color: "var(--text-muted)" }}>Public IP</p>
            <p className="type-subheadline font-mono" style={{ color: "var(--text)" }}>{wanIp}</p>
          </div>
          <div>
            <p className="type-caption-2 uppercase tracking-wide mb-0.5" style={{ color: "var(--text-muted)" }}>Connection</p>
            <p className="type-subheadline" style={{ color: "var(--text)" }}>{protoLabel(wan?.proto ?? "")}</p>
          </div>
          <div>
            <p className="type-caption-2 uppercase tracking-wide mb-0.5" style={{ color: "var(--text-muted)" }}>Uptime</p>
            <p className="type-subheadline tabular-nums" style={{ color: "var(--text)" }}>{uptime}</p>
          </div>
        </div>
      </section>

      {/* Devices + auto-managed coverage + escape hatch to Advanced */}
      <section className="card">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-8">
            <div className="flex items-center gap-3">
              <span
                className="flex-none h-10 w-10 rounded-[10px] flex items-center justify-center"
                style={{ background: "var(--card-inner)", color: "var(--text-muted)" }}
              >
                <Cpu className="h-5 w-5" />
              </span>
              <div>
                <p className="type-title-3 tabular-nums" style={{ color: "var(--text)" }}>{deviceCount}</p>
                <p className="type-subheadline" style={{ color: "var(--text-muted)" }}>
                  device{deviceCount === 1 ? "" : "s"} on your network
                </p>
              </div>
            </div>

            {hasExtenders && (
              <div className="flex items-center gap-3">
                <span
                  className="flex-none h-10 w-10 rounded-[10px] flex items-center justify-center"
                  style={{ background: "var(--card-inner)", color: "var(--text-muted)" }}
                >
                  <Wifi className="h-5 w-5" />
                </span>
                <div>
                  <p className="type-title-3 tabular-nums" style={{ color: "var(--text)" }}>{apsOnline}</p>
                  <p className="type-subheadline" style={{ color: "var(--text-muted)" }}>
                    access point{apsOnline === 1 ? "" : "s"} · auto-managed
                  </p>
                </div>
              </div>
            )}
          </div>

          <button
            onClick={onOpenAdvanced}
            className="btn px-3 h-9 rounded-md"
          >
            <span className="type-subheadline">All network controls</span>
            <ArrowRight size={15} />
          </button>
        </div>

        {apsAwaiting > 0 && (
          <button
            onClick={onOpenAdvanced}
            className="mt-3 w-full flex items-center gap-2 rounded-md bg-system-orange/10 text-system-orange px-3 py-2 text-left transition-colors hover:bg-system-orange/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
          >
            <AlertTriangle size={15} className="flex-none" />
            <span className="type-subheadline">
              {apsAwaiting} access point{apsAwaiting === 1 ? "" : "s"} awaiting approval — review in
              Advanced
            </span>
          </button>
        )}
      </section>

      {/* Router — #17: surface the router as a manageable thing in the Simple
          (home) view, with a direct path to its settings. The full controls
          (hostname, OpenWrt version, reboot, resources) live in Advanced ›
          System; home users had no discoverable entry point. Hardware-agnostic
          per ADR-011 — status + a settings link, no board/NIC names. */}
      <section className="card">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <span
              className="flex-none h-10 w-10 rounded-[10px] flex items-center justify-center"
              style={{ background: "var(--card-inner)", color: "var(--text-muted)" }}
            >
              <Router className="h-5 w-5" />
            </span>
            <div>
              <p className="type-title-3" style={{ color: "var(--text)" }}>Router</p>
              <p className="type-subheadline" style={{ color: "var(--text-muted)" }}>
                {routerConnected ? "Connected" : "Status unknown"}
              </p>
            </div>
          </div>
          <button
            onClick={onOpenAdvanced}
            className="btn px-3 h-9 rounded-md"
          >
            <span className="type-subheadline">Router settings</span>
            <ArrowRight size={15} />
          </button>
        </div>
      </section>
    </div>
  );
}
