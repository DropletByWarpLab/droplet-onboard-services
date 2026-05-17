"use client";

import { useCallback, useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  AlertCircle,
  ArrowLeft,
  Copy,
  Check,
  Download,
  Globe,
  Smartphone,
} from "lucide-react";
import { fetchVpnStatus, createVpnPeer } from "@/lib/api";
import type { VpnStatusInfo, VpnPeerCreatedInfo } from "@/lib/types";
import { StepShell } from "@/components/setup/StepShell";
import { LearnMoreCard } from "@/components/setup/LearnMoreCard";

/**
 * Wizard step — connect the customer's phone via WireGuard.
 *
 * Hard-gated on the Internet step (DuckDNS subdomain configured). The
 * commit-4 WIREGUARD_ENDPOINT_HOST auto-derivation in vpn.ts means
 * `endpointConfigured: true` lights up the moment DuckDNS is set in the
 * Internet step — no orchestrator restart needed. If the customer
 * skipped Internet, this step shows a "set up Internet first" view
 * that bounces them back; we don't try to mint a peer that the phone
 * can't dial.
 *
 * State machine:
 *
 *   gate     → /api/vpn/status (loading)
 *      ↓
 *   preCheck → endpointConfigured: false. Two actions: "Back to
 *              Internet" (calls onBackToInternet) or "Skip for now".
 *      ↓
 *   form     → device-name input + "Create config" CTA. Mirrors the
 *              existing /remote-access "Add a device" dialog shape so
 *              the customer recognises it later.
 *      ↓
 *   ready    → QR + .conf download + the how-to-use ordered list
 *              (install WireGuard, scan, toggle). "I'm connected —
 *              continue" advances; the customer can also "Skip" still.
 *
 * The QR + .conf are returned ONCE from POST /api/vpn/peers. The dialog
 * forgets `created` on advance — if the customer needs to re-add the
 * device they revoke + re-mint from /remote-access later.
 *
 * Tier-3 reminder (llm-safety-tiers.md): VPN config is blocked for the
 * LLM. This step is by design the customer's only path to mint their
 * first peer.
 */
export function VpnStep({
  onComplete,
  onSkip,
  onBackToInternet,
}: {
  onComplete: () => void;
  onSkip: () => void;
  onBackToInternet: () => void;
}) {
  const [phase, setPhase] = useState<"gate" | "preCheck" | "form" | "ready">(
    "gate",
  );
  const [status, setStatus] = useState<VpnStatusInfo | null>(null);
  const [deviceLabel, setDeviceLabel] = useState("");
  const [created, setCreated] = useState<VpnPeerCreatedInfo | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await fetchVpnStatus();
      setStatus(s);
      setPhase(s?.endpointConfigured ? "form" : "preCheck");
    } catch {
      // Routing service down / orchestrator dev shim — surface the
      // preCheck so the customer has a path out (skip or retry).
      setPhase("preCheck");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleCreate() {
    const trimmed = deviceLabel.trim();
    if (!trimmed) {
      setError("Give this device a name (e.g. \"Stefan's iPhone\")");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const result = await createVpnPeer(trimmed);
      setCreated(result);
      setPhase("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create device");
    } finally {
      setSubmitting(false);
    }
  }

  // Auto-clear the system clipboard 30 s after a successful copy. The
  // `created.conf` body is a full WireGuard config — including the
  // peer's PrivateKey — and writeText leaves it in the OS clipboard
  // (visible to clipboard-history on macOS / Win11, other tabs, any
  // extension with clipboard permission) until something else overwrites
  // it. PR #232 review (Romain): "drop the affordance or schedule a
  // clipboard wipe and surface a one-line expires-in-30s hint." 30 s is
  // long enough to paste into WireGuard's Import-from-clipboard flow on
  // desktop, short enough to bound exposure. We also surface a countdown
  // hint next to the button so the customer isn't surprised when the
  // value disappears.
  const CLIPBOARD_TTL_MS = 30_000;

  function handleCopyConf() {
    if (!created) return;
    navigator.clipboard.writeText(created.conf).then(() => {
      setCopied(true);
      // Reset the button label after 1.5 s (unchanged).
      setTimeout(() => setCopied(false), 1500);
      // Wipe the clipboard after the TTL. We overwrite with an empty
      // string rather than calling .reset()/.clear() because not every
      // browser exposes those; writeText("") is universally supported.
      // Best-effort: if the user's already copied something else in the
      // meantime we just overwrite their newer value with empty, which
      // is mildly annoying but strictly safer than leaving the conf.
      setTimeout(() => {
        navigator.clipboard.writeText("").catch(() => {
          // Permission may have been revoked since the original write
          // (focus loss, tab background); nothing meaningful we can do.
        });
      }, CLIPBOARD_TTL_MS);
    });
  }

  function handleDownloadConf() {
    if (!created) return;
    const safeName =
      created.peer.deviceLabel.replace(/[^a-z0-9_-]+/gi, "_") || "wg-peer";
    const blob = new Blob([created.conf], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${safeName}.conf`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ──────────────────────────────────────────────────────────────────
  // Loading gate — short-lived, just renders a skeleton.
  // ──────────────────────────────────────────────────────────────────
  if (phase === "gate") {
    return (
      <StepShell title="Connect your phone" subtitle="One moment…">
        <div className="space-y-2">
          {[0, 1].map((i) => (
            <div
              key={i}
              className="dp-card !py-3 flex items-center gap-3 opacity-30"
            >
              <div className="w-9 h-9 rounded-lg bg-surface-secondary animate-pulse" />
              <div className="flex-1 space-y-1.5">
                <div className="h-3 w-32 bg-surface-secondary rounded animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      </StepShell>
    );
  }

  // ──────────────────────────────────────────────────────────────────
  // Internet wasn't configured → no usable endpoint to mint a peer
  // against. Send the customer back to the Internet step (preserves the
  // form state via the wizard's outer state machine).
  // ──────────────────────────────────────────────────────────────────
  if (phase === "preCheck") {
    return (
      <StepShell
        title="Connect your phone"
        subtitle="To set up remote access we need an internet name first."
        primary={{
          label: "Back to internet setup",
          onClick: onBackToInternet,
        }}
        skip={{ label: "Skip for now", onClick: onSkip }}
      >
        <div className="dp-card !p-4 flex items-start gap-3">
          <Globe
            size={18}
            className="text-system-orange flex-shrink-0 mt-0.5"
          />
          <div>
            <p className="type-subheadline text-label-primary mb-1">
              Internet step not finished
            </p>
            <p className="type-footnote text-label-secondary">
              Your phone needs a name to dial back to (like{" "}
              <span className="font-mono">yourstudio.duckdns.org</span>) when
              it&rsquo;s off your home Wi-Fi. Pop back to the Internet step,
              save your DuckDNS info, and the VPN step lights up
              automatically.
            </p>
          </div>
        </div>

        <LearnMoreCard helpAnchor="vpn">
          <p>
            You can also set this up later from{" "}
            <span className="font-mono">Remote Access</span> in the dashboard
            — the wizard isn&rsquo;t your only path.
          </p>
        </LearnMoreCard>
      </StepShell>
    );
  }

  // ──────────────────────────────────────────────────────────────────
  // Form — customer types a device name, we mint the peer + .conf.
  // ──────────────────────────────────────────────────────────────────
  if (phase === "form") {
    return (
      <StepShell
        title="Connect your phone"
        subtitle="Name the device you want to connect — usually your phone."
        primary={{
          label: "Create config",
          loadingLabel: "Generating…",
          onClick: handleCreate,
          isLoading: submitting,
        }}
        skip={{ label: "Skip for now", onClick: onSkip }}
      >
        <div className="space-y-4">
          <div>
            <label className="type-subheadline text-label-secondary block mb-1.5">
              Device name
            </label>
            <div className="relative">
              <Smartphone
                size={16}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-label-tertiary"
                aria-hidden="true"
              />
              <input
                type="text"
                value={deviceLabel}
                onChange={(e) => setDeviceLabel(e.target.value)}
                placeholder="Stefan's iPhone"
                className="dp-input pl-10"
                maxLength={64}
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                autoFocus
              />
            </div>
            <p className="type-caption-1 text-label-quaternary mt-1.5">
              You&rsquo;ll see this name in your devices list. The phone
              doesn&rsquo;t need to know it.
            </p>
          </div>

          {status?.endpointHost && (
            <p className="type-footnote text-label-tertiary">
              Will connect to{" "}
              <span className="font-mono">{status.endpointHost}</span>.
            </p>
          )}

          {error && (
            <div className="flex items-start gap-2 type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2">
              <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <LearnMoreCard
          title="Why a name?"
          helpAnchor="vpn"
        >
          <p>
            Each device that connects gets its own WireGuard key. The name
            is just a label so you can find &ldquo;Stefan&rsquo;s
            iPhone&rsquo;s connection&rdquo; in the list and revoke it later
            if the phone is lost.
          </p>
        </LearnMoreCard>
      </StepShell>
    );
  }

  // ──────────────────────────────────────────────────────────────────
  // Ready — peer is minted, show the QR + .conf + how-to-use list.
  // ──────────────────────────────────────────────────────────────────
  if (!created) return null;
  return (
    <StepShell
      title="Scan to connect"
      subtitle="Open WireGuard on your phone and scan this code."
      primary={{
        label: "I'm connected — continue",
        onClick: onComplete,
        showArrow: true,
      }}
      skip={{ label: "Skip for now", onClick: onSkip }}
    >
      <div className="flex justify-center mb-4">
        <div
          className="p-4 bg-white rounded-lg"
          data-testid="vpn-qr-wrapper"
        >
          <QRCodeSVG
            value={created.conf}
            size={224}
            level="M"
            includeMargin={false}
          />
        </div>
      </div>

      <div className="flex flex-col items-center justify-center gap-1 mb-5">
        <div className="flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={handleDownloadConf}
            className="dp-btn-secondary type-footnote !min-h-[36px] !py-1.5 !px-3"
          >
            <Download size={14} />
            Download .conf
          </button>
          <button
            type="button"
            onClick={handleCopyConf}
            className="dp-btn-secondary type-footnote !min-h-[36px] !py-1.5 !px-3"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        {copied && (
          <p className="type-caption-1 text-label-tertiary">
            Clipboard clears in 30 s for safety.
          </p>
        )}
      </div>

      <LearnMoreCard title="How to use this on your phone">
        <ol className="list-decimal pl-5 space-y-1.5">
          <li>
            Install{" "}
            <a
              href="https://www.wireguard.com/install/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:underline"
            >
              WireGuard
            </a>{" "}
            from the App Store or Play Store. (Free, made by the WireGuard
            project — accept no substitutes.)
          </li>
          <li>
            Open WireGuard, tap <strong>+</strong>, choose{" "}
            <strong>Scan from QR code</strong>.
          </li>
          <li>Point your phone at the QR code above.</li>
          <li>
            Tap the toggle to <strong>Connect</strong>. You&rsquo;ll see a
            tiny VPN icon in your status bar.
          </li>
        </ol>
        <p>
          Once connected, you can reach this Droplet from anywhere — type
          <span className="font-mono"> droplet.local</span> or{" "}
          <span className="font-mono">
            {status?.endpointHost ?? "yoursubdomain.duckdns.org"}
          </span>{" "}
          in your phone&rsquo;s browser. Lose the phone? Revoke this device
          from <span className="font-mono">Remote Access</span> in the
          dashboard — its config stops working immediately.
        </p>
        <p className="type-caption-1 text-label-quaternary">
          Heads up: this code is shown once. If you close this page without
          scanning it, you can revoke and create a new one from{" "}
          <span className="font-mono">Remote Access</span> later — the old
          config will stop working.
        </p>
      </LearnMoreCard>
    </StepShell>
  );
}

// Helper retained for tests that want to assert the ready-state copy
// without rendering through the full wizard. Not used by the component
// itself.
export { ArrowLeft as _ArrowLeftIcon };
