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
  Plus,
  Smartphone,
} from "lucide-react";
import {
  fetchVpnStatus,
  fetchVpnPeers,
  createVpnPeer,
  routerUnreachableNotice,
} from "@/lib/api";
import type {
  VpnStatusInfo,
  VpnPeerInfo,
  VpnPeerCreatedInfo,
} from "@/lib/types";
import { StepShell } from "@/components/setup/StepShell";
import { LearnMoreCard } from "@/components/setup/LearnMoreCard";
import { ScrollRegion } from "@/components/setup/ScrollRegion";

/**
 * Wizard step — connect the customer's phone via WireGuard (remote access).
 *
 * Render-only precheck state machine (SETUP-WIZARD-SPEC §D — "render, never
 * redirect"). The precheck picks which view to render in place; it never calls
 * a navigate/redirect in an effect, so re-entering the step (via Back or the
 * clickable rail) can never bounce. Navigation away is user-initiated only.
 *
 *   loading   → GET /api/vpn/status in flight (first entry only).
 *   blocked   → endpointConfigured === false: no DuckDNS address yet. Renders a
 *               "Set up internet" button that is an ordinary back-jump
 *               (onBackToInternet → setStep("internet")) — NO redirect, NO
 *               reload (SETUP-WIZARD-SPEC §D.5).
 *   form      → endpointConfigured && no peer yet: device-name input +
 *               "Create config" mints the first peer.
 *   created   → a peer was just minted this session: QR + .conf + how-to-use.
 *               The .conf (with the private key) is one-shot.
 *   returning → endpointConfigured && a peer already exists: summarise it,
 *               "Continue" or "Add another device". Keys are NOT re-issued and
 *               the precheck renders this directly — it does not bounce
 *               (SETUP-WIZARD-SPEC §D.3 / §D.5).
 *   error     → status fetch failed: "Try again" + "Skip for now". Never
 *               auto-advances or auto-skips on error (SETUP-WIZARD-SPEC §D.3).
 *
 * Hard-gated on the Internet step (DuckDNS subdomain configured). The
 * WIREGUARD_ENDPOINT_HOST auto-derivation in vpn.ts means
 * `endpointConfigured: true` lights up the moment DuckDNS is set in the
 * Internet step — no orchestrator restart needed.
 *
 * Tier-3 reminder (llm-safety-tiers.md): VPN config is blocked for the LLM.
 * This step is by design the customer's only in-wizard path to mint their
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
  const [phase, setPhase] = useState<
    "loading" | "blocked" | "form" | "created" | "returning" | "error"
  >("loading");
  const [status, setStatus] = useState<VpnStatusInfo | null>(null);
  // Active peers already on the box — drives the `returning` summary. Fetched
  // once when status reports peers exist; never causes a key re-issue.
  const [existingPeers, setExistingPeers] = useState<VpnPeerInfo[]>([]);
  const [deviceLabel, setDeviceLabel] = useState("");
  const [created, setCreated] = useState<VpnPeerCreatedInfo | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // WARP-807: a router-reachability notice is a soft "do this later" state —
  // render it in amber (matching the blocked gate) rather than alarm-red.
  const [errorTone, setErrorTone] = useState<"error" | "notice">("error");
  // Surface name to monospace inside the notice when the tone is "notice".
  const [noticeDestination, setNoticeDestination] = useState<string | null>(
    null,
  );
  const [copied, setCopied] = useState(false);
  // Where this step's settings live in the dashboard. WireGuard peers are
  // managed at /remote-access ("Remote Access") — that, not Settings, is where
  // we point the customer to finish later (WARP-807 UX review).
  const REMOTE_ACCESS_DESTINATION = "Remote Access";

  // Render-only precheck. Fetched once per entry into the step; NO navigation
  // happens here (SETUP-WIZARD-SPEC §D.2 — navigation is user-initiated only),
  // so returning to this step never re-fires a redirect.
  const load = useCallback(async () => {
    setPhase("loading");
    try {
      const s = await fetchVpnStatus();
      setStatus(s);
      if (!s.endpointConfigured) {
        setPhase("blocked");
        return;
      }
      // Endpoint is live. If a peer already exists this is a "returning" visit
      // (the customer came back via Back or the rail) — summarise it and never
      // re-mint the one-shot key (SETUP-WIZARD-SPEC §D.3 / §D.5).
      if ((s.peerCount ?? 0) > 0) {
        try {
          const { peers } = await fetchVpnPeers();
          const active = peers.filter((p) => p.status === "active");
          if (active.length > 0) {
            setExistingPeers(active);
            setPhase("returning");
            return;
          }
        } catch {
          // Peer list unavailable — fall through to the create form rather than
          // trapping the customer on a half-rendered returning view.
        }
      }
      setPhase("form");
    } catch {
      // Status fetch failed → render the error view with a retry. Never
      // auto-skip or bounce (SETUP-WIZARD-SPEC §D.3).
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleCreate() {
    const trimmed = deviceLabel.trim();
    if (!trimmed) {
      setErrorTone("error");
      setError("Give this device a name (e.g. \"Stefan's iPhone\")");
      return;
    }
    setError(null);
    setErrorTone("error");
    setSubmitting(true);
    try {
      const result = await createVpnPeer(trimmed);
      setCreated(result);
      setPhase("created");
    } catch (e) {
      // WARP-807: an unreachable router surfaces as a RouterStatusError
      // (503 / UNREACHABLE). Show the actionable "finish from Remote Access
      // later" notice in the soft amber tone; everything else keeps its real
      // message.
      const notice = routerUnreachableNotice(e, REMOTE_ACCESS_DESTINATION);
      if (notice) {
        setErrorTone("notice");
        setError(notice.prefix);
        setNoticeDestination(notice.destination);
      } else {
        setErrorTone("error");
        setError(e instanceof Error ? e.message : "Failed to create device");
      }
    } finally {
      setSubmitting(false);
    }
  }

  // Auto-clear the system clipboard 30 s after a successful copy. The
  // `created.conf` body is a full WireGuard config — including the peer's
  // PrivateKey — and writeText leaves it in the OS clipboard until something
  // else overwrites it. PR #232 review (Romain): "schedule a clipboard wipe and
  // surface a one-line expires-in-30s hint." 30 s is long enough to paste into
  // WireGuard's Import-from-clipboard flow, short enough to bound exposure.
  const CLIPBOARD_TTL_MS = 30_000;

  function handleCopyConf() {
    if (!created) return;
    navigator.clipboard.writeText(created.conf).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      setTimeout(() => {
        navigator.clipboard.writeText("").catch(() => {
          // Permission may have been revoked since the original write (focus
          // loss, tab background); nothing meaningful we can do.
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
  // loading — short-lived, just renders a skeleton.
  // ──────────────────────────────────────────────────────────────────
  if (phase === "loading") {
    return (
      <StepShell current="vpn" title="Connect your phone" subtitle="One moment…">
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
  // error — status fetch failed. Render in place with a retry; never
  // auto-advance or auto-skip (SETUP-WIZARD-SPEC §D.3).
  // ──────────────────────────────────────────────────────────────────
  if (phase === "error") {
    return (
      <StepShell
        current="vpn"
        title="Couldn't check remote access"
        subtitle="Something went wrong reaching the box to check your remote-access setup."
        primary={{ label: "Try again", onClick: () => load() }}
        skip={{ label: "Skip for now", onClick: onSkip }}
      >
        {/* Hard failure (status fetch died, step can't proceed) → role="alert"
            (assertive), matching the status-vs-alert split used by the form
            error below and InternetStep. Soft "do it later" notices stay
            role="status". */}
        <div className="dp-card !p-4 flex items-start gap-3" role="alert">
          <AlertCircle
            size={18}
            className="text-system-orange flex-shrink-0 mt-0.5"
            aria-hidden="true"
          />
          <p className="type-footnote text-label-secondary">
            This usually clears on its own. Try again, or skip for now — you can
            finish remote access anytime from{" "}
            <span className="font-mono">Remote Access</span> in the dashboard.
          </p>
        </div>
      </StepShell>
    );
  }

  // ──────────────────────────────────────────────────────────────────
  // blocked — Internet wasn't configured, so there's no usable endpoint to
  // mint a peer against. Render the blocked card in place; "Set up internet"
  // is a normal back-jump (no redirect, no reload — SETUP-WIZARD-SPEC §D.5).
  // ──────────────────────────────────────────────────────────────────
  if (phase === "blocked") {
    return (
      <StepShell
        current="vpn"
        title="Remote access needs an internet address first"
        subtitle="No internet address is set up yet."
        primary={{ label: "Set up internet", onClick: onBackToInternet }}
        skip={{ label: "Skip for now", onClick: onSkip }}
      >
        <div className="dp-card !p-4 flex items-start gap-3">
          <Globe
            size={18}
            className="text-system-orange flex-shrink-0 mt-0.5"
            aria-hidden="true"
          />
          <div>
            <p className="type-subheadline text-label-primary mb-1">
              Why this comes first
            </p>
            <p className="type-footnote text-label-secondary">
              Your home internet&rsquo;s address can change. DuckDNS gives the
              box one permanent web address (like{" "}
              <span className="font-mono">yourstudio.duckdns.org</span>) so your
              phone can reach it from anywhere. Set that up on the Internet step
              and this lights up automatically.
            </p>
          </div>
        </div>

        <LearnMoreCard helpAnchor="vpn">
          <p>
            You can also set this up later from{" "}
            <span className="font-mono">Remote Access</span> in the dashboard —
            the wizard isn&rsquo;t your only path.
          </p>
        </LearnMoreCard>
      </StepShell>
    );
  }

  // ──────────────────────────────────────────────────────────────────
  // returning — a peer already exists. Summarise it; do NOT re-mint or
  // re-issue the one-shot key (SETUP-WIZARD-SPEC §D.3 / §D.5).
  // ──────────────────────────────────────────────────────────────────
  if (phase === "returning") {
    return (
      <StepShell
        current="vpn"
        title="Remote access is set up"
        subtitle="Add more devices now, or anytime from Remote Access."
        primary={{ label: "Continue", onClick: onComplete, showArrow: true }}
      >
        {/* WARP-820 viewport lock: the peer list is genuinely unbounded, so it
            uses the wizard's single permitted inner-scroll surface. The title,
            "Add another device", and the Continue CTA stay pinned in StepShell;
            only this list scrolls (bounded to a viewport-relative max-height). */}
        <ScrollRegion aria-label="Connected devices" className="space-y-2">
          {existingPeers.map((p) => (
            <div key={p.id} className="dp-card !py-3 flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-accent-subtle flex items-center justify-center flex-shrink-0">
                <Smartphone
                  size={16}
                  className="text-accent"
                  aria-hidden="true"
                />
              </div>
              <div className="flex-1 min-w-0">
                <p className="type-subheadline text-label-primary truncate">
                  {p.deviceLabel}
                </p>
                {status?.endpointHost && (
                  <p className="type-caption-1 text-label-tertiary font-mono truncate">
                    {status.endpointHost}
                  </p>
                )}
              </div>
              <span className="dp-status-chip type-caption-1 !h-7 !px-2.5 flex-shrink-0">
                <Check
                  size={12}
                  className="text-system-green"
                  aria-hidden="true"
                />
                Connected
              </span>
            </div>
          ))}
        </ScrollRegion>

        <button
          type="button"
          onClick={() => {
            setError(null);
            setDeviceLabel("");
            setPhase("form");
          }}
          className="dp-btn-secondary mt-4 w-full"
        >
          <Plus size={16} aria-hidden="true" />
          Add another device
        </button>

        <LearnMoreCard helpAnchor="vpn">
          <p>
            Each device has its own WireGuard key. Keys are generated once — you
            can revoke any device anytime from{" "}
            <span className="font-mono">Remote Access</span> in the dashboard and
            its config stops working immediately.
          </p>
        </LearnMoreCard>
      </StepShell>
    );
  }

  // ──────────────────────────────────────────────────────────────────
  // form — customer types a device name, we mint the peer + .conf.
  // ──────────────────────────────────────────────────────────────────
  if (phase === "form") {
    return (
      <StepShell
        current="vpn"
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

          {error && errorTone === "notice" && (
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
              <span>
                {error}{" "}
                <span className="font-mono">{noticeDestination}</span> later.
              </span>
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

        <LearnMoreCard title="Why a name?" helpAnchor="vpn">
          <p>
            Each device that connects gets its own WireGuard key. The name is
            just a label so you can find &ldquo;Stefan&rsquo;s iPhone&rsquo;s
            connection&rdquo; in the list and revoke it later if the phone is
            lost.
          </p>
        </LearnMoreCard>
      </StepShell>
    );
  }

  // ──────────────────────────────────────────────────────────────────
  // created — peer is minted, show the QR + .conf + how-to-use list.
  // ──────────────────────────────────────────────────────────────────
  if (!created) return null;
  return (
    <StepShell
      current="vpn"
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
        <div className="p-4 bg-white rounded-lg" data-testid="vpn-qr-wrapper">
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
            Tap the toggle to <strong>Connect</strong>. You&rsquo;ll see a tiny
            VPN icon in your status bar.
          </li>
        </ol>
        <p>
          Once connected, you can reach this Droplet from anywhere — type
          <span className="font-mono"> droplet.local</span> or{" "}
          <span className="font-mono">
            {status?.endpointHost ?? "yoursubdomain.duckdns.org"}
          </span>{" "}
          in your phone&rsquo;s browser. Lose the phone? Revoke this device from{" "}
          <span className="font-mono">Remote Access</span> in the dashboard — its
          config stops working immediately.
        </p>
        <p className="type-caption-1 text-label-quaternary">
          Heads up: this code is shown once. If you close this page without
          scanning it, you can revoke and create a new one from{" "}
          <span className="font-mono">Remote Access</span> later — the old config
          will stop working.
        </p>
      </LearnMoreCard>
    </StepShell>
  );
}

// Helper retained for tests that want to assert the ready-state copy without
// rendering through the full wizard. Not used by the component itself.
export { ArrowLeft as _ArrowLeftIcon };
