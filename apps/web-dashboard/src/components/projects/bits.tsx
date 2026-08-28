"use client";

// Shared Projects primitives — safety chip, priority, state pill, labels,
// avatars, due/count metas, empty + skeleton. All `pm-`-classed (scoped).

import { createContext, useContext, type JSX } from "react";
import type { CSSProperties, ReactNode } from "react";
import { PmIcon } from "./icons";
import { PRIORITY, fmtDate, isOverdue } from "./config";
import type { Person, Priority, PmState, PmLabel, PmWorkItem } from "./types";

/** Resolves assignee/lead ids → Person. Provided at the page root. */
export const PeopleContext = createContext<(id: string) => Person>((id) => ({
  id,
  name: "Unknown",
  initials: "?",
  tone: 1,
}));
export const usePerson = () => useContext(PeopleContext);

// ── Safety chip (§8) — label ink is label-primary; color only on the icon ───
export function SafetyChip({
  tier = "read",
  pending,
  onAccept,
  onReject,
}: {
  tier?: "read" | "write";
  pending?: boolean;
  onAccept?: () => void;
  onReject?: () => void;
}): JSX.Element {
  const read = tier === "read";
  const ink = read ? "var(--ok)" : "var(--warn)";
  return (
    <span className="pm-row" style={{ gap: 8 }}>
      <span className={"pm-safety " + (read ? "read" : "write")} role="status">
        <PmIcon name={read ? "eye" : "pencil"} size={13} style={{ color: ink }} />
        {read ? "Read · stays on LAN" : "Write · confirm to apply"}
      </span>
      {!read && pending && (
        <span className="pm-row" style={{ gap: 6 }}>
          <button className="pm-btn primary sm" onClick={onAccept} type="button">
            <PmIcon name="check" size={13} />
            Confirm
          </button>
          <button className="pm-btn sm" onClick={onReject} type="button">
            Reject
          </button>
        </span>
      )}
    </span>
  );
}

// ── Priority ────────────────────────────────────────────────────────────────
export function PriorityFlag({
  p,
  size = 14,
  withLabel,
}: {
  p: Priority;
  size?: number;
  withLabel?: boolean;
}): JSX.Element | null {
  const meta = PRIORITY[p];
  if (!meta) return null;
  if (p === "none" && !withLabel) {
    return <PmIcon name="minus" size={size} style={{ color: meta.color }} />;
  }
  return (
    <span
      className="pm-row"
      title={meta.label}
      style={{ gap: 5, color: meta.color, fontSize: 11.5, fontWeight: 600 }}
    >
      <PmIcon name={meta.icon} size={size} sw={p === "urgent" ? 2.2 : 1.8} />
      {withLabel && <span style={{ color: "var(--text-2)" }}>{meta.label}</span>}
    </span>
  );
}

// ── State pill ──────────────────────────────────────────────────────────────
export function StatePill({
  state,
  onClick,
}: {
  state: PmState;
  onClick?: () => void;
}): JSX.Element {
  return (
    <span
      className={"pm-statechip " + state.group + (onClick ? " clickable" : "")}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      <span className="pm-dot" style={{ background: state.color ?? "var(--text-4)", width: 7, height: 7 }} />
      {state.name}
      {onClick && <PmIcon name="chevD" size={11} style={{ marginLeft: -1, opacity: 0.6 }} />}
    </span>
  );
}

// ── Label tag ───────────────────────────────────────────────────────────────
export function LabelTag({ label, small }: { label: PmLabel; small?: boolean }): JSX.Element {
  return (
    <span className={"pm-tag" + (small ? " sm" : "")}>
      <span className="swatch" style={{ background: label.color ?? "var(--text-4)" }} />
      {label.name}
    </span>
  );
}

// ── Avatars ─────────────────────────────────────────────────────────────────
export function Avatar({ id, size = 26, ring }: { id: string; size?: number; ring?: boolean }): JSX.Element {
  const person = usePerson();
  const p = person(id);
  return (
    <span
      className="pm-av"
      data-tone={p.tone}
      title={p.name}
      aria-label={p.name}
      style={{
        width: size,
        height: size,
        fontSize: size < 24 ? 9 : 10,
        ...(ring ? { border: "2px solid var(--bg-canvas)" } : {}),
      }}
    >
      {p.initials}
    </span>
  );
}

export function AvatarStack({ ids, size = 24 }: { ids: string[]; size?: number }): JSX.Element {
  if (!ids || ids.length === 0) {
    return (
      <span
        className="pm-av-none"
        title="Unassigned"
        aria-label="Unassigned"
        style={{ width: size, height: size }}
      >
        <PmIcon name="user" size={Math.round(size * 0.5)} />
      </span>
    );
  }
  return (
    <span className="pm-row">
      {ids.slice(0, 3).map((id, i) => (
        <span key={id} style={{ marginLeft: i ? -7 : 0, zIndex: 5 - i }}>
          <Avatar id={id} size={size} ring />
        </span>
      ))}
      {ids.length > 3 && (
        <span
          className="pm-av"
          style={{
            width: size,
            height: size,
            fontSize: 9,
            marginLeft: -7,
            background: "var(--bg-sunken)",
            color: "var(--text-3)",
          }}
        >
          +{ids.length - 3}
        </span>
      )}
    </span>
  );
}

// ── Due chip + count meta ───────────────────────────────────────────────────
export function DueChip({ item }: { item: PmWorkItem }): JSX.Element | null {
  if (!item.dueDate) return null;
  const overdue = isOverdue(item);
  return (
    <span className={"pm-duechip " + (overdue ? "warn" : "info")}>
      <PmIcon name="clock" size={11} />
      <span className="pm-mono" style={{ fontSize: 11 }}>
        {fmtDate(item.dueDate)}
      </span>
    </span>
  );
}

export function CountMeta({ item }: { item: PmWorkItem }): JSX.Element | null {
  if (!item.subItemCount && !item.commentCount) return null;
  return (
    <span className="pm-row" style={{ gap: 9, color: "var(--text-4)", fontSize: 11 }}>
      {item.subItemCount > 0 && (
        <span className="pm-row" style={{ gap: 3 }}>
          <PmIcon name="branch" size={12} />
          {item.subItemCount}
        </span>
      )}
      {item.commentCount > 0 && (
        <span className="pm-row" style={{ gap: 3 }}>
          <PmIcon name="msg" size={12} />
          {item.commentCount}
        </span>
      )}
    </span>
  );
}

// ── Empty / error block + skeleton ──────────────────────────────────────────
export function EmptyBlock({
  icon = "inbox",
  heading,
  body,
  cta,
  tone,
}: {
  icon?: string;
  heading: string;
  body?: string;
  cta?: ReactNode;
  tone?: "error";
}): JSX.Element {
  const tintBg = tone === "error" ? "var(--err-soft)" : "rgba(99,102,241,0.10)";
  const tintFg = tone === "error" ? "var(--err)" : "var(--accent)";
  return (
    <div className="pm-empty">
      <span className="glyph" style={{ background: tintBg, color: tintFg }}>
        <PmIcon name={icon} size={24} />
      </span>
      <h3>{heading}</h3>
      {body && <p>{body}</p>}
      {cta && <div style={{ marginTop: 12 }}>{cta}</div>}
    </div>
  );
}

export function Skel({
  w = "100%",
  h = 12,
  r = 6,
  style,
}: {
  w?: number | string;
  h?: number;
  r?: number;
  style?: CSSProperties;
}): JSX.Element {
  return <span className="pm-skel" style={{ width: w, height: h, borderRadius: r, ...style }} />;
}
