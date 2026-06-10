"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  Eye,
  EyeOff,
  Globe,
  Lock,
  ShieldCheck,
  Wifi,
} from "lucide-react";
import {
  fetchDuckDnsStatus,
  routerUnreachableNotice,
  setDuckDnsConfig,
} from "@/lib/api";
import type { DuckDnsStatus } from "@/lib/types";
import { StepShell } from "@/components/setup/StepShell";
import { LearnMoreCard } from "@/components/setup/LearnMoreCard";

/**
 * Wizard step — "Give your box a web address" (Onboarding-Flow redesign,
 * WIFI-ADDRESS-THEME-HANDOFF §1b). The DuckDNS half of the old combined
 * "Internet" step, now its own step after `wifi`.
 *
 * The customer signs up for a free DuckDNS account (their own, not a Droplet
 * cloud feature) and pastes the subdomain + token. We store it on the OpenWrt
 * side via PUT /api/ddns/duckdns; the subsequent `vpn` step uses the resulting
 * `<subdomain>.duckdns.org` as the WireGuard endpoint. An inline three-step
 * diagram (Home Wi-Fi → Internet address → Remote access) makes the mental
 * model explicit — this address is what the remote-access step hands the phone.
 *
 * Skippable. Skipping leaves DuckDNS unconfigured, so the downstream `vpn` step
 * renders its blocked state and points back HERE (the address step), not the
 * Wi-Fi step.
 *
 * DuckDNS validation mirrors the orchestrator's Zod schema in
 * `apps/orchestrator/src/routes/ddns.ts`:
 *   subdomain: /^[a-z0-9-]+$/, no leading/trailing hyphen, 1–63 chars
 *   token: 10–128 chars
 */

/** One node in the "what this is for" chain diagram. */
function ChainNode({
  icon: Icon,
  label,
  caption,
  hot,
}: {
  icon: typeof Globe;
  label: string;
  caption: string;
  hot?: boolean;
}) {
  return (
    <div
      className={`flex-1 min-w-0 rounded-xl px-3 py-2.5 text-center border ${
        hot
          ? "border-accent/30 bg-accent-subtle"
          : "border-separator bg-surface-secondary"
      }`}
    >
      <Icon
        size={17}
        className={`mx-auto ${hot ? "text-accent" : "text-label-tertiary"}`}
        aria-hidden="true"
      />
      <div
        className={`type-caption-1 font-semibold mt-1.5 ${
          hot ? "text-accent" : "text-label-secondary"
        }`}
      >
        {label}
      </div>
      <div className="type-caption-2 text-label-tertiary mt-0.5">{caption}</div>
    </div>
  );
}

export function AddressStep({
  onComplete,
  onSkip,
}: {
  // The VpnStep re-fetches the live endpoint via `fetchVpnStatus()` on mount,
  // so the parent doesn't need to thread the subdomain through.
  onComplete: () => void;
  onSkip: () => void;
}) {
  const [subdomain, setSubdomain] = useState("");
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [existing, setExisting] = useState<DuckDnsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // WARP-807: a router-reachability problem is a soft "do this later" notice
  // (amber), not a destructive validation error (red).
  const [errorTone, setErrorTone] = useState<"error" | "notice">("error");
  const [noticeDestination, setNoticeDestination] = useState<string | null>(
    null,
  );
  // The dashboard surface this step's settings live on (WARP-807 UX review).
  const NETWORK_DESTINATION = "Network";

  // Load any prior DuckDNS config so we can pre-fill the form. 403 just means
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
    const sub = subdomain.trim();
    if (!sub) return null; // blank = skip the address for now.
    if (sub.length > 63) return "Subdomain must be 63 characters or fewer.";
    if (!/^[a-z0-9-]+$/.test(sub))
      return "Subdomain can only contain lowercase letters, numbers, and hyphens.";
    if (sub.startsWith("-") || sub.endsWith("-"))
      return "Subdomain can't start or end with a hyphen.";

    // Token is required unless we're keeping a previously-stored one.
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
    return null;
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

    const sub = subdomain.trim();
    // Blank = move on without remote access; the VPN step will render blocked.
    if (!sub) {
      onComplete();
      return;
    }

    setSaving(true);
    try {
      // "Keep stored" path: omit `token` so the orchestrator preserves the
      // existing one (its Zod schema treats token as optional).
      const keepStored = !token.trim() && existing?.configured === true;
      const payload: { subdomain: string; token?: string; enabled?: boolean } = {
        subdomain: sub,
        enabled,
      };
      if (!keepStored) payload.token = token.trim();
      const result = await setDuckDnsConfig(payload);
      setExisting(result);
      onComplete();
    } catch (e) {
      // WARP-807: an unreachable router throws a RouterStatusError (503 /
      // UNREACHABLE). Surface the actionable "finish from Network later" notice
      // in the soft amber tone; everything else keeps its real message.
      const notice = routerUnreachableNotice(e, NETWORK_DESTINATION);
      if (notice) {
        setErrorTone("notice");
        setError(notice.prefix);
        setNoticeDestination(notice.destination);
      } else {
        setErrorTone("error");
        setError(
          e instanceof Error
            ? e.message
            : "Could not save. Try again in a moment.",
        );
      }
    } finally {
      setSaving(false);
    }
  }

  const alreadyConfigured = existing?.configured === true;
  // The CTA reads "Continue" when there's nothing new to submit (already
  // configured and no new token typed) or the address is being skipped (blank).
  const nothingNewToSubmit =
    !subdomain.trim() || (alreadyConfigured && token.length === 0);

  return (
    <StepShell
      current="address"
      title="Give your box a web address"
      subtitle="A permanent address so you can reach this box from anywhere — only needed if you want remote access from outside your home."
      primary={{
        label: nothingNewToSubmit ? "Continue" : "Save and continue",
        loadingLabel: "Saving…",
        onClick: handleSave,
        isLoading: saving,
        disabled: loading,
        showArrow: !subdomain.trim(),
      }}
      skip={{ label: "Skip — no remote access", onClick: onSkip }}
    >
      {/* Fixed-content body (chain diagram, subdomain + token fields,
          auto-update toggle, help card) — NOT an unbounded list, so it is NOT
          wrapped in a <ScrollRegion>. WARP-847: the onboarding split (#548) had
          capped this at 40/44dvh, which forced an inner scrollbar over the
          inputs with dead space below the card — regressing the #546 fix. The
          StepShell panel is scroll-when-needed instead (fits a normal viewport
          with no scrollbar; a viewport too short scrolls the whole panel rather
          than clipping). */}
      <>
        {/* The chain, in plain terms — why this step exists. */}
        <div
          className="flex items-stretch gap-2 mb-4"
          role="img"
          aria-label="Home Wi-Fi, then Internet address (this step), then Remote access"
        >
          <ChainNode icon={Wifi} label="Home Wi-Fi" caption="on your network" />
          <ArrowRight
            size={14}
            className="self-center flex-none text-label-tertiary"
            aria-hidden="true"
          />
          <ChainNode
            icon={Globe}
            label="Internet address"
            caption="this step"
            hot
          />
          <ArrowRight
            size={14}
            className="self-center flex-none text-label-tertiary"
            aria-hidden="true"
          />
          <ChainNode
            icon={ShieldCheck}
            label="Remote access"
            caption="reach it away"
          />
        </div>

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

        <div className="flex items-center gap-2 mb-3">
          <Globe
            size={15}
            className="text-accent flex-shrink-0"
            aria-hidden="true"
          />
          <span className="type-caption-1 font-bold uppercase tracking-[0.06em] text-label-secondary">
            Internet address · DuckDNS
          </span>
        </div>

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
                type={showToken ? "text" : "password"}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={
                  alreadyConfigured && existing.tokenSet
                    ? "•••••• (stored)"
                    : "Paste your DuckDNS token"
                }
                className="dp-input pl-10 pr-10"
                autoComplete="off"
              />
              <button
                type="button"
                onClick={() => setShowToken((s) => !s)}
                aria-label={showToken ? "Hide token" : "Show token"}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-label-tertiary transition-colors duration-200 hover:text-label-secondary"
              >
                {showToken ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
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

        <LearnMoreCard helpAnchor="internet">
          <p>
            Your home internet&rsquo;s address can change without warning.{" "}
            <strong>DuckDNS</strong> is a free service that gives the box one
            permanent web address — like{" "}
            <span className="font-mono">yourstudio.duckdns.org</span> — that
            always finds it. That address is what the <strong>Remote access</strong>{" "}
            step hands your phone; without it the VPN has nowhere to dial.
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
            </a>{" "}
            — it takes a minute. You sign in with a Google, GitHub, Reddit, or
            Twitter account, pick a subdomain, and copy the token. Skip this and
            remote access stays off until you add it later.
          </p>
        </LearnMoreCard>
      </>
    </StepShell>
  );
}
