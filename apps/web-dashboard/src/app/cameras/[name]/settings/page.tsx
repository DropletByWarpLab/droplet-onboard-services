"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import useSWR from "swr";
import {
  AlertTriangle,
  ArrowLeft,
  Camera,
  Check,
  HardDrive,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Shield,
  X,
} from "lucide-react";
import { useCameras } from "@/lib/hooks/useCameras";
import { fetchCameraSettings, patchCameraSettings, setCameraBudget } from "@/lib/api";
import { ZoneEditor } from "@/components/settings/ZoneEditor";
import { MotionMaskEditor } from "@/components/settings/MotionMaskEditor";
import { ShellPage } from "@/components/shell/ShellPage";
import type {
  CameraInfo,
  CameraSettings,
  CameraSettingsPatch,
  CameraZone,
  MotionMaskPolygon,
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
 * Zones + motion masks are edited inline via the interactive polygon
 * editors (`ZoneEditor` / `MotionMaskEditor`) — draw/drag vertices,
 * changes merge into the local draft and ship with the same Save.
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

  // WARP-1851 — storage budget. Kept out of `draft` because it is not part
  // of the Frigate settings patch: it is orchestrator state that DERIVES a
  // retention window, and it saves through its own endpoint.
  const [budgetGb, setBudgetGb] = useState("");
  const [budgetSaving, setBudgetSaving] = useState(false);
  const [budgetMsg, setBudgetMsg] = useState<string | null>(null);

  const saveBudget = async (bytes: number | null) => {
    setBudgetSaving(true);
    setBudgetMsg(null);
    try {
      const r = await setCameraBudget(name, bytes);
      if (r.retentionMode === "MANUAL") {
        setBudgetGb("");
        setBudgetMsg(r.note ?? "Back to setting retention in days yourself.");
      } else if (r.measurable && r.projectedDays != null) {
        // State the trade out loud — a budget means nothing to the operator
        // until it is expressed in days of footage.
        setBudgetMsg(
          `That's about ${r.projectedDays} day${r.projectedDays === 1 ? "" : "s"} of footage at this camera's current recording rate.`,
        );
      } else {
        setBudgetMsg(r.note ?? "Saved.");
      }
    } catch (e) {
      setBudgetMsg(e instanceof Error ? e.message : "Couldn't save the budget.");
    } finally {
      setBudgetSaving(false);
    }
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
    for (const field of [
      "continuousRetainDays",
      "motionRetainDays",
      "alertsRetainDays",
      "detectionsRetainDays",
    ] as const) {
      if (draft[field] !== fetched[field]) patch[field] = draft[field];
    }
    if (draft.snapshotsEnabled !== fetched.snapshotsEnabled) {
      patch.snapshotsEnabled = draft.snapshotsEnabled;
    }
    if (draft.snapshotRetainDays !== fetched.snapshotRetainDays) {
      patch.snapshotRetainDays = draft.snapshotRetainDays;
    }
    if (JSON.stringify(draft.zones) !== JSON.stringify(fetched.zones)) {
      patch.zones = draft.zones;
    }
    if (
      JSON.stringify(draft.motionMasks) !== JSON.stringify(fetched.motionMasks)
    ) {
      patch.motionMasks = draft.motionMasks;
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

  const actions = (
    <>
      <button
        onClick={() => router.push(`/cameras/${encodeURIComponent(name)}`)}
        className="btn ghost"
        type="button"
      >
        <ArrowLeft size={15} />
        Camera
      </button>
      <button
        onClick={() => mutate()}
        disabled={isLoading}
        className="icon-btn"
        aria-label="Refresh"
        title="Refresh"
        type="button"
      >
        <RefreshCw size={16} className={isLoading ? "animate-spin" : ""} />
      </button>
    </>
  );

  return (
    <ShellPage
      icon={<Camera size={15} />}
      label="Settings"
      title={`${camera?.displayName ?? name} · Settings`}
      sub="Detection, objects, retention. Saving restarts the camera so changes take effect."
      actions={actions}
    >
      {error && (
        <div className="card" style={{ color: "#ef4444", marginBottom: 16 }}>
          <p>
            Couldn&apos;t load settings:{" "}
            {error instanceof Error ? error.message : String(error)}
          </p>
        </div>
      )}

      {!draft ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="card" style={{ height: 192, background: "var(--surface-2)" }} />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Detection */}
          <div className="card space-y-3">
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
          <div className="card space-y-3">
            <div className="flex items-center gap-2">
              <Shield size={16} className="text-accent" />
              <h2 className="type-headline text-label-primary">Recording</h2>
            </div>
            <ToggleRow
              label="Recording"
              value={draft.recordEnabled}
              onChange={(v) => update("recordEnabled", v)}
            />
            {/* WARP-1849: Frigate keeps four independent retention windows.
                Continuous and motion cover raw footage; alerts and
                detections cover the clips that show up in the events list.
                A single "Retention" control could only ever set one of
                them, which is how the previous version silently kept
                nothing. */}
            <SliderRow
              label="Keep 24/7 footage"
              min={0}
              max={90}
              step={1}
              value={draft.continuousRetainDays}
              onChange={(v) => update("continuousRetainDays", v)}
              format={(v) => (v === 0 ? "Don't keep" : `${v} day${v === 1 ? "" : "s"}`)}
              disabled={!draft.recordEnabled}
            />
            <SliderRow
              label="Keep footage with motion"
              min={0}
              max={90}
              step={1}
              value={draft.motionRetainDays}
              onChange={(v) => update("motionRetainDays", v)}
              format={(v) => (v === 0 ? "Don't keep" : `${v} day${v === 1 ? "" : "s"}`)}
              disabled={!draft.recordEnabled}
            />
            <p className="type-caption-1 text-label-tertiary">
              24/7 footage is by far the largest consumer of disk. Keeping
              only motion gives you most of what you&apos;d go looking for at
              a fraction of the space.
            </p>
            <SliderRow
              label="Keep alert clips"
              min={0}
              max={90}
              step={1}
              value={draft.alertsRetainDays}
              onChange={(v) => update("alertsRetainDays", v)}
              format={(v) => (v === 0 ? "Don't keep" : `${v} day${v === 1 ? "" : "s"}`)}
              disabled={!draft.recordEnabled}
            />
            <SliderRow
              label="Keep other detections"
              min={0}
              max={90}
              step={1}
              value={draft.detectionsRetainDays}
              onChange={(v) => update("detectionsRetainDays", v)}
              format={(v) => (v === 0 ? "Don't keep" : `${v} day${v === 1 ? "" : "s"}`)}
              disabled={!draft.recordEnabled}
            />
            <p className="type-caption-1 text-label-tertiary">
              Alerts are the clips worth your attention — a person or car
              your camera is watching for. Other detections are everything
              else it noticed.
            </p>
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

          {/* Storage budget (WARP-1851) */}
          <div className="card space-y-3">
            <div className="flex items-center gap-2">
              <HardDrive size={16} className="text-accent" />
              <h2 className="type-headline text-label-primary">Storage budget</h2>
            </div>
            <p className="type-caption-1 text-label-tertiary">
              Give this camera an amount of disk instead of a number of days.
              We measure how fast it actually records and keep as many days as
              that budget covers, adjusting as the rate changes.
            </p>
            <label className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                step={1}
                value={budgetGb}
                onChange={(e) => setBudgetGb(e.target.value)}
                placeholder="e.g. 200"
                className="input"
                style={{ maxWidth: 140 }}
                aria-label="Storage budget in gigabytes"
              />
              <span className="type-body text-label-secondary">GB</span>
            </label>
            {budgetMsg && (
              <p className="type-caption-1 text-label-tertiary">{budgetMsg}</p>
            )}
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="btn"
                disabled={budgetSaving || !budgetGb}
                onClick={() => saveBudget(Number(budgetGb) * 1024 * 1024 * 1024)}
              >
                {budgetSaving ? "Saving…" : "Use this budget"}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={budgetSaving}
                onClick={() => saveBudget(null)}
              >
                Set days myself
              </button>
            </div>
          </div>

          {/* Tracked objects + filters — full-width on lg */}
          <div className="card space-y-3 lg:col-span-2">
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
                  className="chip on capitalize"
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
                className="h-7 px-2 type-caption-2 outline-none focus:border-[var(--brand)]"
                style={{
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-pill)",
                  color: "var(--text)",
                }}
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

          {/* Zones — interactive polygon editor (Phase 4.2) */}
          <div className="card space-y-3 lg:col-span-2">
            <div className="flex items-center justify-between">
              <h2 className="type-headline text-label-primary">Zones</h2>
              <span className="type-caption-2 text-label-tertiary">
                {draft.zones.length} zone{draft.zones.length === 1 ? "" : "s"}
              </span>
            </div>
            <ZoneEditor
              cameraName={name}
              zones={draft.zones}
              trackedLabels={draft.trackedLabels}
              onChange={(next: CameraZone[]) =>
                setDraft((d) => (d ? { ...d, zones: next } : d))
              }
            />
          </div>

          {/* Motion mask — interactive editor (Phase 4.3) */}
          <div className="card space-y-3 lg:col-span-2">
            <div className="flex items-center justify-between">
              <h2 className="type-headline text-label-primary">Motion mask</h2>
              <span className="type-caption-2 text-label-tertiary">
                {draft.motionMasks.length} mask
                {draft.motionMasks.length === 1 ? "" : "s"}
              </span>
            </div>
            <p className="type-caption-1 text-label-tertiary">
              Areas the camera service ignores for motion — masking out a
              tree branch that triggers in wind, or a busy street corner.
            </p>
            <MotionMaskEditor
              cameraName={name}
              masks={draft.motionMasks}
              onChange={(next: MotionMaskPolygon[]) =>
                setDraft((d) => (d ? { ...d, motionMasks: next } : d))
              }
            />
          </div>
        </div>
      )}

      {/* Sticky save bar */}
      {draft && (
        <div className="card sticky bottom-4 mt-6 flex items-center justify-between gap-3 backdrop-blur-md" style={{ padding: 12 }}>
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
                Unsaved changes — the camera service will restart on save.
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
              className="btn ghost"
              type="button"
            >
              Discard
            </button>
            <button
              onClick={handleSave}
              disabled={!dirty || saving}
              className="btn primary"
              type="button"
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
    </ShellPage>
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
      <span className="type-subheadline" style={{ color: "var(--text)" }}>
        {label}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
        className="relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors"
        style={{ background: value ? "var(--brand)" : "var(--inset)" }}
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
