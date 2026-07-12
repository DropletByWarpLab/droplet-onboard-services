"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { QRCodeSVG } from "qrcode.react";
import {
  ArrowLeft,
  Check,
  Copy,
  Loader2,
  Plus,
  RefreshCw,
  Smartphone,
  Laptop,
} from "lucide-react";
import {
  createPairingCode,
  getPairingCodeStatus,
} from "@/lib/api";
import type { PairingCodeInfo, PairingCodeStatus } from "@/lib/types";

type DeviceType = "mobile" | "desktop";
type Platform = "ios" | "android" | "macos" | "windows" | "linux" | "other";

const PLATFORM_OPTIONS: Array<{ id: Platform; label: string; type: DeviceType }> = [
  { id: "android", label: "Android", type: "mobile" },
  { id: "ios", label: "iOS", type: "mobile" },
  { id: "macos", label: "macOS", type: "desktop" },
  { id: "windows", label: "Windows", type: "desktop" },
  { id: "linux", label: "Linux", type: "desktop" },
  { id: "other", label: "Other", type: "desktop" },
];

/**
 * Pair-a-mobile-device flow (Phase 7.1).
 *
 * Mechanically two screens collapsed into one route:
 *   1. Form: pick platform + name the device → POST /devices/pair
 *      gets back { code, expiresAt, pairUrl }.
 *   2. QR: render the pairUrl as a scannable QR + show the manual
 *      6-digit code as fallback. Poll /pair/:code/status every 2s
 *      until the device claims it (used=true) or the code expires.
 *
 * The pairing URL is `droplet://pair?server=...&code=...`. The Android
 * + iOS apps register the `droplet://` scheme and consume that URL
 * directly when scanned. Manual entry of the code is the fallback —
 * the native app accepts it on a typing screen.
 *
 * Once claimed, we route to /devices/clients so the operator can see
 * the new device in the paired-clients list.
 */
export default function PairDevicePage() {
  const router = useRouter();

  // Form state
  const [deviceName, setDeviceName] = useState("");
  const [platform, setPlatform] = useState<Platform>("android");
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);

  // Active pairing code
  const [code, setCode] = useState<PairingCodeInfo | null>(null);
  const [status, setStatus] = useState<PairingCodeStatus | null>(null);

  const platformInfo = PLATFORM_OPTIONS.find((p) => p.id === platform)!;

  // WARP-650: label/input associations for the pairing form fields.
  const deviceNameId = useId();
  // The platform picker is a button group, not a single labelable control
  // (<label htmlFor> only targets input/select/textarea/button etc.), so it
  // is associated via aria-labelledby on the role="group" wrapper instead —
  // the standard WCAG 1.3.1 technique for grouped controls.
  const platformGroupId = useId();

  const handleCreate = async () => {
    if (!deviceName.trim()) {
      setCreateErr("Give the device a name first.");
      return;
    }
    setCreating(true);
    setCreateErr(null);
    try {
      const res = await createPairingCode({
        deviceName: deviceName.trim(),
        deviceType: platformInfo.type,
        platform,
      });
      setCode(res);
      setStatus(null);
    } catch (e) {
      setCreateErr(e instanceof Error ? e.message : "Failed to start pairing");
    } finally {
      setCreating(false);
    }
  };

  // Poll status every 2s while a code is active. Bail when used or
  // expired. Cleanup on unmount or code-change.
  const pollRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!code) return;
    let cancelled = false;
    async function tick() {
      if (cancelled || !code) return;
      try {
        const s = await getPairingCodeStatus(code.code);
        if (cancelled) return;
        setStatus(s);
        if (s.used) {
          // Pairing claimed — small delay so the operator sees the
          // success state, then bounce to the clients list.
          setTimeout(() => router.push("/devices/clients"), 1200);
          return;
        }
        if (s.expired) return;
      } catch {
        // Transient failure; the next tick retries.
      }
    }
    void tick();
    pollRef.current = window.setInterval(tick, 2000);
    return () => {
      cancelled = true;
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [code, router]);

  const expired = status?.expired ?? false;
  const claimed = status?.used ?? false;

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <button
          onClick={() => router.push("/devices")}
          className="p-2 -ml-2 rounded-full hover:bg-surface-secondary"
          aria-label="Back to devices"
        >
          <ArrowLeft size={20} />
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="type-large-title text-label-primary">Pair a device</h1>
          <p className="type-subheadline text-label-tertiary mt-0.5">
            Open the Droplet app on your phone or laptop, then scan the code.
          </p>
        </div>
      </div>

      {!code ? (
        <div className="dp-card p-5 space-y-4">
          <div>
            <label htmlFor={deviceNameId} className="type-caption-2 text-label-tertiary uppercase tracking-wide block mb-1.5">
              Device name
            </label>
            <input
              id={deviceNameId}
              type="text"
              value={deviceName}
              onChange={(e) => setDeviceName(e.target.value)}
              maxLength={100}
              autoFocus
              placeholder="Alice's Pixel"
              className="w-full h-10 px-3 rounded-lg border border-separator bg-surface-secondary type-subheadline text-label-primary focus:border-accent focus:outline-none"
            />
            <p className="type-caption-2 text-label-tertiary mt-1">
              Helps you find this device later if you need to revoke it.
            </p>
          </div>

          <div>
            <label id={platformGroupId} className="type-caption-2 text-label-tertiary uppercase tracking-wide block mb-1.5">
              Platform
            </label>
            <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby={platformGroupId}>
              {PLATFORM_OPTIONS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setPlatform(p.id)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full type-caption-1 transition-colors ${
                    platform === p.id
                      ? "bg-accent text-white"
                      : "bg-surface-secondary text-label-secondary hover:bg-surface-tertiary"
                  }`}
                >
                  {p.type === "mobile" ? (
                    <Smartphone size={12} />
                  ) : (
                    <Laptop size={12} />
                  )}
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {createErr && (
            <p className="type-caption-1 text-system-red">{createErr}</p>
          )}

          <div className="flex justify-end">
            <button
              onClick={handleCreate}
              disabled={creating || !deviceName.trim()}
              className="dp-btn-primary flex items-center gap-2 px-3 py-2 rounded-lg type-subheadline disabled:opacity-50"
            >
              {creating ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Plus size={14} />
              )}
              {creating ? "Starting…" : "Generate pairing code"}
            </button>
          </div>
        </div>
      ) : (
        <div className="dp-card p-5 space-y-4">
          {claimed ? (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <div className="w-14 h-14 rounded-full bg-system-green/15 flex items-center justify-center">
                <Check size={28} className="text-system-green" />
              </div>
              <h2 className="type-headline text-label-primary">Paired!</h2>
              <p className="type-caption-1 text-label-tertiary">
                Heading to your devices…
              </p>
            </div>
          ) : expired ? (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <h2 className="type-headline text-system-red">Code expired</h2>
              <p className="type-caption-1 text-label-tertiary">
                Pairing codes are good for 10 minutes. Generate a new one to
                try again.
              </p>
              <button
                onClick={() => {
                  setCode(null);
                  setStatus(null);
                }}
                className="dp-btn-secondary flex items-center gap-2 px-3 py-2 rounded-lg type-subheadline"
              >
                <RefreshCw size={14} />
                Generate new code
              </button>
            </div>
          ) : (
            <>
              <div className="flex flex-col items-center gap-4">
                <div className="bg-white p-4 rounded-xl">
                  <QRCodeSVG value={code.pairUrl} size={208} level="M" />
                </div>
                <div className="text-center">
                  <p className="type-caption-2 text-label-tertiary uppercase tracking-wide mb-1">
                    Manual code
                  </p>
                  <div className="flex items-center justify-center gap-2">
                    <span className="type-large-title text-label-primary font-mono tracking-wider">
                      {code.code}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        navigator.clipboard.writeText(code.code).catch(() => {})
                      }
                      title="Copy code"
                      className="p-1.5 rounded text-label-tertiary hover:text-label-primary hover:bg-surface-secondary"
                    >
                      <Copy size={14} />
                    </button>
                  </div>
                </div>
              </div>

              <div className="border-t border-separator pt-4 space-y-1">
                <p className="type-subheadline text-label-primary text-center">
                  Open the Droplet app on your{" "}
                  <span className="font-medium capitalize">{platform}</span>{" "}
                  device
                </p>
                <p className="type-caption-1 text-label-tertiary text-center">
                  Choose &ldquo;Pair with server&rdquo; and either scan the QR
                  or type the code by hand.
                </p>
                <p className="type-caption-2 text-label-tertiary text-center font-mono mt-2 break-all">
                  {code.pairUrl}
                </p>
                <div className="flex items-center justify-center gap-1 type-caption-2 text-label-tertiary mt-2">
                  <Loader2 size={10} className="animate-spin" />
                  Waiting for device…
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
