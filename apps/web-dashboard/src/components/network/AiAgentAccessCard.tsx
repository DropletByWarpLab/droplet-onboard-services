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
    return <p className="type-caption-1" style={{ color: "var(--text-faint)" }}>None</p>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {scopes.map((scope) => (
        <span
          key={scope}
          className="type-caption-2 font-mono px-2 py-0.5 rounded-sm"
          style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}
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
    <div className="card">
      <div className="flex items-center gap-2 mb-1">
        <Bot size={18} style={{ color: "var(--text-muted)" }} aria-hidden="true" />
        <h3 className="type-headline" style={{ color: "var(--text)" }}>AI agent access</h3>
      </div>
      <p className="type-subheadline mb-4" style={{ color: "var(--text-muted)" }}>
        What Droplet&apos;s assistant is allowed to do on your network. These
        permissions are set on the appliance and shown here read-only.
      </p>

      {isLoading ? (
        <p className="type-subheadline" style={{ color: "var(--text-muted)" }}>Loading…</p>
      ) : (
        <div className="space-y-4">
          <div>
            <p className="type-caption-1 mb-1.5" style={{ color: "var(--text-muted)" }}>Can read</p>
            <ScopeChips scopes={data?.readScopes ?? []} />
          </div>
          <div>
            <p className="type-caption-1 mb-1.5" style={{ color: "var(--text-muted)" }}>Can change</p>
            <ScopeChips scopes={data?.writeScopes ?? []} />
          </div>

          <div className="pt-1 type-caption-1 space-y-1" style={{ color: "var(--text-muted)" }}>
            <p>
              Endpoint{" "}
              <span className="font-mono" style={{ color: "var(--text-muted)" }}>{data?.endpoint ?? "—"}</span>
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
              className="btn opacity-50 cursor-not-allowed"
            >
              Rotate token
            </button>
            <button
              type="button"
              disabled
              title="Managed on-device — revoking access here would disconnect the whole Network tab."
              className="btn opacity-50 cursor-not-allowed"
            >
              Revoke access
            </button>
          </div>
          <p className="type-caption-2" style={{ color: "var(--text-faint)" }}>
            Managed on the appliance — these are set up during installation.
          </p>
        </div>
      )}
    </div>
  );
}
