"use client";

import { Globe, Cpu, ArrowRight } from "lucide-react";
import type { NetworkOverview } from "@/lib/types";

function fmtUptime(sec: number): string {
  if (!sec || sec <= 0) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  if (d > 0) return `${d}d ${h}h`;
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

interface Props {
  overview: NetworkOverview | undefined;
  onOpenAdvanced: () => void;
}

/** WARP-612: the everyday "is the internet up?" glance for Home installs —
 *  the Droplet Design System's Simple-mode internet hero + device count, built
 *  on real /api/network data. Wi-Fi name/password, guest Wi-Fi, and camera
 *  privacy are a follow-up (they need the wifi-config + VLAN backends). */
export function NetworkSimple({ overview, onOpenAdvanced }: Props) {
  const wan = overview?.interfaces?.wan;
  const online = !!wan?.up;
  const wanIp = wan?.["ipv4-address"]?.[0]?.address ?? "—";
  const wanProto = wan?.proto ?? "—";
  const wanDevice = wan?.device ?? wan?.l3_device ?? "—";
  const uptime = fmtUptime(overview?.system?.resources?.uptime ?? 0);
  const deviceCount = overview?.connectedDeviceCount ?? 0;

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
            <p className="type-caption-2 uppercase tracking-wide text-label-tertiary mb-0.5">WAN port</p>
            <p className="type-subheadline font-mono text-label-primary">
              {wanDevice} · {wanProto}
            </p>
          </div>
          <div>
            <p className="type-caption-2 uppercase tracking-wide text-label-tertiary mb-0.5">Uptime</p>
            <p className="type-subheadline text-label-primary tabular-nums">{uptime}</p>
          </div>
        </div>
      </section>

      {/* Connected devices + escape hatch to Advanced */}
      <section className="dp-card p-5 flex items-center justify-between gap-4 flex-wrap">
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
        <button
          onClick={onOpenAdvanced}
          className="dp-btn-secondary inline-flex items-center gap-1.5 px-3 h-9 rounded-md"
        >
          <span className="type-subheadline">All network controls</span>
          <ArrowRight size={15} />
        </button>
      </section>
    </div>
  );
}
