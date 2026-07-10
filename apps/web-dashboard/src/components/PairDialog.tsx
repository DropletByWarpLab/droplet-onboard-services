"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  X,
  Smartphone,
  Laptop,
  Copy,
  Check,
  Loader2,
  CheckCircle2,
} from "lucide-react";
import { createPairingCode, getPairingCodeStatus } from "@/lib/api";
import { translateError } from "@/lib/friendly-errors";
import type { PairingCodeInfo } from "@/lib/types";
import { Dialog } from "./Dialog";

interface PairDialogProps {
  onClose: () => void;
  onPaired: () => void;
}

type Platform = "macos" | "windows" | "linux" | "ios" | "android" | "other";

const PLATFORMS: { value: Platform; label: string; icon: typeof Laptop }[] = [
  { value: "macos",   label: "macOS",   icon: Laptop     },
  { value: "windows", label: "Windows", icon: Laptop     },
  { value: "linux",   label: "Linux",   icon: Laptop     },
  { value: "ios",     label: "iOS",     icon: Smartphone },
  { value: "android", label: "Android", icon: Smartphone },
];

const STATUS_POLL_INTERVAL_MS = 2000;

/**
 * Pair-a-new-device modal. Two-step UX:
 *   1. Name the device + pick a platform
 *   2. Show a QR code + pair URL; poll /pair/:code/status every 2s until
 *      the native client claims it
 *
 * When the status poll flips `used=true`, we flash a success panel and
 * call onPaired so the parent can refresh its device-clients list.
 *
 * WARP-289: rebuilt on top of the shared `<Dialog>` primitive — full
 * modal ARIA, focus restore, Escape close, body scroll-lock all come
 * from there.
 */
export function PairDialog({ onClose, onPaired }: PairDialogProps) {
  const [step, setStep] = useState<"form" | "waiting" | "done">("form");
  const [deviceName, setDeviceName] = useState("");
  const [platform, setPlatform] = useState<Platform>("macos");
  const [pairing, setPairing] = useState<PairingCodeInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const headingId = useId();

  const deviceType: "desktop" | "mobile" =
    platform === "ios" || platform === "android" ? "mobile" : "desktop";

  const handleGenerate = useCallback(async () => {
    if (!deviceName.trim()) {
      setError("Please give this device a name");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const info = await createPairingCode({
        deviceName: deviceName.trim(),
        deviceType,
        platform,
      });
      setPairing(info);
      setStep("waiting");
    } catch (err) {
      // WARP-1150: this is the CREATE-a-pairing-session step — no device is
      // involved yet, so the "device" domain's "couldn't reach that device"
      // copy is nonsense here. The "pairing" domain keeps every failure at
      // this step phrased as "couldn't create a code, retry".
      setError(translateError(err, "pairing"));
    } finally {
      setSubmitting(false);
    }
  }, [deviceName, deviceType, platform]);

  // Poll for claim status once we have a code
  useEffect(() => {
    if (!pairing || step !== "waiting") return;

    const tick = async () => {
      try {
        const status = await getPairingCodeStatus(pairing.code);
        if (status.used) {
          setStep("done");
          onPaired();
          if (pollRef.current) clearInterval(pollRef.current);
          // Auto-close after 2s so the user sees the success flash
          setTimeout(() => onClose(), 2000);
        } else if (status.expired) {
          setError("Code expired. Generate a new one.");
          setStep("form");
          setPairing(null);
          if (pollRef.current) clearInterval(pollRef.current);
        }
      } catch {
        // swallow — transient network hiccups shouldn't break the poll
      }
    };

    tick();
    pollRef.current = setInterval(tick, STATUS_POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [pairing, step, onPaired, onClose]);

  const handleCopy = () => {
    if (!pairing) return;
    navigator.clipboard.writeText(pairing.pairUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const expiresInMinutes = pairing
    ? Math.max(
        0,
        Math.round((new Date(pairing.expiresAt).getTime() - Date.now()) / 60_000)
      )
    : 0;

  return (
    // `flush`: sectioned layout — the full-width header divider + per-step
    // bodies own their padding (WARP-1153).
    <Dialog open onClose={onClose} labelledBy={headingId} maxWidth="md" flush>
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3"
        style={{ borderBottom: "1px solid var(--card-bd)" }}
      >
        <h3 id={headingId} className="type-title-3" style={{ color: "var(--text)" }}>
          Pair a new device
        </h3>
        <button
          onClick={onClose}
          aria-label="Close"
          className="p-1 text-[var(--text-muted)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] rounded-[var(--radius-input)]"
        >
          <X size={18} />
        </button>
      </div>

      {/* Form step */}
      {step === "form" && (
        <div className="p-5 space-y-4">
          <div>
            <label
              className="type-caption-1 mb-1.5 block"
              style={{ color: "var(--text-muted)" }}
            >
              Device name
            </label>
            <input
              autoFocus
              value={deviceName}
              onChange={(e) => setDeviceName(e.target.value)}
              placeholder="Alice's MacBook"
              className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors"
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-input)",
                color: "var(--text)",
              }}
              onKeyDown={(e) => e.key === "Enter" && handleGenerate()}
            />
          </div>

          <div>
            <label
              className="type-caption-1 mb-1.5 block"
              style={{ color: "var(--text-muted)" }}
            >
              Platform
            </label>
            <div className="grid grid-cols-3 gap-2">
              {PLATFORMS.map((p) => {
                const Icon = p.icon;
                const selected = platform === p.value;
                return (
                  <button
                    key={p.value}
                    onClick={() => setPlatform(p.value)}
                    className={`flex flex-col items-center gap-1 p-3 rounded-[var(--radius-input)] type-caption-1 transition-colors ${
                      selected
                        ? "bg-[var(--brand-subtle)] text-[var(--brand)] font-medium"
                        : "bg-[var(--surface-2)] text-[var(--text-muted)] hover:text-[var(--text)]"
                    }`}
                  >
                    <Icon size={16} />
                    {p.label}
                  </button>
                );
              })}
            </div>
          </div>

          {error && (
            <div className="p-2 bg-[rgba(239,68,68,0.1)] border border-[rgba(239,68,68,0.2)] rounded-[var(--radius-input)] type-footnote text-[#ef4444]">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button onClick={onClose} className="btn ghost">
              Cancel
            </button>
            <button
              onClick={handleGenerate}
              disabled={submitting}
              className="btn primary"
            >
              {submitting ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  Generating…
                </>
              ) : (
                "Generate code"
              )}
            </button>
          </div>
        </div>
      )}

      {/* Waiting / QR step */}
      {step === "waiting" && pairing && (
        <div className="p-5 space-y-4">
          <p
            className="type-footnote text-center"
            style={{ color: "var(--text-muted)" }}
          >
            Scan this code with the Droplet app, or copy the link and open it
            on the device you want to pair.
          </p>

          <div className="flex justify-center">
            {/* Solid white behind the QR — scanner contrast, not a theme surface. */}
            <div className="p-4 bg-white rounded-[var(--radius-card)]">
              <QRCodeSVG
                value={pairing.pairUrl}
                size={192}
                level="M"
                includeMargin={false}
              />
            </div>
          </div>

          <div className="text-center">
            <p className="type-caption-1" style={{ color: "var(--text-muted)" }}>
              Pairing code
            </p>
            <p
              className="type-title-3 font-mono tracking-wider"
              style={{ color: "var(--text)" }}
            >
              {pairing.code}
            </p>
            <p className="type-caption-2 mt-1" style={{ color: "var(--text-faint)" }}>
              Expires in ~{expiresInMinutes} min
            </p>
          </div>

          <div className="flex items-center gap-2">
            <input
              readOnly
              value={pairing.pairUrl}
              className="type-caption-1 flex-1 px-3 py-1.5 font-mono outline-none focus:border-[var(--brand)]"
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-input)",
                color: "var(--text)",
              }}
              onFocus={(e) => e.currentTarget.select()}
            />
            <button
              onClick={handleCopy}
              className="p-2 rounded-[var(--radius-input)] bg-[var(--brand-subtle)] text-[var(--brand)] hover:bg-[rgba(99,102,241,0.2)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
              title="Copy link"
              aria-label="Copy pair link"
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </div>

          <div
            className="flex items-center justify-center gap-2 type-footnote"
            style={{ color: "var(--text-muted)" }}
          >
            <Loader2 size={14} className="animate-spin" />
            Waiting for the device to claim the code…
          </div>
        </div>
      )}

      {/* Done step */}
      {step === "done" && (
        <div className="p-8 flex flex-col items-center gap-3 text-center">
          <CheckCircle2 size={48} className="text-system-green" />
          <p className="type-headline" style={{ color: "var(--text)" }}>
            Device paired
          </p>
          <p className="type-footnote" style={{ color: "var(--text-muted)" }}>
            <strong>{deviceName}</strong> is ready to sync.
          </p>
        </div>
      )}
    </Dialog>
  );
}
