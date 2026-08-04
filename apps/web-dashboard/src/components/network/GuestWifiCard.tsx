"use client";

import { useRef, useState } from "react";
import useSWR from "swr";
import { QRCodeSVG } from "qrcode.react";
import {
  AlertCircle,
  CheckCircle2,
  Copy,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  Power,
  ShieldCheck,
  Users,
} from "lucide-react";
import {
  confirmNetworkCommand,
  createGuestWifi,
  fetchGuestWifi,
  fetchNetworkOperation,
  removeGuestWifi,
  RouterStatusError,
  routerUnreachableNotice,
  type GuestWifiStatus,
} from "@/lib/api";
import { ConfirmDialog } from "@/components/ConfirmDialog";

/**
 * Guest Wi-Fi (Droplet Design System · Network · Simple).
 *
 * An isolated visitor network: its own SSID on a separate firewall zone —
 * guests get internet only, never the household LAN. Status-aware:
 *  - not configured → a setup form (SSID + password). Creating is Tier 2 (a new
 *    broadcasting SSID + zone) so it confirms-then-polls, mirroring
 *    WifiSettingsForm.
 *  - configured + on → the live network with its SSID, a revealable password, a
 *    join QR, and a one-tap turn-off (drops guests only; applies immediately).
 *
 * Wired to /api/network/wifi/guest (GET/POST/DELETE → routing /wireless/guest).
 * Validation mirrors services/routing/schemas.py (SSID 1–32, PSK 8–63). The
 * scheduled daily-reset shown in the design is a separate scheduler concern and
 * isn't built here.
 */

const SSID_MAX = 32;
const PSK_MIN = 8;
const PSK_MAX = 63;
const KEY = "/api/network/wifi/guest";

/** Wi-Fi network QR payload (RFC-ish de-facto format). Escapes \ ; , : " */
function wifiQrPayload(ssid: string, password: string): string {
  const esc = (s: string) => s.replace(/([\\;,:"])/g, "\\$1");
  return `WIFI:T:WPA;S:${esc(ssid)};P:${esc(password)};;`;
}

type Status =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "error"; message: string }
  | { kind: "notice"; message: string };

export function GuestWifiCard() {
  const { data, isLoading, mutate } = useSWR<GuestWifiStatus>(KEY, fetchGuestWifi, {
    refreshInterval: 30000,
  });

  if (isLoading && !data) {
    return <div className="card animate-pulse" style={{ height: 160, background: "var(--surface-2)" }} />;
  }

  // Honest unavailable state — this appliance shape can't provision a guest
  // network yet (single-box hostapd AP). Mirrors the UPnP card rather than
  // showing a setup form that would fail (or a fabricated "live" network).
  if (data && !data.supported) {
    return <GuestUnavailable />;
  }

  if (data?.configured && data.enabled && data.ssid) {
    return <GuestActive ssid={data.ssid} password={data.password ?? ""} onChanged={() => mutate()} />;
  }

  return <GuestSetup onConfigured={() => mutate()} />;
}

// --- Not available on this appliance shape ---
function GuestUnavailable() {
  return (
    <div className="card">
      <div className="flex items-center gap-2 mb-1">
        <Users size={18} className="text-[color:var(--text-muted)]" />
        <h3 className="type-headline text-[color:var(--text)]">Guest Wi-Fi</h3>
        <span className="type-caption-2 font-medium px-2 py-0.5 rounded-full bg-[var(--card-inner)] text-[color:var(--text-muted)]">
          Not available
        </span>
      </div>
      <p className="type-subheadline text-[color:var(--text-muted)]">
        A separate visitor network isn&apos;t available on this Droplet yet.
      </p>
    </div>
  );
}

// --- Active guest network ---
function GuestActive({
  ssid,
  password,
  onChanged,
}: {
  ssid: string;
  password: string;
  onChanged: () => void;
}) {
  const [showPassword, setShowPassword] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const offRef = useRef<HTMLButtonElement>(null);

  async function copyPassword() {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — no-op */
    }
  }

  async function turnOff() {
    setRemoving(true);
    setError(null);
    try {
      await removeGuestWifi();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't turn off guest Wi-Fi.");
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div className="card">
      <div className="flex items-center gap-2 mb-1">
        <Users size={18} className="text-system-green" />
        <h3 className="type-headline text-[color:var(--text)]">Guest Wi-Fi</h3>
        <span className="type-caption-2 font-medium px-2 py-0.5 rounded-full bg-system-green/15 text-system-green">
          On
        </span>
      </div>
      <div className="flex items-center gap-1.5 mb-4 type-caption-1 text-system-green">
        <ShieldCheck size={14} />
        <span>Isolated from your main network</span>
      </div>

      <div className="flex flex-col sm:flex-row gap-5">
        <div className="flex-1 space-y-3 min-w-0">
          <div>
            <p className="type-caption-1 text-[color:var(--text-muted)]">Network name</p>
            <p className="type-subheadline text-[color:var(--text)] font-mono truncate">{ssid}</p>
          </div>
          <div>
            <p className="type-caption-1 text-[color:var(--text-muted)]">Password</p>
            <div className="flex items-center gap-2">
              <p className="type-subheadline text-[color:var(--text)] font-mono truncate">
                {showPassword ? password : "•".repeat(Math.min(password.length, 12))}
              </p>
              <button
                type="button"
                onClick={() => setShowPassword((s) => !s)}
                aria-label={showPassword ? "Hide guest password" : "Show guest password"}
                className="text-[color:var(--text-muted)] hover:text-[color:var(--text)] transition-colors"
              >
                {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
              <button
                type="button"
                onClick={copyPassword}
                aria-label="Copy guest password"
                className="text-[color:var(--text-muted)] hover:text-[color:var(--text)] transition-colors"
              >
                {copied ? <CheckCircle2 size={15} className="text-system-green" /> : <Copy size={15} />}
              </button>
            </div>
          </div>
          <button
            ref={offRef}
            type="button"
            onClick={() => setConfirmOpen(true)}
            disabled={removing}
            className="btn ghost"
            /* `.droplet-shell .btn` pins `color` at (0,2,0), so the danger ink
               has to come from the style attribute — same as the converted
               access panel's destructive menu item. */
            style={{ color: "var(--danger)" }}
          >
            {removing ? <Loader2 size={15} className="animate-spin" /> : <Power size={15} />}
            {removing ? "Turning off…" : "Turn off guest Wi-Fi"}
          </button>
          {error && (
            <div role="alert" className="flex items-start gap-2 type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2">
              <AlertCircle size={14} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* Join QR — visitors scan to connect without typing the password. */}
        <div className="flex flex-col items-center gap-1.5">
          <div className="p-2 bg-white rounded-md">
            <QRCodeSVG value={wifiQrPayload(ssid, password)} size={120} level="M" />
          </div>
          <span className="type-caption-2 text-[color:var(--text-muted)]">Scan to join</span>
        </div>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        triggerRef={offRef}
        title="Turn off guest Wi-Fi?"
        description="Anyone currently on the guest network will be disconnected. You can set it up again any time."
        confirmLabel="Turn off"
        variant="destructive"
        onConfirm={async () => {
          setConfirmOpen(false);
          await turnOff();
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}

// --- Setup form (no guest network yet) ---
function GuestSetup({ onConfigured }: { onConfigured: () => void }) {
  const [ssid, setSsid] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  function validate(): string | null {
    const name = ssid.trim();
    if (!name) return "Enter a guest network name (SSID).";
    if (name.length > SSID_MAX) return `Guest network name (SSID) must be ${SSID_MAX} characters or fewer.`;
    if (password.length < PSK_MIN) return `Guest password must be at least ${PSK_MIN} characters.`;
    if (password.length > PSK_MAX) return `Guest password must be ${PSK_MAX} characters or fewer.`;
    return null;
  }

  async function pollOperation(operationId: string): Promise<void> {
    const startedAt = Date.now();
    for (;;) {
      const op = await fetchNetworkOperation(operationId);
      if (op.state === "applied") return;
      if (op.state === "rejected") {
        throw new Error(op.reason ?? "The router didn't accept the guest network, so nothing was changed.");
      }
      if (op.state === "rolled_back" || op.state === "unknown") {
        throw new Error(op.reason ?? "The guest network didn't take. Try again.");
      }
      if (Date.now() - startedAt > 70_000) {
        throw new Error("Timed out waiting for the router to set up guest Wi-Fi.");
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  async function handleSave() {
    const v = validate();
    if (v) {
      setStatus({ kind: "error", message: v });
      return;
    }
    setStatus({ kind: "saving" });
    try {
      const result = await createGuestWifi(ssid.trim(), password);
      if (result.status === "confirmation_required" && result.confirmationToken && result.operation) {
        const { operationId } = await confirmNetworkCommand(result.confirmationToken, result.operation);
        if (operationId) await pollOperation(operationId);
      }
      onConfigured();
    } catch (e) {
      if (routerUnreachableNotice(e, "Network")) {
        setStatus({ kind: "notice", message: "Your router isn't reachable right now — try again in a moment." });
      } else if (e instanceof RouterStatusError && (e.status === 400 || e.status === 422) && e.message.trim().length > 0) {
        setStatus({ kind: "error", message: e.message });
      } else if (!(e instanceof RouterStatusError) && e instanceof Error && e.message.trim().length > 0) {
        setStatus({ kind: "error", message: e.message });
      } else {
        setStatus({ kind: "notice", message: "Couldn't set up guest Wi-Fi right now. Try again in a moment." });
      }
    }
  }

  const saving = status.kind === "saving";

  return (
    <div className="card">
      <div className="flex items-center gap-2 mb-1">
        <Users size={18} className="text-[color:var(--text-muted)]" />
        <h3 className="type-headline text-[color:var(--text)]">Guest Wi-Fi</h3>
      </div>
      <p className="type-subheadline text-[color:var(--text-muted)] mb-3">
        A separate network for visitors. Guests get internet only — they can&apos;t
        reach your devices, cameras or files.
      </p>
      <div className="flex items-center gap-1.5 mb-4 type-caption-1 text-system-green">
        <ShieldCheck size={14} />
        <span>Isolated from your main network</span>
      </div>

      <div className="space-y-4 max-w-md">
        <div>
          <label htmlFor="guest-ssid" className="type-subheadline text-[color:var(--text-muted)] block mb-1.5">
            Guest network name (SSID)
          </label>
          <div className="relative">
            <Users size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[color:var(--text-muted)]" aria-hidden="true" />
            <input
              id="guest-ssid"
              type="text"
              value={ssid}
              onChange={(e) => setSsid(e.target.value)}
              placeholder="Studio Guest"
              className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors pl-10"
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-input)",
                color: "var(--text)",
              }}
              maxLength={SSID_MAX}
              autoComplete="off"
              spellCheck={false}
              disabled={saving}
            />
          </div>
        </div>

        <div>
          <label htmlFor="guest-password" className="type-subheadline text-[color:var(--text-muted)] block mb-1.5">
            Guest password
          </label>
          <div className="relative">
            <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[color:var(--text-muted)]" aria-hidden="true" />
            <input
              id="guest-password"
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
              className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors pl-10 pr-10"
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-input)",
                color: "var(--text)",
              }}
              maxLength={PSK_MAX}
              autoComplete="off"
              disabled={saving}
            />
            <button
              type="button"
              onClick={() => setShowPassword((s) => !s)}
              aria-label={showPassword ? "Hide guest password" : "Show guest password"}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[color:var(--text-muted)] transition-colors duration-200 hover:text-[color:var(--text)]"
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </div>

        <button type="button" onClick={handleSave} disabled={saving} className="btn primary">
          {saving && <Loader2 size={16} className="animate-spin" />}
          {saving ? "Setting up…" : "Set up guest Wi-Fi"}
        </button>
      </div>

      {status.kind === "notice" && (
        <div role="status" aria-live="polite" className="mt-4 flex items-start gap-2 type-footnote text-[color:var(--text)] bg-system-orange/10 rounded-sm px-3 py-2">
          <AlertCircle size={14} className="mt-0.5 flex-shrink-0 text-system-orange" aria-hidden="true" />
          <span>{status.message}</span>
        </div>
      )}

      {status.kind === "error" && (
        <div role="alert" className="mt-4 flex items-start gap-2 type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2">
          <AlertCircle size={14} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
          <span>{status.message}</span>
        </div>
      )}
    </div>
  );
}
