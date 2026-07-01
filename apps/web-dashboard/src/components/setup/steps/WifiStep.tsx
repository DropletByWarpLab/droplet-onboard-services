"use client";

import { useState } from "react";
import { AlertCircle, Eye, EyeOff, Lock, ShieldCheck, Wifi } from "lucide-react";
import {
  confirmNetworkCommand,
  fetchNetworkOperation,
  RouterStatusError,
  routerUnreachableNotice,
  setWifiPassword,
  setWifiSsid,
} from "@/lib/api";
import { StepShell } from "@/components/setup/StepShell";
import { LearnMoreCard } from "@/components/setup/LearnMoreCard";

/**
 * Wizard step — "Set up your home Wi-Fi" (Onboarding-Flow redesign,
 * WIFI-ADDRESS-THEME-HANDOFF §1a).
 *
 * The old single "Internet" step mixed two unrelated things — the LOCAL Wi-Fi
 * the box broadcasts and the secure address the box gives itself that powers
 * REMOTE access. Customers conflated them, so the redesign splits them into two
 * ordered steps. This is the first half: the local home network only. The
 * secure address is now its own `address` step (`AddressStep.tsx`).
 *
 * The Wi-Fi the box can broadcast is OPTIONAL (WARP-809): the Droplet always
 * runs its own local network for connected gear (switch, cameras); broadcasting
 * a joinable Wi-Fi is opt-in, and many homes keep the box on an existing
 * network. So this step is fully skippable — leaving the fields blank writes
 * nothing and the box stays reachable either way. Because Wi-Fi now has the
 * whole step to itself (no longer a cramped section behind a disclosure), the
 * fields render directly; skipping is the footer "Skip" action.
 *
 * Single-box write path (WARP-808): the Droplet IS the AP, so the write goes
 * through the host hostapd — the orchestrator stages the SSID
 * (POST /api/network/wifi/ssid, Tier 1), then the password write
 * (POST /api/network/wifi/password, Tier 2) applies both via the device-bridge
 * and may return a 202 `confirmation_required` we auto-confirm (the "Save and
 * continue" click is the consent). Validation mirrors the routing service's
 * Pydantic schema (`services/routing/schemas.py`): SSID 1–32, PSK 8–63. The
 * calm error ladder (WARP-807/809) is preserved: an unreachable router → "finish
 * from Network later"; a 4xx validation refusal → the specific, fixable reason;
 * any other write failure → a calm Wi-Fi-specific "skip and do it later".
 */

/** Mirrors `services/routing/schemas.py` SetSsidRequest / SetPasswordRequest. */
const SSID_MAX = 32;
const PSK_MIN = 8;
const PSK_MAX = 63;

export function WifiStep({
  onComplete,
  onSkip,
}: {
  onComplete: () => void;
  onSkip: () => void;
}) {
  const [ssid, setSsid] = useState("");
  const [wifiPassword, setWifiPasswordValue] = useState("");
  const [showWifiPassword, setShowWifiPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // WARP-807: a router-reachability problem is a soft "do this later" notice
  // (amber), not a destructive validation error (red).
  const [errorTone, setErrorTone] = useState<"error" | "notice">("error");
  // Which amber notice to render. "router-unreachable" is the WARP-807
  // 503/UNREACHABLE case; "wifi-write" is the parked-hostapd ROLLED_BACK/500
  // case the unreachable classifier does NOT catch, so it gets its own
  // actionable Wi-Fi-specific copy. Only meaningful while tone === "notice".
  const [noticeKind, setNoticeKind] = useState<
    "router-unreachable" | "wifi-write"
  >("router-unreachable");
  // The dashboard surface to monospace inside the notice — Network, the page
  // that actually has the Wi-Fi controls (WARP-807 UX review).
  const NETWORK_DESTINATION = "Network";

  function validate(): string | null {
    const wifiName = ssid.trim();
    if (!wifiName) return null; // blank = skip; nothing to validate or write.
    if (wifiName.length > SSID_MAX)
      return `Network name (SSID) must be ${SSID_MAX} characters or fewer.`;
    // A broadcast network with no key isn't something we'll push.
    if (wifiPassword.length < PSK_MIN)
      return `Wi-Fi password must be at least ${PSK_MIN} characters.`;
    if (wifiPassword.length > PSK_MAX)
      return `Wi-Fi password must be ${PSK_MAX} characters or fewer.`;
    return null;
  }

  /**
   * Push the Home Wi-Fi config to the router. SSID first (Tier 1, applies
   * immediately), then the password (Tier 2). If the password POST resolves to
   * a 202 `confirmation_required`, auto-confirm — the "Save and continue" click
   * is the consent — and poll the operation until it leaves the pending state.
   * Throws on failure so `handleSave` can surface an inline error.
   */
  async function applyWifi(wifiName: string) {
    await setWifiSsid(wifiName);
    const pwResult = await setWifiPassword(wifiPassword);
    if (
      pwResult.status === "confirmation_required" &&
      pwResult.confirmationToken &&
      pwResult.operation
    ) {
      const { operationId } = await confirmNetworkCommand(
        pwResult.confirmationToken,
        pwResult.operation,
      );
      if (operationId) {
        await pollOperation(operationId);
      }
    }
  }

  /**
   * Poll the operation record until it reaches a terminal state. Capped at
   * ~70s (safe-apply's 60s rollback window + slack), matching the network
   * page's WARP-40 loop. A rollback or an indeterminate "unknown" surfaces as
   * an error so the customer never trusts a Wi-Fi change that didn't land.
   */
  async function pollOperation(operationId: string): Promise<void> {
    const startedAt = Date.now();
    for (;;) {
      const op = await fetchNetworkOperation(operationId);
      if (op.state === "applied") return;
      if (
        op.state === "rolled_back" ||
        op.state === "unknown" ||
        op.state === "rejected"
      ) {
        throw new Error(
          op.reason ??
            "The Wi-Fi change didn't take. Re-check the network and try again.",
        );
      }
      if (Date.now() - startedAt > 70_000) {
        throw new Error(
          "Timed out waiting for the router to apply the Wi-Fi change.",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  async function handleSave() {
    const v = validate();
    if (v) {
      setErrorTone("error");
      setError(v);
      return;
    }
    setError(null);
    setErrorTone("error");

    const wifiName = ssid.trim();
    // Blank = the customer is moving on without broadcasting a Wi-Fi. No write.
    if (!wifiName) {
      onComplete();
      return;
    }

    setSaving(true);
    try {
      await applyWifi(wifiName);
      onComplete();
    } catch (wifiErr) {
      const unreachable = routerUnreachableNotice(wifiErr, NETWORK_DESTINATION);
      if (unreachable) {
        setErrorTone("notice");
        setNoticeKind("router-unreachable");
        setError(unreachable.prefix);
      } else if (
        // A 4xx validation refusal from the host AP carries an actionable,
        // customer-fixable message — show it in red, not the generic notice.
        wifiErr instanceof RouterStatusError &&
        (wifiErr.status === 400 || wifiErr.status === 422) &&
        wifiErr.message.trim().length > 0
      ) {
        setErrorTone("error");
        setError(wifiErr.message);
      } else if (
        // A UCI safe-apply revert surfaces as a PLAIN Error whose message IS
        // the router's revert reason (pollOperation throws new Error(op.reason)).
        // Actionable, not a raw 500 — surface it instead of the generic notice.
        !(wifiErr instanceof RouterStatusError) &&
        wifiErr instanceof Error &&
        wifiErr.message.trim().length > 0
      ) {
        setErrorTone("error");
        setError(wifiErr.message);
      } else {
        // Parked-hostapd ROLLED_BACK / any other Wi-Fi write failure: calm,
        // actionable, Wi-Fi-specific copy instead of the raw server error.
        setErrorTone("notice");
        setNoticeKind("wifi-write");
        setError(null);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <StepShell
      current="wifi"
      title="Set up your home Wi-Fi"
      subtitle="Your Droplet can broadcast its own Wi-Fi network for your phones, laptops, and TVs to join. This is local to your home — separate from reaching the box over the internet (that's the next step)."
      primary={{
        label: ssid.trim() ? "Save and continue" : "Continue",
        loadingLabel: "Saving…",
        onClick: handleSave,
        isLoading: saving,
        showArrow: !ssid.trim(),
      }}
      skip={{ label: "Skip — I'll do this later", onClick: onSkip }}
    >
      {/* Fixed-content form (SSID + password, security chip, advisory notices,
          help card) — NOT an unbounded list, so it is NOT wrapped in a
          <ScrollRegion>. WARP-847: the onboarding split (#548) had capped this
          at 40/44dvh, which forced an inner scrollbar over the inputs with dead
          space below the card — regressing the #546 fix. The StepShell panel is
          scroll-when-needed instead (fits a normal viewport with no scrollbar;
          a viewport too short scrolls the whole panel rather than clipping). */}
      <>
        <div className="space-y-4">
          <div>
            <label className="type-subheadline text-label-secondary block mb-1.5">
              Network name (SSID)
            </label>
            <div className="relative">
              <Wifi
                size={16}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-label-tertiary"
                aria-hidden="true"
              />
              <input
                type="text"
                value={ssid}
                onChange={(e) => setSsid(e.target.value)}
                placeholder="Studio Fotonia"
                className="dp-input pl-10"
                maxLength={SSID_MAX}
                autoComplete="off"
                spellCheck={false}
                aria-describedby="wifi-ssid-hint"
              />
            </div>
            <p id="wifi-ssid-hint" className="type-caption-1 text-label-tertiary mt-1.5">
              Up to {SSID_MAX} characters.
            </p>
          </div>

          <div>
            <label className="type-subheadline text-label-secondary block mb-1.5">
              Wi-Fi password
            </label>
            <div className="relative">
              <Lock
                size={16}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-label-tertiary"
                aria-hidden="true"
              />
              <input
                type={showWifiPassword ? "text" : "password"}
                value={wifiPassword}
                onChange={(e) => setWifiPasswordValue(e.target.value)}
                placeholder="Wi-Fi password"
                className="dp-input pl-10 pr-10"
                maxLength={PSK_MAX}
                autoComplete="off"
                aria-describedby="wifi-psk-hint"
              />
              <button
                type="button"
                onClick={() => setShowWifiPassword((s) => !s)}
                aria-label={
                  showWifiPassword ? "Hide Wi-Fi password" : "Show Wi-Fi password"
                }
                className="absolute right-3 top-1/2 -translate-y-1/2 text-label-tertiary transition-colors duration-200 hover:text-label-secondary"
              >
                {showWifiPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            <p id="wifi-psk-hint" className="type-caption-1 text-label-tertiary mt-1.5">
              Use at least {PSK_MIN} characters.
            </p>
          </div>

          <div className="flex items-center gap-2 rounded-md border border-separator bg-surface-secondary px-3 py-2 type-caption-1 text-label-tertiary">
            <ShieldCheck
              size={14}
              className="text-system-green flex-shrink-0"
              aria-hidden="true"
            />
            WPA2 / WPA3 · broadcast on 2.4 &amp; 5 GHz from your Droplet
          </div>

          {/* WARP-808: on the single-box shape the Droplet IS the router, so
              changing the Wi-Fi name/key reconfigures the AP and drops every
              connected device. Warn the customer BEFORE they save and tell them
              how to get back on. Shows only once a network name is entered — an
              empty step changes nothing. Calm amber advisory, role=status so a
              screen reader hears it without an alert. */}
          {ssid.trim() && (
            <div
              role="status"
              aria-live="polite"
              aria-label="Wi-Fi change notice"
              className="flex items-start gap-2 type-caption-1 text-label-primary bg-system-orange/10 rounded-md px-3 py-2"
            >
              <AlertCircle
                size={14}
                className="mt-0.5 flex-shrink-0 text-system-orange"
                aria-hidden="true"
              />
              <span>
                Saving a new Wi-Fi name or password disconnects every device on
                your Droplet right now — including this phone. Rejoin with the new
                name and password to get back on.
              </span>
            </div>
          )}

          {errorTone === "notice" && (
            <div
              role="status"
              aria-live="polite"
              className="flex items-start gap-2 type-footnote text-label-primary bg-system-orange/10 rounded-sm px-3 py-2"
            >
              <AlertCircle
                size={14}
                className="mt-0.5 flex-shrink-0 text-system-orange"
                aria-hidden="true"
              />
              {noticeKind === "wifi-write" ? (
                <span>
                  Couldn&rsquo;t set up the Droplet&rsquo;s Wi-Fi right now — you
                  can skip this and set it later from{" "}
                  <span className="font-mono">{NETWORK_DESTINATION}</span>.
                </span>
              ) : (
                <span>
                  {error} <span className="font-mono">{NETWORK_DESTINATION}</span>{" "}
                  later.
                </span>
              )}
            </div>
          )}

          {error && errorTone === "error" && (
            <div
              role="alert"
              className="flex items-start gap-2 type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2"
            >
              <AlertCircle
                size={14}
                className="mt-0.5 flex-shrink-0"
                aria-hidden="true"
              />
              <span>{error}</span>
            </div>
          )}
        </div>

        <LearnMoreCard helpAnchor="internet">
          <p>
            <strong>Home Wi-Fi is optional.</strong> Your Droplet always runs a
            local network for connected gear (your switch, cameras). If
            you&rsquo;d also like it to broadcast its own Wi-Fi for devices to
            join, name it here with a password of 8 characters or more. Already
            on a home network? Skip this — your Droplet stays reachable either
            way.
          </p>
          <p>
            This is a <strong>local</strong> setting — the name and password your
            devices use to get online, exactly like joining any Wi-Fi. It has
            nothing to do with reaching the box from outside your home; that&rsquo;s
            the internet address on the next step.
          </p>
        </LearnMoreCard>
      </>
    </StepShell>
  );
}
