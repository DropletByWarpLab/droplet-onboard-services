"use client";

import {
  ArrowRight,
  BadgeCheck,
  Building2,
  Camera,
  Check,
  Droplets,
  Globe,
  HardDrive,
  KeyRound,
  Lightbulb,
  Shield,
  ShieldCheck,
  Sparkles,
  User,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { DropletMark } from "@/components/DropletMark";
import { STEPS, type Step } from "@/components/setup/wizard-steps";

/**
 * Shared chrome for setup-wizard step components — the **aurora left-rail
 * frame** (PR #384; design upgrade over the original centered card +
 * ProgressDots, mirrors the onboarding handoff). Each step renders its own
 * `<StepShell current=… title subtitle primary skip>{body}</StepShell>`; the
 * rail (every wizard step, current highlighted) is painted from `current`.
 *
 * The rail's step list is DERIVED from the wizard's live `STEPS` source
 * (`components/setup/wizard-steps`) — not a hardcoded array — so the frame and the
 * resumable state machine can never drift. `RAIL_LABELS` only supplies the
 * presentation metadata (a plain-language label + a Lucide icon) for each
 * step id; the `Record<Step, …>` type makes a missing entry a compile error,
 * so adding a step to STEPS forces a rail label too.
 *
 * The rail shows on `lg+`; a compact progress header stands in for it on
 * smaller screens. Backends are untouched — this is presentation only. Same
 * declarative `primary` / `skip` action API as before; steps only gained the
 * `current` prop they pass through to here.
 *
 * Design-token discipline: `dp-btn-*` / `dp-input` / `type-*` / `text-label-*`
 * / `bg-surface-*` / `.aurora-brand`. The only off-system values are the
 * white-on-aurora rail text (kept at ≥`white/80` for AA), the emerald
 * done-dot, and the pixel-faithful rail sizes from the handoff mock — the
 * documented brand-moment exception (same basis as the login hero; the
 * `.aurora-brand` class itself is shared with that surface).
 */

/** Plain-language rail label + Lucide icon for each wizard step. Keyed by the
 *  `Step` union so TypeScript forces a label for every step in `STEPS` — the
 *  rail can't silently miss a step. */
export const RAIL_LABELS: Record<Step, { label: string; Icon: LucideIcon }> = {
  welcome: { label: "Welcome", Icon: Droplets },
  // PR #384 — plain-language labels for the steps the original re-skin
  // predated. "Claim" gets a verified-badge glyph; "Workspace" the org
  // building; "2-step" the key the 2FA recovery codes already use.
  claim: { label: "Claim", Icon: BadgeCheck },
  account: { label: "Account", Icon: User },
  org: { label: "Workspace", Icon: Building2 },
  twofactor: { label: "2-step", Icon: KeyRound },
  internet: { label: "Internet", Icon: Globe },
  storage: { label: "Storage", Icon: HardDrive },
  discovery: { label: "Smart home", Icon: Lightbulb },
  cameras: { label: "Cameras", Icon: Camera },
  vpn: { label: "Remote access", Icon: ShieldCheck },
  ai: { label: "Private AI", Icon: Sparkles },
  team: { label: "Your team", Icon: Users },
  done: { label: "Done", Icon: Check },
};

export interface StepShellAction {
  /** Visible label when not loading. */
  label: string;
  /** Optional label shown while `isLoading`. Defaults to "Working…". */
  loadingLabel?: string;
  onClick: () => void;
  disabled?: boolean;
  isLoading?: boolean;
  /** Adds the arrow glyph used by "Get Started" / "Continue". */
  showArrow?: boolean;
}

export interface StepShellSkip {
  label: string;
  onClick: () => void;
}

function RailRow({
  label,
  Icon,
  state,
}: {
  label: string;
  Icon: LucideIcon;
  state: "done" | "active" | "todo";
}) {
  return (
    <div
      data-testid="rail-row"
      aria-current={state === "active" ? "step" : undefined}
      className={`flex items-center gap-3 rounded-[10px] px-3 py-2 ${
        state === "active" ? "bg-white/[0.15]" : ""
      }`}
    >
      <span
        aria-hidden="true"
        className={`flex h-[25px] w-[25px] flex-none items-center justify-center rounded-full ${
          state === "done"
            ? "bg-emerald-400 text-emerald-950"
            : state === "active"
              ? "bg-white text-accent"
              : "border border-white/20 bg-white/[0.12] text-white/70"
        }`}
      >
        {state === "done" ? <Check size={13} /> : <Icon size={12} />}
      </span>
      <span
        className={`text-[13.5px] ${
          state === "active"
            ? "font-semibold text-white"
            : state === "done"
              ? "font-medium text-white"
              : "font-medium text-white/80"
        }`}
      >
        {label}
      </span>
    </div>
  );
}

export function StepShell({
  current,
  title,
  subtitle,
  icon,
  children,
  primary,
  skip,
}: {
  /** Which wizard step is active — drives the rail highlight + counter. */
  current: Step;
  title: string;
  subtitle?: string;
  /** Optional adornment above the title (e.g. an animated scan ring). */
  icon?: ReactNode;
  children?: ReactNode;
  primary?: StepShellAction;
  skip?: StepShellSkip;
}) {
  const idx = STEPS.indexOf(current);
  const total = STEPS.length;
  // The content kicker reads "Step N" for the interior steps; welcome (idx 0)
  // and the terminal step don't get one (welcome is a splash; `done` isn't
  // even rail-framed). Guard idx >= 0 so an unknown id never renders "Step 0".
  const showKicker = idx >= 1 && idx <= total - 2;

  return (
    <div className="grid min-h-dvh bg-surface-primary lg:grid-cols-[288px_1fr]">
      {/* Aurora step rail (lg+) */}
      <aside className="aurora-brand hidden flex-col overflow-hidden p-7 text-white lg:flex xl:p-8">
        <div className="mb-9 flex items-center gap-2.5">
          <DropletMark size={24} className="text-white" />
          <span className="text-[18px] font-bold tracking-tight">Droplet</span>
        </div>
        <p className="mb-4 text-[11.5px] font-semibold uppercase tracking-[0.08em] text-white/80">
          Set up · ~10 min
        </p>
        <nav className="flex flex-col gap-0.5" aria-label="Setup progress">
          {STEPS.map((id, i) => {
            const meta = RAIL_LABELS[id];
            return (
              <RailRow
                key={id}
                label={meta.label}
                Icon={meta.Icon}
                state={i < idx ? "done" : i === idx ? "active" : "todo"}
              />
            );
          })}
        </nav>
        <div className="mt-auto flex items-center gap-2 pt-6 type-caption-1 leading-snug text-white/80">
          <Shield size={13} aria-hidden="true" />
          Everything here stays on the box.
        </div>
      </aside>

      {/* Content + footer */}
      <div className="flex min-w-0 flex-col">
        {/* Compact progress header (below lg, where the rail is hidden) */}
        <div className="lg:hidden">
          <div className="flex items-center justify-between px-6 pt-6 sm:px-10">
            <div className="flex items-center gap-2">
              <DropletMark size={20} className="text-accent" />
              <span className="type-headline text-label-primary">Droplet</span>
            </div>
            <span className="type-caption-1 text-label-tertiary">
              Step {idx + 1} of {total}
            </span>
          </div>
          <div className="mx-6 mt-4 h-1 overflow-hidden rounded-full bg-separator sm:mx-10">
            <div
              className="h-full rounded-full bg-accent transition-all duration-300"
              style={{ width: `${((idx + 1) / total) * 100}%` }}
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-10 sm:px-10">
          <div className="mx-auto max-w-[600px] animate-in fade-in duration-300">
            {icon && <div className="mb-6">{icon}</div>}
            {showKicker && (
              <p className="type-caption-1 font-bold uppercase tracking-[0.06em] text-accent">
                Step {idx + 1}
              </p>
            )}
            <h1 className="type-title-1 text-label-primary mt-2">{title}</h1>
            {subtitle && (
              <p className="type-subheadline text-label-secondary mt-2 mb-8">
                {subtitle}
              </p>
            )}
            {!subtitle && <div className="mb-8" />}
            {children}
          </div>
        </div>

        {(primary || skip) && (
          <div className="flex items-center justify-end gap-3 border-t border-separator bg-surface-secondary px-6 py-3.5 sm:px-10">
            {skip && (
              <button
                type="button"
                onClick={skip.onClick}
                className="type-footnote font-semibold text-label-tertiary transition-colors hover:text-label-secondary"
              >
                {skip.label}
              </button>
            )}
            <span className="type-caption-1 text-label-quaternary">
              {idx + 1} / {total}
            </span>
            {primary && (
              <button
                type="button"
                onClick={primary.onClick}
                disabled={primary.disabled || primary.isLoading}
                className="dp-btn-primary"
              >
                {primary.isLoading
                  ? (primary.loadingLabel ?? "Working…")
                  : primary.label}
                {!primary.isLoading && primary.showArrow && (
                  <ArrowRight size={16} aria-hidden="true" />
                )}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
