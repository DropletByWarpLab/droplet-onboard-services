"use client";

import { Lightbulb, ThermometerSun, Lock, Play } from "lucide-react";
import type { MatterGrouped } from "@/lib/types";

/**
 * Smart-home KPI strip (Droplet Design System · §2.7). At-a-glance counts for
 * the four things a household most wants to glance at — lights, climate, locks,
 * routines. Every number is derived from live data (the Matter device groups +
 * the saved routines); nothing is fabricated. Copy leads with the count, jargon
 * stays a quiet secondary (ADR-002): "6 lights · 4 on".
 */
export function DeviceStats({
  grouped,
  routineCount,
}: {
  grouped: MatterGrouped | null;
  routineCount: number;
}) {
  const lights = grouped?.lights ?? [];
  const climate = grouped?.climate ?? [];
  const locks = grouped?.locks ?? [];

  const lightsOn = lights.filter((d) => d.state === "on").length;
  const locksLocked = locks.filter(
    (d) => d.state === "locked" || d.state === "closed",
  ).length;
  const locksOpen = locks.length - locksLocked;

  const stats: Array<{
    icon: typeof Lightbulb;
    label: string;
    value: number;
    sub: string;
  }> = [
    {
      icon: Lightbulb,
      label: "Lights",
      value: lights.length,
      sub: lights.length ? `${lightsOn} on` : "none paired",
    },
    {
      icon: ThermometerSun,
      label: "Climate",
      value: climate.length,
      sub: climate.length === 1 ? "thermostat" : climate.length === 0 ? "none paired" : "thermostats",
    },
    {
      icon: Lock,
      label: "Locks",
      value: locks.length,
      sub: !locks.length
        ? "none paired"
        : locksOpen === 0
          ? "all locked"
          : `${locksOpen} unlocked`,
    },
    {
      icon: Play,
      label: "Routines",
      value: routineCount,
      sub: routineCount === 1 ? "routine" : "routines",
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {stats.map((s) => {
        const Icon = s.icon;
        return (
          <div key={s.label} className="card">
            <div className="flex items-center gap-2 mb-2">
              <Icon size={16} style={{ color: "var(--text-muted)" }} />
              <span
                className="type-footnote font-medium uppercase tracking-wider"
                style={{ color: "var(--text-muted)" }}
              >
                {s.label}
              </span>
            </div>
            <p className="type-title-2" style={{ color: "var(--text)" }}>{s.value}</p>
            <p className="type-caption-1 mt-0.5" style={{ color: "var(--text-muted)" }}>{s.sub}</p>
          </div>
        );
      })}
    </div>
  );
}
