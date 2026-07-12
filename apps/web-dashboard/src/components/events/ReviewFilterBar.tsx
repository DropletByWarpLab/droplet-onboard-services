"use client";

import { useMemo, useState } from "react";
import { ChevronDown, Filter, X } from "lucide-react";
import type { CameraInfo, ReviewFilter } from "@/lib/types";

interface Props {
  cameras: CameraInfo[];
  filter: ReviewFilter;
  onChange: (next: ReviewFilter) => void;
}

const TIME_PRESETS: Array<{ id: string; label: string; secondsAgo: number | null }> = [
  { id: "any", label: "Any time", secondsAgo: null },
  { id: "1h", label: "Last hour", secondsAgo: 60 * 60 },
  { id: "today", label: "Today", secondsAgo: -1 },
  { id: "24h", label: "Last 24h", secondsAgo: 24 * 60 * 60 },
  { id: "7d", label: "Last 7 days", secondsAgo: 7 * 24 * 60 * 60 },
];

function presetIdFor(after: number | undefined): string {
  if (!after) return "any";
  const now = Math.floor(Date.now() / 1000);
  const startOfToday = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
  if (Math.abs(after - startOfToday) < 60) return "today";
  const ago = now - after;
  if (Math.abs(ago - 60 * 60) < 30) return "1h";
  if (Math.abs(ago - 24 * 60 * 60) < 30) return "24h";
  if (Math.abs(ago - 7 * 24 * 60 * 60) < 30) return "7d";
  return "any";
}

/**
 * Filter rail for the Reviews tabs (Alerts / Detections). Trimmed
 * down vs the events filter — Frigate reviews are clusters, so
 * per-event controls (label, min_score, has_clip) don't apply.
 *
 * What does apply: cameras, time range, and an "unreviewed only"
 * toggle that lets the operator focus on triage. The active-count
 * pip + clear-all are intentionally identical to EventFilterBar so
 * the two UIs feel like siblings.
 */
export function ReviewFilterBar({ cameras, filter, onChange }: Props) {
  const [collapsed, setCollapsed] = useState(false);

  const selectedCameras = filter.cameras ?? [];

  const sortedCameras = useMemo(
    () => cameras.slice().sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [cameras],
  );

  const toggleCamera = (name: string) => {
    const set = new Set(selectedCameras);
    set.has(name) ? set.delete(name) : set.add(name);
    onChange({ ...filter, cameras: set.size > 0 ? Array.from(set) : undefined });
  };

  const setTimePreset = (id: string) => {
    if (id === "any") {
      const { after: _after, ...rest } = filter;
      onChange(rest);
      return;
    }
    if (id === "today") {
      const startOfToday = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
      onChange({ ...filter, after: startOfToday });
      return;
    }
    const preset = TIME_PRESETS.find((p) => p.id === id);
    if (!preset || preset.secondsAgo === null || preset.secondsAgo < 0) return;
    onChange({ ...filter, after: Math.floor(Date.now() / 1000) - preset.secondsAgo });
  };

  const setReviewed = (next: boolean | undefined) => {
    if (next === undefined) {
      const { reviewed: _r, ...rest } = filter;
      onChange(rest);
    } else {
      onChange({ ...filter, reviewed: next });
    }
  };

  const clearAll = () => {
    // Keep severity (driven by the tab) but drop everything else.
    const { severity } = filter;
    onChange(severity ? { severity } : {});
  };

  const activePreset = presetIdFor(filter.after);
  const activeCount =
    (selectedCameras.length > 0 ? 1 : 0) +
    (activePreset !== "any" ? 1 : 0) +
    (filter.reviewed !== undefined ? 1 : 0);

  return (
    <div className="card mb-4 space-y-3">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-center gap-2"
        >
          <Filter size={16} />
          <span className="type-subheadline font-medium">Filters</span>
          {activeCount > 0 && (
            <span className="badge info">{activeCount}</span>
          )}
          <ChevronDown
            size={16}
            className={`transition-transform text-[color:var(--text-muted)] ${collapsed ? "-rotate-90" : ""}`}
          />
        </button>
        {activeCount > 0 && (
          <button
            type="button"
            onClick={clearAll}
            className="flex items-center gap-1 type-caption-1 text-[color:var(--text-muted)] hover:text-[color:var(--text)] transition-colors"
          >
            <X size={12} />
            Clear all
          </button>
        )}
      </div>

      {!collapsed && (
        <div className="space-y-3">
          {sortedCameras.length > 0 && (
            <div>
              <div className="type-caption-2 text-[color:var(--text-muted)] mb-1.5">Cameras</div>
              <div className="chiprow">
                {sortedCameras.map((cam) => {
                  const active = selectedCameras.includes(cam.name);
                  return (
                    <button
                      key={cam.name}
                      type="button"
                      onClick={() => toggleCamera(cam.name)}
                      className={`chip${active ? " on" : ""}`}
                    >
                      {cam.displayName}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <div className="type-caption-2 text-[color:var(--text-muted)] mb-1.5">When</div>
              <select
                value={activePreset}
                onChange={(e) => setTimePreset(e.target.value)}
                className="w-full h-9 px-2 type-footnote outline-none focus:border-[var(--brand)]"
                style={{
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-input)",
                  color: "var(--text)",
                }}
              >
                {TIME_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <div className="type-caption-2 text-[color:var(--text-muted)] mb-1.5">Status</div>
              <div className="pills" role="group" aria-label="Status">
                <button
                  type="button"
                  onClick={() => setReviewed(undefined)}
                  className={filter.reviewed === undefined ? "active" : undefined}
                  aria-pressed={filter.reviewed === undefined}
                >
                  All
                </button>
                <button
                  type="button"
                  onClick={() => setReviewed(false)}
                  className={filter.reviewed === false ? "active" : undefined}
                  aria-pressed={filter.reviewed === false}
                >
                  Unreviewed
                </button>
                <button
                  type="button"
                  onClick={() => setReviewed(true)}
                  className={filter.reviewed === true ? "active" : undefined}
                  aria-pressed={filter.reviewed === true}
                >
                  Reviewed
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
