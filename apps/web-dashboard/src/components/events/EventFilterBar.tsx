"use client";

import { useMemo, useState } from "react";
import { ChevronDown, Filter, X } from "lucide-react";
import type { CameraInfo, EventFilter } from "@/lib/types";

interface Props {
  cameras: CameraInfo[];
  /** Frigate labels seen in the most recent results — used to populate
   *  the label filter without forcing the operator to type. */
  knownLabels: string[];
  filter: EventFilter;
  onChange: (next: EventFilter) => void;
}

const TIME_PRESETS: Array<{ id: string; label: string; secondsAgo: number | null }> = [
  { id: "any", label: "Any time", secondsAgo: null },
  { id: "1h", label: "Last hour", secondsAgo: 60 * 60 },
  { id: "today", label: "Today", secondsAgo: -1 /* sentinel — handled below */ },
  { id: "24h", label: "Last 24h", secondsAgo: 24 * 60 * 60 },
  { id: "7d", label: "Last 7 days", secondsAgo: 7 * 24 * 60 * 60 },
];

/** Map an EventFilter.after to whichever preset id matches it (rough). */
function presetIdFor(after: number | undefined): string {
  if (!after) return "any";
  const now = Math.floor(Date.now() / 1000);
  const startOfToday = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
  if (Math.abs(after - startOfToday) < 60) return "today";
  const ago = now - after;
  // Allow a small wobble so the preset stays selected across re-renders.
  if (Math.abs(ago - 60 * 60) < 30) return "1h";
  if (Math.abs(ago - 24 * 60 * 60) < 30) return "24h";
  if (Math.abs(ago - 7 * 24 * 60 * 60) < 30) return "7d";
  return "any";
}

/**
 * Filter rail for the Events page — camera multi-select, label
 * multi-select, score floor, time-range preset, and clip/snapshot
 * affinity. Renders inline (no popovers) so all the active filters are
 * visible at a glance.
 *
 * Multi-selects are "click-to-toggle" pills rather than HTML
 * `<select multiple>` because the operator needs to see what's
 * selected without scrolling a dropdown. The accent fill on a pill is
 * the only "I'm in" affordance.
 */
export function EventFilterBar({ cameras, knownLabels, filter, onChange }: Props) {
  const [collapsed, setCollapsed] = useState(false);

  const selectedCameras = filter.cameras ?? [];
  const selectedLabels = filter.labels ?? [];

  const sortedCameras = useMemo(
    () =>
      cameras.slice().sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [cameras],
  );

  const toggleCamera = (name: string) => {
    const set = new Set(selectedCameras);
    set.has(name) ? set.delete(name) : set.add(name);
    onChange({ ...filter, cameras: set.size > 0 ? Array.from(set) : undefined });
  };
  const toggleLabel = (label: string) => {
    const set = new Set(selectedLabels);
    set.has(label) ? set.delete(label) : set.add(label);
    onChange({ ...filter, labels: set.size > 0 ? Array.from(set) : undefined });
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

  const setMinScore = (raw: string) => {
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    if (n <= 0) {
      const { minScore: _ms, ...rest } = filter;
      onChange(rest);
      return;
    }
    onChange({ ...filter, minScore: Math.min(Math.max(n, 0), 1) });
  };

  const setHasClip = (next: boolean | undefined) => {
    if (next === undefined) {
      const { hasClip: _hc, ...rest } = filter;
      onChange(rest);
    } else {
      onChange({ ...filter, hasClip: next });
    }
  };

  const clearAll = () => {
    onChange({});
  };

  const activePreset = presetIdFor(filter.after);
  const activeCount =
    (selectedCameras.length > 0 ? 1 : 0) +
    (selectedLabels.length > 0 ? 1 : 0) +
    (filter.minScore !== undefined ? 1 : 0) +
    (activePreset !== "any" ? 1 : 0) +
    (filter.hasClip !== undefined ? 1 : 0);

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
          {/* Cameras */}
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

          {/* Labels */}
          {knownLabels.length > 0 && (
            <div>
              <div className="type-caption-2 text-[color:var(--text-muted)] mb-1.5">Labels</div>
              <div className="chiprow">
                {knownLabels.map((label) => {
                  const active = selectedLabels.includes(label);
                  return (
                    <button
                      key={label}
                      type="button"
                      onClick={() => toggleLabel(label)}
                      className={`chip capitalize${active ? " on" : ""}`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {/* Time preset */}
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

            {/* Score floor */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="type-caption-2 text-[color:var(--text-muted)]">Min score</span>
                <span className="type-caption-2 font-mono text-[color:var(--text-muted)]">
                  {filter.minScore !== undefined
                    ? `${Math.round(filter.minScore * 100)}%`
                    : "Any"}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={filter.minScore ?? 0}
                onChange={(e) => setMinScore(e.target.value)}
                className="w-full"
                style={{ accentColor: "var(--brand)" }}
              />
            </div>

            {/* Clip / snapshot */}
            <div>
              <div className="type-caption-2 text-[color:var(--text-muted)] mb-1.5">Media</div>
              <div className="pills" role="group" aria-label="Media">
                <button
                  type="button"
                  onClick={() => setHasClip(undefined)}
                  className={filter.hasClip === undefined ? "active" : undefined}
                  aria-pressed={filter.hasClip === undefined}
                >
                  All
                </button>
                <button
                  type="button"
                  onClick={() => setHasClip(true)}
                  className={filter.hasClip === true ? "active" : undefined}
                  aria-pressed={filter.hasClip === true}
                >
                  With clip
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
