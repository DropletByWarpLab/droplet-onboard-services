"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Maximize2, Pin, PinOff, Settings, VideoOff, Circle } from "lucide-react";
import { getCameraLiveUrl, getCameraSnapshotUrl } from "@/lib/api";
import {
  MODE_CHIP_LABEL,
  describeLastSaved,
  formatStorageBytes,
  isRecordingDegraded,
  modeTooltip,
  statusLabel,
} from "@/lib/camera-recording";
import type { CameraInfo } from "@/lib/types";

interface CameraCardProps {
  camera: CameraInfo;
  onClick: (camera: CameraInfo) => void;
  /** When true, the card renders the filled-pin affordance and lives in
   *  the "Pinned" section. Optional — pin support is a per-user pref the
   *  caller wires in if it has a useCameraPins hook handy. */
  isPinned?: boolean;
  /** Toggle handler. Receives the camera so the page can dispatch
   *  add/remove without re-deriving from the click target. */
  onTogglePin?: (camera: CameraInfo) => void | Promise<void>;
  /** WARP-3511: opens this camera's settings. Offered only to owners and
   *  admins, so it is absent for everyone else and no gear is drawn. */
  onOpenSettings?: (camera: CameraInfo) => void;
}

// Snapshot refresh interval. The previous 1 s bucket was too short — every
// flip remounted the <img> element (because we keyed it on the bucket) and
// the browser flashed blank between mounts. Two changes here:
//   1. Bumped to 2 s — still feels live for a security camera, halves the
//      request rate.
//   2. The <img> uses a STABLE key, and the new src is preloaded in an
//      offscreen Image() before we swap. The visible <img> only ever
//      changes when the next frame is fully decoded, so there's no blink.
const SNAPSHOT_INTERVAL_MS = 2000;

// Switch to MJPEG only on hover/focus so the grid stays cheap by default.
// 6 cards in MJPEG would burn 30–90 Mbps; 6 cards on snapshots is
// ~250 kbps. The hovered card is the one the operator actually wants
// motion in.
const HOVER_LATENCY_DELAY_MS = 250;

// The label words live in `statusLabel` (lib/camera-recording) so the tile and
// the detail screen cannot drift; only the dot is decided here.
const STATUS_CONFIG = {
  recording: { color: "var(--success)", pulse: false },
  // WARP-3511: blue (info) — a healthy camera whose objects are being tracked.
  // It shared amber with "not saving", so a camera that was working and one
  // that was keeping nothing looked the same.
  detecting: { color: "var(--color-system-blue)", pulse: true },
  // WARP-1974: a healthy stream that keeps NOTHING. Orange (warning) rather
  // than green, and named for what it is — the camera works, but nothing is
  // being saved, so there will be nothing to look back at. The old build
  // showed this exact state as a green "Recording".
  live: { color: "var(--color-system-orange)", pulse: false },
  idle: { color: "var(--text-faint)", pulse: false },
  offline: { color: "var(--danger)", pulse: false },
} as const;

// Shown when the camera service could not be read: not "Offline" (the cameras
// are probably fine) and not a recording claim either way.
const UNAVAILABLE_DOT = { color: "var(--text-faint)", pulse: false } as const;

export function CameraCard({
  camera,
  onClick,
  isPinned = false,
  onTogglePin,
  onOpenSettings,
}: CameraCardProps) {
  const [imgError, setImgError] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [pinBusy, setPinBusy] = useState(false);
  // The src on the visible <img>. We update this ONLY after the next
  // snapshot has decoded successfully — that's what eliminates the blink.
  const [snapshotSrc, setSnapshotSrc] = useState(() =>
    `${getCameraSnapshotUrl(camera.name)}?t=${Math.floor(Date.now() / SNAPSHOT_INTERVAL_MS)}`,
  );

  const degraded = isRecordingDegraded(camera);
  const statusCfg = degraded ? UNAVAILABLE_DOT : STATUS_CONFIG[camera.status];
  const rec = camera.recording;
  const saved = describeLastSaved(camera);
  const off = rec?.mode === "off";
  // Orange text is only legible on its own tint (the shell darkens it there),
  // so a warning is a pill, never bare orange on the card.
  const warnPill = "text-system-orange bg-system-orange/10 px-1.5 py-0.5 rounded-full";

  // Slight pointer-enter delay so a quick mouse-over while scrolling doesn't
  // open MJPEG streams on every card the cursor passes through.
  const hoverTimer = useRef<number | undefined>(undefined);
  const startHover = useCallback(() => {
    window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(
      () => setHovering(true),
      HOVER_LATENCY_DELAY_MS,
    );
  }, []);
  const endHover = useCallback(() => {
    window.clearTimeout(hoverTimer.current);
    setHovering(false);
  }, []);
  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);

  // Preload-then-swap: every SNAPSHOT_INTERVAL_MS, build the next URL,
  // load it offscreen, and only commit it as the visible src once it's
  // decoded. The visible <img> is never replaced with a "blank
  // loading…" state, so no flicker. If the preload errors, we surface
  // the offline icon via setImgError; the next interval will retry.
  useEffect(() => {
    if (camera.status === "offline" || hovering) return;
    let cancelled = false;
    const id = window.setInterval(() => {
      const next = `${getCameraSnapshotUrl(camera.name)}?t=${Math.floor(
        Date.now() / SNAPSHOT_INTERVAL_MS,
      )}`;
      const probe = new window.Image();
      probe.onload = () => {
        if (cancelled) return;
        setImgError(false);
        setSnapshotSrc(next);
      };
      probe.onerror = () => {
        if (cancelled) return;
        setImgError(true);
      };
      probe.src = next;
    }, SNAPSHOT_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [camera.name, camera.status, hovering]);

  // Reset error on hover-out so a stale failure doesn't pin the card on
  // the offline icon when the user comes back to it.
  useEffect(() => {
    if (!hovering) setImgError(false);
  }, [hovering]);

  const showImage = camera.status !== "offline" && !imgError;
  const useLive = showImage && hovering;

  // The card wrapper is a `<div role="button">` rather than a real
  // `<button>` so the pin-toggle <button> can nest inside without
  // emitting the invalid-HTML "<button> in <button>" React warning.
  // We forward Enter/Space to onClick to keep keyboard activation
  // identical to the previous semantics.
  const handleKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return; // child handled it
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick(camera);
    }
  };

  const handleSettingsClick = (e: React.MouseEvent) => {
    e.stopPropagation(); // don't open the detail view when opening settings
    onOpenSettings?.(camera);
  };

  const handlePinClick = async (e: React.MouseEvent) => {
    e.stopPropagation(); // don't open detail page when toggling pin
    if (!onTogglePin || pinBusy) return;
    setPinBusy(true);
    try {
      await onTogglePin(camera);
    } finally {
      setPinBusy(false);
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onClick(camera)}
      onKeyDown={handleKey}
      onMouseEnter={startHover}
      onMouseLeave={endHover}
      onFocus={startHover}
      onBlur={endHover}
      className="card overflow-hidden text-left w-full transition-all duration-200 ease-smooth hover:shadow-md group cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
      style={{ padding: 0 }}
    >
      <div className="relative aspect-video" style={{ background: "var(--card-inner)" }}>
        {showImage ? (
          // Two persistent <img> elements stacked. The MJPEG one is only
          // mounted while hovering (so we don't burn bandwidth at rest);
          // the snapshot one stays mounted, swapping `src` only after the
          // next frame is decoded — no blink between snapshots.
          <>
            <img
              src={snapshotSrc}
              alt={camera.displayName}
              className={`w-full h-full object-cover transition-opacity duration-200 ${
                useLive ? "opacity-0" : "opacity-100"
              }`}
              onError={() => setImgError(true)}
              loading="lazy"
            />
            {useLive && (
              <img
                src={getCameraLiveUrl(camera.name)}
                alt={`${camera.displayName} live preview`}
                className="absolute inset-0 w-full h-full object-cover"
                onError={() => setImgError(true)}
              />
            )}
          </>
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <VideoOff size={32} style={{ color: "var(--text-faint)" }} />
          </div>
        )}

        {/* Status badge */}
        <div
          data-testid="status-badge"
          className="absolute top-2 right-2 flex items-center gap-1.5 px-2 py-1 rounded-full bg-black/60 backdrop-blur-sm"
        >
          <Circle
            size={8}
            className={`fill-current ${statusCfg.pulse ? "animate-pulse" : ""}`}
            style={{ color: statusCfg.color }}
          />
          <span className="type-caption-2 text-white">{statusLabel(camera)}</span>
        </div>

        {/* Pin toggle — top-left. Always rendered (so the operator can pin
            from the grid without opening the detail page) but partially
            faded at rest until hover so it doesn't compete with the
            thumbnail. Only mounted if a parent wired onTogglePin. */}
        {onTogglePin && (
          <button
            type="button"
            onClick={handlePinClick}
            disabled={pinBusy}
            aria-label={isPinned ? "Unpin camera" : "Pin camera"}
            aria-pressed={isPinned}
            className={`absolute top-2 left-2 p-1.5 rounded-full backdrop-blur-sm transition-all ${
              isPinned
                ? "bg-[var(--brand)] text-white opacity-100"
                : "bg-black/60 text-white opacity-70 hover:opacity-100 group-hover:opacity-100"
            } ${pinBusy ? "opacity-50 cursor-wait" : ""}`}
          >
            {isPinned ? (
              <Pin size={14} className="fill-current" />
            ) : (
              <PinOff size={14} />
            )}
          </button>
        )}

        {/* LIVE pip — only visible while the MJPEG stream is actually open.
            Sits to the right of the pin so they don't overlap. */}
        {useLive && (
          <div
            className={`absolute top-2 flex items-center gap-1.5 px-2 py-1 rounded-full bg-system-red backdrop-blur-sm ${
              onTogglePin ? "left-12" : "left-2"
            }`}
          >
            <Circle
              size={8}
              className="text-white fill-current animate-pulse"
            />
            <span className="type-caption-2 text-white font-medium tracking-wide">
              LIVE
            </span>
          </div>
        )}

        {/* "Open fullscreen" affordance — visible at rest so operators on
            touch devices know there's a destination, not just a hover
            interaction. Group-hover bumps the opacity on desktop. */}
        {showImage && (
          <div className="absolute bottom-2 right-2 flex items-center gap-1 px-2 py-1 rounded-full bg-black/60 backdrop-blur-sm opacity-70 group-hover:opacity-100 transition-opacity">
            <Maximize2 size={12} className="text-white" />
            <span className="type-caption-2 text-white">Open</span>
          </div>
        )}
      </div>

      {/* Info */}
      <div className="p-3">
        <div className="flex items-center justify-between gap-2">
          <h3
            className="type-subheadline font-medium truncate"
            style={{ color: "var(--text)" }}
          >
            {camera.displayName}
          </h3>
          {/* Owner / admin only (the page decides). A real button beside the
              title, drawn at rest: a hover-only control is unreachable on
              touch, and settings are where "not saving" gets fixed. */}
          {onOpenSettings && (
            <button
              type="button"
              onClick={handleSettingsClick}
              aria-label={`Settings for ${camera.displayName}`}
              title="Camera settings"
              className="flex-shrink-0 -my-1 -mr-1.5 p-2 rounded-full transition-colors hover:bg-[var(--hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
              style={{ color: "var(--text-muted)" }}
            >
              <Settings size={15} aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="flex items-center justify-between mt-1">
          <p
            className="type-caption-1 truncate"
            style={{ color: "var(--text-muted)" }}
          >
            {camera.manufacturer
              ? `${camera.manufacturer}${camera.model ? ` ${camera.model}` : ""}`
              : camera.ipAddress}
          </p>
          {camera.lastDetection && (
            <span
              className="type-caption-2 flex-shrink-0 ml-2"
              style={{ color: "var(--brand)" }}
            >
              {camera.lastDetection.label}
            </span>
          )}
        </div>

        {/* WARP-3511 — is it keeping footage? Mode, the newest write, how much
            is stored. Nothing here while the service is unreadable: the badge
            says so, and a chip would be a claim with nothing behind it. */}
        {rec && !degraded && rec.mode && (
          <div
            data-testid="recording-meta"
            className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-2 type-caption-2"
          >
            <span
              data-testid="recording-mode-chip"
              title={modeTooltip(rec)}
              className={off ? warnPill : "px-1.5 py-0.5 rounded-full"}
              style={off ? undefined : { background: "var(--inset)", color: "var(--text)" }}
            >
              {MODE_CHIP_LABEL[rec.mode]}
            </span>
            {saved && (
              <span
                className={saved.tone === "warn" ? warnPill : ""}
                style={saved.tone === "warn" ? undefined : { color: "var(--text-muted)" }}
              >
                {saved.text}
              </span>
            )}
            {rec.usedBytes !== null && (
              <span className="font-mono" style={{ color: "var(--text-muted)" }}>
                {formatStorageBytes(rec.usedBytes)}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
