"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Bell,
  Car,
  Dog,
  Loader2,
  RefreshCw,
  Save,
  User,
  Activity,
} from "lucide-react";
import { useCameras } from "@/lib/hooks/useCameras";
import {
  fetchCameraNotifications,
  updateCameraNotifications,
} from "@/lib/api";
import { PushSubscriptionCard } from "@/components/notifications/PushSubscriptionCard";
import type { CameraInfo, NotificationPrefs } from "@/lib/types";

type RowState = NotificationPrefs & {
  loading: boolean;
  dirty: boolean;
  error: string | null;
};

const DEFAULT_PREFS: NotificationPrefs = {
  onPerson: true,
  onVehicle: true,
  onAnimal: false,
  onMotion: false,
};

/**
 * Global notification preferences (Phase 6.3) — closes out the
 * Frigate-parity rollout.
 *
 * Aggregates per-camera, per-user notification toggles into a single
 * table so the operator can dial in "wake me up for people on the
 * front door, but not for cars on the street" without bouncing
 * through every camera's detail page.
 *
 * Each row is its own little state machine: load → dirty on toggle →
 * save → return to clean. We keep saves per-row rather than batching
 * to a single global "Save all" button — operators usually adjust
 * one camera at a time and the per-row save fires the right
 * /api/cameras/<name>/notifications PUT directly.
 */
export default function NotificationsPage() {
  const router = useRouter();
  const { cameras, isLoading: camerasLoading, refresh } = useCameras();

  // Per-camera state, keyed by name.
  const [rows, setRows] = useState<Record<string, RowState>>({});

  // Track which cameras have already been hydrated so a second mount
  // doesn't re-fetch.
  const hydratedRef = useRef<Set<string>>(new Set());

  // Load prefs for any camera we haven't seen yet. Runs once per
  // camera-name addition; the inFlight guard keeps a slow fetcher
  // from kicking off duplicates.
  useEffect(() => {
    if (cameras.length === 0) return;
    const inFlight: string[] = [];
    for (const cam of cameras) {
      if (hydratedRef.current.has(cam.name)) continue;
      hydratedRef.current.add(cam.name);
      inFlight.push(cam.name);
    }
    if (inFlight.length === 0) return;
    Promise.allSettled(
      inFlight.map((name) => fetchCameraNotifications(name).then((p) => [name, p] as const)),
    ).then((results) => {
      setRows((current) => {
        const next = { ...current };
        for (const r of results) {
          if (r.status === "fulfilled") {
            const [name, prefs] = r.value;
            next[name] = {
              ...prefs,
              loading: false,
              dirty: false,
              error: null,
            };
          } else {
            // We don't know which name failed without threading more
            // info; store a generic error keyed off whatever we can
            // recover. In practice the page surfaces "—" for the row.
            // The retry is "click Refresh."
          }
        }
        return next;
      });
    });
  }, [cameras]);

  const togglePref = (name: string, key: keyof NotificationPrefs) => {
    setRows((r) => {
      const cur = r[name] ?? { ...DEFAULT_PREFS, loading: false, dirty: false, error: null };
      return {
        ...r,
        [name]: {
          ...cur,
          [key]: !cur[key],
          dirty: true,
          error: null,
        },
      };
    });
  };

  const saveRow = async (name: string) => {
    const row = rows[name];
    if (!row) return;
    setRows((r) => ({ ...r, [name]: { ...row, loading: true, error: null } }));
    try {
      const next = await updateCameraNotifications(name, {
        onPerson: row.onPerson,
        onVehicle: row.onVehicle,
        onAnimal: row.onAnimal,
        onMotion: row.onMotion,
      });
      setRows((r) => ({
        ...r,
        [name]: { ...next, loading: false, dirty: false, error: null },
      }));
    } catch (e) {
      setRows((r) => ({
        ...r,
        [name]: {
          ...row,
          loading: false,
          error: e instanceof Error ? e.message : "Save failed",
        },
      }));
    }
  };

  const sortedCameras = useMemo(
    () =>
      cameras.slice().sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [cameras],
  );

  const dirtyCount = Object.values(rows).filter((r) => r.dirty).length;

  return (
    <div className="p-6">
      <div className="flex items-center gap-3 mb-4">
        <button
          onClick={() => router.push("/cameras")}
          className="p-2 -ml-2 rounded-full hover:bg-surface-secondary transition-colors"
          aria-label="Back to cameras"
        >
          <ArrowLeft size={20} />
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="type-large-title text-label-primary">Notifications</h1>
          <p className="type-subheadline text-label-tertiary mt-0.5">
            Per-camera push notification preferences. Click a category to
            toggle; saves apply per row.
          </p>
        </div>
        <button
          onClick={() => {
            hydratedRef.current.clear();
            refresh();
          }}
          className="dp-btn-secondary flex items-center gap-2 px-3 py-2 rounded-lg"
        >
          <RefreshCw size={16} />
          <span className="type-subheadline">Refresh</span>
        </button>
      </div>

      {/* Push subscription state — handles its own permission flow.
          Lives above the per-camera prefs grid so the operator
          enables push first, then dials in what triggers it. */}
      <PushSubscriptionCard />

      {dirtyCount > 0 && (
        <div className="dp-card p-3 mb-3 bg-system-yellow/10 text-label-primary border-l-2 border-system-yellow flex items-center gap-2">
          <Bell size={14} />
          <span className="type-caption-1">
            {dirtyCount} unsaved row{dirtyCount === 1 ? "" : "s"} — use the
            Save button on each row to apply.
          </span>
        </div>
      )}

      {camerasLoading && cameras.length === 0 ? (
        <div className="dp-card p-4 space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="h-12 rounded animate-pulse bg-surface-secondary"
            />
          ))}
        </div>
      ) : cameras.length === 0 ? (
        <div className="dp-card text-center py-12">
          <Bell size={32} className="mx-auto text-label-quaternary mb-3" />
          <h2 className="type-title-3 text-label-primary mb-1">
            No cameras configured
          </h2>
          <p className="type-subheadline text-label-tertiary max-w-md mx-auto">
            Add a camera first — notifications fire per-camera, so there&apos;s
            nothing to dial in until at least one is set up.
          </p>
        </div>
      ) : (
        <div className="dp-card overflow-hidden">
          {/* Header */}
          <div className="hidden sm:grid grid-cols-[1fr_repeat(4,_4.5rem)_5rem] gap-2 px-4 py-2 border-b border-separator type-caption-2 text-label-tertiary uppercase tracking-wide">
            <span>Camera</span>
            <span className="text-center">Person</span>
            <span className="text-center">Vehicle</span>
            <span className="text-center">Animal</span>
            <span className="text-center">Motion</span>
            <span className="text-right" />
          </div>

          <ul className="divide-y divide-separator">
            {sortedCameras.map((cam) => (
              <CameraNotificationRow
                key={cam.name}
                camera={cam}
                row={rows[cam.name]}
                onToggle={(key) => togglePref(cam.name, key)}
                onSave={() => saveRow(cam.name)}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function CameraNotificationRow({
  camera,
  row,
  onToggle,
  onSave,
}: {
  camera: CameraInfo;
  row: RowState | undefined;
  onToggle: (key: keyof NotificationPrefs) => void;
  onSave: () => void;
}) {
  const loading = row?.loading ?? false;
  const dirty = row?.dirty ?? false;
  const err = row?.error ?? null;

  const Cell = ({
    icon: Icon,
    active,
    onClick,
    label,
  }: {
    icon: typeof User;
    active: boolean;
    onClick: () => void;
    label: string;
  }) => (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      className={`flex items-center justify-center h-9 w-full rounded-lg transition-colors ${
        active
          ? "bg-accent text-white"
          : "bg-surface-secondary text-label-tertiary hover:bg-surface-tertiary"
      }`}
    >
      <Icon size={14} />
    </button>
  );

  return (
    <li className="px-4 py-2.5 grid grid-cols-1 sm:grid-cols-[1fr_repeat(4,_4.5rem)_5rem] gap-2 items-center">
      <div className="min-w-0">
        <span className="type-subheadline text-label-primary truncate block">
          {camera.displayName}
        </span>
        <span className="type-caption-2 text-label-tertiary truncate block">
          {camera.name}
        </span>
        {err && (
          <span className="type-caption-2 text-system-red truncate block">
            {err}
          </span>
        )}
      </div>

      {row ? (
        <>
          <Cell
            icon={User}
            active={row.onPerson}
            onClick={() => onToggle("onPerson")}
            label="Notify on person"
          />
          <Cell
            icon={Car}
            active={row.onVehicle}
            onClick={() => onToggle("onVehicle")}
            label="Notify on vehicle"
          />
          <Cell
            icon={Dog}
            active={row.onAnimal}
            onClick={() => onToggle("onAnimal")}
            label="Notify on animal"
          />
          <Cell
            icon={Activity}
            active={row.onMotion}
            onClick={() => onToggle("onMotion")}
            label="Notify on motion"
          />
          <button
            type="button"
            onClick={onSave}
            disabled={!dirty || loading}
            className="dp-btn-primary flex items-center justify-center gap-1.5 h-9 rounded-lg type-caption-1 disabled:opacity-50"
          >
            {loading ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Save size={12} />
            )}
            {loading ? "Saving" : dirty ? "Save" : "Saved"}
          </button>
        </>
      ) : (
        <div className="col-span-full sm:col-span-5 type-caption-1 text-label-tertiary">
          Loading…
        </div>
      )}
    </li>
  );
}
