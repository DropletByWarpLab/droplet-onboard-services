"use client";

import { useEffect, useRef } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Minus,
  Plus,
  X,
} from "lucide-react";
import { ptzGoToPreset, ptzMove } from "@/lib/api";
import type { PtzAction, PtzCapabilities } from "@/lib/types";

interface Props {
  cameraName: string;
  caps: PtzCapabilities;
  onClose: () => void;
}

/**
 * PTZ control overlay for cameras that support pan/tilt/zoom.
 *
 * Each direction button uses press-to-move semantics: pointerdown
 * starts continuous motion via Frigate's PUT /ptz?action=MOVE_*,
 * pointerup/cancel/leave fires STOP. That matches how every operator
 * expects a PTZ control to work — release button = stop.
 *
 * The "leave" handler matters: a user can drag off the button mid-
 * press (especially on touch), and we never want the camera to stay
 * panning. STOP is idempotent in Frigate so a duplicate STOP is fine.
 *
 * Presets are click-to-recall — Frigate handles the move internally.
 */
export function PtzOverlay({ cameraName, caps, onClose }: Props) {
  // Track which action is currently in flight so a stuck request
  // doesn't queue up multiples. Also lets us label the active button.
  const activeRef = useRef<PtzAction | null>(null);

  const startMove = async (action: PtzAction) => {
    if (activeRef.current) return;
    activeRef.current = action;
    try {
      await ptzMove(cameraName, action);
    } catch {
      activeRef.current = null;
    }
  };

  const stopMove = async () => {
    if (!activeRef.current) return;
    activeRef.current = null;
    try {
      await ptzMove(cameraName, "STOP");
    } catch {
      // STOP failure is silent — the camera will stop on its own
      // timeout anyway, and there's nothing useful for the operator
      // to do about it.
    }
  };

  // Esc closes the overlay AND fires a STOP, in case the operator was
  // mid-press when they hit the key.
  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") {
        void stopMove();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      // Belt-and-braces: make sure we never leave the camera spinning
      // when the overlay unmounts for any reason.
      void stopMove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose]);

  const dirButton = (action: PtzAction, Icon: typeof ChevronUp, label: string) => (
    <button
      type="button"
      aria-label={label}
      onPointerDown={(e) => {
        e.preventDefault();
        void startMove(action);
      }}
      onPointerUp={() => void stopMove()}
      onPointerLeave={() => void stopMove()}
      onPointerCancel={() => void stopMove()}
      className="flex items-center justify-center w-10 h-10 rounded-lg bg-white/10 hover:bg-white/20 active:bg-white/30 text-white touch-none select-none"
    >
      <Icon size={18} />
    </button>
  );

  return (
    <div className="absolute bottom-4 right-4 z-30 flex flex-col gap-2 p-3 rounded-xl bg-black/80 backdrop-blur-md text-white shadow-2xl max-w-[18rem]">
      <div className="flex items-center justify-between gap-3">
        <span className="type-caption-2 uppercase tracking-wide text-white/70">
          PTZ
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close PTZ controls"
          className="text-white/70 hover:text-white"
        >
          <X size={14} />
        </button>
      </div>

      {/* Direction pad */}
      {caps.supportsPanTilt && (
        <div
          className="grid grid-cols-3 gap-1 self-center"
          // touch-none prevents scroll-on-press on iOS
        >
          <span />
          {dirButton("MOVE_UP", ChevronUp, "Pan up")}
          <span />
          {dirButton("MOVE_LEFT", ChevronLeft, "Pan left")}
          <span className="flex items-center justify-center w-10 h-10 type-caption-2 text-white/40">
            ⏺
          </span>
          {dirButton("MOVE_RIGHT", ChevronRight, "Pan right")}
          <span />
          {dirButton("MOVE_DOWN", ChevronDown, "Pan down")}
          <span />
        </div>
      )}

      {/* Zoom row */}
      {caps.supportsZoom && (
        <div className="flex items-center justify-center gap-2">
          {dirButton("ZOOM_OUT", Minus, "Zoom out")}
          <span className="type-caption-2 text-white/70">Zoom</span>
          {dirButton("ZOOM_IN", Plus, "Zoom in")}
        </div>
      )}

      {/* Presets */}
      {caps.presets.length > 0 && (
        <div className="border-t border-white/10 pt-2">
          <div className="type-caption-2 uppercase tracking-wide text-white/70 mb-1.5">
            Presets
          </div>
          <div className="flex flex-wrap gap-1">
            {caps.presets.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() =>
                  ptzGoToPreset(cameraName, p).catch(() => {
                    /* swallow — preset call failure surfaces in
                       Frigate's logs; not actionable for the operator */
                  })
                }
                className="px-2 py-0.5 rounded-full type-caption-2 bg-white/10 hover:bg-white/20"
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      )}

      {!caps.supportsPanTilt && !caps.supportsZoom && caps.presets.length === 0 && (
        <p className="type-caption-2 text-white/70">
          This camera reports no PTZ capability.
        </p>
      )}
    </div>
  );
}
