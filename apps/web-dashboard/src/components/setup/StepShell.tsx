"use client";

import {
  ArrowLeft,
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
  Wifi,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { DropletMark } from "@/components/DropletMark";
import { STEPS, type Step } from "@/components/setup/wizard-steps";
import { useSetupNav } from "@/components/setup/setup-nav";
import { WizardThemeToggle } from "@/components/setup/WizardThemeToggle";

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
  // Onboarding-Flow redesign — the old single "Internet" rail row becomes two:
  // the local home Wi-Fi the box broadcasts, then the DuckDNS web address.
  wifi: { label: "Home Wi-Fi", Icon: Wifi },
  address: { label: "Internet address", Icon: Globe },
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
  onClick,
}: {
  label: string;
  Icon: LucideIcon;
  state: "done" | "active" | "todo";
  /** When set, the row is a button that jumps to this (already-reached) step. */
  onClick?: () => void;
}) {
  const inner = (
    <>
      <span
        aria-hidden="true"
        className={`flex h-[clamp(21px,18px+0.6vh,25px)] w-[clamp(21px,18px+0.6vh,25px)] flex-none items-center justify-center rounded-full ${
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
        className={`text-[clamp(12px,11px+0.35vh,13.5px)] ${
          state === "active"
            ? "font-semibold text-white"
            : state === "done"
              ? "font-medium text-white"
              : "font-medium text-white/80"
        }`}
      >
        {label}
      </span>
    </>
  );

  const rowClass = `flex items-center gap-3 rounded-[10px] px-3 py-[clamp(5px,1.1vh,8px)] ${
    state === "active" ? "bg-white/[0.15]" : ""
  }`;

  // A reached, non-active step becomes a button that navigates back (or
  // forward) to it. Without the wizard nav context (a step rendered in
  // isolation under test) `onClick` is undefined and the row stays a static,
  // non-interactive div — the pre-nav behaviour, so existing tests hold.
  if (onClick) {
    return (
      <button
        type="button"
        data-testid="rail-row"
        onClick={onClick}
        aria-label={`Go to ${label}`}
        className={`${rowClass} w-full text-left transition-colors hover:bg-white/[0.10] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40`}
      >
        {inner}
      </button>
    );
  }

  return (
    <div
      data-testid="rail-row"
      aria-current={state === "active" ? "step" : undefined}
      className={rowClass}
    >
      {inner}
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

  // Wizard navigation (clickable rail + Back button). `null` when this shell is
  // rendered outside the wizard page (a step under test) — the rail then stays
  // static and no Back button shows. `maxReachedIdx` keeps a step the customer
  // already completed navigable even after they jump back to an earlier one.
  // Falling back to `idx` (no provider) reproduces the original rail states
  // exactly: `< idx` done, `=== idx` active, `> idx` to-do.
  const nav = useSetupNav();
  const navigate = nav?.navigate;
  const back = nav?.back;
  const maxReached = nav?.maxReachedIdx ?? idx;
  const showFooter = Boolean(primary || skip || (navigate && idx >= 1));

  return (
    // `setup-shell` scopes the wizard's fluid `type-*` overrides (globals.css);
    // the rest of the dashboard's fixed type is untouched. `h-dvh
    // overflow-hidden` keeps the document itself from ever scrolling.
    <div className="setup-shell grid h-dvh grid-rows-1 overflow-hidden bg-surface-primary lg:grid-cols-[288px_1fr]">
      {/* Aurora step rail (lg+). WARP-820: no inner scroll — the rail is sized
          to fit; its spacing is viewport-fluid so the 12 steps + footer fit a
          short laptop without a scrollbar. */}
      <aside
        data-testid="setup-rail"
        className="aurora-brand hidden min-h-0 flex-col overflow-hidden p-[clamp(16px,1vw+1.6vh,32px)] text-white lg:flex"
      >
        <div className="mb-[clamp(16px,3.5vh,36px)] flex items-center gap-2.5">
          <DropletMark size={24} className="text-white" />
          <span className="text-[18px] font-bold tracking-tight">Droplet</span>
        </div>
        <p className="mb-[clamp(10px,1.6vh,16px)] text-[11.5px] font-semibold uppercase tracking-[0.08em] text-white/80">
          Set up · ~10 min
        </p>
        <nav
          className="flex min-h-0 flex-col gap-0.5"
          aria-label="Setup progress"
        >
          {STEPS.map((id, i) => {
            const meta = RAIL_LABELS[id];
            const state =
              i === idx ? "active" : i <= maxReached ? "done" : "todo";
            return (
              <RailRow
                key={id}
                label={meta.label}
                Icon={meta.Icon}
                state={state}
                onClick={
                  navigate && i !== idx && i <= maxReached
                    ? () => navigate(id)
                    : undefined
                }
              />
            );
          })}
        </nav>
        <div className="mt-auto flex flex-col gap-[clamp(8px,1.6vh,14px)] pt-[clamp(12px,2.4vh,24px)]">
          {/* Appearance toggle (Onboarding-Flow redesign §2). Flips the shared
              `droplet-theme` preference the whole dashboard reads. */}
          <div className="flex items-center justify-between gap-2">
            <span className="type-caption-2 font-semibold uppercase tracking-[0.06em] text-white/60">
              Appearance
            </span>
            <WizardThemeToggle variant="aurora" compact />
          </div>
          <div className="flex items-center gap-2 type-caption-1 leading-snug text-white/80">
            <Shield size={13} aria-hidden="true" />
            Everything here stays on the box.
          </div>
        </div>
      </aside>

      {/* Content + footer */}
      <div className="flex min-h-0 min-w-0 flex-col">
        {/* Compact progress header (below lg, where the rail is hidden) */}
        <div className="lg:hidden">
          <div className="flex items-center justify-between px-6 pt-6 sm:px-10">
            <div className="flex items-center gap-2">
              <DropletMark size={20} className="text-accent" />
              <span className="type-headline text-label-primary">Droplet</span>
            </div>
            <div className="flex items-center gap-3">
              <WizardThemeToggle variant="plain" compact />
              <span className="type-caption-1 text-label-tertiary">
                Step {idx + 1} of {total}
              </span>
            </div>
          </div>
          <div className="mx-6 mt-4 h-1 overflow-hidden rounded-full bg-separator sm:mx-10">
            <div
              className="h-full rounded-full bg-accent transition-all duration-300"
              style={{ width: `${((idx + 1) / total) * 100}%` }}
            />
          </div>
        </div>

        {/* The DOCUMENT never scrolls — the shell root is `h-dvh
            overflow-hidden`. This content panel is scroll-WHEN-NEEDED: steps are
            sized (fluid type + spacing) to fit, so on a normal viewport the
            content fits and NO scrollbar shows; only a viewport too short to hold
            a step scrolls here, instead of clipping the step's lower content
            off-screen (the failure WARP-820 had band-aided with a 44dvh-capped
            ScrollRegion on the form steps). The CTA stays pinned in the footer
            below — outside this panel — always reachable. Vertical padding is
            viewport-fluid so the panel breathes on desktop and tightens on a
            short landscape phone. */}
        <div
          data-testid="setup-main"
          className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-6 py-[clamp(16px,4vh,40px)] sm:px-10"
        >
          <div className="mx-auto w-full max-w-[600px] animate-in fade-in duration-300">
            {icon && <div className="mb-[clamp(12px,2.4vh,24px)]">{icon}</div>}
            {showKicker && (
              <p className="type-caption-1 font-bold uppercase tracking-[0.06em] text-accent">
                Step {idx + 1}
              </p>
            )}
            <h1 className="type-title-1 text-label-primary mt-2">{title}</h1>
            {subtitle && (
              <p className="type-subheadline text-label-secondary mt-2 mb-[clamp(16px,3.2vh,32px)]">
                {subtitle}
              </p>
            )}
            {!subtitle && <div className="mb-[clamp(16px,3.2vh,32px)]" />}
            {children}
          </div>
        </div>

        {showFooter && (
          <div className="flex items-center justify-between gap-3 border-t border-separator bg-surface-secondary px-6 py-[clamp(10px,1.6vh,14px)] sm:px-10">
            {/* Back — jumps to the previous step. Hidden on welcome (idx 0) and
                when the wizard nav context isn't present (a step under test).
                Keeps dp-btn-secondary's full 44px min-height (the system touch
                target) — only the horizontal padding is tightened for the
                compact footer; a mobile home user is exactly who needs the 44px
                target (UX review on #518). */}
            <div>
              {navigate && idx >= 1 && (
                <button
                  type="button"
                  onClick={() => (back ? back() : navigate(STEPS[idx - 1]))}
                  className="dp-btn-secondary type-footnote !px-3"
                >
                  <ArrowLeft size={16} aria-hidden="true" />
                  Back
                </button>
              )}
            </div>
            <div className="flex items-center gap-3">
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
          </div>
        )}
      </div>
    </div>
  );
}
