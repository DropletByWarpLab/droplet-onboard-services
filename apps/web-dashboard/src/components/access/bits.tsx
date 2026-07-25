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
 *  Wrapped in a polite live region so state changes announce (§11/§13). */
export function SyncChip({ state }: { state: AccessSyncState | "applied" | null | undefined }) {
  if (state !== "pending" && state !== "applied" && state !== "failed") return null;
  return (
    <span role="status" aria-live="polite" style={{ display: "inline-flex" }}>
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

/** Quiet guard/info note — the honest-reason surface for §8 rails. */
export function GuardNote({
  warn,
  icon,
  role,
  children,
}: {
  warn?: boolean;
  icon?: ReactNode;
  role?: string;
  children: ReactNode;
}) {
  return (
    <div className={`acc-note${warn ? " warn" : ""}`} role={role}>
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
