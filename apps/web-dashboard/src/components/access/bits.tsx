"use client";

/**
 * WARP-1532 (RBAC v2 T8) — shared presentational bits for Access & Roles.
 *
 * Ported from the design packet's access-bits.jsx onto the droplet-shell
 * idiom this page already uses (the DepartmentsPanel precedent): status is
 * never color-alone (icon + word on every chip), roles and levels stay
 * neutral text-first chips (never the --role-* ramp — brief §1/§15), and
 * the only sustained motion is the Loader2 spin, which `motion-reduce:
 * animate-none` freezes under prefers-reduced-motion.
 */

import type { ReactNode } from "react";
import {
  AlertTriangle,
  Check,
  Eye,
  Loader2,
  Lock,
  Pencil,
  SlidersHorizontal,
} from "lucide-react";
import type { AccessStartingPoint, AccessSyncState, FeatureAccessLevel } from "@/lib/types";
import {
  floorBlockedReason,
  isLevelBlocked,
  type AccessFeatureDef,
} from "@/lib/access";
import { ACCESS_COPY } from "./copy";
import "./access.css";

/** Neutral text-first chip (the dp-status-chip family, shell `.chip` metrics). */
export function AccessChip({
  icon,
  mono,
  tone = "",
  title,
  children,
}: {
  icon?: ReactNode;
  mono?: boolean;
  tone?: "" | "green" | "orange" | "red" | "muted";
  title?: string;
  children: ReactNode;
}) {
  return (
    <span className={`acc-chip${tone ? ` ${tone}` : ""}${mono ? " mono" : ""}`} title={title}>
      {icon}
      {children}
    </span>
  );
}

/** Sync-state chip — §12 vocabulary; color + icon + word, never color alone.
 *  Wrapped in a polite live region so state changes announce (§11/§13).
 *
 *  WARP-1528: the live region is now PERMANENTLY MOUNTED and only the inner
 *  chip is conditional. Previously the wrapper was created together with its
 *  content (early `return null`), so at the moment the state changed the
 *  `role="status"` element did not yet exist in the DOM — screen readers only
 *  reliably announce mutations to a region they were already observing, so the
 *  announcement was a coin-flip across SR/browser pairs. This path is exercised
 *  for the first time now that the chip actually renders, so it has to be right.
 *
 *  Empty state uses `display: contents`, not `inline-flex`: both call sites sit
 *  in flex rows WITH a gap (`.acc-rolecard .meta` 6px, the detail header 12px),
 *  and a permanently-mounted empty flex item would inject a phantom gap on
 *  every role card. `contents` generates no box at all, while keeping the
 *  element — and its explicit non-generic `status` role — in the DOM and the
 *  accessibility tree. */
export function SyncChip({ state }: { state: AccessSyncState | "applied" | null | undefined }) {
  const showing = state === "pending" || state === "applied" || state === "failed";
  return (
    <span
      role="status"
      aria-live="polite"
      style={{ display: showing ? "inline-flex" : "contents" }}
    >
      {state === "pending" && (
        <AccessChip
          tone="orange"
          icon={
            <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
          }
        >
          {ACCESS_COPY.applying}
        </AccessChip>
      )}
      {state === "applied" && (
        <AccessChip tone="green" icon={<Check size={12} aria-hidden="true" />}>
          {ACCESS_COPY.applied}
        </AccessChip>
      )}
      {state === "failed" && (
        <AccessChip tone="red" icon={<AlertTriangle size={12} aria-hidden="true" />}>
          {ACCESS_COPY.needsAttention}
        </AccessChip>
      )}
    </span>
  );
}

/** Quiet guard/info note — the honest-reason surface for §8 rails.
 *
 *  `id` (WARP-1560) lets a note be the `aria-describedby` target of the
 *  control it explains. A disabled button carries no `title` announcement
 *  anyone can rely on, and a reason sitting in a sibling div is invisible to
 *  assistive tech unless something points at it — so where a note IS the
 *  reason for a disabled control, wire the two together. */
export function GuardNote({
  warn,
  icon,
  id,
  role,
  children,
}: {
  warn?: boolean;
  icon?: ReactNode;
  id?: string;
  role?: string;
  children: ReactNode;
}) {
  return (
    <div className={`acc-note${warn ? " warn" : ""}`} id={id} role={role}>
      {icon ?? <Lock size={15} aria-hidden="true" />}
      <div>{children}</div>
    </div>
  );
}

/** Toggle switch on the shell `.sw` recipe, plus the disabled-with-reason
 *  contract the always-on rows need (shell primitives' Toggle has no
 *  disabled state — this is the same recipe with `disabled` + `title`). */
export function AccessToggle({
  on,
  onChange,
  disabled,
  title,
  ariaLabel,
  small,
}: {
  on: boolean;
  onChange?: () => void;
  disabled?: boolean;
  title?: string;
  ariaLabel: string;
  small?: boolean;
}) {
  return (
    <button
      type="button"
      className={`sw${on ? " on" : ""}${small ? " acc-sw-sm" : ""}`}
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      disabled={disabled}
      title={title}
      onClick={disabled ? undefined : onChange}
    >
      <span className="ball" />
    </button>
  );
}

const LEVEL_ICON: Record<FeatureAccessLevel, typeof Eye> = {
  view: Eye,
  act: Pencil,
  manage: SlidersHorizontal,
};

/** Feature-specific level pills. Floor-blocked levels render disabled with a
 *  Lock and the specific reason UNDER the row — shown, never hidden (§5.2). */
export function LevelPills({
  feature,
  startingPoint,
  value,
  onChange,
  disabled,
}: {
  feature: AccessFeatureDef;
  startingPoint: AccessStartingPoint;
  value: FeatureAccessLevel;
  onChange: (level: FeatureAccessLevel) => void;
  disabled?: boolean;
}) {
  const firstBlocked = feature.levels.find((l) =>
    isLevelBlocked(startingPoint, feature.moduleId, l.value),
  );
  const current =
    feature.levels.find(
      (l) => l.value === value && !isLevelBlocked(startingPoint, feature.moduleId, l.value),
    ) ?? feature.levels[0]!;
  return (
    <div className="acc-levels">
      <div className="acc-level-row" role="group" aria-label={`${feature.label} level`}>
        {feature.levels.map((level) => {
          const blocked = isLevelBlocked(startingPoint, feature.moduleId, level.value);
          const Icon = blocked ? Lock : LEVEL_ICON[level.value];
          const selected = current.value === level.value && !blocked;
          return (
            <button
              key={level.value}
              type="button"
              className={`acc-lvl${selected ? " on" : ""}`}
              aria-pressed={selected}
              disabled={blocked || disabled}
              onClick={() => !blocked && !disabled && onChange(level.value)}
            >
              <Icon size={13} aria-hidden="true" />
              {level.label}
            </button>
          );
        })}
      </div>
      {firstBlocked && (
        <div className="acc-lvl-reason">
          <Lock size={12} aria-hidden="true" />
          {floorBlockedReason(feature.moduleId, firstBlocked.value)}
        </div>
      )}
      {current.grants && <div className="acc-lvl-caption">{current.grants}.</div>}
    </div>
  );
}
