"use client";

/**
 * Camera-based Matter QR scanner with manual pairing-code fallback.
 *
 * Two paths to the same `commissionMatterDevice()` call:
 *   1. Camera viewport — @zxing/browser decodes the QR every animation
 *      frame; on first valid match we stop scanning and submit the
 *      decoded string.
 *   2. Manual entry — text input accepting either the 11-digit short
 *      Matter manual code or the 21-digit long form. The orchestrator's
 *      `ManualPairingCodeCodec` and `QrPairingCodeCodec` both consume
 *      raw strings, so we don't need to discriminate client-side.
 *
 * Camera permissions
 * ------------------
 * `navigator.mediaDevices.getUserMedia` requires HTTPS or localhost.
 * The Droplet dashboard runs on `https://192.168.10.1` (self-signed) so
 * permissions land cleanly. iOS Safari is the strictest target — we
 * test against it because the most likely scan source is a customer's
 * phone, opened to droplet.local.
 *
 * On permission denial we fall through to the manual-entry textbox
 * without an error banner — the input is always rendered below the
 * viewport, so the camera failure is a graceful degradation.
 */

import { useCallback, useEffect, useRef, useState } from "react";
// BrowserMultiFormatReader lives in @zxing/browser (split out from
// @zxing/library in newer versions). Its decodeFromVideoElement takes
// a (videoElement, callback) signature — the @zxing/library variant
// is single-shot Promise-based and would fail to typecheck here.
// NotFoundException stays in @zxing/library where the core exceptions live.
import { BrowserMultiFormatReader } from "@zxing/browser";
import { NotFoundException } from "@zxing/library";
import { AlertCircle, Camera, CameraOff, KeyRound, Loader2 } from "lucide-react";

export type ScanStatus =
  | "idle"           // before "start scanning"
  | "starting"       // permission prompt + camera warm-up
  | "scanning"       // active video stream + decode loop
  | "decoded"        // QR found, about to call onResult
  | "denied"         // camera permission denied
  | "no-camera"      // no media device available (desktop)
  | "error";         // any other failure (driver, lost device)

interface MatterQrScannerProps {
  /** Invoked once with the decoded QR string OR the manually-entered
   *  pairing code. Parent owns the actual commissioning request and
   *  the spinner / success / error UI around it. */
  onResult: (pairingCode: string) => void;
  /** Disable both the start-scanning button and the manual-entry
   *  submit while a commissioning request is in flight upstream. */
  disabled?: boolean;
}

// A real Matter QR payload starts with the `MT:` URI prefix
// (Matter spec §5.1.5: "MT:" + Base38 payload). The bare numeric
// pairing code is also valid input here because we accept both QR
// strings and manually-typed pairing codes through the same callback.
// Anything outside of those two shapes is a poisoned QR sticker — bail
// before round-tripping through the orchestrator.
function isValidMatterQrPayload(raw: string): boolean {
  return /^MT:[A-Z0-9.\-]{1,256}$/.test(raw);
}

// Matter pairing codes are decimal digits in one of two forms (per
// Matter Core spec §5.1.4):
//   - 11-digit short manual code
//   - 21-digit long manual code (used by devices that don't print a QR)
// Hyphens are stripped before validation; we already strip them at the
// call site, so this regex is digits-only.
function isValidPairingCode(digits: string): boolean {
  return /^(\d{11}|\d{21})$/.test(digits);
}

export function MatterQrScanner({ onResult, disabled = false }: MatterQrScannerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const readerRef = useRef<BrowserMultiFormatReader | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // The `@zxing` decoder loop closes over the `onResult` callback at the
  // moment we hand it in. If the parent ever re-renders with a fresh
  // function identity (e.g. `useCallback` deps shift) the looping closure
  // still holds the stale reference. Today the parent uses a stable
  // callback so this isn't triggered, but the failure mode is silent —
  // a stale `onResult` would simply call into a stopped-state setter.
  // Mirror the prop through a ref + read inside the decode callback so
  // the latest version is always used.
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  const [status, setStatus] = useState<ScanStatus>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [manualCode, setManualCode] = useState("");

  // --- Camera lifecycle ---

  const stopCamera = useCallback(() => {
    readerRef.current?.reset();
    readerRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const startCamera = useCallback(async () => {
    if (disabled) return;
    setStatus("starting");
    setErrorMsg(null);
    try {
      // Prefer the back-facing camera on phones. `facingMode: "environment"`
      // is a hint; iOS honors it, desktops just pick whatever they have.
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      streamRef.current = stream;
      if (!videoRef.current) {
        // Component unmounted mid-startup — release the camera handle
        // we just acquired so we don't leak it.
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      videoRef.current.srcObject = stream;
      await videoRef.current.play();

      const reader = new BrowserMultiFormatReader();
      readerRef.current = reader;
      setStatus("scanning");

      // decodeFromVideoElement loops internally; we resolve on first
      // valid decode, ignore NotFoundException (no QR in this frame).
      reader.decodeFromVideoElement(videoRef.current, (result, err) => {
        if (result) {
          const payload = result.getText();
          if (!isValidMatterQrPayload(payload)) {
            // Random QR sticker that happens to be in frame (Wi-Fi
            // join code, business card, etc.) — keep scanning instead
            // of forwarding the garbage to the orchestrator. Surface
            // a hint so the customer knows the camera is working but
            // the sticker isn't a Matter device. We don't stop the
            // scanner — the user may pan over to the right sticker.
            setErrorMsg(
              "That doesn't look like a Matter QR code. Look for one that starts with “MT:”.",
            );
            return;
          }
          setStatus("decoded");
          stopCamera();
          // Use the ref so a parent re-render after the loop started
          // can't strand us on a stale callback.
          onResultRef.current(payload);
          return;
        }
        if (err && !(err instanceof NotFoundException)) {
          // Log but keep scanning — transient decode errors are normal
          // when the QR is partially obscured or out of focus.
          console.debug("[MatterQrScanner] non-fatal decode error:", err);
        }
      });
    } catch (err: unknown) {
      stopCamera();
      const e = err as { name?: string; message?: string };
      if (e?.name === "NotAllowedError" || e?.name === "PermissionDeniedError") {
        setStatus("denied");
        setErrorMsg(
          "Camera access was denied. You can still enter the pairing code below.",
        );
      } else if (e?.name === "NotFoundError" || e?.name === "OverconstrainedError") {
        setStatus("no-camera");
        setErrorMsg(
          "No camera found on this device. Use the pairing code below.",
        );
      } else {
        setStatus("error");
        setErrorMsg(e?.message ?? "Failed to start camera.");
      }
    }
    // Note: `onResult` is read via `onResultRef.current` inside the
    // decode callback, so we deliberately don't list it here. Adding
    // it would force `startCamera` to re-create whenever the parent
    // passes a fresh function identity — which would tear down the
    // active camera stream mid-scan.
  }, [disabled, stopCamera]);

  // Stop camera on unmount — important on mobile, where leaving the
  // stream open keeps the camera LED on and drains battery.
  useEffect(() => stopCamera, [stopCamera]);

  // --- Manual entry submit ---

  const submitManual = useCallback(() => {
    const code = manualCode.trim();
    if (!code) return;
    // Matter pairing codes are decimal digits; the long form has
    // hyphens for readability. Strip those before submitting.
    const normalized = code.replace(/-/g, "");
    if (!isValidPairingCode(normalized)) {
      // Format validation client-side — saves a network round-trip
      // and surfaces "use 11 or 21 digits" before the orchestrator's
      // matter.js parser emits a raw `Invalid manual code: non-numeric
      // character at position N` message.
      setErrorMsg(
        "Pairing codes are 11 or 21 digits. Double-check the number on your device.",
      );
      return;
    }
    setErrorMsg(null);
    onResult(normalized);
  }, [manualCode, onResult]);

  // --- Render ---

  return (
    <div className="space-y-4">
      {/* Camera viewport — black box that lights up once permission grants */}
      <div className="relative aspect-square bg-fill-quaternary rounded-xl overflow-hidden border border-separator-default">
        <video
          ref={videoRef}
          className="w-full h-full object-cover"
          // playsInline keeps iOS Safari from going fullscreen on .play()
          playsInline
          muted
          aria-label="QR code camera viewport"
        />

        {/* Viewfinder overlay (corner brackets) only visible while scanning */}
        {status === "scanning" && (
          <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
            <div className="w-3/5 aspect-square border-2 border-system-blue/60 rounded-2xl shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
          </div>
        )}

        {/* Status overlays for non-scanning states */}
        {status === "idle" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-label-secondary">
            <Camera size={32} aria-hidden="true" />
            <p className="type-subheadline">Tap to scan a Matter device QR code</p>
            <button
              onClick={startCamera}
              disabled={disabled}
              className="px-4 py-2 bg-system-blue text-white rounded-lg type-callout font-medium hover:bg-system-blue/90 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Start camera
            </button>
          </div>
        )}

        {status === "starting" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-label-secondary">
            <Loader2 size={28} className="animate-spin" aria-hidden="true" />
            <p className="type-footnote">Waiting for camera permission…</p>
          </div>
        )}

        {(status === "denied" || status === "no-camera" || status === "error") && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-label-secondary px-6 text-center">
            <CameraOff size={32} aria-hidden="true" />
            <p className="type-footnote">{errorMsg}</p>
          </div>
        )}

        {status === "decoded" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-system-green bg-fill-quaternary/90">
            <Loader2 size={28} className="animate-spin" aria-hidden="true" />
            <p className="type-callout font-medium">QR detected — commissioning…</p>
          </div>
        )}
      </div>

      {/* Manual fallback. Always shown so users with no camera (desktop
          ops console, headless setup) have a path. */}
      <div className="space-y-2">
        <label
          htmlFor="matter-manual-code"
          className="flex items-center gap-2 type-subheadline font-medium text-label-primary"
        >
          <KeyRound size={14} aria-hidden="true" />
          Or enter the pairing code
        </label>
        <p className="type-footnote text-label-secondary">
          Look on the device, packaging, or quick-start guide. The code is 11 or
          21 digits, sometimes shown with hyphens (e.g. 3497-0112-3320).
        </p>
        <div className="flex gap-2">
          <input
            id="matter-manual-code"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={manualCode}
            disabled={disabled}
            onChange={(e) => setManualCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitManual();
            }}
            placeholder="3497-0112-3320"
            className="flex-1 px-3 py-2 bg-fill-tertiary border border-separator-default rounded-lg type-callout font-mono placeholder:text-label-tertiary focus:outline-none focus:border-system-blue"
            aria-describedby="matter-manual-help"
          />
          <button
            onClick={submitManual}
            disabled={disabled || !manualCode.trim()}
            className="px-4 py-2 bg-system-blue text-white rounded-lg type-callout font-medium hover:bg-system-blue/90 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Commission
          </button>
        </div>

        {/* Camera-error OR format-validation hint. Both flow through the
            same `errorMsg` state — camera failures are surfaced as
            graceful-degrade copy ("use the pairing code below"), QR
            and manual-code rejections are surfaced as actionable copy
            ("look for MT:…", "11 or 21 digits"). */}
        {errorMsg && (status === "denied" || status === "no-camera" || status === "scanning" || status === "idle") && (
          <div
            id="matter-manual-help"
            className="flex items-start gap-2 type-footnote text-label-tertiary"
          >
            <AlertCircle size={12} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
            <span>{errorMsg}</span>
          </div>
        )}
      </div>
    </div>
  );
}
