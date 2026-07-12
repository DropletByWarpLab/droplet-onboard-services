"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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

/** WARP-933 — how often to re-probe discovered cameras while the customer is on
 *  this step, so a camera plugged in mid-step appears live. Bounded by React
 *  cleanup; never a while-true. */
const CAMERA_POLL_INTERVAL_MS = 10_000;

/** WARP-1282 — the banner distinguishes WHERE the error came from so its
 *  "Try again" control (which re-runs `load()`) only renders for load
 *  failures; accept/remove failures direct the customer to the Cameras page
 *  instead, and a load-retry button beneath that copy would be incoherent. */
type StepError = { kind: "load" | "action"; message: string };

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
 *
 * WARP-1282 — a transient backend outage during `load()` used to strand
 * the step: the 10 s poll refreshed the *discovered* list once the backend
 * came back but never re-ran the full load, so `existing` stayed
 * empty/stale and the WARP-861 remove affordance silently vanished. The
 * poll now re-runs the FULL `load()` while the last load is marked
 * incomplete, and the error banner carries an explicit "Try again" button.
 */
export function CamerasStep({
  onComplete,
  onSkip,
}: {
  onComplete: (acceptedCount: number) => void;
  onSkip: () => void;
  /** WARP-933 — deprecated/no-op: the step no longer auto-skips when no
   *  cameras are found (it renders + keeps discovery live instead). Kept in the
   *  prop type so the page's existing pass stays valid; ignored at runtime. */
  onAutoSkip?: () => void;
}) {
  const [cameras, setCameras] = useState<DiscoveredCamera[]>([]);
  const [existing, setExisting] = useState<CameraInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<StepError | null>(null);
  // WARP-1282 — true while the last `load()` didn't fully complete (discovery
  // unreachable, or the existing-cameras read failed). Tells the 10 s poll to
  // re-run the FULL load instead of the light discovered-only refresh. A ref
  // (not state) so the interval callback (armed once) sees the current value;
  // the banner's "Try again" button gates on `error.kind` instead.
  const loadFailedRef = useRef(false);
  // WARP-1282 review — load-generation counter. Each load() claims a
  // generation at start and discards its results at apply time if a newer
  // load started meanwhile (Try-again racing a poll tick: last-started wins,
  // stale can't overwrite fresh) or if local state became authoritative
  // (Remove / accept-all bump the counter, so an in-flight fetchCameras
  // snapshot taken BEFORE the mutation can't resurrect a deleted row).
  const loadGenRef = useRef(0);
  const [retrying, setRetrying] = useState(false);
  // WARP-933 review — `alive` guards async setState after the customer advances
  // (the step unmounts while a fetch is still in flight); `savingRef` lets the
  // discovery poll pause while an accept-all is mid-flight, so a poll tick can't
  // blank the discovered cards out from under the save.
  const alive = useRef(true);
  const savingRef = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const gen = ++loadGenRef.current;
    try {
      // The cameras list rides along but must not block the step —
      // discovery is the primary signal. A cameras-list failure stays silent
      // here (just tracked): the banner decision is made ONCE per load, after
      // both fetches settle, so the role="alert" region gets at most one
      // content change per load and nothing fires ahead of the apply-time
      // guards below (an early setError would announce twice per poll tick
      // during a full outage, flicker every 10 s in the designed-silent
      // partial mode, and could pop a load banner mid-accept-all).
      let all: CameraInfo[];
      let camerasListFailed = false;
      try {
        all = await fetchCameras();
      } catch {
        camerasListFailed = true;
        all = [];
      }
      const list = await fetchDiscoveredCameras();
      // GET /cameras includes pending discovered rows (enabled=false) —
      // filter to enabled so they don't duplicate the discovered cards.
      const enabled = all.filter((c) => c.enabled);
      // WARP-1282 — same guard as the poll: never apply results after unmount
      // or under an in-flight accept-all (load() is now re-entered from the
      // poll and the Try-again button, not just mount); a stale generation
      // means a newer load or a local mutation superseded this snapshot.
      if (!alive.current || savingRef.current || gen !== loadGenRef.current)
        return;
      // The one banner decision per load: discovery reachable → no banner.
      setError(null);
      setCameras(list);
      if (camerasListFailed) {
        // WARP-1282 — the existing-cameras read failed: keep whatever we last
        // knew instead of blanking the "Already set up" section, and leave
        // the load marked incomplete so the 10 s poll re-runs the FULL load
        // until fetchCameras succeeds again.
        loadFailedRef.current = true;
      } else {
        setExisting(enabled);
        loadFailedRef.current = false;
      }
      // WARP-933 — do NOT auto-skip when nothing's found yet. The step stays
      // visible (with an explicit "looking for cameras" state) and keeps
      // polling (below), so a camera plugged in DURING this step shows up live
      // instead of the page silently jumping past it.
    } catch {
      if (!alive.current || savingRef.current || gen !== loadGenRef.current)
        return;
      // Discovery service unreachable — surface it with a retry rather than
      // silently skipping, which read to customers as "the page doesn't work".
      // The button carries the "try again" verb, so the copy stays short.
      setError({ kind: "load", message: "Couldn't check for cameras right now." });
      loadFailedRef.current = true;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // WARP-933 — keep discovery LIVE while the customer is on this step, so a
  // camera powered on / plugged in mid-step appears without a manual refresh.
  // Bounded by React cleanup (cleared on unmount). camera-discovery runs a ~30s
  // ONVIF/RTSP probe loop server-side; a 10s client poll surfaces new finds
  // promptly. A transient poll failure is ignored — the next tick retries.
  useEffect(() => {
    const timer = setInterval(() => {
      // Don't overwrite the cards while an accept-all is in flight (a tick
      // returning [] mid-save would blank them out under the save).
      if (savingRef.current) return;
      // WARP-1282 — the last full load didn't complete (backend outage while
      // this step was loading): the light discovered-only refresh below would
      // leave `existing` empty/stale for the rest of the step. Re-run the
      // FULL load instead — the first successful tick repopulates both lists
      // and clears the error.
      if (loadFailedRef.current) {
        void load();
        return;
      }
      void fetchDiscoveredCameras()
        .then((list) => {
          if (alive.current && !savingRef.current) {
            setError(null);
            setCameras(list);
          }
        })
        .catch(() => {});
    }, CAMERA_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);

  // WARP-1282 — explicit recovery control on the error banner. Respects the
  // same guards as the poll: never refetch under an in-flight accept-all, and
  // don't stack retries.
  async function handleTryAgain() {
    if (savingRef.current || retrying) return;
    setRetrying(true);
    try {
      await load();
    } finally {
      if (alive.current) setRetrying(false);
    }
  }

  async function handleAcceptAll() {
    setError(null);
    setSaving(true);
    savingRef.current = true;
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
        setError({
          kind: "action",
          message:
            "Couldn't add the cameras just now. Try again from the Cameras page.",
        });
        setSaving(false);
        return;
      }
      onComplete(accepted);
    } catch (e) {
      setError({
        kind: "action",
        message: e instanceof Error ? e.message : "Save failed. Try again.",
      });
      setSaving(false);
    } finally {
      // Resume the discovery poll regardless of outcome (success unmounts; the
      // accepted===0 / catch paths stay on the step). Any accepts that landed
      // changed server rows out from under a load that was already in flight
      // when the save began (its apply-time savingRef check runs AFTER this
      // reset) — bump the generation so that snapshot discards.
      savingRef.current = false;
      loadGenRef.current++;
    }
  }

  async function handleRemove(cam: CameraInfo) {
    setError(null);
    setRemoving(cam.name);
    try {
      await removeCamera(cam.name);
      // getCameras is server-cached — trust the delete and update local
      // state instead of refetching into a stale read. Local state is now
      // authoritative: invalidate any in-flight load whose fetchCameras
      // snapshot predates the delete, or it would resurrect this row.
      loadGenRef.current++;
      setExisting((prev) => prev.filter((c) => c.name !== cam.name));
    } catch {
      setError({
        kind: "action",
        message: "Couldn't remove that camera. Try again from the Cameras page.",
      });
    } finally {
      setRemoving(null);
    }
  }

  // Initial load — show a skeleton. WARP-933 review: also offer "Skip for now"
  // so a hung discovery bridge (load never resolves) isn't a dead-end with only
  // Back as an escape.
  if (loading && cameras.length === 0 && existing.length === 0) {
    return (
      <StepShell
        current="cameras"
        title="Set up your cameras"
        subtitle="One moment…"
        skip={{ label: "Skip for now", onClick: onSkip }}
      >
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
          : existing.length > 0
            ? `${existing.length} camera${existing.length !== 1 ? "s are" : " is"} still set up from a previous run.`
            : "We're watching your network for cameras — plug one in and it'll appear here."
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
              // No discovered cameras → nothing to accept, so `saving` (set only
              // by handleAcceptAll) can never be true here. Plain Continue.
              label: "Continue",
              onClick: () => onComplete(0),
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

        {/* WARP-933 — explicit, visible empty state (was a silent auto-skip).
            Discovery keeps polling, so a camera plugged in now appears here. */}
        {!hasDiscovered && existing.length === 0 && (
          <div className="dp-card !py-6 flex flex-col items-center gap-2 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-accent/10">
              <Video size={20} className="text-accent" />
            </div>
            <p className="type-subheadline text-label-primary">No cameras yet</p>
            <p className="type-caption-1 text-label-tertiary max-w-xs">
              Connect an IP camera to your network and it&rsquo;ll show up here
              automatically. You can also add cameras later from the Cameras
              page.
            </p>
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="flex items-start gap-2 type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2 mt-3"
          >
            <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
            <div className="flex flex-1 flex-col items-start gap-2">
              <span>{error.message}</span>
              {/* WARP-1282 — an explicit recovery control. dp-btn-secondary
                  carries the 44px min tap target; the focus ring follows the
                  CoverageExtendersPanel precedent (the token ships none).
                  Load failures only — accept/remove errors direct the
                  customer to the Cameras page, which this button doesn't
                  serve. */}
              {error.kind === "load" && (
                <button
                  type="button"
                  onClick={handleTryAgain}
                  disabled={retrying || saving}
                  className="dp-btn-secondary type-footnote !px-3 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  {retrying ? "Checking…" : "Try again"}
                </button>
              )}
            </div>
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
