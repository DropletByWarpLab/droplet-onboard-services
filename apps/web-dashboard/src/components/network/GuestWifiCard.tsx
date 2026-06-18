"use client";

import { useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  ShieldCheck,
  Users,
} from "lucide-react";
import {
  confirmNetworkCommand,
  createGuestWifi,
  fetchNetworkOperation,
  RouterStatusError,
  routerUnreachableNotice,
} from "@/lib/api";

/**
 * Guest Wi-Fi setup (Droplet Design System · Network · Simple).
 *
 * Stands up an isolated guest network: its own SSID on a separate firewall zone
 * — guests get internet only, never reach into the household LAN. Wired to
 * POST /api/network/wifi/guest → routing service POST /wireless/guest. Creating
 * it is Tier 2 (a new broadcasting SSID + zone), so the orchestrator may answer
 * 202 `confirmation_required`; the Save click is the consent, mirroring
 * WifiSettingsForm's password write. Validation mirrors
 * services/routing/schemas.py CreateGuestNetworkRequest (SSID 1–32, PSK 8–63).
 *
 * Disable/QR/scheduled-reset aren't surfaced — the routing service exposes guest
 * creation only today; those need device-bridge endpoints that don't exist yet.
 */

const SSID_MAX = 32;
const PSK_MIN = 8;
const PSK_MAX = 63;

type Status =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "applied" }
  | { kind: "error"; message: string }
  | { kind: "notice"; message: string };

export function GuestWifiCard() {
  const [ssid, setSsid] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  function validate(): string | null {
    const name = ssid.trim();
    if (!name) return "Enter a guest network name (SSID).";
    if (name.length > SSID_MAX)
      return `Guest network name (SSID) must be ${SSID_MAX} characters or fewer.`;
    if (password.length < PSK_MIN)
      return `Guest password must be at least ${PSK_MIN} characters.`;
    if (password.length > PSK_MAX)
      return `Guest password must be ${PSK_MAX} characters or fewer.`;
    return null;
  }

  async function pollOperation(operationId: string): Promise<void> {
    const startedAt = Date.now();
    for (;;) {
      const op = await fetchNetworkOperation(operationId);
      if (op.state === "applied") return;
      if (op.state === "rejected") {
        throw new Error(
          op.reason ??
            "The router didn't accept the guest network, so nothing was changed.",
        );
      }
      if (op.state === "rolled_back" || op.state === "unknown") {
        throw new Error(
          op.reason ?? "The guest network didn't take. Try again.",
        );
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
      if (
        result.status === "confirmation_required" &&
        result.confirmationToken &&
        result.operation
      ) {
        const { operationId } = await confirmNetworkCommand(
          result.confirmationToken,
          result.operation,
        );
        if (operationId) await pollOperation(operationId);
      }
      setStatus({ kind: "applied" });
    } catch (e) {
      if (routerUnreachableNotice(e, "Network")) {
        setStatus({
          kind: "notice",
          message:
            "Your router isn't reachable right now — try again in a moment.",
        });
      } else if (
        e instanceof RouterStatusError &&
        (e.status === 400 || e.status === 422) &&
        e.message.trim().length > 0
      ) {
        setStatus({ kind: "error", message: e.message });
      } else if (
        !(e instanceof RouterStatusError) &&
        e instanceof Error &&
        e.message.trim().length > 0
      ) {
        setStatus({ kind: "error", message: e.message });
      } else {
        setStatus({
          kind: "notice",
          message: "Couldn't set up guest Wi-Fi right now. Try again in a moment.",
        });
      }
    }
  }

  const saving = status.kind === "saving";

  return (
    <div className="dp-card">
      <div className="flex items-center gap-2 mb-1">
        <Users size={18} className="text-label-tertiary" />
        <h3 className="type-headline text-label-primary">Guest Wi-Fi</h3>
      </div>
      <p className="type-subheadline text-label-tertiary mb-3">
        A separate network for visitors. Guests get internet only — they can&apos;t
        reach your devices, cameras or files.
      </p>

      <div className="flex items-center gap-1.5 mb-4 type-caption-1 text-system-green">
        <ShieldCheck size={14} />
        <span>Isolated from your main network</span>
      </div>

      <div className="space-y-4 max-w-md">
        <div>
          <label
            htmlFor="guest-ssid"
            className="type-subheadline text-label-secondary block mb-1.5"
          >
            Guest network name (SSID)
          </label>
          <div className="relative">
            <Users
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-label-tertiary"
              aria-hidden="true"
            />
            <input
              id="guest-ssid"
              type="text"
              value={ssid}
              onChange={(e) => setSsid(e.target.value)}
              placeholder="Studio Guest"
              className="dp-input pl-10"
              maxLength={SSID_MAX}
              autoComplete="off"
              spellCheck={false}
              disabled={saving}
            />
          </div>
        </div>

        <div>
          <label
            htmlFor="guest-password"
            className="type-subheadline text-label-secondary block mb-1.5"
          >
            Guest password
          </label>
          <div className="relative">
            <Lock
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-label-tertiary"
              aria-hidden="true"
            />
            <input
              id="guest-password"
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
              className="dp-input pl-10 pr-10"
              maxLength={PSK_MAX}
              autoComplete="off"
              disabled={saving}
            />
            <button
              type="button"
              onClick={() => setShowPassword((s) => !s)}
              aria-label={showPassword ? "Hide guest password" : "Show guest password"}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-label-tertiary transition-colors duration-200 hover:text-label-secondary"
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </div>

        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="dp-btn-primary flex items-center gap-2"
        >
          {saving && <Loader2 size={16} className="animate-spin" />}
          {saving ? "Setting up…" : "Set up guest Wi-Fi"}
        </button>
      </div>

      {status.kind === "applied" && (
        <div
          role="status"
          className="mt-4 flex items-start gap-2 type-footnote text-label-primary bg-system-green/10 rounded-sm px-3 py-2"
        >
          <CheckCircle2
            size={14}
            className="mt-0.5 flex-shrink-0 text-system-green"
            aria-hidden="true"
          />
          <span>Guest Wi-Fi is on. Share the name and password with visitors.</span>
        </div>
      )}

      {status.kind === "notice" && (
        <div
          role="status"
          aria-live="polite"
          className="mt-4 flex items-start gap-2 type-footnote text-label-primary bg-system-orange/10 rounded-sm px-3 py-2"
        >
          <AlertCircle
            size={14}
            className="mt-0.5 flex-shrink-0 text-system-orange"
            aria-hidden="true"
          />
          <span>{status.message}</span>
        </div>
      )}

      {status.kind === "error" && (
        <div
          role="alert"
          className="mt-4 flex items-start gap-2 type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2"
        >
          <AlertCircle size={14} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
          <span>{status.message}</span>
        </div>
      )}
    </div>
  );
}
