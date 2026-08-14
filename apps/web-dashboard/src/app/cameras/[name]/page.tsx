"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft,
  Circle,
  Film,
  Maximize2,
  Move,
  Pin,
  PinOff,
  Power,
  PowerOff,
  Settings,
  Trash2,
  VideoOff,
} from "lucide-react";
import useSWR from "swr";
import { useCameras } from "@/lib/hooks/useCameras";
import { useCameraPins } from "@/lib/hooks/useCameraPins";
import { fetchPtzCapabilities, getCameraLiveUrl, getCameraSnapshotUrl } from "@/lib/api";
import { authFetch } from "@/lib/auth";
import { PtzOverlay } from "@/components/ptz/PtzOverlay";
import type { CameraInfo, DetectionEvent, PtzCapabilities } from "@/lib/types";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";

const STATUS_COLORS: Record<CameraInfo["status"], string> = {
  recording: "text-system-green",
  detecting: "text-system-orange",
  // WARP-1974: healthy stream, nothing retained. Not green — green here
  // told the household their footage was safe when none was being kept.
  live: "text-system-orange",
  idle: "text-label-quaternary",
  offline: "text-system-red",
};

/**
 * What each state means in words a household member can act on.
 *
 * `live` in particular has to say what to DO. "Live · not saving" states
 * the fact; someone who does not know what a retention window is still
 * needs telling where to fix it.
 */
const STATUS_HELP: Partial<Record<CameraInfo["status"], string>> = {
  live: "This camera is working, but nothing is being saved — there'll be nothing to look back at. Set how long to keep footage in Settings.",
};

/**
 * Single-camera fullscreen view at /cameras/[name].
 *
 * Phase 1.2 of the Frigate-parity rollout. Full-bleed live MJPEG via
 * `/api/cameras/:name/live` (the orchestrator route added in #102), with a
 * snapshot fallback if the live `<img>` errors. Side rail carries the
 * status, the most recent detection events, and the per-camera controls
 * (enable/disable + remove). The `Esc` key takes the operator back to the
 * grid — same key the platform uses for closing modals everywhere else.
 *
 * No external Frigate-UI link by design — Phase-1 of the parity work
 * deliberately keeps the operator inside Droplet's UI for every camera
 * surface (see docs/FRIGATE_PARITY.md).
 */
export default function CameraFullscreenPage() {
  const params = useParams<{ name: string }>();
  const router = useRouter();
  const name = useMemo(
    () => (typeof params?.name === "string" ? decodeURIComponent(params.name) : ""),
    [params],
  );

  const { cameras, isLoading, enableCam, disableCam, removeCam } = useCameras();
  const [removeOpen, setRemoveOpen] = useState(false);
  const { toast } = useToast();
  const camera = cameras.find((c) => c.name === name);

  // PTZ capabilities — fetched once per camera, cheap. Drives whether
  // the "PTZ" button shows up in the toolbar at all.
  const { data: ptzCaps } = useSWR<PtzCapabilities>(
    name ? `/api/cameras/${encodeURIComponent(name)}/ptz` : null,
    () => fetchPtzCapabilities(name),
    { revalidateOnFocus: false },
  );
  const hasPtz =
    !!ptzCaps &&
    (ptzCaps.supportsPanTilt || ptzCaps.supportsZoom || ptzCaps.presets.length > 0);
  const [ptzOpen, setPtzOpen] = useState(false);

  // Pin state for the toolbar toggle. Mirrors the grid affordance so the
  // operator can pin/unpin without backing out to the cards page.
  const { pinnedSet, toggle: togglePin } = useCameraPins();
  const [pinBusy, setPinBusy] = useState(false);
  const isPinned = camera ? pinnedSet.has(camera.name) : false;
  const handleTogglePin = async () => {
    if (!camera || pinBusy) return;
    setPinBusy(true);
    try {
      await togglePin(camera.name);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to update pin", "error");
    } finally {
      setPinBusy(false);
    }
  };

  const performRemove = async () => {
    if (!camera) return;
    try {
      await removeCam(camera.name);
      setRemoveOpen(false);
      router.replace("/cameras");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to remove camera", "error");
      throw e;
    }
  };

  // Per-camera recent events for the side rail. We hit the existing
  // `/api/cameras/:name/events` route instead of the global recent feed so
  // operator focus stays on this camera.
  const { data: events } = useSWR<DetectionEvent[]>(
    name ? `/api/cameras/${encodeURIComponent(name)}/events?limit=8` : null,
    async (url: string) => {
      const res = await authFetch(url);
      if (!res.ok) return [];
      const body = (await res.json()) as { events?: DetectionEvent[] };
      return body.events ?? [];
    },
    { refreshInterval: 15_000 },
  );

  const [liveError, setLiveError] = useState(false);
  // When the operator hits Esc we route back to the grid. Use replace so
  // the back button still goes wherever they came from before the camera
  // page (typically /cameras), not into a dead-end of the same route.
  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") router.replace("/cameras");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  // Reset the fallback flag when the camera name changes — the operator
  // might navigate to a different camera through the URL bar.
  useEffect(() => {
    setLiveError(false);
  }, [name]);

  if (!name) {
    return null;
  }

  if (isLoading && !camera) {
    return (
      <div className="fixed inset-0 bg-black flex items-center justify-center">
        <div className="h-8 w-8 rounded-full border-2 border-label-quaternary border-t-accent animate-spin" />
      </div>
    );
  }

  if (!camera) {
    return (
      <div className="fixed inset-0 bg-black flex flex-col items-center justify-center gap-4 p-6 text-center">
        <VideoOff size={48} className="text-label-quaternary" />
        <h1 className="type-title-2 text-white">Camera not found</h1>
        <p className="type-subheadline text-label-tertiary max-w-md">
          No camera named <span className="font-mono">{name}</span> is registered.
          It may have been removed, or the name in the URL is stale.
        </p>
        <button
          onClick={() => router.replace("/cameras")}
          className="dp-btn-primary flex items-center gap-2 px-4 py-2 rounded-lg"
        >
          <ArrowLeft size={16} />
          Back to cameras
        </button>
      </div>
    );
  }

  const offline = camera.status === "offline";
  const statusHelp = STATUS_HELP[camera.status];

  return (
    <div className="fixed inset-0 z-40 bg-black flex flex-col">
      {/* Top bar — back, title, status, primary actions */}
      <header className="flex items-center justify-between px-4 sm:px-6 h-14 border-b border-white/10 bg-black/80 backdrop-blur-md">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <button
            onClick={() => router.replace("/cameras")}
            className="p-2 -ml-2 rounded-full hover:bg-white/10 transition-colors text-white"
            aria-label="Back to cameras"
          >
            <ArrowLeft size={20} />
          </button>
          <div className="min-w-0">
            <h1 className="type-headline text-white truncate">{camera.displayName}</h1>
            <div className="flex items-center gap-2 mt-0.5">
              <Circle
                size={8}
                className={`${STATUS_COLORS[camera.status]} fill-current ${
                  camera.status === "detecting" ? "animate-pulse" : ""
                }`}
              />
              <span className="type-caption-1 text-white/70 capitalize">
                {camera.status === "live" ? "Live · not saving" : camera.status}
              </span>
              {camera.manufacturer && (
                <>
                  <span className="text-white/40">·</span>
                  <span className="type-caption-1 text-white/70">
                    {camera.manufacturer} {camera.model || ""}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {camera.enabled ? (
            <button
              onClick={() => disableCam(camera.name)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-white/90 hover:bg-white/10 transition-colors"
            >
              <PowerOff size={16} />
              <span className="type-subheadline hidden sm:inline">Disable</span>
            </button>
          ) : (
            <button
              onClick={() => enableCam(camera.name)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-accent text-white hover:bg-accent/90 transition-colors"
            >
              <Power size={16} />
              <span className="type-subheadline hidden sm:inline">Enable</span>
            </button>
          )}
          {hasPtz && (
            <button
              onClick={() => setPtzOpen((o) => !o)}
              aria-pressed={ptzOpen}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg transition-colors ${
                ptzOpen
                  ? "bg-accent/15 text-accent"
                  : "text-white/90 hover:bg-white/10"
              }`}
              title="Pan / tilt / zoom controls"
            >
              <Move size={16} />
              <span className="type-subheadline hidden sm:inline">PTZ</span>
            </button>
          )}
          <button
            onClick={() => router.push(`/cameras/${encodeURIComponent(camera.name)}/recordings`)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-white/90 hover:bg-white/10 transition-colors"
            title="Browse recordings + timeline"
          >
            <Film size={16} />
            <span className="type-subheadline hidden sm:inline">Recordings</span>
          </button>
          <button
            onClick={() => router.push(`/cameras/${encodeURIComponent(camera.name)}/settings`)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-white/90 hover:bg-white/10 transition-colors"
            title="Detection, recording, and zone settings"
          >
            <Settings size={16} />
            <span className="type-subheadline hidden sm:inline">Settings</span>
          </button>
          <button
            onClick={handleTogglePin}
            disabled={pinBusy}
            aria-pressed={isPinned}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg transition-colors ${
              isPinned
                ? "bg-accent/15 text-accent hover:bg-accent/25"
                : "text-white/90 hover:bg-white/10"
            } ${pinBusy ? "opacity-50 cursor-wait" : ""}`}
            title={isPinned ? "Unpin from grid" : "Pin to top of grid"}
          >
            {isPinned ? (
              <Pin size={16} className="fill-current" />
            ) : (
              <PinOff size={16} />
            )}
            <span className="type-subheadline hidden sm:inline">
              {isPinned ? "Pinned" : "Pin"}
            </span>
          </button>
          <button
            onClick={async () => {
              try {
                const el = document.getElementById("camera-feed");
                if (el && document.fullscreenElement !== el) {
                  await el.requestFullscreen();
                } else if (document.fullscreenElement) {
                  await document.exitFullscreen();
                }
              } catch {
                /* fullscreen API unavailable — silent no-op */
              }
            }}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-white/90 hover:bg-white/10 transition-colors"
            title="Toggle browser fullscreen"
            aria-label="Toggle fullscreen"
          >
            <Maximize2 size={16} aria-hidden="true" />
          </button>
          <button
            onClick={() => setRemoveOpen(true)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-system-red hover:bg-system-red/15 transition-colors"
            title="Remove camera"
            aria-label={`Remove camera ${camera.displayName}`}
          >
            <Trash2 size={16} />
          </button>
        </div>
      </header>

      {/* WARP-1974 — the state that used to read as a green "Recording".
          Saying "not saving" is the fact; a household member also needs
          telling what to do about it. */}
      {statusHelp && (
        <div
          data-testid="status-help"
          className="flex items-start gap-2 px-4 sm:px-6 py-2 bg-system-orange/15 border-b border-system-orange/30"
        >
          <Circle size={8} className="text-system-orange fill-current mt-1.5 shrink-0" />
          <p className="type-caption-1 text-white/80">{statusHelp}</p>
        </div>
      )}

      <ConfirmDialog
        open={removeOpen}
        onConfirm={performRemove}
        onCancel={() => setRemoveOpen(false)}
        title={`Remove camera "${camera.displayName}"?`}
        description="The camera stops recording and is removed from the dashboard. Existing clips and events are kept until they expire normally."
        confirmLabel="Remove"
        variant="destructive"
      />

      {/* Main: feed + side rail */}
      <div className="flex-1 flex flex-col lg:flex-row min-h-0">
        {/* Feed — full-bleed MJPEG. We render the snapshot fallback as a
            sibling layered behind the live <img>; the moment the live
            stream errors, liveError flips and the snapshot becomes
            visible without a flash of black. */}
        <div
          id="camera-feed"
          className="relative flex-1 bg-black flex items-center justify-center min-h-0"
        >
          {offline ? (
            <div className="flex flex-col items-center gap-3 p-6 text-center">
              <VideoOff size={56} className="text-label-quaternary" />
              <p className="type-subheadline text-label-tertiary">Camera offline</p>
            </div>
          ) : !liveError ? (
            <img
              src={getCameraLiveUrl(camera.name)}
              alt={`${camera.displayName} live feed`}
              className="max-w-full max-h-full object-contain"
              onError={() => setLiveError(true)}
            />
          ) : (
            <img
              src={`${getCameraSnapshotUrl(camera.name)}?t=${Math.floor(Date.now() / 5000)}`}
              alt={`${camera.displayName} latest frame`}
              className="max-w-full max-h-full object-contain"
            />
          )}

          {!offline && !liveError && (
            <div className="absolute top-3 left-3 flex items-center gap-1.5 px-2 py-1 rounded-full bg-system-red/90 backdrop-blur-sm">
              <Circle
                size={8}
                className="text-white fill-current animate-pulse"
              />
              <span className="type-caption-2 text-white font-medium tracking-wide">
                LIVE
              </span>
            </div>
          )}

          {/* PTZ overlay floats over the feed. Mounted on demand so a
              non-PTZ camera doesn't pay for the network probe. */}
          {ptzOpen && hasPtz && ptzCaps && (
            <PtzOverlay
              cameraName={camera.name}
              caps={ptzCaps}
              onClose={() => setPtzOpen(false)}
            />
          )}
        </div>

        {/* Side rail — recent events + camera metadata. Stacks below the
            feed on small screens. */}
        <aside className="w-full lg:w-80 lg:border-l border-t lg:border-t-0 border-white/10 bg-black/40 overflow-y-auto">
          <div className="p-4 space-y-4">
            <div>
              <h2 className="type-caption-1 text-white/60 uppercase tracking-wide mb-2">
                Recent events
              </h2>
              {events && events.length > 0 ? (
                <ul className="space-y-2">
                  {events.map((ev) => (
                    <li
                      key={ev.id}
                      className="flex items-start gap-3 p-2 rounded-lg hover:bg-white/5 transition-colors"
                    >
                      {ev.thumbnail ? (
                        <img
                          src={ev.thumbnail}
                          alt={ev.label}
                          className="w-16 h-12 rounded object-cover flex-shrink-0 bg-surface-secondary"
                        />
                      ) : (
                        <div className="w-16 h-12 rounded bg-surface-secondary flex-shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="type-footnote text-white capitalize truncate">
                          {ev.label}
                        </p>
                        <p className="type-caption-2 text-white/60">
                          {new Date(ev.startTime * 1000).toLocaleString()}
                        </p>
                      </div>
                      <span className="type-caption-2 text-white/60 flex-shrink-0">
                        {Math.round(ev.score * 100)}%
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="type-footnote text-white/40">
                  No events recorded yet on this camera.
                </p>
              )}
            </div>

            <div className="pt-4 border-t border-white/10 space-y-2">
              <h2 className="type-caption-1 text-white/60 uppercase tracking-wide">
                Details
              </h2>
              <DetailRow label="IP" value={camera.ipAddress || "Unknown"} mono />
              <DetailRow label="MAC" value={camera.macAddress || "Unknown"} mono />
              <DetailRow
                label="Last seen"
                value={new Date(camera.lastSeen).toLocaleString()}
              />
              <DetailRow
                label="Discovery"
                value={camera.autoDiscovered ? "Auto-discovered" : "Manual"}
              />
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function DetailRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="type-caption-2 text-white/60 flex-shrink-0">{label}</span>
      <span
        className={`type-footnote text-white truncate ${mono ? "font-mono" : ""}`}
      >
        {value}
      </span>
    </div>
  );
}
