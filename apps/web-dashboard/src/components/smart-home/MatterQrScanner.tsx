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
import { BrowserMultiFormatReader, type IScannerControls } from "@zxing/browser";
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

export function MatterQrScanner({ onResult, disabled = false }: MatterQrScannerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // @zxing/browser's decodeFromVideoElement returns an IScannerControls
  // handle whose .stop() shuts down the continuous-decode loop. The old
  // BrowserMultiFormatReader.reset() lived in @zxing/library; we hold
  // the controls (not the reader) so cleanup is one well-typed call.
  const controlsRef = useRef<IScannerControls | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [status, setStatus] = useState<ScanStatus>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [manualCode, setManualCode] = useState("");

  // --- Camera lifecycle ---

  const stopCamera = useCallback(() => {
    controlsRef.current?.stop();
    controlsRef.current = null;
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
      setStatus("scanning");

      // decodeFromVideoElement loops internally; returns IScannerControls
      // whose .stop() ends the decode loop. We hold the controls on
      // controlsRef so stopCamera() can call it.
      controlsRef.current = await reader.decodeFromVideoElement(
        videoRef.current,
        (result, err) => {
          if (result) {
            setStatus("decoded");
            stopCamera();
            onResult(result.getText());
            return;
          }
          if (err && !(err instanceof NotFoundException)) {
            // Log but keep scanning — transient decode errors are normal
            // when the QR is partially obscured or out of focus.
            console.debug("[MatterQrScanner] non-fatal decode error:", err);
          }
        },
      );
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
  }, [disabled, onResult, stopCamera]);

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

        {/* Camera-error hint, only shown when relevant */}
        {(status === "denied" || status === "no-camera") && (
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
