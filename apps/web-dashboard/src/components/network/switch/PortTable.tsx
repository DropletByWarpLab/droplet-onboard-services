"use client";

import { Lock, ChevronRight } from "lucide-react";
import type { SwitchPort } from "@/lib/types/switch";
import {
  ROLE,
  CHIP_CLASS,
  DOT_CLASS,
  STATUS_TONE,
  formatBytes,
  portName,
  roleLabel,
  pct,
} from "./helpers";
import styles from "./switch.module.css";

interface Props {
  ports: SwitchPort[];
  onPick: (port: SwitchPort) => void;
}

const GRID = "grid-cols-[1.7fr_0.9fr_0.9fr_1.3fr_1.4fr_0.9fr_24px]";

function Row({ p, onPick }: { p: SwitchPort; onPick: (port: SwitchPort) => void }) {
  const { Icon } = ROLE[p.role];
  const label = roleLabel(p);
  const tone = STATUS_TONE[p.status];
  const poeDelivering = p.poe?.delivering ?? false;
  const poePct = p.poe && poeDelivering ? pct(p.poe.power_w, p.poe.max_power_w) : 0;
  const isCameraIsolated = p.role === "camera" && p.vlan === 100;
  return (
    <button
      type="button"
      onClick={() => onPick(p)}
      className={[
        "grid w-full items-center gap-3 px-4 py-2.5 text-left border-t border-[var(--card-bd)]",
        "cursor-pointer transition-colors hover:bg-[var(--brand-subtle)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:ring-inset",
        GRID,
      ].join(" ")}
    >
      {/* Port — friendly name + id (mono) */}
      <span className="min-w-0">
        <span className="block type-footnote font-medium text-[color:var(--text)] truncate">
          {portName(p)}
        </span>
        <span className="block type-caption-2 text-[color:var(--text-muted)] font-mono mt-px">
          {p.label}
          {p.is_sfp ? " · SFP" : ""}
        </span>
      </span>

      {/* Link — LED + speed, and the traffic the port has actually carried.
          WARP-1716: the counters are what distinguish a busy port from one
          that's merely plugged in. */}
      <span className="type-caption-2 text-[color:var(--text-muted)] flex flex-col gap-0.5">
        <span className="flex items-center gap-1.5">
          <span
            className={[styles.led, styles.ledLink, styles.ledInline, p.link_up ? styles.ledLinkOn : ""].join(" ")}
            aria-hidden="true"
          />
          <span className="font-mono">{p.link_up ? (p.speed ?? "—") : "—"}</span>
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
        {label}
      </span>

      {/* VLAN — mono; camera-on-100 gets the green lock */}
      <span className="type-caption-2 text-[color:var(--text-muted)] inline-flex items-center gap-1.5 font-mono">
        VLAN {p.vlan} · {p.vlan_name}
        {isCameraIsolated && (
          <span className="text-system-green inline-flex" aria-label="isolated">
            <Lock size={9} aria-hidden="true" />
          </span>
        )}
      </span>

      {/* PoE — label + mini draw bar */}
      <span className="type-caption-2 text-[color:var(--text-muted)]">
        {p.poe ? (
          <>
            <span className="font-mono">
              {poeDelivering ? `PoE+ · ${p.poe.power_w.toFixed(1)} W` : "off"}
            </span>
            {poeDelivering && (
              <span className="block h-1 w-16 bg-[var(--inset)] rounded-full overflow-hidden mt-1">
                <span className={styles.poeMiniFill} style={{ width: `${poePct}%` }} />
              </span>
            )}
          </>
        ) : (
          <span className="font-mono text-[color:var(--text-muted)]">—</span>
        )}
      </span>

      {/* Status chip */}
      <span
        className={`inline-flex items-center gap-1.5 type-caption-2 px-2 py-0.5 rounded-full w-fit ${CHIP_CLASS[tone]}`}
      >
        <span className={`w-1.5 h-1.5 rounded-full ${DOT_CLASS[tone]}`} aria-hidden="true" />
        {p.status}
      </span>

      <ChevronRight size={13} className="text-[color:var(--text-muted)]" aria-hidden="true" />
    </button>
  );
}

/**
 * Port table (layout B) — denser, the default on mobile and the
 * screen-reader-friendly layout. A header row + one button row per port.
 */
export function PortTable({ ports, onPick }: Props) {
  return (
    <div className="border border-[var(--card-bd)] rounded-[12px] overflow-hidden">
      <div
        className={`grid gap-3 px-4 py-2.5 bg-[var(--card-inner)] text-[color:var(--text-muted)] type-caption-2 font-semibold uppercase tracking-wider ${GRID}`}
        aria-hidden="true"
      >
        <span>Port</span>
        <span>Link</span>
        <span>Role</span>
        <span>VLAN</span>
        <span>PoE</span>
        <span>Status</span>
        <span />
      </div>
      {ports.map((p) => (
        <Row key={p.port} p={p} onPick={onPick} />
      ))}
    </div>
  );
}
