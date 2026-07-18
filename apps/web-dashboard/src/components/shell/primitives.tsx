"use client";

/**
 * Shared presentational primitives for the indigo page shell — the React
 * port of the Claude Design handoff's `shell.jsx`. All of these render the
 * generic class names defined (descendant-scoped) in `droplet-shell.css`, so
 * they only style correctly inside a `.droplet-shell` ancestor (ShellPage).
 *
 * Icons are passed as ReactNodes (e.g. `<Files size={16} />`) rather than the
 * handoff's string-keyed icon map, so callers use lucide-react directly.
 */

import type { CSSProperties, ReactNode } from "react";
import { Video } from "lucide-react";

/* Big page header (title + subtitle + optional right-side actions). */
export function Phead({
  title,
  sub,
  actions,
}: {
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="phead">
      <div className="ph-tx">
        <h1>{title}</h1>
        {sub ? <p>{sub}</p> : null}
      </div>
      {actions ? <div className="phead-actions">{actions}</div> : null}
    </div>
  );
}

/* Small section label with an optional muted extra. */
export function Sect({ title, extra }: { title: ReactNode; extra?: ReactNode }) {
  return (
    <div className="sect">
      <h2>{title}</h2>
      {extra ? <span className="sx">{extra}</span> : null}
    </div>
  );
}

/* Card surface with an optional header (icon + title + mono meta). */
export function Card({
  icon,
  title,
  meta,
  children,
  className = "",
  hover = false,
  onClick,
  style,
}: {
  icon?: ReactNode;
  title?: ReactNode;
  meta?: ReactNode;
  children?: ReactNode;
  className?: string;
  hover?: boolean;
  onClick?: () => void;
  style?: CSSProperties;
}) {
  return (
    <div
      className={"card " + (hover ? "hover " : "") + className}
      onClick={onClick}
      style={style}
    >
      {title || icon ? (
        <div className="card-h">
          {icon ? <span className="ci">{icon}</span> : null}
          {title ? <span className="ct">{title}</span> : null}
          {meta ? <span className="cm">{meta}</span> : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}

/* KPI tile — eyebrow label, big number, optional sub-note with a dot. */
export function Kpi({
  icon,
  label,
  value,
  unit,
  note,
  dot,
}: {
  icon?: ReactNode;
  label: ReactNode;
  value: ReactNode;
  unit?: ReactNode;
  note?: ReactNode;
  dot?: string;
}) {
  return (
    <div className="kpi">
      <span className="k">
        {icon}
        {label}
      </span>
      <span className="v">
        {value}
        {unit ? <small>{unit}</small> : null}
      </span>
      {note ? (
        <span className="d">
          {dot ? <span className="dot" style={{ background: dot }} /> : null}
          {note}
        </span>
      ) : null}
    </div>
  );
}

export type BadgeKind = "ok" | "warn" | "danger" | "info" | "muted";

export function Badge({
  kind = "muted",
  children,
  dot,
}: {
  kind?: BadgeKind;
  children: ReactNode;
  dot?: string;
}) {
  return (
    <span className={"badge " + kind}>
      {dot ? <span className="dot" style={{ background: dot }} /> : null}
      {children}
    </span>
  );
}

export function Meter({ pct, kind = "" }: { pct: number; kind?: "" | "ok" | "warn" | "danger" }) {
  return (
    <div className="meter">
      <div className={"fill " + kind} style={{ width: Math.max(0, Math.min(100, pct)) + "%" }} />
    </div>
  );
}

export function Bars({ data, hot }: { data: number[]; hot?: number }) {
  const max = data.length ? Math.max(...data) : 0;
  return (
    <div className="bars">
      {data.map((v, i) => (
        <span
          key={i}
          className={"bar" + (hot != null && i === hot ? " hot" : "")}
          style={{ height: (max ? (v / max) * 100 : 0) + "%" }}
        />
      ))}
    </div>
  );
}

/* List/table-like row helper. */
export function Row({
  icon,
  iconBrand,
  title,
  sub,
  subMono,
  meta,
  metaMono,
  value,
  right,
}: {
  icon?: ReactNode;
  iconBrand?: boolean;
  title: ReactNode;
  sub?: ReactNode;
  subMono?: boolean;
  meta?: ReactNode;
  metaMono?: boolean;
  value?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="lrow">
      {icon ? <span className={"ri" + (iconBrand ? " brand" : "")}>{icon}</span> : null}
      <span className="rt">
        <span className="nm">{title}</span>
        {sub ? <span className={"sub" + (subMono ? " mono" : "")}>{sub}</span> : null}
      </span>
      {meta ? <span className={"rmeta" + (metaMono ? " mono" : "")}>{meta}</span> : null}
      {value != null ? <span className="rval">{value}</span> : null}
      {right || null}
    </div>
  );
}

/* Camera feed placeholder tile (live thumbnail can be layered as a child). */
export function Feed({
  label,
  time,
  offline,
  height = 150,
  children,
}: {
  label?: ReactNode;
  time?: ReactNode;
  offline?: boolean;
  height?: number;
  children?: ReactNode;
}) {
  return (
    <div className="feed" style={{ height }}>
      {children}
      {offline ? (
        <div className="off">
          <Video size={15} /> offline
        </div>
      ) : (
        <span className="rec" />
      )}
      {!offline && time ? <span className="ts">{time}</span> : null}
      {label ? <span className="lb">{label}</span> : null}
    </div>
  );
}

/* Controlled toggle switch. `ariaLabel` gives the switch an accessible name
   when the visible label lives in a sibling element (the switch renders no
   text of its own) — same contract as the legacy smart-home ToggleSwitch. */
export function Toggle({
  on,
  onChange,
  ariaLabel,
}: {
  on: boolean;
  onChange?: (next: boolean) => void;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      className={"sw" + (on ? " on" : "")}
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      onClick={() => onChange && onChange(!on)}
    >
      <span className="ball" />
    </button>
  );
}
