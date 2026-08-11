"use client";

import type { RouterPort } from "@/lib/types/router-ports";
import {
  ROLE,
  CHIP_CLASS,
  DOT_CLASS,
  STATUS_TONE,
  STATUS_LABEL,
  formatBytes,
  networksLabel,
  portName,
} from "./helpers";
import styles from "../switch/switch.module.css";

interface Props {
  ports: RouterPort[];
}

const GRID = "grid-cols-[1.5fr_1fr_1fr_1.2fr_1fr]";

function Row({ p }: { p: RouterPort }) {
  const { Icon } = ROLE[p.role];
  const tone = STATUS_TONE[p.status];
  return (
    <div
      className={`grid w-full items-center gap-3 px-4 py-2.5 text-left border-t border-[var(--card-bd)] ${GRID} ${
        p.present ? "" : "opacity-70"
      }`}
    >
      {/* Port — what it's for + the netdev name */}
      <span className="min-w-0">
        <span className="block type-footnote font-medium text-[color:var(--text)] truncate">
          {portName(p)}
        </span>
        <span className="block type-caption-2 text-[color:var(--text-muted)] font-mono mt-px">
          {p.id}
          {p.is_sfp ? " · SFP" : ""}
        </span>
      </span>

      {/* Link — LED + speed, and the traffic the port has actually carried.
          The counters are what separate a busy port from one that is merely
          plugged in (the switch panel's WARP-1716 lesson). */}
      <span className="type-caption-2 text-[color:var(--text-muted)] flex flex-col gap-0.5">
        <span className="flex items-center gap-1.5">
          <span
            className={[styles.led, styles.ledLink, styles.ledInline, p.link_up ? styles.ledLinkOn : ""].join(" ")}
            aria-hidden="true"
          />
          <span className="font-mono">{p.link_up ? (p.speed ?? "up") : "—"}</span>
        </span>
        {p.link_up && p.traffic && (
          <span className="font-mono text-[10px] leading-none text-[color:var(--text-faint)]">
            ↓{formatBytes(p.traffic.rx_bytes)} ↑{formatBytes(p.traffic.tx_bytes)}
          </span>
        )}
      </span>

      {/* Role chip */}
      <span className="inline-flex items-center gap-1.5 type-caption-2 text-[color:var(--text-muted)] bg-[var(--card-inner)] px-2.5 py-1 rounded-full w-fit">
        <Icon size={11} aria-hidden="true" />
        {ROLE[p.role].label}
      </span>

      {/* Networks this jack carries — mono, "—" when none claims it */}
      <span className="type-caption-2 text-[color:var(--text-muted)] font-mono truncate">
        {networksLabel(p)}
      </span>

      {/* Status chip */}
      <span
        className={`inline-flex items-center gap-1.5 type-caption-2 px-2 py-0.5 rounded-full w-fit ${CHIP_CLASS[tone]}`}
      >
        <span className={`w-1.5 h-1.5 rounded-full ${DOT_CLASS[tone]}`} aria-hidden="true" />
        {STATUS_LABEL[p.status]}
      </span>
    </div>
  );
}

/**
 * Router port table — denser than the faceplate, the default on mobile, and
 * the screen-reader-friendly layout. Rows are static (read-only panel), so
 * they are plain elements rather than the switch table's buttons.
 */
export function RouterPortTable({ ports }: Props) {
  return (
    <div className="border border-[var(--card-bd)] rounded-[12px] overflow-hidden">
      <div
        className={`grid gap-3 px-4 py-2.5 bg-[var(--card-inner)] text-[color:var(--text-muted)] type-caption-2 font-semibold uppercase tracking-wider ${GRID}`}
        aria-hidden="true"
      >
        <span>Port</span>
        <span>Link</span>
        <span>Role</span>
        <span>Networks</span>
        <span>Status</span>
      </div>
      {ports.map((p) => (
        <Row key={p.id} p={p} />
      ))}
    </div>
  );
}
