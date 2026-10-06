"use client";
import { ThemedDateInput } from "@/components/ui/ThemedDateInput";


import { useMemo } from "react";
import { Filter, X } from "lucide-react";
import type { CameraInfo, MotionFilter } from "@/lib/types";
import { BusinessHoursFilter } from "./BusinessHoursFilter";
import { ThemedSelect } from "@/components/ui/ThemedSelect";

export type MotionPeriod = "recent" | "day";
export function recentMotionRange(): Pick<MotionFilter, "after" | "before"> {
  const before = Math.floor(Date.now() / 1000);
  return { after: before - 86400, before };
}
function dateString(timestamp: number) {
  const date = new Date(timestamp * 1000);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function calendarDayRange(day: string) {
  const [y, m, d] = day.split("-").map(Number);
  return {
    after: Math.floor(new Date(y, m - 1, d).getTime() / 1000),
    before: Math.min(Math.floor(Date.now() / 1000), Math.floor(new Date(y, m - 1, d + 1).getTime() / 1000)),
  };
}
const CONTROL = "w-full h-9 px-2 type-footnote outline-none focus:ring-2 focus:ring-[var(--brand)] rounded-[var(--radius-input)] bg-[var(--surface)] border border-[var(--border)] text-[color:var(--text)]";

export function MotionFilterBar({ cameras, filter, period, businessHoursConfigured, onChange }: {
  cameras: CameraInfo[];
  filter: MotionFilter;
  period: MotionPeriod;
  businessHoursConfigured: boolean;
  onChange: (next: MotionFilter, period?: MotionPeriod) => void;
}) {
  const sortedCameras = useMemo(() => [...cameras].sort((a, b) => a.displayName.localeCompare(b.displayName)), [cameras]);
  const active = filter.cameras?.length || filter.businessHours || period === "day";
  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 type-subheadline font-medium"><Filter size={16} /> Filters</span>
        {active && <button type="button" className="flex items-center gap-1 type-caption-1 text-[color:var(--text-muted)]" onClick={() => onChange(recentMotionRange(), "recent")}><X size={12} /> Clear all</button>}
      </div>
      <BusinessHoursFilter value={filter.businessHours} configured={businessHoursConfigured} onChange={(businessHours) => onChange({ ...filter, businessHours })} />
      {sortedCameras.length > 0 && <div>
        <div className="type-caption-2 text-[color:var(--text-muted)] mb-1.5">Cameras</div>
        <div className="chiprow">{sortedCameras.map((camera) => <button key={camera.name} type="button" className={`chip${filter.cameras?.includes(camera.name) ? " on" : ""}`} onClick={() => {
          const selected = new Set(filter.cameras);
          selected.has(camera.name) ? selected.delete(camera.name) : selected.add(camera.name);
          onChange({ ...filter, cameras: selected.size ? [...selected] : undefined });
        }}>{camera.displayName}</button>)}</div>
      </div>}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="type-caption-2 text-[color:var(--text-muted)]">When
          <ThemedSelect aria-label="Motion time range" className={`${CONTROL} mt-1.5`} value={period} onChange={(e) => {
            const nextPeriod = e.target.value as MotionPeriod;
            onChange({ ...filter, ...(nextPeriod === "recent" ? recentMotionRange() : calendarDayRange(dateString(Date.now() / 1000))) }, nextPeriod);
          }}><option value="recent">Last 24 hours</option><option value="day">Calendar day</option></ThemedSelect>
        </label>
        {period === "day" && <label className="type-caption-2 text-[color:var(--text-muted)]">Date
          <ThemedDateInput aria-label="Motion date" type="date" className={`${CONTROL} mt-1.5`} value={dateString(filter.after)} max={dateString(Date.now() / 1000)} onChange={(e) => {
            if (e.target.value) onChange({ ...filter, ...calendarDayRange(e.target.value) }, "day");
          }} />
        </label>}
      </div>
    </div>
  );
}
