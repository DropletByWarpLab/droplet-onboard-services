"use client";

import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Shared chrome for setup-wizard step components.
 *
 * Provides the title + optional subtitle + step body + action buttons in
 * the layout every step shares. Each step's body lives in `children`; the
 * step decides what form fields, scanners, or copy go there. Actions are
 * declarative props so a step can:
 *
 *   - render a primary CTA only ("Get Started"),
 *   - a primary + skip pair ("Continue" / "Skip for now"),
 *   - nothing (terminal step with its own CTA — see `DoneStep`).
 *
 * Used by AccountStep and (subsequent commits) Internet / Storage /
 * Cameras / VPN / AI steps. WelcomeStep and DiscoveryStep have their own
 * intentionally-bespoke chrome and don't wrap with this.
 *
 * Design-token discipline: only `dp-btn-primary` / `dp-btn-secondary` /
 * `type-*` / `text-label-*` are referenced — no freelance colours or
 * font sizes (per `auto-claude/agents/ui-ux.md` review rules).
 */
export interface StepShellAction {
  /** Visible label when not loading. */
  label: string;
  /** Optional label shown while `isLoading`. Defaults to "Working…". */
  loadingLabel?: string;
  onClick: () => void;
  disabled?: boolean;
  isLoading?: boolean;
  /** Adds the chevron-right glyph used by "Get Started" / "Continue". */
  showArrow?: boolean;
}

export interface StepShellSkip {
  label: string;
  onClick: () => void;
}

export function StepShell({
  title,
  subtitle,
  icon,
  children,
  primary,
  skip,
}: {
  title: string;
  subtitle?: string;
  /** Optional adornment above the title (e.g. an animated scan ring). */
  icon?: ReactNode;
  children?: ReactNode;
  primary?: StepShellAction;
  skip?: StepShellSkip;
}) {
  return (
    <div className="animate-in fade-in duration-300">
      {icon && <div className="mb-6 flex items-center justify-center">{icon}</div>}

      <h1 className="type-title-1 text-label-primary mb-2 text-center">
        {title}
      </h1>
      {subtitle && (
        <p className="type-subheadline text-label-secondary mb-8 text-center">
          {subtitle}
        </p>
      )}

      {children}

      {(primary || skip) && (
        <div className="space-y-3 mt-6">
          {primary && (
            <button
              type="button"
              onClick={primary.onClick}
              disabled={primary.disabled || primary.isLoading}
              className="dp-btn-primary w-full"
            >
              {primary.isLoading
                ? primary.loadingLabel ?? "Working…"
                : primary.label}
              {!primary.isLoading && primary.showArrow && (
                <ArrowRight size={16} />
              )}
            </button>
          )}
          {skip && (
            <button
              type="button"
              onClick={skip.onClick}
              className="w-full type-subheadline text-label-tertiary hover:text-label-secondary py-2 transition-colors"
            >
              {skip.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
