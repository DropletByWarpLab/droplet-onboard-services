"use client";

/**
 * WARP-836 — one opt-in cloud provider row on the Models page.
 *
 * Read-only on this surface. The toggle reflects the provider's `enabled`
 * state but is DISABLED here — turning a provider on is a Settings action
 * (the off-LAN allowlist, which logs to Activity and requires admin), never a
 * one-click flip on a status page. We render it as a real `role="switch"` with
 * `aria-checked` so assistive tech reads the state, plus `disabled` so it's
 * non-operable and the copy points the user to where the switch actually lives.
 */

import { Cloud } from "lucide-react";
import type { CloudProviderRow as CloudProviderRowData } from "@/lib/types";

/** Provider id → display name + the headline model family shown as sub-text. */
const PROVIDER_META: Record<
  CloudProviderRowData["provider"],
  { name: string; family: string }
> = {
  anthropic: { name: "Anthropic", family: "Claude" },
  openai: { name: "OpenAI", family: "GPT" },
  gemini: { name: "Gemini", family: "Google" },
};

export function CloudProviderRow({ provider }: { provider: CloudProviderRowData }) {
  const meta = PROVIDER_META[provider.provider];
  const stateLabel = provider.enabled ? "On" : "Off";

  return (
    <div className="flex items-center gap-3 px-4 py-3.5">
      <span
        className="w-8 h-8 rounded-md flex items-center justify-center flex-shrink-0"
        style={{ background: "var(--brand-subtle)", color: "var(--brand)" }}
        aria-hidden
      >
        <Cloud size={16} strokeWidth={2} />
      </span>

      <div className="flex-1 min-w-0">
        <p className="type-subheadline font-medium truncate" style={{ color: "var(--text)" }}>
          {meta.name}
        </p>
        <p className="type-caption-1 truncate" style={{ color: "var(--text-muted)" }}>
          {meta.family} · opt-in, off by default
        </p>
      </div>

      {/* Plain-text state next to the switch so the (disabled) control isn't the
          only signal of on/off — and so colour isn't load-bearing. */}
      <span className="type-caption-1 tabular-nums" style={{ color: "var(--text-muted)" }}>
        {stateLabel}
      </span>

      {/* Disabled switch — present for a11y/state read-out, not operable here. */}
      <button
        type="button"
        role="switch"
        aria-checked={provider.enabled}
        aria-label={`${meta.name} cloud model — ${stateLabel} (change in Settings)`}
        disabled
        title="Enable cloud models in Settings"
        className={`
          relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full
          border cursor-not-allowed opacity-60
          ${provider.enabled ? "bg-[var(--brand)] border-[var(--brand)]" : "bg-[var(--inset)] border-[var(--card-bd)]"}
        `}
      >
        <span
          className={`
            inline-block h-4 w-4 rounded-full bg-white shadow
            motion-safe:transition-transform motion-safe:duration-200 ease-smooth
            ${provider.enabled ? "translate-x-6" : "translate-x-1"}
          `}
          aria-hidden
        />
      </button>
    </div>
  );
}
