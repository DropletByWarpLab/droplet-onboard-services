"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import useSWR from "swr";
import {
  AlertTriangle,
  ArrowLeft,
  Camera,
  Check,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Shield,
  X,
} from "lucide-react";
import { useCameras } from "@/lib/hooks/useCameras";
import { fetchCameraSettings, patchCameraSettings } from "@/lib/api";
import type {
  CameraInfo,
  CameraSettings,
  CameraSettingsPatch,
  ObjectFilter,
} from "@/lib/types";

/** Common Frigate object labels the operator usually wants. The full
 *  COCO set is ~80 labels — we surface this subset for one-click add
 *  and let them type any other label by hand. */
const COMMON_LABELS = [
  "person",
  "car",
  "truck",
  "motorcycle",
  "bicycle",
  "dog",
  "cat",
  "bird",
];

/**
 * Per-camera settings page (Phase 4.1).
 *
 * The operator edits a draft locally; nothing hits Frigate until they
 * click Save. We diff against the server-truth snapshot (`fetched`)
 * to compute the minimum-shape PATCH so the orchestrator only writes
 * what changed.
 *
 * Object filters are merged on the way in — Frigate exposes per-camera
 * + global defaults; the dashboard treats the camera-level filter as
 * authoritative and writes back camera-level overrides only.
 *
 * Zones + motion masks render as read-only here (with a "Coming in
 * Phase 4.2" hint) — they need a polygon editor we haven't built yet.
 */
export default function CameraSettingsPage() {
  const params = useParams<{ name: string }>();
  const router = useRouter();
  const name = useMemo(
    () => (typeof params?.name === "string" ? decodeURIComponent(params.name) : ""),
    [params],
  );

  const { cameras } = useCameras();
  const camera: CameraInfo | undefined = cameras.find((c) => c.name === name);

  const { data: fetched, error, isLoading, mutate } = useSWR<CameraSettings>(
    name ? ["camera-settings", name] : null,
    () => fetchCameraSettings(name),
    { revalidateOnFocus: false },
  );

  // Local draft; populated when the fetch completes. Operator edits
  // mutate this; the diff against `fetched` produces the patch we POST.
  const [draft, setDraft] = useState<CameraSettings | null>(null);
  useEffect(() => {
    if (fetched) setDraft(structuredClone(fetched));
  }, [fetched]);

  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState("");

  const dirty = useMemo(() => {
    if (!draft || !fetched) return false;
    return JSON.stringify(draft) !== JSON.stringify(fetched);
  }, [draft, fetched]);

  const update = <K extends keyof CameraSettings>(key: K, value: CameraSettings[K]) => {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  };

  const updateFilter = (label: string, patch: Partial<ObjectFilter>) => {
    setDraft((d) => {
      if (!d) return d;
      const cur = d.objectFilters[label] ?? { threshold: 0.7, minScore: 0.5 };
      return {
        ...d,
        objectFilters: { ...d.objectFilters, [label]: { ...cur, ...patch } },
      };
    });
  };

  const addLabel = (label: string) => {
    const trimmed = label.trim().toLowerCase();
    if (!trimmed || !/^[a-z0-9_-]{1,32}$/.test(trimmed)) {
      setSaveMsg(`"${label}" isn't a valid label`);
      return;
    }
    setDraft((d) => {
      if (!d) return d;
      if (d.trackedLabels.includes(trimmed)) return d;
      return {
        ...d,
        trackedLabels: [...d.trackedLabels, trimmed],
        objectFilters: {
          ...d.objectFilters,
          [trimmed]: d.objectFilters[trimmed] ?? { threshold: 0.7, minScore: 0.5 },
        },
      };
    });
    setNewLabel("");
    setSaveMsg(null);
  };

  const removeLabel = (label: string) => {
    setDraft((d) => {
      if (!d) return d;
      return {
        ...d,
        trackedLabels: d.trackedLabels.filter((l) => l !== label),
      };
    });
  };

  const handleSave = async () => {
    if (!draft || !fetched) return;
    const patch: CameraSettingsPatch = {};
    if (draft.detectEnabled !== fetched.detectEnabled) patch.detectEnabled = draft.detectEnabled;
    if (draft.detectFps !== fetched.detectFps) patch.detectFps = draft.detectFps;
    if (JSON.stringify(draft.trackedLabels) !== JSON.stringify(fetched.trackedLabels)) {
      patch.trackedLabels = draft.trackedLabels;
    }
    // Object filters: only send labels whose threshold or minScore differ.
    const filterPatch: Record<string, Partial<ObjectFilter>> = {};
    for (const label of draft.trackedLabels) {
      const drf = draft.objectFilters[label];
      const ftc = fetched.objectFilters[label];
      if (!drf) continue;
      if (!ftc || drf.threshold !== ftc.threshold || drf.minScore !== ftc.minScore) {
        filterPatch[label] = { threshold: drf.threshold, minScore: drf.minScore };
      }
    }
    if (Object.keys(filterPatch).length > 0) patch.objectFilters = filterPatch;
    if (draft.recordEnabled !== fetched.recordEnabled) patch.recordEnabled = draft.recordEnabled;
    if (draft.recordRetainDays !== fetched.recordRetainDays) {
      patch.recordRetainDays = draft.recordRetainDays;
    }
    if (draft.snapshotsEnabled !== fetched.snapshotsEnabled) {
      patch.snapshotsEnabled = draft.snapshotsEnabled;
    }
    if (draft.snapshotRetainDays !== fetched.snapshotRetainDays) {
      patch.snapshotRetainDays = draft.snapshotRetainDays;
    }

    if (Object.keys(patch).length === 0) {
      setSaveMsg("Nothing to save.");
      return;
    }

    setSaving(true);
    setSaveMsg(null);
    try {
      const next = await patchCameraSettings(name, patch);
      await mutate(next, { revalidate: false });
      setDraft(structuredClone(next));
      setSaveMsg("Saved. Camera restarting…");
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    if (!fetched) return;
    setDraft(structuredClone(fetched));
    setSaveMsg(null);
  };

  if (!name) return null;

  return (
    <div className="p-6">
      <div className="flex items-center gap-3 mb-4">
        <button
          onClick={() => router.push(`/cameras/${encodeURIComponent(name)}`)}
          className="p-2 -ml-2 rounded-full hover:bg-surface-secondary transition-colors"
          aria-label="Back to camera"
        >
          <ArrowLeft size={20} />
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="type-large-title text-label-primary truncate">
            {camera?.displayName ?? name} · Settings
          </h1>
          <p className="type-subheadline text-label-tertiary mt-0.5">
            Detection, objects, retention. Saving restarts the camera so changes take effect.
          </p>
        </div>
        <button
          onClick={() => mutate()}
          disabled={isLoading}
          className="dp-btn-secondary flex items-center gap-2 px-3 py-2 rounded-lg"
        >
          <RefreshCw size={16} className={isLoading ? "animate-spin" : ""} />
          <span className="type-subheadline">Refresh</span>
        </button>
      </div>

      {error && (
        <div className="dp-card p-4 mb-4 text-system-red">
          <p className="type-subheadline">
            Couldn&apos;t load settings:{" "}
            {error instanceof Error ? error.message : String(error)}
          </p>
        </div>
      )}

      {!draft ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="dp-card h-48 animate-pulse bg-surface-secondary" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Detection */}
          <div className="dp-card p-4 space-y-3">
            <div className="flex items-center gap-2">
              <Camera size={16} className="text-accent" />
              <h2 className="type-headline text-label-primary">Detection</h2>
            </div>
            <ToggleRow
              label="Detection enabled"
              value={draft.detectEnabled}
              onChange={(v) => update("detectEnabled", v)}
            />
            <SliderRow
              label="Detection FPS"
              min={1}
              max={15}
              step={1}
              value={draft.detectFps}
              onChange={(v) => update("detectFps", v)}
              format={(v) => `${v} fps`}
            />
            <p className="type-caption-1 text-label-tertiary">
              Higher FPS catches faster motion but uses more GPU. 5 fps suits
              most fixed cameras.
            </p>
          </div>

          {/* Recording */}
          <div className="dp-card p-4 space-y-3">
            <div className="flex items-center gap-2">
              <Shield size={16} className="text-accent" />
              <h2 className="type-headline text-label-primary">Recording</h2>
            </div>
            <ToggleRow
              label="Continuous recording"
              value={draft.recordEnabled}
              onChange={(v) => update("recordEnabled", v)}
            />
            <SliderRow
              label="Retention"
              min={0}
              max={90}
              step={1}
              value={draft.recordRetainDays}
              onChange={(v) => update("recordRetainDays", v)}
              format={(v) => (v === 0 ? "Off" : `${v} day${v === 1 ? "" : "s"}`)}
              disabled={!draft.recordEnabled}
            />
            <ToggleRow
              label="Save event snapshots"
              value={draft.snapshotsEnabled}
              onChange={(v) => update("snapshotsEnabled", v)}
            />
            <SliderRow
              label="Snapshot retention"
              min={0}
              max={90}
              step={1}
              value={draft.snapshotRetainDays}
              onChange={(v) => update("snapshotRetainDays", v)}
              format={(v) => (v === 0 ? "Off" : `${v} day${v === 1 ? "" : "s"}`)}
              disabled={!draft.snapshotsEnabled}
            />
          </div>

          {/* Tracked objects + filters — full-width on lg */}
          <div className="dp-card p-4 space-y-3 lg:col-span-2">
            <div className="flex items-center justify-between">
              <h2 className="type-headline text-label-primary">Tracked objects</h2>
              <span className="type-caption-2 text-label-tertiary">
                {draft.trackedLabels.length} label{draft.trackedLabels.length === 1 ? "" : "s"}
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {draft.trackedLabels.map((label) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => removeLabel(label)}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-full type-caption-1 capitalize bg-accent text-white hover:bg-accent-hover"
                  title="Click to stop tracking"
                >
                  {label}
                  <X size={10} />
                </button>
              ))}
              {draft.trackedLabels.length === 0 && (
                <span className="type-caption-1 text-label-tertiary">
                  Not tracking any objects yet.
                </span>
              )}
            </div>

            {/* Quick-add common labels */}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="type-caption-2 text-label-tertiary mr-1">
                Add:
              </span>
              {COMMON_LABELS.filter((l) => !draft.trackedLabels.includes(l)).map(
                (label) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => addLabel(label)}
                    className="flex items-center gap-1 px-2 py-0.5 rounded-full type-caption-2 capitalize bg-surface-secondary text-label-secondary hover:bg-surface-tertiary"
                  >
                    <Plus size={10} />
                    {label}
                  </button>
                ),
              )}
              <input
                type="text"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addLabel(newLabel);
                  }
                }}
                placeholder="Custom label…"
                maxLength={32}
                className="h-7 px-2 rounded-full border border-separator bg-surface-secondary type-caption-2 text-label-primary focus:border-accent focus:outline-none"
              />
            </div>

            {/* Per-label filter sliders */}
            {draft.trackedLabels.length > 0 && (
              <div className="space-y-3 pt-2 border-t border-separator">
                {draft.trackedLabels.map((label) => {
                  const f = draft.objectFilters[label] ?? { threshold: 0.7, minScore: 0.5 };
                  return (
                    <div key={label} className="grid grid-cols-1 sm:grid-cols-[120px_1fr_1fr] items-center gap-3">
                      <span className="type-subheadline text-label-primary capitalize font-medium">
                        {label}
                      </span>
                      <SliderRow
                        label="Threshold"
                        compact
                        min={0}
                        max={1}
                        step={0.05}
                        value={f.threshold}
                        onChange={(v) => updateFilter(label, { threshold: v })}
                        format={(v) => `${Math.round(v * 100)}%`}
                      />
                      <SliderRow
                        label="Min score"
                        compact
                        min={0}
                        max={1}
                        step={0.05}
                        value={f.minScore}
                        onChange={(v) => updateFilter(label, { minScore: v })}
                        format={(v) => `${Math.round(v * 100)}%`}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Zones + motion mask — read-only for Phase 4.1 */}
          <div className="dp-card p-4 space-y-2 lg:col-span-2">
            <div className="flex items-center gap-2">
              <h2 className="type-headline text-label-primary">Zones &amp; motion mask</h2>
              <span className="type-caption-2 px-1.5 py-0.5 rounded-full bg-system-yellow/20 text-system-yellow">
                Read-only
              </span>
            </div>
            <p className="type-caption-1 text-label-tertiary">
              The polygon editor lands in Phase 4.2. For now you can see what
              zones Frigate is using; edit them via the Frigate config file
              if you must.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {draft.zoneNames.length === 0 ? (
                <span className="type-caption-1 text-label-tertiary">
                  No zones defined.
                </span>
              ) : (
                draft.zoneNames.map((z) => (
                  <span
                    key={z}
                    className="px-2.5 py-1 rounded-full type-caption-1 bg-surface-secondary text-label-secondary"
                  >
                    {z}
                  </span>
                ))
              )}
            </div>
            <p className="type-caption-1 text-label-tertiary">
              Motion mask:{" "}
              {draft.hasMotionMask ? "configured" : "none"}.
            </p>
          </div>
        </div>
      )}

      {/* Sticky save bar */}
      {draft && (
        <div className="sticky bottom-4 mt-6 flex items-center justify-between gap-3 dp-card p-3 backdrop-blur-md bg-[var(--color-surface-primary)]/95">
          <div className="flex items-center gap-2 min-w-0">
            {saveMsg ? (
              <>
                {saveMsg.startsWith("Saved") ? (
                  <Check size={14} className="text-system-green" />
                ) : (
                  <AlertTriangle size={14} className="text-system-red" />
                )}
                <span
                  className={`type-caption-1 truncate ${
                    saveMsg.startsWith("Saved") ? "text-system-green" : "text-system-red"
                  }`}
                >
                  {saveMsg}
                </span>
              </>
            ) : dirty ? (
              <span className="type-caption-1 text-label-tertiary">
                Unsaved changes — Frigate will restart on save.
              </span>
            ) : (
              <span className="type-caption-1 text-label-tertiary">
                No unsaved changes.
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={handleDiscard}
              disabled={!dirty || saving}
              className="dp-btn-secondary px-3 py-2 rounded-lg type-subheadline disabled:opacity-50"
            >
              Discard
            </button>
            <button
              onClick={handleSave}
              disabled={!dirty || saving}
              className="dp-btn-primary flex items-center gap-2 px-3 py-2 rounded-lg type-subheadline disabled:opacity-50"
            >
              {saving ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Save size={14} />
              )}
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reusable form rows — kept local because they're stylistically tied to this
// page and would just be noise in a shared components folder.
// ---------------------------------------------------------------------------

function ToggleRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 cursor-pointer">
      <span className="type-subheadline text-label-primary">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
        className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors ${
          value ? "bg-accent" : "bg-surface-tertiary"
        }`}
      >
        <span
          className={`inline-block h-5 w-5 rounded-full bg-white shadow transform transition-transform ${
            value ? "translate-x-5" : "translate-x-0.5"
          } translate-y-0.5`}
        />
      </button>
    </label>
  );
}

function SliderRow({
  label,
  min,
  max,
  step,
  value,
  onChange,
  format,
  disabled,
  compact,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (next: number) => void;
  format?: (value: number) => string;
  disabled?: boolean;
  compact?: boolean;
}) {
  const display = format ? format(value) : String(value);
  return (
    <div className={compact ? "" : "space-y-1"}>
      <div className="flex items-center justify-between gap-2">
        <span
          className={`${
            compact ? "type-caption-2" : "type-subheadline"
          } text-label-secondary`}
        >
          {label}
        </span>
        <span
          className={`${
            compact ? "type-caption-2" : "type-caption-1"
          } text-label-secondary font-mono`}
        >
          {display}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-accent disabled:opacity-50"
      />
    </div>
  );
}
