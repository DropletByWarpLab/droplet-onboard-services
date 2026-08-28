"use client";

import { X } from "lucide-react";
import type { SwitchPort } from "@/lib/types/switch";
import { ROLE, portName } from "./helpers";
import styles from "./switch.module.css";

interface Props {
  ports: SwitchPort[];
  onPick: (port: SwitchPort) => void;
}

function Cell({ p, onPick }: { p: SwitchPort; onPick: (port: SwitchPort) => void }) {
  const { Icon } = ROLE[p.role];
  const poeDelivering = p.poe?.delivering ?? false;
  const cellBorder =
    p.status === "warn"
      ? "border-system-orange/50"
      : "border-[var(--card-bd)]";
  const cellOpacity = p.status === "blocked" ? "opacity-[0.62]" : "";
  return (
    <button
      type="button"
      onClick={() => onPick(p)}
      title={portName(p)}
      className={[
        "flex flex-col items-center gap-1.5 rounded-[9px] border bg-[var(--card-bg)]",
        "px-1.5 pt-2.5 pb-2 min-w-0 cursor-pointer transition-all duration-150 ease-smooth",
        "hover:-translate-y-0.5 hover:border-[color-mix(in_srgb,var(--brand)_40%,var(--card-bd))] hover:shadow-sm",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]",
        cellBorder,
        cellOpacity,
      ].join(" ")}
    >
      <span className={[styles.jack, p.is_sfp ? styles.jackSfp : "", p.link_up ? styles.up : ""].join(" ")}>
        <span
          className={[styles.led, styles.ledLink, p.link_up ? styles.ledLinkOn : ""].join(" ")}
          aria-hidden="true"
        />
        {p.poe && p.poe.delivering && (
          <span className={[styles.led, styles.ledPoe].join(" ")} aria-hidden="true" />
        )}
        {p.status === "blocked" && (
          <span className={styles.jackX}>
            <X size={11} aria-hidden="true" />
          </span>
        )}
      </span>
      <span className="type-caption-2 font-semibold text-[color:var(--text-muted)] font-mono">
        {p.is_sfp ? "SFP " : ""}
        {p.port}
      </span>
      <span className="text-[color:var(--text-muted)] flex">
        <Icon size={11} aria-hidden="true" />
      </span>
      <span className="type-caption-2 max-w-full truncate text-[color:var(--text)]">
        {portName(p)}
      </span>
      <span className="text-[10px] leading-none text-[color:var(--text-muted)] font-mono">
        {p.poe ? (poeDelivering ? `${p.poe.power_w.toFixed(1)} W` : "off") : "—"}
      </span>
    </button>
  );
}

/**
 * Faceplate (layout A) — the "feels like real hardware" view. Desktop-only
 * (hidden below the mobile breakpoint by the panel). Copper bank flexes;
 * the SFP bank is fixed-width, separated by a hairline divider.
 */
/** "1–8", or "3" for a single port, or "" for none. Ports arrive sorted. */
function bankLabel(ports: SwitchPort[]): string {
  if (ports.length === 0) return "";
  const first = ports[0].port;
  const last = ports[ports.length - 1].port;
  return first === last ? `${first}` : `${first}–${last}`;
}

export function Faceplate({ ports, onPick }: Props) {
  const copper = ports.filter((p) => !p.is_sfp);
  const sfp = ports.filter((p) => p.is_sfp);
  // WARP-2165: the SFP bank is a property of the VARIANT. The 10HP has one;
  // the 8HP has no optical cage at all. Rendering the divider and the
  // fixed-width bank unconditionally left a stray hairline and a dead 110px
  // column on the right of every 8HP faceplate.
  const hasSfp = sfp.length > 0;
  return (
    <div>
      <div className="flex gap-[18px] items-stretch bg-[var(--card-inner)] border border-[var(--card-bd)] rounded-[12px] p-3.5">
        <div className="grid grid-flow-col auto-cols-fr gap-2 flex-1">
          {copper.map((p) => (
            <Cell key={p.port} p={p} onPick={onPick} />
          ))}
        </div>
        {hasSfp && (
          <>
            <div className="w-px bg-[var(--card-bd)]" aria-hidden="true" />
            <div className="grid grid-flow-col gap-2 flex-none" style={{ gridAutoColumns: "110px" }}>
              {sfp.map((p) => (
                <Cell key={p.port} p={p} onPick={onPick} />
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
        <span className="inline-flex items-center gap-1.5">
          <span className={[styles.led, styles.ledPoe, styles.ledInline].join(" ")} aria-hidden="true" />
          PoE delivering
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-[3px] bg-system-orange" aria-hidden="true" />
          warn
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-[3px] bg-system-red" aria-hidden="true" />
          disabled
        </span>
        {/* Describe the unit in front of you, not the one we shipped first. */}
        <span className="ml-auto font-mono">
          {[
            copper.length > 0 ? `copper ${bankLabel(copper)}` : "",
            hasSfp ? `SFP ${bankLabel(sfp)}` : "",
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </div>
    </div>
  );
}
