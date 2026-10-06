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
import { dashboardUrlFromConf } from "@/lib/wireguard";

/**
 * Wizard step — turn on remote access (WireGuard), one tap (WARP-979).
 *
 * Ported from the handoff's one-tap VPN step: the PRIMARY entry is a single
 * "Turn on remote access" toggle (role="switch"). Flipping it on mints the
 * first peer + surfaces the config — but presented as one tap, not a form. The
 * ADVANCED "Add another device / QR / .conf" flow is kept fully reachable
 * (behind "Add another device") so nothing is lost.
 *
 * Render-only precheck state machine (SETUP-WIZARD-SPEC §D — "render, never
 * redirect"). The precheck picks which view to render in place; it never calls a
 * navigate/redirect in an effect, so re-entering the step (via Back or the
 * clickable rail) can never bounce. Navigation away is user-initiated only.
 *
 *   loading   → GET /api/vpn/status in flight (first entry only).
 *   blocked   → neither endpoint nor discovered LAN address: show network guidance.
 *   toggle    → endpointConfigured && no peer yet: the one-tap switch. Flipping
 *               on mints the first peer with an auto-derived label.
 *   created   → a peer was just minted this session: QR + .conf + how-to-use.
 *               The .conf (with the private key) is one-shot.
 *   form      → the advanced named-device form (reached from `created`/`returning`
 *               via "Add another device"), mints an additional named peer.
 *   returning → endpointConfigured && a peer already exists: summarise it,
 *               "Continue" or "Add another device". Keys are NOT re-issued.
 *   error     → status fetch failed: "Try again" + "Skip for now".
 *
 * Tier-3 reminder (llm-safety-tiers.md): VPN config is blocked for the LLM.
 * This step is by design the customer's only in-wizard path to mint their first
 * peer.
 */
export function VpnStep({
  onComplete,
  onSkip,
}: {
  onComplete: () => void;
  onSkip: () => void;
}) {
  const [phase, setPhase] = useState<
    "loading" | "blocked" | "toggle" | "form" | "created" | "returning" | "error"
  >("loading");
  const [status, setStatus] = useState<VpnStatusInfo | null>(null);
  const [existingPeers, setExistingPeers] = useState<VpnPeerInfo[]>([]);
  const [deviceLabel, setDeviceLabel] = useState("");
  const [created, setCreated] = useState<VpnPeerCreatedInfo | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorTone, setErrorTone] = useState<"error" | "notice">("error");
  // WARP-1283 — the typed `code` off a failed status precheck (null when the
  // failure carried none). fetchVpnStatus attaches the orchestrator's code so
  // the error phase can be specific when the box's routing service is simply
  // unavailable (ROUTING_UNAVAILABLE) instead of guessing "this usually
  // clears on its own".
  const [precheckErrorCode, setPrecheckErrorCode] = useState<string | null>(
    null,
  );
  const [noticeDestination, setNoticeDestination] = useState<string | null>(
    null,
  );
  const [copied, setCopied] = useState(false);
  const REMOTE_ACCESS_DESTINATION = "Remote Access";

  const load = useCallback(async () => {
    setPhase("loading");
    // WARP-1283 — clear the previous attempt's typed code up front so the
    // error phase can never render stale copy; the catch below re-derives it
    // from whatever this attempt actually threw.
    setPrecheckErrorCode(null);
    try {
      const s = await fetchVpnStatus();
      setStatus(s);
      if (!s.endpointConfigured && !s.homeEndpointHost) {
        setPhase("blocked");
        return;
      }
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
          // Peer list unavailable — fall through to the one-tap toggle rather
          // than trapping the customer on a half-rendered returning view.
        }
      }
      // This wizard mints office configurations, which require a discovered LAN endpoint.
      if (!s.homeEndpointHost) {
        setPrecheckErrorCode("ROUTING_UNAVAILABLE");
        setPhase("error");
        return;
      }
      setPhase("toggle");
    } catch (e) {
      setPrecheckErrorCode(
        e && typeof e === "object" && typeof (e as { code?: unknown }).code === "string"
          ? (e as { code: string }).code
          : null,
      );
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Mint a peer. `label` is the device name — auto-derived ("This device") for
  // the one-tap path, or the customer-typed value from the advanced form.
  const mintPeer = useCallback(
    async (label: string) => {
      const trimmed = label.trim();
      if (!trimmed) {
        setErrorTone("error");
        setError("Give this device a name (e.g. \"Stefan's iPhone\")");
        return;
      }
      setError(null);
      setErrorTone("error");
      setSubmitting(true);
      try {
        // The wizard creates an office configuration explicitly.
        const result = await createVpnPeer(trimmed, "home");
        setCreated(result);
        setPhase("created");
      } catch (e) {
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
    },
    [],
  );

  function handleCreate() {
    void mintPeer(deviceLabel);
  }

  const CLIPBOARD_TTL_MS = 30_000;

  function handleCopyConf() {
    if (!created) return;
    navigator.clipboard.writeText(created.conf).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      setTimeout(() => {
        navigator.clipboard.writeText("").catch(() => {});
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
  // loading
  // ──────────────────────────────────────────────────────────────────
  if (phase === "loading") {
    return (
      <StepShell current="vpn" title="Turn on remote access" subtitle="One moment…">
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
  // error
  // ──────────────────────────────────────────────────────────────────
  if (phase === "error") {
    // WARP-1283 — when the orchestrator says the routing sidecar is
    // unavailable (a known, recoverable condition — it may simply still be
    // coming up), be specific instead of the generic "something went wrong"
    // guess. Title and the Try again / Skip affordances are identical in both
    // variants.
    const routingUnavailable = precheckErrorCode === "ROUTING_UNAVAILABLE";
    return (
      <StepShell
        current="vpn"
        title="Couldn't check remote access"
        subtitle={
          routingUnavailable
            ? "The box’s network service isn’t responding right now."
            : "Something went wrong reaching the box to check your remote-access setup."
        }
        primary={{ label: "Try again", onClick: () => load() }}
        skip={{ label: "Skip for now", onClick: onSkip }}
      >
        <div className="dp-card !p-4 flex items-start gap-3" role="alert">
          <AlertCircle
            size={18}
            className="text-system-orange flex-shrink-0 mt-0.5"
            aria-hidden="true"
          />
          <p className="type-footnote text-label-secondary">
            {routingUnavailable ? (
              <>
                Try again in a minute — this part of the box may still be
                starting up. Or skip for now — you can finish remote access
                anytime from <span className="font-mono">Remote Access</span> in
                the dashboard.
              </>
            ) : (
              <>
                This usually clears on its own. Try again, or skip for now — you
                can finish remote access anytime from{" "}
                <span className="font-mono">Remote Access</span> in the
                dashboard.
              </>
            )}
          </p>
        </div>
      </StepShell>
    );
  }

  // ──────────────────────────────────────────────────────────────────
  // blocked
  // ──────────────────────────────────────────────────────────────────
  if (phase === "blocked") {
    return (
      <StepShell current="vpn" title="WireGuard needs a network endpoint"
        subtitle="The Droplet's office network address isn't available yet."
        primary={{ label: "Check again", onClick: () => load() }}
        skip={{ label: "Skip for now", onClick: onSkip }}>
        <LearnMoreCard helpAnchor="vpn">
          <p>Check the Droplet's network connection and router discovery, then try again. You can finish this from Remote Access later.</p>
        </LearnMoreCard>
      </StepShell>
    );
  }

  // ──────────────────────────────────────────────────────────────────
  // toggle — the one-tap primary entry (WARP-979).
  // ──────────────────────────────────────────────────────────────────
  if (phase === "toggle") {
    const hostname = status?.internalHostname ?? null;
    return (
      <StepShell
        current="vpn"
        title="Turn on remote access"
        subtitle="Create an office WireGuard configuration, then scan it in the WireGuard app."
        skip={{ label: "I'll do this later", onClick: onSkip }}
      >
        {/* The one-tap switch. Flipping on mints the first peer immediately; the
            precheck advances to `created` so the QR + .conf appear. */}
        <div className="dp-card !p-4 flex items-center gap-4">
          <span className="w-11 h-11 rounded-xl flex-none flex items-center justify-center bg-accent-subtle text-accent">
            <Smartphone size={22} aria-hidden="true" />
          </span>
          <div className="flex-1 min-w-0">
            <p className="type-subheadline font-semibold text-label-primary">
              Droplet VPN
            </p>
            <p className="type-footnote text-label-tertiary mt-0.5">
              {submitting
                ? "Connecting this device…"
                : "Off · tap to connect this device"}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={submitting}
            aria-label="Turn on remote access"
            disabled={submitting}
            onClick={() => void mintPeer("This device")}
            className={`relative w-[52px] h-[30px] rounded-full flex-none transition-colors duration-200 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
              submitting ? "bg-accent" : "bg-separator"
            }`}
          >
            {/* Knob slides to the "on" position and the track fills accent while
                the peer is minting, so the switch genuinely reports + shows an
                on-state (aria-checked, slid knob) before it advances to the QR —
                rather than being a permanently-off switch that acts as a launcher
                (UX note, WARP-979). On mint failure `submitting` reverts to false,
                sliding it back off = the correct rollback. */}
            <span
              className={`absolute top-[3px] w-6 h-6 rounded-full bg-white shadow transition-[left] duration-200 ${
                submitting ? "left-[25px]" : "left-[3px]"
              }`}
            />
          </button>
        </div>

        {/* flex-wrap so at ~320px the supplemental caption drops to its own line
            instead of squeezing the truncating FQDN to near-zero (UX note). */}
        <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 dp-card !py-2.5 !px-3">
          <Globe size={14} className="text-label-tertiary flex-none" aria-hidden="true" />
          {hostname ? (
            <span className="font-mono type-footnote text-label-secondary truncate min-w-0">
              https://{hostname}
            </span>
          ) : (
            <span className="type-footnote text-label-tertiary">
              your internal DNS address
            </span>
          )}
          <span className="type-caption-1 text-label-quaternary ml-auto">
            Office network configuration
          </span>
        </div>

        {error && errorTone === "notice" && (
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
            <span>
              {error} <span className="font-mono">{noticeDestination}</span>{" "}
              later.
            </span>
          </div>
        )}

        {error && errorTone === "error" && (
          <div
            role="alert"
            className="mt-4 flex items-start gap-2 type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2"
          >
            <AlertCircle
              size={14}
              className="mt-0.5 flex-shrink-0"
              aria-hidden="true"
            />
            <span>{error}</span>
          </div>
        )}

        {/* Advanced escape hatch — the named-device form, kept reachable. */}
        <button
          type="button"
          onClick={() => {
            setError(null);
            setDeviceLabel("");
            setPhase("form");
          }}
          className="type-footnote font-semibold text-accent hover:underline mt-4 inline-flex items-center gap-1.5"
        >
          <Plus size={14} aria-hidden="true" />
          Name a specific device instead
        </button>

        <LearnMoreCard title="How does one tap do all that?" helpAnchor="vpn">
          <p>
            This generates a WireGuard key pair and an office configuration with
            the Droplet's LAN endpoint and internal DNS. Scan the QR code in
            WireGuard and activate the tunnel while on your office network.
            For access from another network, configure a direct endpoint and
            create an away configuration from Remote Access.
          </p>
        </LearnMoreCard>
      </StepShell>
    );
  }

  // ──────────────────────────────────────────────────────────────────
  // returning
  // ──────────────────────────────────────────────────────────────────
  if (phase === "returning") {
    return (
      <StepShell
        current="vpn"
        title="Remote access is set up"
        subtitle="Add more devices now, or anytime from Remote Access."
        primary={{ label: "Continue", onClick: onComplete, showArrow: true }}
      >
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
                {status?.homeEndpointHost && (
                  <p className="type-caption-1 text-label-tertiary font-mono truncate">
                    {status.homeEndpointHost}
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
  // form — the advanced named-device flow (Add another device / name a device).
  // ──────────────────────────────────────────────────────────────────
  if (phase === "form") {
    return (
      <StepShell
        current="vpn"
        title="Add a device"
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

          {status?.homeEndpointHost && (
            <p className="type-footnote text-label-tertiary">
              Will connect to{" "}
              <span className="font-mono">{status.homeEndpointHost}</span>.
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
  const dashboardUrl = dashboardUrlFromConf(
    created.conf,
    status?.internalHostname ?? undefined,
  );

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
          Once connected, open{" "}
          <span className="font-mono break-all">{dashboardUrl}</span> in your
          phone&rsquo;s browser while connected to your office network.
          Your device may need to trust the Droplet's HTTPS certificate.
          Lose the phone? Revoke this device from{" "}
          <span className="font-mono">Remote Access</span> in the dashboard.
        </p>
        <p>
          This QR code uses the office LAN endpoint. For away-from-office access,
          configure a reachable direct WireGuard endpoint and create an away
          configuration from Remote Access.
        </p>
        <p className="type-caption-1 text-label-quaternary">
          Heads up: this code is shown once. If you close this page without
          scanning it, you can revoke and create a new one from{" "}
          <span className="font-mono">Remote Access</span> later — the old config
          will stop working.
        </p>
        {/* Add-another-device escape hatch from the created view too. */}
        <button
          type="button"
          onClick={() => {
            setCreated(null);
            setError(null);
            setDeviceLabel("");
            setPhase("form");
          }}
          className="type-footnote font-semibold text-accent hover:underline mt-1 inline-flex items-center gap-1.5"
        >
          <Plus size={14} aria-hidden="true" />
          Add another device
        </button>
      </LearnMoreCard>
    </StepShell>
  );
}

// Helper retained for tests that want to assert the ready-state copy without
// rendering through the full wizard. Not used by the component itself.
export { ArrowLeft as _ArrowLeftIcon };
