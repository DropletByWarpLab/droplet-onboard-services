"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Maximize2, Pin, PinOff, VideoOff, Circle } from "lucide-react";
import { getCameraLiveUrl, getCameraSnapshotUrl } from "@/lib/api";
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

const STATUS_CONFIG = {
  recording: { label: "Recording", color: "var(--success)", pulse: false },
  detecting: { label: "Detecting", color: "#d9a35c", pulse: true },
  // WARP-1974: a healthy stream that keeps NOTHING. Amber rather than
  // green, and named for what it is — the camera works, but nothing is
  // being saved, so there will be nothing to look back at. The old build
  // showed this exact state as a green "Recording".
  live: { label: "Live · not saving", color: "#d9a35c", pulse: false },
  idle: { label: "Idle", color: "var(--text-faint)", pulse: false },
  offline: { label: "Offline", color: "var(--danger)", pulse: false },
} as const;

export function CameraCard({
  camera,
  onClick,
  isPinned = false,
  onTogglePin,
}: CameraCardProps) {
  const [imgError, setImgError] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [pinBusy, setPinBusy] = useState(false);
  // The src on the visible <img>. We update this ONLY after the next
  // snapshot has decoded successfully — that's what eliminates the blink.
  const [snapshotSrc, setSnapshotSrc] = useState(() =>
    `${getCameraSnapshotUrl(camera.name)}?t=${Math.floor(Date.now() / SNAPSHOT_INTERVAL_MS)}`,
  );

  const statusCfg = STATUS_CONFIG[camera.status];

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
        <div className="absolute top-2 right-2 flex items-center gap-1.5 px-2 py-1 rounded-full bg-black/60 backdrop-blur-sm">
          <Circle
            size={8}
            className={`fill-current ${statusCfg.pulse ? "animate-pulse" : ""}`}
            style={{ color: statusCfg.color }}
          />
          <span className="type-caption-2 text-white">{statusCfg.label}</span>
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
            className={`absolute top-2 flex items-center gap-1.5 px-2 py-1 rounded-full bg-[#ef4444] backdrop-blur-sm ${
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
        <h3
          className="type-subheadline font-medium truncate"
          style={{ color: "var(--text)" }}
        >
          {camera.displayName}
        </h3>
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
      </div>
    </div>
  );
}
