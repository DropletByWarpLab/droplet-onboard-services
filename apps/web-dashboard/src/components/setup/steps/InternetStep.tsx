"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Globe, Lock } from "lucide-react";
import { fetchDuckDnsStatus, setDuckDnsConfig } from "@/lib/api";
import type { DuckDnsStatus } from "@/lib/types";
import { StepShell } from "@/components/setup/StepShell";
import { LearnMoreCard } from "@/components/setup/LearnMoreCard";

/**
 * Wizard step — give the Droplet a permanent address on the internet.
 *
 * The customer signs up for a free DuckDNS account (their own account,
 * not a Droplet cloud feature) and pastes the subdomain + token. We
 * store it on the OpenWrt side via PUT /api/ddns/duckdns; the
 * subsequent VPN step uses the resulting `<subdomain>.duckdns.org` as
 * the WireGuard endpoint.
 *
 * Skippable. If the customer skips, the VPN step downstream surfaces a
 * "set up internet first" view and points back here. That's by design —
 * we don't block setup on getting a DuckDNS account, but the VPN flow
 * can't issue a working .conf without one.
 *
 * Validation mirrors the orchestrator's Zod schema in
 * `apps/orchestrator/src/routes/ddns.ts`:
 *   subdomain: /^[a-z0-9-]+$/, no leading/trailing hyphen, 1–63 chars
 *   token: 10–128 chars
 *
 * Pattern matches the DuckDnsCard already on `/remote-access` so the
 * customer sees consistent affordances when they revisit later.
 */
export function InternetStep({
  onComplete,
  onSkip,
}: {
  // VpnStep re-fetches the live endpoint via `fetchVpnStatus()` on
  // mount, so the parent doesn't need to thread the subdomain through.
  // (The wizard used to pipe it as an early-paint placeholder; cleaner
  // to let the server be the single source of truth.)
  onComplete: () => void;
  onSkip: () => void;
}) {
  const [subdomain, setSubdomain] = useState("");
  const [token, setToken] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [existing, setExisting] = useState<DuckDnsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    const sub = subdomain.trim();
    if (!sub) return "Enter a subdomain.";
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
    return null;
  }

  async function handleSave() {
    const v = validate();
    if (v) {
      setError(v);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      // "Keep stored" path: omit `token` from the request entirely.
      // The orchestrator's Zod schema + the routing service's Pydantic
      // schema both treat `token` as optional, and the routing handler
      // preserves the existing password value when it's missing. The
      // earlier `token: "stored"` sentinel tripped the min(10) check
      // and returned 400 — `Invalid request` — when a returning
      // customer re-entered this step without re-typing their token.
      const keepStored = !token.trim() && existing?.configured === true;
      const payload: { subdomain: string; token?: string; enabled?: boolean } = {
        subdomain: subdomain.trim(),
        enabled,
      };
      if (!keepStored) payload.token = token.trim();
      const result = await setDuckDnsConfig(payload);
      setExisting(result);
      onComplete();
    } catch (e) {
      const msg =
        e instanceof Error ? e.message : "Could not save. Try again in a moment.";
      setError(msg);
    } finally {
      setSaving(false);
    }
  }

  const alreadyConfigured = existing?.configured === true;

  return (
    <StepShell current="internet"
      title="Connect to the internet"
      subtitle="Give your Droplet a name people can find from anywhere."
      primary={{
        label: alreadyConfigured && token.length === 0 ? "Continue" : "Save and continue",
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

        {error && (
          <div className="flex items-start gap-2 type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2">
            <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </div>

      <LearnMoreCard helpAnchor="internet">
        <p>
          DuckDNS gives your Droplet a fixed name on the internet — like{" "}
          <span className="font-mono">yourstudio.duckdns.org</span> — that
          keeps working even when your home internet&rsquo;s address changes.
          The VPN step in a moment uses this name so your phone can find the
          Droplet when you&rsquo;re away.
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
