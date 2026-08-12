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

/**
 * The column gap `gap-3` asked for, spelled where nothing can outrank it —
 * the same constant, for the same reason, as the switch table's
 * (`../switch/PortTable.tsx`).
 *
 * These rows render inside `.droplet-shell`, whose `.grid { gap: 16px }`
 * primitive is specificity (0,2,0) and silently beats the (0,1,0) utility
 * (`04-coding-standards/mobile-web-layout.md` §4). Across four gaps that is
 * 16px of a phone's width handed away without anyone asking for it — and,
 * worse, a column rhythm that disagreed with the switch port table sitting
 * directly above it on the same page.
 */
const ROW_GAP = { gap: "12px" } as const;

/**
 * The width the five columns need before `fr` distribution starts starving
 * them.
 *
 * Derived from the switch table's Chrome measurement rather than re-measured:
 * the two tables share a page, a card, a type scale, `px-4` and now this gap,
 * so the density that stopped the switch row clipping is the density this row
 * needs. There, 620px carried 7.1fr of columns plus a 24px chevron and six
 * 12px gaps inside `px-4` — 69.3px per `fr`, at which nothing was cut and the
 * Port column measured 117.8px. Here: 5.7fr × 69.3 = 395px, plus four 12px
 * gaps and 32px of padding = 475px, rounded up.
 *
 * The floor matters because — exactly as on the switch table — Port is the
 * only column carrying `min-w-0`, so it is the one column that yields, and it
 * yields all the way. On the switch table that arrangement resolved Port to
 * **0px** and the row lost the label identifying it. Below this width the
 * table scrolls instead (WARP-1787).
 */
const TRACK_MIN = "min-w-[480px]";

function Row({ p }: { p: RouterPort }) {
  const { Icon } = ROLE[p.role];
  const tone = STATUS_TONE[p.status];
  return (
    <div
      style={ROW_GAP}
      className={`grid w-full items-center px-4 py-2.5 text-left border-t border-[var(--card-bd)] ${GRID} ${
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
 *
 * On a phone this table is not a choice the user made: `RouterPortsPanel`
 * renders it under `md:hidden` even when the Faceplate layout is selected, so
 * it IS the phone view of the router port map. Five attributes per port cannot
 * wrap into a phone's width and cannot shrink into it either, so it takes the
 * other half of the contract in `mobile-web-layout.md` §2a: it **contains its
 * own overflow**. The header and the rows share one `TRACK_MIN`-wide track
 * inside a single scroll box, so they scroll together and stay
 * column-aligned; the outer wrapper keeps the rounded border. Before this the
 * wrapper's `overflow-hidden` simply threw the excess away.
 *
 * This mirrors `../switch/PortTable.tsx` deliberately, constant for constant:
 * the two port maps stack on one /network page, and a phone user scrolling
 * one of them horizontally and not the other is the defect, not the fix.
 *
 * The scrollbar is deliberately left visible: it is the only affordance that
 * says the row scrolls (the same call QA made on the tab strip, guarded in
 * `src/__tests__/shell/mobile-layout-contract.test.ts`).
 */
export function RouterPortTable({ ports }: Props) {
  return (
    <div className="border border-[var(--card-bd)] rounded-[12px] overflow-hidden">
      <div data-port-table-scroll className="overflow-x-auto overscroll-x-contain">
        <div className={TRACK_MIN}>
          <div
            style={ROW_GAP}
            className={`grid px-4 py-2.5 bg-[var(--card-inner)] text-[color:var(--text-muted)] type-caption-2 font-semibold uppercase tracking-wider ${GRID}`}
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
      </div>
    </div>
  );
}
