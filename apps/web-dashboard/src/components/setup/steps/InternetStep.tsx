"use client";

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  AlertCircle,
  ChevronRight,
  Eye,
  EyeOff,
  Globe,
  Lock,
  ShieldCheck,
  Wifi,
} from "lucide-react";
import {
  confirmNetworkCommand,
  fetchDuckDnsStatus,
  fetchNetworkOperation,
  routerUnreachableNotice,
  setDuckDnsConfig,
  setWifiPassword,
  setWifiSsid,
} from "@/lib/api";
import type { DuckDnsStatus } from "@/lib/types";
import { StepShell } from "@/components/setup/StepShell";
import { LearnMoreCard } from "@/components/setup/LearnMoreCard";

/**
 * Wizard step — "Set up your network" (WARP-657).
 *
 * Two sections:
 *
 *   A · Home Wi-Fi — OPTIONAL (WARP-809). The box always runs its own local
 *       network for connected gear (switch, cameras); it does NOT have to be the
 *       home router. Many deployments coexist on an existing network. So this
 *       section is collapsed by default behind an "Add a Wi-Fi network"
 *       disclosure and tagged "Optional" — the customer broadcasts a Wi-Fi from
 *       the Droplet only if they want to. When opened and an SSID is entered, it
 *       wires the existing network endpoints: POST /api/network/wifi/ssid
 *       (Tier 1) then POST /api/network/wifi/password (Tier 2 — may return a 202
 *       `confirmation_required` we auto-confirm, because the "Save and continue"
 *       click is itself the consent; there's no extra modal). Validation mirrors
 *       the routing service's Pydantic schema in `services/routing/schemas.py`:
 *       SSID 1–32 chars, PSK 8–63 chars. Left collapsed (or opened-but-blank) =
 *       skipped: no Wi-Fi write happens and the box stays reachable either way.
 *
 *       Safety net (WARP-809): WARP-808's hostapd write-fix is parked, so on the
 *       single-box shape an SSID write still 500s with code ROLLED_BACK — which
 *       is NOT in ROUTER_UNREACHABLE_CODES, so the WARP-807 routerUnreachable
 *       notice doesn't catch it. A failed Wi-Fi write therefore surfaces its own
 *       calm, actionable notice ("Couldn't set up the Droplet's Wi-Fi right
 *       now — you can skip this and set it later from Network") instead of the
 *       raw "Set SSID: 500 Internal Server Error".
 *
 *   B · Internet address · DuckDNS — unchanged. The customer signs up for a
 *       free DuckDNS account (their own, not a Droplet cloud feature) and
 *       pastes the subdomain + token. We store it on the OpenWrt side via
 *       PUT /api/ddns/duckdns; the subsequent VPN step uses the resulting
 *       `<subdomain>.duckdns.org` as the WireGuard endpoint.
 *
 * Skippable. If the customer skips, the VPN step downstream surfaces a
 * "set up internet first" view and points back here. That's by design — we
 * don't block setup on getting a DuckDNS account, but the VPN flow can't
 * issue a working .conf without one.
 *
 * DuckDNS validation mirrors the orchestrator's Zod schema in
 * `apps/orchestrator/src/routes/ddns.ts`:
 *   subdomain: /^[a-z0-9-]+$/, no leading/trailing hyphen, 1–63 chars
 *   token: 10–128 chars
 */

/** Mirrors `services/routing/schemas.py` SetSsidRequest / SetPasswordRequest. */
const SSID_MAX = 32;
const PSK_MIN = 8;
const PSK_MAX = 63;

/**
 * Section divider label — a Lucide icon + an uppercase caption. Ports the
 * mock's `WizSectionLabel` helper into product tokens (`type-caption-1`,
 * `text-label-secondary`, accent icon) — no inline styles, no raw hex.
 */
function SectionLabel({
  icon: Icon,
  children,
}: {
  icon: typeof Wifi;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <Icon size={15} className="text-accent flex-shrink-0" aria-hidden="true" />
      <span className="type-caption-1 font-bold uppercase tracking-[0.06em] text-label-secondary">
        {children}
      </span>
    </div>
  );
}

export function InternetStep({
  onComplete,
  onSkip,
}: {
  // VpnStep re-fetches the live endpoint via `fetchVpnStatus()` on
  // mount, so the parent doesn't need to thread the subdomain through.
  onComplete: () => void;
  onSkip: () => void;
}) {
  // --- Home Wi-Fi (Section A) ---
  // WARP-809: optional + collapsed by default. The box runs its own LAN
  // regardless; broadcasting a Wi-Fi is opt-in. `wifiExpanded` gates whether the
  // SSID/password fields are mounted at all — collapsed means the customer
  // can't accidentally trigger the box's Wi-Fi write.
  const [wifiExpanded, setWifiExpanded] = useState(false);
  const [ssid, setSsid] = useState("");
  const [wifiPassword, setWifiPasswordValue] = useState("");
  const [showWifiPassword, setShowWifiPassword] = useState(false);

  // --- DuckDNS (Section B) ---
  const [subdomain, setSubdomain] = useState("");
  const [token, setToken] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [existing, setExisting] = useState<DuckDnsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // WARP-807: a router-reachability notice is a soft "do this later" state, not
  // a destructive validation error — render it in the calmer amber tone (like
  // the VPN step's "Internet not finished" gate) rather than alarm-red.
  const [errorTone, setErrorTone] = useState<"error" | "notice">("error");
  // WARP-809: which amber "notice" to render. "router-unreachable" is the
  // WARP-807 503/UNREACHABLE case (covers DuckDNS + Wi-Fi alike); "wifi-write"
  // is the parked-hostapd ROLLED_BACK/500 case that the unreachable classifier
  // does NOT catch, so it needs its own actionable, Wi-Fi-specific copy. Only
  // meaningful while `errorTone === "notice"`.
  const [noticeKind, setNoticeKind] = useState<
    "router-unreachable" | "wifi-write"
  >("router-unreachable");
  // When the tone is "notice", the surface name to monospace inside the
  // sentence (e.g. "Network"). Kept separate from `error` (the prefix text) so
  // the destination can render as its own <span className="font-mono">.
  const [noticeDestination, setNoticeDestination] = useState<string | null>(null);
  // The dashboard surface this step's settings live on. Surfaced in the
  // unreachable notice ("…finish this from Network later") so we send the
  // customer to the page that actually has the Wi-Fi/DuckDNS controls — NOT
  // Settings (WARP-807 UX review). Rendered monospaced, like the LearnMoreCards.
  const NETWORK_DESTINATION = "Network";

  // Load any prior DuckDNS config so we can pre-fill the form (and let
  // the customer know they don't have to redo the work). 403 just means
  // the auth context hasn't fully hydrated yet — treat as "no config".
  const load = useCallback(async () => {
    try {
      const status = await fetchDuckDnsStatus();
      setExisting(status);
      if (status.configured) {
        setSubdomain(status.subdomain);
        setEnabled(status.enabled);
      }
    } catch {
      // Non-fatal — render the form as if unconfigured.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function validate(): string | null {
    // Section A — Home Wi-Fi. Optional: only validate when an SSID is entered.
    // We mirror the routing service so the box never sees a payload hostapd
    // would reject (SSID 1–32, PSK 8–63).
    const wifiName = ssid.trim();
    if (wifiName) {
      if (wifiName.length > SSID_MAX)
        return `Network name (SSID) must be ${SSID_MAX} characters or fewer.`;
      // The password is required once a network name is set — a broadcast
      // network with no key isn't something we'll push.
      if (wifiPassword.length < PSK_MIN)
        return `Wi-Fi password must be at least ${PSK_MIN} characters.`;
      if (wifiPassword.length > PSK_MAX)
        return `Wi-Fi password must be ${PSK_MAX} characters or fewer.`;
    }

    // Section B — DuckDNS. Optional too: a blank subdomain means "skip the
    // address for now" (the customer can still set Wi-Fi). Only validate the
    // DuckDNS fields when a subdomain is present.
    const sub = subdomain.trim();
    if (sub) {
      if (sub.length > 63) return "Subdomain must be 63 characters or fewer.";
      if (!/^[a-z0-9-]+$/.test(sub))
        return "Subdomain can only contain lowercase letters, numbers, and hyphens.";
      if (sub.startsWith("-") || sub.endsWith("-"))
        return "Subdomain can't start or end with a hyphen.";

      // Token is required unless we're keeping a previously-stored one
      // (existing.configured && tokenSet) and the user hasn't typed anything.
      const tok = token.trim();
      const keepingStored =
        existing?.configured === true &&
        existing.tokenSet === true &&
        tok.length === 0;
      if (!keepingStored) {
        if (tok.length < 10)
          return "Paste the DuckDNS token from your account (at least 10 characters).";
        if (tok.length > 128)
          return "That token is longer than expected. Double-check you copied it cleanly.";
      }
    }
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
    // The orchestrator returns { status: "confirmation_required", operation,
    // confirmationToken } at 202 for the Tier-2 password change (the radio
    // restart drops every connected device). `res.ok` is true for 202 so the
    // client doesn't throw — we drive the confirm + poll dance here.
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
      if (op.state === "rolled_back" || op.state === "unknown") {
        throw new Error(
          op.reason ??
            "The Wi-Fi change didn't take. Re-check the network and try again.",
        );
      }
      if (Date.now() - startedAt > 70_000) {
        throw new Error("Timed out waiting for the router to apply the Wi-Fi change.");
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
    setSaving(true);
    try {
      // Section A — Home Wi-Fi. Optional (WARP-809): only attempted when the
      // section was opened AND an SSID was entered. Its own try/catch so a write
      // failure surfaces the Wi-Fi-specific actionable notice (the ROLLED_BACK/
      // 500 from parked-WARP-808 is NOT caught by routerUnreachableNotice) and
      // stops the flow before DuckDNS / onComplete — rather than letting a raw
      // "Set SSID: 500" reach the shared handler.
      const wifiName = wifiExpanded ? ssid.trim() : "";
      if (wifiName) {
        try {
          await applyWifi(wifiName);
        } catch (wifiErr) {
          // Router unreachable applies to Wi-Fi too — keep the WARP-807 notice.
          const unreachable = routerUnreachableNotice(wifiErr, NETWORK_DESTINATION);
          if (unreachable) {
            setErrorTone("notice");
            setNoticeKind("router-unreachable");
            setError(unreachable.prefix);
            setNoticeDestination(unreachable.destination);
          } else {
            // Parked-hostapd ROLLED_BACK / any other Wi-Fi write failure: calm,
            // actionable, Wi-Fi-specific copy instead of the raw server error.
            setErrorTone("notice");
            setNoticeKind("wifi-write");
            setNoticeDestination(NETWORK_DESTINATION);
            setError(null);
          }
          return;
        }
      }

      // Section B — DuckDNS (only when a subdomain was entered). Keeps the
      // existing submit + "keep stored token" path verbatim.
      const sub = subdomain.trim();
      if (sub) {
        // "Keep stored" path: omit `token` from the request entirely. The
        // orchestrator's Zod schema + the routing service's Pydantic schema
        // both treat `token` as optional and preserve the existing password
        // when it's missing. The earlier `token: "stored"` sentinel tripped
        // the min(10) check and returned 400.
        const keepStored = !token.trim() && existing?.configured === true;
        const payload: { subdomain: string; token?: string; enabled?: boolean } = {
          subdomain: sub,
          enabled,
        };
        if (!keepStored) payload.token = token.trim();
        const result = await setDuckDnsConfig(payload);
        setExisting(result);
      }

      onComplete();
    } catch (e) {
      // WARP-807: when the router/routing service is unreachable the write
      // throws a RouterStatusError (503 / UNREACHABLE). Surface the actionable
      // "finish from Settings later" notice instead of the raw error, and tone
      // it as a soft notice. Everything else keeps its real message.
      const notice = routerUnreachableNotice(e, NETWORK_DESTINATION);
      if (notice) {
        setErrorTone("notice");
        setNoticeKind("router-unreachable");
        setError(notice.prefix);
        setNoticeDestination(notice.destination);
      } else {
        setErrorTone("error");
        setError(
          e instanceof Error ? e.message : "Could not save. Try again in a moment.",
        );
      }
    } finally {
      setSaving(false);
    }
  }

  const alreadyConfigured = existing?.configured === true;
  // The CTA still reads "Continue" only when there's nothing new to submit:
  // DuckDNS is already configured and no new Wi-Fi or token has been typed.
  const nothingNewToSubmit =
    alreadyConfigured && token.length === 0 && ssid.trim().length === 0;

  return (
    <StepShell
      current="internet"
      title="Set up your network"
      subtitle="Give your Droplet a web address you can reach from anywhere — and, if you like, a Wi-Fi network it can broadcast."
      primary={{
        label: nothingNewToSubmit ? "Continue" : "Save and continue",
        loadingLabel: "Saving…",
        onClick: handleSave,
        isLoading: saving,
        disabled: loading,
      }}
      skip={{ label: "Skip for now", onClick: onSkip }}
    >
      {alreadyConfigured && (
        <div className="dp-card !p-3 mb-4 flex items-start gap-2">
          <Globe size={14} className="text-system-green flex-shrink-0 mt-1" />
          <div>
            <p className="type-footnote text-label-primary">
              Already set up — your Droplet is reachable at{" "}
              <span className="font-mono">{existing.fullDomain}</span>.
            </p>
            <p className="type-caption-1 text-label-tertiary mt-0.5">
              Paste a new token below to replace the stored one, or just
              continue.
            </p>
          </div>
        </div>
      )}

      {/* Section A — Home Wi-Fi · OPTIONAL (WARP-809). The box runs its own LAN
          regardless; broadcasting a Wi-Fi is opt-in, so the fields stay collapsed
          behind a disclosure and the section is tagged "Optional". */}
      <div className="flex items-center gap-2 mb-3">
        <Wifi size={15} className="text-accent flex-shrink-0" aria-hidden="true" />
        <span className="type-caption-1 font-bold uppercase tracking-[0.06em] text-label-secondary">
          Home Wi-Fi
        </span>
        <span className="type-caption-2 font-medium uppercase tracking-[0.04em] text-label-tertiary border border-separator rounded-full px-2 py-0.5">
          Optional
        </span>
      </div>

      <p className="type-footnote text-label-secondary mb-3">
        Your Droplet always runs a local network for connected gear (your switch,
        cameras). If you&rsquo;d also like it to broadcast its own Wi-Fi for
        devices to join, add it here. Already on a home network? Skip this — your
        Droplet stays reachable either way.
      </p>

      <button
        type="button"
        onClick={() => setWifiExpanded((open) => !open)}
        aria-expanded={wifiExpanded}
        aria-controls="home-wifi-fields"
        className="flex items-center gap-2 w-full text-left type-subheadline text-label-primary rounded-md px-1 py-1.5 transition-colors duration-200 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <ChevronRight
          size={16}
          className={`flex-shrink-0 text-label-tertiary transition-transform duration-200 ${
            wifiExpanded ? "rotate-90" : ""
          }`}
          aria-hidden="true"
        />
        Add a Wi-Fi network
      </button>

      {wifiExpanded && (
        <div id="home-wifi-fields" className="space-y-4 mt-3">
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
              />
            </div>
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
              how to get back on. Lives inside the (WARP-809) opt-in disclosure
              and shows only once a network name is entered — an empty section
              changes nothing. Calm amber advisory — same tokens as the WARP-807
              unreachable notice (text-label-primary on a system-orange wash,
              vivid AlertCircle), role=status/polite so a screen reader hears it
              without an alert. */}
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
        </div>
      )}

      {/* Thin divider between the two sections */}
      <div className="my-5 h-px bg-separator" />

      {/* Section B — Internet address · DuckDNS (unchanged behavior) */}
      <SectionLabel icon={Globe}>Internet address · DuckDNS</SectionLabel>
      <div className="space-y-4">
        <div>
          <label className="type-subheadline text-label-secondary block mb-1.5">
            Subdomain
          </label>
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Globe
                size={16}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-label-tertiary"
                aria-hidden="true"
              />
              <input
                type="text"
                value={subdomain}
                onChange={(e) => setSubdomain(e.target.value.toLowerCase())}
                placeholder="yourstudio"
                className="dp-input pl-10"
                maxLength={63}
                autoCapitalize="none"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <span className="type-footnote text-label-tertiary whitespace-nowrap">
              .duckdns.org
            </span>
          </div>
        </div>

        <div>
          <label className="type-subheadline text-label-secondary block mb-1.5">
            Token
            {alreadyConfigured && existing.tokenSet && (
              <span className="text-label-tertiary"> (replace, optional)</span>
            )}
          </label>
          <div className="relative">
            <Lock
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-label-tertiary"
              aria-hidden="true"
            />
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={
                alreadyConfigured && existing.tokenSet
                  ? "•••••• (stored)"
                  : "Paste your DuckDNS token"
              }
              className="dp-input pl-10"
              autoComplete="off"
            />
          </div>
        </div>

        <label className="flex items-center gap-2 type-footnote text-label-secondary cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="rounded"
          />
          Keep the address up to date automatically
        </label>
      </div>

      {errorTone === "notice" && (
        // Soft "do this later" notice. WARP-807 UX review:
        //  · a11y — role="status"/aria-live="polite" so a screen reader hears it
        //    without interrupting (a bare <div> was silent before).
        //  · contrast — the message text is text-label-primary (≈19:1 on the
        //    amber wash) instead of text-system-orange (~2:1, failed AA). The
        //    AlertCircle glyph stays vivid system-orange to keep the amber
        //    semantic; non-text contrast doesn't gate a paired decorative icon.
        // WARP-809: two variants share this calm amber treatment —
        //  · router-unreachable (WARP-807): "…finish this from <Network> later."
        //  · wifi-write (parked-WARP-808 ROLLED_BACK/500): a Wi-Fi-specific
        //    "couldn't set it up, you can skip + do it later from <Network>"
        //    so the customer never sees a raw "Set SSID: 500".
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
          {noticeKind === "wifi-write" ? (
            <span>
              Couldn&rsquo;t set up the Droplet&rsquo;s Wi-Fi right now — you can
              skip this and set it later from{" "}
              <span className="font-mono">{noticeDestination}</span>.
            </span>
          ) : (
            <span>
              {error}{" "}
              <span className="font-mono">{noticeDestination}</span> later.
            </span>
          )}
        </div>
      )}

      {error && errorTone === "error" && (
        // Hard validation/write failure — urgent, so role="alert" (assertive).
        // Pre-existing red tone retained.
        <div
          role="alert"
          className="mt-4 flex items-start gap-2 type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2"
        >
          <AlertCircle size={14} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      <LearnMoreCard helpAnchor="internet">
        <p>
          <strong>Home Wi-Fi is optional.</strong> Your Droplet always runs a
          local network for connected gear (your switch, cameras). If you&rsquo;d
          also like it to broadcast its own Wi-Fi for devices to join, name it
          here (a password of 8 characters or more). Already on a home network?
          Skip this — your Droplet stays reachable either way.
        </p>
        <p>
          <strong>DuckDNS</strong> then gives the box a permanent address on the
          internet — like{" "}
          <span className="font-mono">yourstudio.duckdns.org</span> — that keeps
          working even when your home internet&rsquo;s address changes. The VPN
          step in a moment uses this name so your phone can find the Droplet when
          you&rsquo;re away.
        </p>
        <p>
          Don&rsquo;t have a DuckDNS account?{" "}
          <a
            href="https://www.duckdns.org/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent hover:underline"
          >
            Sign up free at duckdns.org
          </a>
          {" "}— it takes a minute. You sign in with a Google, GitHub, Reddit,
          or Twitter account, pick a subdomain, and copy the token.
        </p>
      </LearnMoreCard>
    </StepShell>
  );
}
