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
  | "insecure"       // page served over http:// — getUserMedia would throw
  | "error";         // any other failure (driver, lost device)

/**
 * Browsers refuse `navigator.mediaDevices.getUserMedia` on insecure
 * origins (anything except https:// or http://localhost/127.0.0.1).
 * The Droplet's first-boot UX often lands the customer on
 * `http://droplet.local/` because mDNS resolves before they accept
 * the self-signed cert at `https://192.168.10.1`. Without this
 * pre-flight check, `getUserMedia` throws a vague NotAllowedError
 * and the customer sees a generic "camera failed" — they have no
 * way to know the actual blocker is the protocol.
 *
 * Returning false here flips the scanner into the `insecure` status
 * which renders a "switch to HTTPS first" card; the manual-entry
 * fallback still works because pairing-code entry doesn't need the
 * camera at all.
 */
function isCameraOriginSecure(): boolean {
  if (typeof window === "undefined") return true; // SSR — irrelevant
  const { protocol, hostname } = window.location;
  if (protocol === "https:") return true;
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
    return true;
  }
  return false;
}

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
    // @zxing/browser v0.1.x dropped the public `reset()` method on
    // BrowserMultiFormatReader in favor of the IScannerControls API
    // (which our callback-style decodeFromVideoElement call doesn't
    // expose). Releasing the underlying MediaStream tracks is what
    // actually frees the camera; the decoder loop terminates the next
    // time it tries to read from the now-ended video element. Drop
    // the ref so a re-start gets a fresh instance.
    readerRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const startCamera = useCallback(async () => {
    if (disabled) return;
    // Pre-flight: refuse to even prompt for camera permission when
    // the page origin isn't secure — getUserMedia would throw a
    // generic NotAllowedError otherwise and leave the customer with
    // no actionable hint. Manual-entry fallback is unaffected (no
    // camera needed).
    if (!isCameraOriginSecure()) {
      setStatus("insecure");
      setErrorMsg(
        "Camera scanning needs HTTPS. Open the dashboard at https:// (accept the certificate prompt) — or enter the pairing code below.",
      );
      return;
    }
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

  // WARP-1411: the camera viewport only exists while the camera is actually
  // live. Reserving an aspect-square box up front cost ~670px of empty black
  // on a desktop column and pushed the pairing-code field — the ONLY path
  // that works on a machine with no camera — below the fold.
  const cameraOpen =
    status === "starting" || status === "scanning" || status === "decoded";

  return (
    <div className="space-y-4">
      {/* Primary path: the pairing code. Leads because the dashboard is
          opened on a laptop at least as often as a phone, and every Matter
          device prints the code next to the QR. */}
      <div className="space-y-2">
        <label
          htmlFor="matter-manual-code"
          className="flex items-center gap-2 type-subheadline font-medium text-[var(--text)]"
        >
          <KeyRound size={14} aria-hidden="true" />
          Enter the pairing code
        </label>
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
            className="flex-1 px-3 py-2 rounded-lg type-callout font-mono outline-none bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] placeholder:text-[var(--text-muted)] focus:border-[var(--brand)]"
            aria-describedby="matter-manual-help"
          />
          <button
            onClick={submitManual}
            disabled={disabled || !manualCode.trim()}
            className="btn primary"
          >
            Commission
          </button>
        </div>
        <p id="matter-manual-help" className="type-footnote text-[var(--text-muted)]">
          11 or 21 digits, on the device or its packaging — hyphens are fine.
        </p>

        {/* Camera-error OR format-validation hint. Both flow through the
            same `errorMsg` state — camera failures are surfaced as
            graceful-degrade copy ("use the pairing code below"), QR
            and manual-code rejections are surfaced as actionable copy
            ("look for MT:…", "11 or 21 digits").
            WARP-1411: rendered whenever errorMsg is set. The old status
            allow-list omitted "insecure", so the http:// pre-flight message
            was set but never displayed — clicking Start camera on a plain
            http:// origin appeared to do nothing at all. */}
        {errorMsg && (
          <div
            role="status"
            className="flex items-start gap-2 type-footnote text-[var(--text-muted)]"
          >
            <AlertCircle size={12} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
            <span>{errorMsg}</span>
          </div>
        )}
      </div>

      {/* Secondary path: the camera, on demand. */}
      {!cameraOpen ? (
        <button
          onClick={startCamera}
          disabled={disabled}
          className="flex items-center justify-center gap-2 w-full py-2.5 rounded-lg type-subheadline
            text-[var(--text-muted)] hover:bg-[var(--hover)] disabled:opacity-40
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
          style={{ border: "1px solid var(--card-bd)" }}
        >
          {/* "insecure" belongs with the other already-tried states: the HTTPS
              pre-flight in startCamera() has run and refused, so the customer
              has pressed this button and been turned away. Leaving it on the
              first-run label invites them to press it again expecting the
              camera to open. */}
          {status === "denied" ||
          status === "no-camera" ||
          status === "error" ||
          status === "insecure" ? (
            <>
              <CameraOff size={15} aria-hidden="true" /> Try the camera again
            </>
          ) : (
            <>
              <Camera size={15} aria-hidden="true" /> Scan the QR code instead
            </>
          )}
        </button>
      ) : (
        <div className="space-y-2">
          {/* Capped so the viewport never dominates a wide column — a
              384px square reads as a scanner, a 672px one reads as a void. */}
          <div
            className="relative w-full max-w-sm mx-auto aspect-square rounded-xl overflow-hidden"
            style={{ background: "var(--inset)", border: "1px solid var(--card-bd)" }}
          >
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
                <div
                  className="w-3/5 aspect-square border-2 rounded-2xl shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]"
                  style={{ borderColor: "color-mix(in srgb, var(--brand) 60%, transparent)" }}
                />
              </div>
            )}

            {status === "starting" && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-[var(--text-muted)]">
                <Loader2 size={28} className="animate-spin" aria-hidden="true" />
                <p className="type-footnote">Waiting for camera permission…</p>
              </div>
            )}

            {status === "decoded" && (
              <div
                className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-system-green"
                style={{ background: "var(--scrim)" }}
              >
                <Loader2 size={28} className="animate-spin" aria-hidden="true" />
                <p className="type-callout font-medium">QR detected — commissioning…</p>
              </div>
            )}
          </div>

          {status === "scanning" && (
            <button
              onClick={() => {
                stopCamera();
                setStatus("idle");
              }}
              className="block mx-auto type-footnote text-[var(--text-muted)] hover:text-[var(--text)]
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] rounded"
            >
              Stop camera
            </button>
          )}
        </div>
      )}
    </div>
  );
}
