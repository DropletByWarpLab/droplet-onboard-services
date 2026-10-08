"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft,
  Activity,
  ChevronDown,
  CirclePlay,
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
import { fetchMotionActivity, fetchPtzCapabilities, getCameraLiveUrl, getCameraSnapshotUrl } from "@/lib/api";
import { authFetch, useAuth } from "@/lib/auth";
import { PtzOverlay } from "@/components/ptz/PtzOverlay";
import { CameraRecordingSummary } from "@/components/cameras/CameraRecordingSummary";
import { CameraServiceNotice } from "@/components/cameras/CameraServiceNotice";
import { RetentionFixButton } from "@/components/cameras/RetentionFixButton";
import { SafetyChip } from "@/components/integrations/SafetyChip";
import { isRecordingDegraded, statusLabel } from "@/lib/camera-recording";
import { isCamerasUnavailableError } from "@/lib/files-unavailable";
import type { CameraInfo, DetectionEvent, MotionActivityResult, PtzCapabilities } from "@/lib/types";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { CameraPlaybackPanel, type CameraPlaybackSelection } from "@/components/cameras/CameraPlaybackPanel";
import { ThumbImage } from "@/components/events/ThumbImage";
import { EventClipModal } from "@/components/events/EventClipModal";
import { cameraDetectionDetail } from "@/lib/camera-detection";

const STATUS_COLORS: Record<CameraInfo["status"], string> = {
  recording: "text-system-green",
  // WARP-3511: blue (info). It shared orange with "not saving", so a camera
  // that was working and one keeping nothing looked the same.
  detecting: "text-system-blue",
  // WARP-1974: healthy stream, nothing retained. Not green — green here
  // told the household their footage was safe when none was being kept.
  live: "text-system-orange",
  idle: "text-label-quaternary",
  offline: "text-system-red",
};

/**
 * Single-camera fullscreen view at /cameras/[name].
 *
 * Live MJPEG with inline archive playback and a persistent recording
 * timeline. Detection and motion rows open their associated HLS clip in
 * the main viewer; Escape returns playback to live before leaving the page.
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

  const { cameras, isLoading, refresh, enableCam, disableCam, removeCam } = useCameras();
  const [removeOpen, setRemoveOpen] = useState(false);
  const [playbackSelection, setPlaybackSelection] = useState<CameraPlaybackSelection | null>(null);
  const [eventDetails, setEventDetails] = useState<DetectionEvent | null>(null);
  const [activeItem, setActiveItem] = useState<string | null>(null);
  const [cameraPlaybackActive, setCameraPlaybackActive] = useState(false);
  const [liveRequest, setLiveRequest] = useState(0);
  const [eventFilter, setEventFilter] = useState<"All" | "Detections" | "Motion">("All");
  // WARP-3511: enabling / disabling is a settings write that restarts the
  // camera service, so it is confirmed first and its failures are said.
  const [toggle, setToggle] = useState<"enable" | "disable" | null>(null);
  const { toast } = useToast();
  const { user } = useAuth();
  // WARP-3104: turning detection on or off, PTZ, settings and removing the
  // camera are owner/admin; the box refuses members.
  const canManage = user?.role === "owner" || user?.role === "admin";
  const camera = cameras.find((c) => c.name === name);

  // PTZ capabilities — fetched once per camera, cheap. Drives whether
  // the "PTZ" button shows up in the toolbar at all.
  // WARP-3511: a camera with no PTZ is the normal case (adoption writes no
  // `onvif:` block), and it used to be retried forever. Never retry on error;
  // ask again only while the answer was "unknown" (the service was down).
  const { data: ptzCaps } = useSWR<PtzCapabilities>(
    name ? `/api/cameras/${encodeURIComponent(name)}/ptz` : null,
    () => fetchPtzCapabilities(name),
    {
      revalidateOnFocus: false,
      shouldRetryOnError: false,
      refreshInterval: (latest) => (latest?.degraded ? 10_000 : 0),
    },
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

  const performToggle = async () => {
    if (!camera || !toggle) return;
    try {
      if (toggle === "disable") await disableCam(camera.name);
      else await enableCam(camera.name);
      toast(
        toggle === "disable"
          ? `${camera.displayName} is disabled.`
          : `${camera.displayName} is enabled.`,
        "success",
      );
    } catch (e) {
      toast(
        isCamerasUnavailableError(e)
          ? "The camera service isn't responding. Try again in a moment."
          : e instanceof Error && e.message
            ? e.message
            : "Couldn't change this camera.",
        "error",
      );
      // ConfirmDialog keeps itself open when this rejects, so it can be retried.
      throw e;
    }
  };

  // Per-camera recent events for the side rail. We hit the existing
  // `/api/cameras/:name/events` route instead of the global recent feed so
  // operator focus stays on this camera.
  const { data: events, error: eventsError, isLoading: eventsLoading, mutate: refreshEvents } = useSWR<DetectionEvent[]>(
    name ? `/api/cameras/${encodeURIComponent(name)}/events?limit=8` : null,
    async (url: string) => {
      const res = await authFetch(url);
      if (!res.ok || res.headers?.get("X-Droplet-Degraded")) {
        throw new Error("Recent detections are unavailable. Try again in a moment.");
      }
      const body = (await res.json()) as { events?: DetectionEvent[] };
      return body.events ?? [];
    },
    { refreshInterval: 15_000 },
  );

  const { data: motion, error: motionError, isLoading: motionLoading, mutate: refreshMotion } = useSWR<MotionActivityResult>(
    name ? ["camera-recent-motion", name] : null,
    () => {
      const before = Math.floor(Date.now() / 1000);
      return fetchMotionActivity({ cameras: [name], after: before - 24 * 3600, before, limit: 8 });
    },
    { refreshInterval: 15_000, revalidateOnFocus: false },
  );
  const recentItems: Array<CameraPlaybackSelection & { key: string; startTime: number }> = [
    ...(eventFilter === "Motion" ? [] : (events ?? []).map((event) => ({ kind: "event" as const, event, key: `event:${event.id}`, startTime: event.startTime }))),
    ...(eventFilter === "Detections" ? [] : (motion?.activity ?? []).map((activity) => ({ kind: "motion" as const, activity, key: `motion:${activity.id}`, startTime: activity.startTime }))),
  ].sort((a, b) => b.startTime - a.startTime);
  const recentLoading = (eventFilter !== "Motion" && eventsLoading) || (eventFilter !== "Detections" && motionLoading);
  const recentError = (eventFilter !== "Motion" && eventsError) || (eventFilter !== "Detections" && motionError);
  const partialMotion = eventFilter !== "Detections" && (motion?.coverage.partial || motion?.scanLimitReached);
  const activeDetection = (events ?? []).find((event) => activeItem === `event:${event.id}`);
  const returnToLive = () => {
    setPlaybackSelection(null);
    setEventDetails(null);
    setActiveItem(null);
    setCameraPlaybackActive(false);
    setLiveRequest((value) => value + 1);
  };

  const [liveError, setLiveError] = useState(false);
  // When the operator hits Esc we route back to the grid. Use replace so
  // the back button still goes wherever they came from before the camera
  // page (typically /cameras), not into a dead-end of the same route.
  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape" && !document.querySelector('[role="dialog"][aria-modal="true"]')) {
        if (cameraPlaybackActive || playbackSelection || activeItem) {
          returnToLive();
          return;
        }
        router.replace("/cameras");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, cameraPlaybackActive, playbackSelection, activeItem]);

  // Reset the fallback flag when the camera name changes — the operator
  // might navigate to a different camera through the URL bar.
  useEffect(() => {
    setLiveError(false);
    setPlaybackSelection(null);
    setEventDetails(null);
    setActiveItem(null);
    setCameraPlaybackActive(false);
    setEventFilter("All");
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

  // WARP-3511: while the camera service cannot be read, the cameras are not
  // known to be offline — and not known to be recording either.
  const degraded = isRecordingDegraded(camera);
  const offline = camera.status === "offline" && !degraded;
  const notSaving = !degraded && camera.status === "live";
  const settingsHref = `/cameras/${encodeURIComponent(camera.name)}/settings`;

  return (
    <div className="dark fixed inset-0 z-40 bg-surface-primary flex flex-col">
      {/* Top bar — back, title, status, primary actions */}
      {/* flex-wrap: on a phone the actions drop to a second row instead of
          squeezing the camera's name to nothing — every control, Settings
          included, keeps its label (WARP-3511). */}
      <header className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 px-4 sm:px-6 py-1.5 min-h-14 border-b border-white/10 bg-black/80 backdrop-blur-md">
        <div className="flex items-center gap-3 min-w-0 flex-1 basis-40">
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
                className={`${degraded ? "text-label-quaternary" : STATUS_COLORS[camera.status]} fill-current ${
                  !degraded && camera.status === "detecting" ? "animate-pulse" : ""
                }`}
              />
              <span className="type-caption-1 text-white/70">
                {statusLabel(camera)}
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
        <div className="flex flex-wrap items-center justify-end gap-1 sm:gap-2">
          {!canManage ? null : camera.enabled ? (
            <button
              onClick={() => setToggle("disable")}
              aria-label="Disable"
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-white/90 hover:bg-white/10 transition-colors"
            >
              <PowerOff size={16} />
              <span className="type-subheadline hidden sm:inline">Disable</span>
            </button>
          ) : (
            <button
              onClick={() => setToggle("enable")}
              aria-label="Enable"
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-accent text-white hover:bg-accent/90 transition-colors"
            >
              <Power size={16} />
              <span className="type-subheadline hidden sm:inline">Enable</span>
            </button>
          )}
          {hasPtz && canManage && (
            <button
              onClick={() => setPtzOpen((o) => !o)}
              aria-label="PTZ"
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
            aria-label="Recordings"
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-white/90 hover:bg-white/10 transition-colors"
            title="Browse recordings + timeline"
          >
            <Film size={16} />
            <span className="type-subheadline hidden sm:inline">Recordings</span>
          </button>
          {canManage && (
          <button
            onClick={() => router.push(settingsHref)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-white/90 hover:bg-white/10 transition-colors"
            title="Detection, recording, and zone settings"
          >
            <Settings size={16} />
            {/* Always labelled: it is where "not saving" is fixed, and an
                unlabelled gear is easy to miss on a phone (WARP-3511). */}
            <span className="type-subheadline">Settings</span>
          </button>
          )}
          <button
            onClick={handleTogglePin}
            aria-label={isPinned ? "Pinned" : "Pin"}
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
          {canManage && (
          <button
            onClick={() => setRemoveOpen(true)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-system-red hover:bg-system-red/15 transition-colors"
            title="Remove camera"
            aria-label={`Remove camera ${camera.displayName}`}
          >
            <Trash2 size={16} />
          </button>
          )}
        </div>
      </header>

      {/* WARP-1974 — the state that used to read as a green "Recording".
          Saying "not saving" is the fact; a household member also needs
          telling what to do about it. */}
      {degraded && <CameraServiceNotice appearance="dark" />}
      {notSaving && (
        <div
          data-testid="status-help"
          className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 sm:px-6 py-2 bg-system-orange/15 border-b border-system-orange/30"
        >
          <Circle size={8} className="text-system-orange fill-current shrink-0" />
          <p className="type-caption-1 text-white/80 flex-1 basis-60">
            This camera is working, but nothing is being saved, so there will be
            nothing to look back at.{" "}
            {canManage ? (
              <>
                Set how long to keep footage in{" "}
                <Link href={settingsHref} className="underline underline-offset-2 text-white">
                  Settings
                </Link>
                .
              </>
            ) : (
              "Ask an owner or admin to turn recording on."
            )}
          </p>
          {canManage && (
            <RetentionFixButton
              cameraName={camera.name}
              cameras={cameras}
              onDone={refresh}
              appearance="dark"
            />
          )}
        </div>
      )}

      <ConfirmDialog
        open={toggle !== null}
        onConfirm={performToggle}
        onCancel={() => setToggle(null)}
        title={
          toggle === "disable"
            ? `Disable "${camera.displayName}"?`
            : `Enable "${camera.displayName}"?`
        }
        description={
          toggle === "disable"
            ? "Detection stops, so this camera won't raise events or alerts. Live video stays on. The camera service restarts to apply this, so every camera drops for a few seconds."
            : "Detection starts again, so this camera raises events and alerts. The camera service restarts to apply this, so every camera drops for a few seconds."
        }
        confirmLabel={toggle === "disable" ? "Disable" : "Enable"}
        variant={toggle === "disable" ? "destructive" : "neutral"}
        accessory={<SafetyChip variant="write" />}
      />

      <ConfirmDialog
        open={removeOpen}
        onConfirm={performRemove}
        onCancel={() => setRemoveOpen(false)}
        title={`Remove camera "${camera.displayName}"?`}
        description="The camera stops recording and is removed from the dashboard. Existing clips and events are kept until they expire normally."
        confirmLabel="Remove"
        variant="destructive"
      />

      {eventDetails && (
        <EventClipModal
          key={eventDetails.id}
          event={cameraDetectionDetail(events?.find((event) => event.id === eventDetails.id) ?? eventDetails)}
          initialMedia={eventDetails.hasSnapshot ? "snapshot" : "clip"}
          cameraName={camera.displayName || camera.name}
          onClose={() => setEventDetails(null)}
        />
      )}

      <div className="flex-1 flex flex-col lg:flex-row min-h-0 overflow-y-auto lg:overflow-hidden">
        <div id="camera-feed" className="droplet-shell flex flex-col flex-1 min-w-0 min-h-0 p-3 sm:p-4 lg:overflow-y-auto bg-surface-primary">
          <CameraPlaybackPanel
            cameraName={camera.name}
            selection={playbackSelection}
            onReturnToLive={returnToLive}
            onActiveItemChange={setActiveItem}
            onPlaybackChange={setCameraPlaybackActive}
            returnToLiveRequest={liveRequest}
          >
            <div className="relative w-full h-full min-h-56 bg-black flex items-center justify-center rounded-xl overflow-hidden">
              {degraded ? (
                <div className="flex flex-col items-center gap-3 p-6 text-center">
                  <VideoOff size={56} className="text-label-quaternary" />
                  <p className="type-subheadline text-label-tertiary">Waiting for the camera service</p>
                </div>
              ) : offline ? (
                <div className="flex flex-col items-center gap-3 p-6 text-center">
                  <VideoOff size={56} className="text-label-quaternary" />
                  <p className="type-subheadline text-label-tertiary">Camera offline</p>
                </div>
              ) : !liveError ? (
                <img
                  src={getCameraLiveUrl(camera.name)}
                  alt={`${camera.displayName} live feed`}
                  className="w-full h-full object-contain"
                  onError={() => setLiveError(true)}
                />
              ) : (
                <img
                  src={`${getCameraSnapshotUrl(camera.name)}?t=${Math.floor(Date.now() / 5000)}`}
                  alt={`${camera.displayName} latest frame`}
                  className="w-full h-full object-contain"
                />
              )}

              {!offline && !degraded && !liveError && (
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
          </CameraPlaybackPanel>
        </div>

        <aside aria-label="Camera activity" className="w-full lg:w-80 shrink-0 lg:border-l border-t lg:border-t-0 border-white/10 bg-surface-primary lg:overflow-y-auto">
          <div className="p-3 sm:p-4 space-y-3">
            <section className="rounded-xl border border-white/10 bg-surface-secondary overflow-hidden">
              <div className="p-3">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="type-subheadline font-medium text-white">Recent events</h2>
                  {activeDetection && (
                    <button type="button" className="type-caption-1 text-accent underline" onClick={() => setEventDetails(activeDetection)}>
                      Event details
                    </button>
                  )}
                </div>
                <p className="type-caption-1 text-white/60 mt-1">Click an event to play its clip here.</p>
                <div className="flex flex-wrap gap-1 mt-3" aria-label="Filter recent events">
                  {(["All", "Detections", "Motion"] as const).map((filter) => (
                    <button key={filter} type="button" aria-pressed={eventFilter === filter} onClick={() => setEventFilter(filter)} className={`px-3 py-1.5 rounded-lg type-caption-1 transition-colors ${eventFilter === filter ? "bg-accent/20 text-accent" : "text-white/70 hover:bg-white/10"}`}>{filter}</button>
                  ))}
                </div>
              </div>
              {recentError && <div role="status" className="px-3 pb-3 type-caption-1 text-white/70">Some recent events could not be loaded. <button type="button" className="underline text-white" onClick={() => { void refreshEvents(); void refreshMotion(); }}>Try again</button></div>}
              {partialMotion && <p role="status" className="px-3 pb-3 type-caption-1 text-white/70">Motion coverage is incomplete. More activity may be available in recordings.</p>}
              {recentItems.length > 0 ? (
                <ul className="px-2 pb-2 space-y-1">
                  {recentItems.map((item) => {
                    const label = item.kind === "event" ? item.event.label : "motion";
                    const end = item.kind === "event" ? item.event.endTime : item.activity.endTime;
                    const seconds = end === null ? null : Math.max(1, Math.round(end - item.startTime));
                    return <li key={item.key}>
                      <button
                        type="button"
                        onClick={() => {
                          setPlaybackSelection(item.kind === "event"
                            ? { kind: "event", event: item.event }
                            : { kind: "motion", activity: item.activity });
                          setActiveItem(item.key);
                        }}
                        aria-label={`Play ${label} clip, ${new Date(item.startTime * 1000).toLocaleString()}`}
                        aria-pressed={activeItem === item.key}
                        className={`flex items-center gap-3 p-2 rounded-lg transition-colors w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${activeItem === item.key ? "bg-accent/15 ring-1 ring-inset ring-accent/50" : "hover:bg-white/5"}`}
                      >
                        <div className="w-16 h-12 rounded-lg overflow-hidden shrink-0 bg-white/5 flex items-center justify-center">
                          {item.kind === "event" ? (
                            <ThumbImage
                              src={cameraDetectionDetail(item.event).thumbnail}
                              alt={label}
                              className="w-full h-full object-cover"
                              retryKey={item.event.endTime}
                              loading="lazy"
                              iconSize={16}
                            />
                          ) : <Activity size={24} className="text-system-orange" aria-hidden="true" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="type-footnote text-white capitalize truncate">
                            {label}
                          </p>
                          <p className="type-caption-2 text-white/60">
                            {recentEventTime(item.startTime)} · {seconds === null ? "In progress" : `${seconds}s`}
                          </p>
                        </div>
                        <CirclePlay size={16} className="text-white/60 shrink-0" aria-hidden="true" />
                      </button>
                    </li>;
                  })}
                </ul>
              ) : (
                <p className="p-3 type-footnote text-white/60">
                  {recentLoading ? "Loading recent events…" : recentError || partialMotion ? "Recent activity is unavailable." : eventFilter === "Motion" ? "No motion kept in the last 24 hours." : "No recent events recorded on this camera."}
                </p>
              )}
            </section>

            <details className="rounded-xl border border-white/10 bg-surface-secondary p-3">
              <summary className="type-footnote text-white/80 flex items-center justify-between gap-2 cursor-pointer">Recording & device details <ChevronDown size={16} aria-hidden="true" /></summary>
              <div className="pt-4 space-y-4">
                <CameraRecordingSummary camera={camera} appearance="rail" current="detail" canManage={canManage} cameras={cameras} onRepaired={refresh} />
                <div className="pt-3 border-t border-white/10 space-y-2">
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
            </details>
          </div>
        </aside>
      </div>
    </div>
  );
}

function recentEventTime(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString();
  return date.toLocaleString([], {
    month: "short", day: "numeric",
    year: date.getFullYear() === today.getFullYear() ? undefined : "numeric",
    hour: "numeric", minute: "2-digit", second: "2-digit",
  });
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
