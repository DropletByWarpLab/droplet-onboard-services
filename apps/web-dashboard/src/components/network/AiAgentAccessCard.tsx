"use client";

import useSWR from "swr";
import { Bot } from "lucide-react";
import { fetchAiNetworkAccess, type AiNetworkAccess } from "@/lib/api";

/**
 * AI agent access (Droplet Design System · Network · System).
 *
 * Read-only view of the droplet-ai ubus RPC scopes — a REAL, shipping artifact
 * (the routing service authenticates AS this user). The chips are parsed from
 * the live on-box ACL, so they reflect on-box truth rather than a hardcoded
 * copy. The endpoint reflects the live single-box /ubus target, NOT the design's
 * legacy multi-box 192.168.50.1.
 *
 * Rotate token / Revoke are HONEST-GATED (disabled): there is no per-token
 * credential to rotate (ubus sessions already rotate hourly), and a real rotate
 * needs a coordinated secret refresh that would self-lock-out the Network tab
 * (the routing service IS droplet-ai). Revoke would brick every routing call.
 * Both are reserved Tier-3 (AI-blocked) server-side; here they read as
 * "managed on-device", never as broken or fake controls.
 */
function ScopeChips({ scopes }: { scopes: string[] }) {
  if (scopes.length === 0) {
    return <p className="type-caption-1 text-label-quaternary">None</p>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {scopes.map((scope) => (
        <span
          key={scope}
          className="type-caption-2 font-mono px-2 py-0.5 rounded-sm bg-surface-secondary text-label-secondary"
        >
          {scope}
        </span>
      ))}
    </div>
  );
}

export function AiAgentAccessCard() {
  const { data, isLoading } = useSWR<AiNetworkAccess>(
    "/api/network/ai-access",
    fetchAiNetworkAccess,
    { refreshInterval: 60000 },
  );

  return (
    <div className="dp-card">
      <div className="flex items-center gap-2 mb-1">
        <Bot size={18} className="text-label-tertiary" aria-hidden="true" />
        <h3 className="type-headline text-label-primary">AI agent access</h3>
      </div>
      <p className="type-subheadline text-label-tertiary mb-4">
        What Droplet&apos;s assistant is allowed to do on your network. These
        permissions are set on the appliance and shown here read-only.
      </p>

      {isLoading ? (
        <p className="type-subheadline text-label-tertiary">Loading…</p>
      ) : (
        <div className="space-y-4">
          <div>
            <p className="type-caption-1 text-label-tertiary mb-1.5">Can read</p>
            <ScopeChips scopes={data?.readScopes ?? []} />
          </div>
          <div>
            <p className="type-caption-1 text-label-tertiary mb-1.5">Can change</p>
            <ScopeChips scopes={data?.writeScopes ?? []} />
          </div>

          <div className="pt-1 type-caption-1 text-label-tertiary space-y-1">
            <p>
              Endpoint{" "}
              <span className="font-mono text-label-secondary">{data?.endpoint ?? "—"}</span>
            </p>
            <p>Signs in as {data?.user ?? "droplet-ai"} · session rotates {data?.session.rotates ?? "hourly"}</p>
          </div>

          {/* Honest gates — no real write. Disabled, with the "managed
              on-device" explainer; never enabled or clickable. */}
          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              disabled
              title="Managed on-device — the agent's session already rotates hourly on its own."
              className="dp-btn-secondary opacity-50 cursor-not-allowed"
            >
              Rotate token
            </button>
            <button
              type="button"
              disabled
              title="Managed on-device — revoking access here would disconnect the whole Network tab."
              className="dp-btn-secondary opacity-50 cursor-not-allowed"
            >
              Revoke access
            </button>
          </div>
          <p className="type-caption-2 text-label-quaternary">
            Managed on the appliance — these are set up during installation.
          </p>
        </div>
      )}
    </div>
  );
}
