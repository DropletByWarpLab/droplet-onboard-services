"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Video, X } from "lucide-react";
import {
  fetchDiscoveredCameras,
  acceptDiscoveredCamera,
  fetchCameras,
  removeCamera,
} from "@/lib/api";
import type { CameraInfo, DiscoveredCamera } from "@/lib/types";
import { StepShell } from "@/components/setup/StepShell";
import { LearnMoreCard } from "@/components/setup/LearnMoreCard";

/**
 * Wizard step — pick up any IP cameras the box discovered.
 *
 * The camera-discovery service runs ONVIF + RTSP probes on a 30 s loop
 * (see `services/camera-discovery/`); each found camera lands in the
 * orchestrator's `Camera` table with `autoDiscovered=true, enabled=false`
 * until the customer accepts it. The wizard's job here is to surface
 * those pending entries in one screen and accept them as a batch.
 *
 * WARP-861 — re-running setup without a factory reset leaves cameras
 * accepted in a previous run (`enabled=true`) live in Frigate, invisible
 * to this step's discovered-only view. Those now render in an "Already
 * set up" section with a per-camera Remove, so a stale camera from an
 * old install can be cleared without leaving the wizard.
 *
 * Auto-skip when there's NOTHING to show — no pending discoveries AND
 * no existing cameras — matches the Storage step's behaviour and avoids
 * making the customer click "Skip" on an empty page. The Cameras page
 * on the main dashboard surfaces its own discovery banner for cameras
 * that show up post-setup; it also owns renaming, credentials, and the
 * Network Isolation (VLAN 100) toggle. We don't surface those advanced
 * controls in the wizard — they belong in the dashboard's
 * progressive-disclosure "Advanced" tier (ADR-002 §"Information
 * architecture").
 *
 * Skipping leaves the pending entries in place; the customer sees them
 * in the Cameras page's discovery banner whenever they next visit.
 */
export function CamerasStep({
  onComplete,
  onSkip,
  onAutoSkip,
}: {
  onComplete: (acceptedCount: number) => void;
  onSkip: () => void;
  /** Invoked when the step skips ITSELF on mount (no cameras found / service
   *  off) — distinct from the user tapping "Skip for now" (onSkip). Lets the
   *  wizard advance WITHOUT recording the step in Back history. Falls back to
   *  onSkip when not provided (older callers/tests). */
  onAutoSkip?: () => void;
}) {
  const [cameras, setCameras] = useState<DiscoveredCamera[]>([]);
  const [existing, setExisting] = useState<CameraInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      // The cameras list rides along but must not block the step —
      // discovery is the primary signal, so its failure (service off in
      // dev) still skips, while a cameras-list hiccup just hides the
      // "Already set up" section.
      const [list, all] = await Promise.all([
        fetchDiscoveredCameras(),
        fetchCameras().catch(() => [] as CameraInfo[]),
      ]);
      // GET /cameras includes pending discovered rows (enabled=false) —
      // filter to enabled so they don't duplicate the discovered cards.
      const enabled = all.filter((c) => c.enabled);
      setCameras(list);
      setExisting(enabled);
      if (list.length === 0 && enabled.length === 0) {
        (onAutoSkip ?? onSkip)();
      }
    } catch {
      // camera-discovery service might be off in dev; treat as "no
      // cameras" and skip silently. Customer can add cameras manually
      // from the Cameras page later.
      (onAutoSkip ?? onSkip)();
    } finally {
      setLoading(false);
    }
  }, [onSkip, onAutoSkip]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleAcceptAll() {
    setError(null);
    setSaving(true);
    try {
      // Per-camera accept — one failure doesn't drop the others. If at
      // least one succeeds the wizard advances; the rest stay pending
      // and the customer can retry from /cameras.
      const results = await Promise.allSettled(
        cameras.map((c) => acceptDiscoveredCamera(c.id)),
      );
      const failed = results.filter((r) => r.status === "rejected");
      const accepted = results.length - failed.length;
      if (accepted === 0) {
        setError(
          "Couldn't add the cameras just now. Try again from the Cameras page.",
        );
        setSaving(false);
        return;
      }
      onComplete(accepted);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed. Try again.");
      setSaving(false);
    }
  }

  async function handleRemove(cam: CameraInfo) {
    setError(null);
    setRemoving(cam.name);
    try {
      await removeCamera(cam.name);
      // getCameras is server-cached — trust the delete and update local
      // state instead of refetching into a stale read.
      setExisting((prev) => prev.filter((c) => c.name !== cam.name));
    } catch {
      setError("Couldn't remove that camera. Try again from the Cameras page.");
    } finally {
      setRemoving(null);
    }
  }

  // Auto-skip path may have fired during load — show a tiny placeholder
  // so we don't briefly flash an empty page before the unmount.
  if (loading && cameras.length === 0 && existing.length === 0) {
    return (
      <StepShell current="cameras" title="Set up your cameras" subtitle="One moment…">
        <div className="space-y-2">
          {[0, 1].map((i) => (
            <div
              key={i}
              className="dp-card !py-3 flex items-center gap-3 opacity-30"
            >
              <div className="w-9 h-9 rounded-lg bg-surface-secondary animate-pulse" />
              <div className="flex-1 space-y-1.5">
                <div className="h-3 w-32 bg-surface-secondary rounded animate-pulse" />
                <div className="h-2.5 w-20 bg-surface-secondary rounded animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      </StepShell>
    );
  }

  const hasDiscovered = cameras.length > 0;

  return (
    <StepShell current="cameras"
      title="Set up your cameras"
      subtitle={
        hasDiscovered
          ? `We found ${cameras.length} camera${cameras.length !== 1 ? "s" : ""} on your network.`
          : `${existing.length} camera${existing.length !== 1 ? "s are" : " is"} still set up from a previous run.`
      }
      primary={
        hasDiscovered
          ? {
              label:
                cameras.length === 1 ? "Add this camera" : "Add these cameras",
              loadingLabel: "Adding…",
              onClick: handleAcceptAll,
              isLoading: saving,
            }
          : {
              label: "Continue",
              onClick: () => onComplete(0),
              isLoading: saving,
            }
      }
      skip={{ label: "Skip for now", onClick: onSkip }}
    >
      <div className="space-y-2">
        {cameras.map((cam) => (
          <div key={cam.id} className="dp-card !py-3 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-accent/10 flex items-center justify-center flex-shrink-0">
              <Video size={18} className="text-accent" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="type-subheadline text-label-primary truncate">
                {describeCamera(cam)}
              </p>
              <p className="type-caption-1 text-label-tertiary">{cam.ip}</p>
            </div>
            <div
              className="w-2 h-2 rounded-full bg-system-green flex-shrink-0"
              aria-label="Discovered"
            />
          </div>
        ))}

        {existing.length > 0 && (
          <>
            <p className="type-footnote text-label-secondary mt-4">
              Already set up{hasDiscovered ? "" : " from a previous run"} —
              remove any you no longer use
            </p>
            {existing.map((cam) => (
              <div key={cam.name} className="dp-card !py-3 flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-accent/10 flex items-center justify-center flex-shrink-0">
                  <Video size={18} className="text-accent" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="type-subheadline text-label-primary truncate">
                    {cam.displayName || cam.name}
                  </p>
                  <p className="type-caption-1 text-label-tertiary">
                    {cam.ipAddress}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleRemove(cam)}
                  disabled={removing === cam.name}
                  aria-label={`Remove ${cam.displayName || cam.name}`}
                  className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-label-tertiary transition-colors duration-200 ease-smooth hover:bg-surface-tertiary hover:text-label-secondary disabled:opacity-50"
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </>
        )}

        {error && (
          <div className="flex items-start gap-2 type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2 mt-3">
            <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </div>

      <LearnMoreCard helpAnchor="cameras">
        <p>
          Your cameras record straight to this Droplet — never to the
          cloud. You can review footage, set up motion alerts, and rename
          cameras anytime from the Cameras page.
        </p>
        <p>
          Want your cameras on their own private network so other devices
          on your Wi-Fi can&rsquo;t see them? Turn on Network Isolation
          from the Cameras page when you&rsquo;re ready.
        </p>
      </LearnMoreCard>
    </StepShell>
  );
}

function describeCamera(cam: DiscoveredCamera): string {
  // Prefer a recognisable manufacturer/model line; fall back to the
  // auto-generated name (typically `<manufacturer>-<lastoctet>`).
  if (cam.manufacturer && cam.model) {
    return `${cam.manufacturer} ${cam.model}`;
  }
  if (cam.manufacturer) return cam.manufacturer;
  return cam.name || cam.ip;
}
