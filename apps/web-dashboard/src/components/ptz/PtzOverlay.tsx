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

// Map a keyboard event's `.key` to the PTZ action the overlay-level
// arrow-key shortcut should fire. Returns null for keys we don't bind
// so the keydown handler can early-return without preventing scroll
// or other default behavior.
function ptzActionForKey(key: string): PtzAction | null {
  switch (key) {
    case "ArrowUp":
      return "MOVE_UP";
    case "ArrowDown":
      return "MOVE_DOWN";
    case "ArrowLeft":
      return "MOVE_LEFT";
    case "ArrowRight":
      return "MOVE_RIGHT";
    case "+":
    case "=":
      return "ZOOM_IN";
    case "-":
    case "_":
      return "ZOOM_OUT";
    default:
      return null;
  }
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
 *
 * Keyboard contract (WARP-296):
 * - Arrow keys on the focused overlay pan; +/- (or =/_) zoom. Keydown
 *   starts the move, keyup stops it. `e.repeat` is filtered so
 *   auto-repeat doesn't double-fire MOVE through the in-flight guard.
 * - Each direction button additionally honors Enter and Space on
 *   keydown so a Tab-focused button can be "pressed" by keyboard.
 *   The default <button> click fires only on key release, which is
 *   too late for hold-to-move — the explicit keydown handler starts
 *   the move on press, keyup stops it.
 * - Escape stops + closes (preserves existing behavior).
 */
export function PtzOverlay({ cameraName, caps, onClose }: Props) {
  // Track which action is currently in flight so a stuck request
  // doesn't queue up multiples. Also lets us label the active button.
  const activeRef = useRef<PtzAction | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  // First directional button — focused on mount only when the overlay
  // was opened via keyboard, so we don't yank focus on touch/mouse.
  const firstButtonRef = useRef<HTMLButtonElement | null>(null);

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

  // Focus the first directional button when the overlay opens via
  // keyboard. `:focus-visible` is the cleanest heuristic for "the user
  // is driving with a keyboard" — if it doesn't match, the user came
  // from a touch/mouse interaction and we leave focus where it was.
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (!document.querySelector(":focus-visible")) return;
    firstButtonRef.current?.focus();
  }, []);

  const handleOverlayKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const action = ptzActionForKey(e.key);
    if (!action) return;
    // Auto-repeat would re-fire MOVE through the in-flight guard the
    // moment STOP settled. Only the first press should issue MOVE.
    if (e.repeat) {
      e.preventDefault();
      return;
    }
    // Prevent the page from scrolling under the focused overlay.
    e.preventDefault();
    void startMove(action);
  };

  const handleOverlayKeyUp = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const action = ptzActionForKey(e.key);
    if (!action) return;
    e.preventDefault();
    void stopMove();
  };

  const dirButton = (
    action: PtzAction,
    Icon: typeof ChevronUp,
    label: string,
    isFirst = false,
  ) => (
    <button
      type="button"
      ref={isFirst ? firstButtonRef : undefined}
      aria-label={label}
      onPointerDown={(e) => {
        e.preventDefault();
        void startMove(action);
      }}
      onPointerUp={() => void stopMove()}
      onPointerLeave={() => void stopMove()}
      onPointerCancel={() => void stopMove()}
      onKeyDown={(e) => {
        // Enter/Space on a focused button should behave like
        // pointerdown — start the move on press, not release. The
        // default <button> click would only fire after key release.
        if ((e.key === "Enter" || e.key === " ") && !e.repeat) {
          e.preventDefault();
          void startMove(action);
        }
      }}
      onKeyUp={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          void stopMove();
        }
      }}
      className="flex items-center justify-center w-11 h-11 rounded-lg bg-white/10 hover:bg-white/20 active:bg-white/30 text-white touch-none select-none"
    >
      <Icon size={18} />
    </button>
  );

  return (
    <div
      ref={overlayRef}
      data-testid="ptz-overlay"
      tabIndex={0}
      role="group"
      aria-label="PTZ control overlay — use arrow keys to pan, +/- to zoom"
      onKeyDown={handleOverlayKeyDown}
      onKeyUp={handleOverlayKeyUp}
      className="absolute bottom-4 right-4 z-30 flex flex-col gap-2 p-3 rounded-xl bg-black/80 backdrop-blur-md text-white shadow-2xl max-w-[18rem] focus:outline-none focus:ring-2 focus:ring-white/40"
    >
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
          {dirButton("MOVE_UP", ChevronUp, "Pan up", true)}
          <span />
          {dirButton("MOVE_LEFT", ChevronLeft, "Pan left")}
          <span className="flex items-center justify-center w-11 h-11 type-caption-2 text-white/40">
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
