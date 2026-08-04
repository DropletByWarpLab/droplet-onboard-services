"use client";

import { Lock, ShieldCheck } from "lucide-react";
import type { SwitchVlan, SwitchVlanProfile } from "@/lib/types/switch";

interface Props {
  profile: SwitchVlanProfile;
  vlans: SwitchVlan[];
}

/**
 * VLAN view — the two honest camera-isolation states (§6).
 *
 * flat-lan  → cameras show on VLAN 1, the Cameras row carries a blue
 *             "isolation pending router setup" pill, and a calm BLUE info
 *             note (never red) explains isolation arrives after router setup.
 * segmented → cameras show on VLAN 100 with a green isolated/lock chip and a
 *             real port count.
 *
 * Port counts are read from the §7 /vlans payload (authoritative) so the
 * panel never invents membership.
 */
export function VlanView({ profile, vlans }: Props) {
  const segmented = profile === "segmented";
  const lan = vlans.find((v) => v.vlan_id === 1);
  const cameras = vlans.find((v) => v.vlan_id === 100);
  const lanCount = lan?.ports.length ?? 0;
  const camCount = cameras?.ports.length ?? 0;

  return (
    <div className="border border-[var(--card-bd)] rounded-[12px] overflow-hidden">
      {/* VLAN 1 · LAN */}
      <div className="flex items-center gap-3.5 px-4 py-3 border-t border-[var(--card-bd)] first:border-t-0">
        <span className="type-caption-2 font-bold text-[color:var(--brand)] bg-[var(--brand-subtle)] px-2.5 py-1 rounded-[7px] flex-none font-mono">
          VLAN 1
        </span>
        <div className="flex-1 min-w-0">
          <div className="type-footnote font-semibold text-[color:var(--text)] flex items-center gap-2 flex-wrap">
            LAN <span className="text-[color:var(--text-muted)] font-normal">· default</span>
          </div>
          <div className="type-caption-1 text-[color:var(--text-muted)] mt-0.5">
            Workstations, printers and access points
          </div>
        </div>
        <span className="type-caption-2 text-[color:var(--text-muted)] font-mono">{lanCount} ports</span>
      </div>

      {/* VLAN 100 · Cameras */}
      <div className="flex items-center gap-3.5 px-4 py-3 border-t border-[var(--card-bd)]">
        <span className="type-caption-2 font-bold text-system-green bg-system-green/10 px-2.5 py-1 rounded-[7px] flex-none font-mono">
          VLAN 100
        </span>
        <div className="flex-1 min-w-0">
          <div className="type-footnote font-semibold text-[color:var(--text)] flex items-center gap-2 flex-wrap">
            Cameras
            {segmented ? (
              <span className="inline-flex items-center gap-1 type-caption-2 font-semibold text-system-green bg-system-green/10 px-2 py-0.5 rounded-full">
                <Lock size={10} aria-hidden="true" />
                isolated
              </span>
            ) : (
              <span className="inline-flex items-center type-caption-2 font-medium text-system-blue bg-system-blue/10 px-2 py-0.5 rounded-full">
                isolation pending router setup
              </span>
            )}
          </div>
          <div className="type-caption-1 text-[color:var(--text-muted)] mt-0.5">
            {segmented
              ? "Camera traffic kept off the main LAN — on-prem only"
              : "Cameras are on the main LAN for now"}
          </div>
        </div>
        <span className="type-caption-2 text-[color:var(--text-muted)] font-mono">
          {segmented ? `${camCount} ports` : "—"}
        </span>
      </div>

      {/* Calm blue info note — flat-lan only, never an error */}
      {!segmented && (
        <div className="flex gap-2.5 items-start px-4 py-3 border-t border-[var(--card-bd)] bg-system-blue/5 type-caption-1 leading-relaxed text-[color:var(--text-muted)]">
          <ShieldCheck size={13} className="text-system-blue flex-none mt-px" aria-hidden="true" />
          <span>
            Camera isolation becomes available after router setup supports inter-VLAN routing. Until
            then cameras stay reachable on the LAN — nothing leaves the box either way.
          </span>
        </div>
      )}
    </div>
  );
}
