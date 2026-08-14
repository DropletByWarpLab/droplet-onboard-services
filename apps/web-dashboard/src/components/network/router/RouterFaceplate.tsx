"use client";

import { X } from "lucide-react";
import type { RouterPort } from "@/lib/types/router-ports";
import { ROLE, portName } from "./helpers";
// The hardware-look vocabulary (RJ45/SFP jack gradients, link LED) is shared
// with the switch faceplate on purpose — the two port maps sit one above the
// other on the Network tab and a second, near-identical jack would read as a
// different kind of thing. Imported rather than copied so they can't drift.
import styles from "../switch/switch.module.css";

interface Props {
  ports: RouterPort[];
  /** WARP-1907 — open the detail drawer for a jack. */
  onPick: (port: RouterPort) => void;
}

function Cell({ p, onPick }: { p: RouterPort; onPick: (port: RouterPort) => void }) {
  const { Icon } = ROLE[p.role];
  return (
    <button
      type="button"
      onClick={() => onPick(p)}
      // The visible label is a stack of fragments (`p5`, an icon, "LAN",
      // "1 Gb"), which a screen reader would read as a run-on. Name the control
      // by what activating it does.
      aria-label={`Port ${p.id} — ${portName(p)}. Open details`}
      title={`${p.id} — ${portName(p)}${p.link_up && p.speed ? ` · ${p.speed}` : ""}`}
      className={[
        "flex flex-col items-center gap-1.5 rounded-[9px] border border-[var(--card-bd)]",
        "bg-[var(--card-bg)] px-1.5 pt-2.5 pb-2 min-w-0",
        // 150ms, border + background only — the same restraint the switch
        // faceplate uses. A jack is a piece of hardware on a rack drawing; it
        // should acknowledge the pointer, not animate.
        "transition-colors duration-150 cursor-pointer",
        "hover:border-[color-mix(in_srgb,var(--brand)_40%,var(--card-bd))] hover:bg-[var(--brand-subtle)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]",
        // An unreadable jack is dimmed rather than drawn as a dark-but-normal
        // port — it looks unmeasured because it is.
        p.present ? "" : "opacity-[0.55] border-dashed",
      ].join(" ")}
    >
      <span className={[styles.jack, p.is_sfp ? styles.jackSfp : "", p.link_up ? styles.up : ""].join(" ")}>
        <span
          className={[styles.led, styles.ledLink, p.link_up ? styles.ledLinkOn : ""].join(" ")}
          aria-hidden="true"
        />
        {p.status === "disabled" && (
          <span className={styles.jackX}>
            <X size={11} aria-hidden="true" />
          </span>
        )}
      </span>
      <span className="type-caption-2 font-semibold text-[color:var(--text-muted)] font-mono">
        {p.id}
      </span>
      <span className="text-[color:var(--text-muted)] flex">
        <Icon size={11} aria-hidden="true" />
      </span>
      <span className="type-caption-2 max-w-full truncate text-[color:var(--text)]">
        {portName(p)}
      </span>
      <span className="text-[10px] leading-none text-[color:var(--text-muted)] font-mono">
        {p.link_up ? (p.speed ?? "up") : "—"}
      </span>
    </button>
  );
}

/**
 * The router faceplate — "feels like real hardware", mirroring the switch's
 * layout A. Desktop-only (the panel collapses to the table below md).
 *
 * WARP-1907: the cells are buttons now, exactly as the switch faceplate's are.
 * Until this ticket they were `<div>`s and the comment here explained that a
 * button opening nothing would be a keyboard trap for no payoff — true while
 * the panel was read-only. A cell now opens the detail drawer, which carries
 * facts the cell has no room for (traffic, MAC, networks) and the write action,
 * so it is the same affordance the switch has had since WARP-1674 — and the
 * drawer opens for everyone, not just owners, so the button is never inert.
 */
export function RouterFaceplate({ ports, onPick }: Props) {
  const copper = ports.filter((p) => !p.is_sfp);
  const fibre = ports.filter((p) => p.is_sfp);
  return (
    <div>
      <div
        role="group"
        aria-label="Router faceplate"
        className="flex gap-[18px] items-stretch bg-[var(--card-inner)] border border-[var(--card-bd)] rounded-[12px] p-3.5"
      >
        <div className="grid grid-flow-col auto-cols-fr gap-2 flex-1">
          {copper.map((p) => (
            <Cell key={p.id} p={p} onPick={onPick} />
          ))}
        </div>
        {fibre.length > 0 && (
          <>
            <div className="w-px bg-[var(--card-bd)]" aria-hidden="true" />
            <div className="grid grid-flow-col gap-2 flex-none" style={{ gridAutoColumns: "110px" }}>
              {fibre.map((p) => (
                <Cell key={p.id} p={p} onPick={onPick} />
              ))}
            </div>
          </>
        )}
      </div>
      <div className="flex items-center gap-4 mt-2.5 type-caption-2 text-[color:var(--text-muted)] flex-wrap">
        <span className="inline-flex items-center gap-1.5">
          <span className={[styles.led, styles.ledLinkOn, styles.ledInline].join(" ")} aria-hidden="true" />
          link up
        </span>
        {/* The unlit swatches need their OWN ink, not the in-jack styling.
            `.led`'s idle fill is rgba(255,255,255,0.18), which is designed to
            sit on the dark jack body — out here on `--card-bg` that is white
            on white in the light theme (1.00:1) and 1.74:1 in dark, so both
            of these legend keys rendered as blank space and the faceplate's
            vocabulary went unexplained. Token-based ink, ≥3:1 in both themes. */}
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block w-[7px] h-[7px] rounded-full bg-[var(--text-muted)]"
            aria-hidden="true"
          />
          no cable
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block w-2.5 h-2.5 rounded-[3px] border border-dashed border-[var(--text-muted)]"
            aria-hidden="true"
          />
          no reading
        </span>
      </div>
    </div>
  );
}
