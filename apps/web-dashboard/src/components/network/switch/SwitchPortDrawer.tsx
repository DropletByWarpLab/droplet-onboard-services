"use client";

import { useId } from "react";
import { Tag, Zap, Lock, ShieldCheck } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import type { SwitchPort, SwitchVlanProfile } from "@/lib/types/switch";
import {
  ROLE,
  CHIP_CLASS,
  STATUS_TONE,
  portName,
  roleLabel,
  pct,
  type SwitchAction,
} from "./helpers";
import styles from "./switch.module.css";

interface Props {
  port: SwitchPort;
  profile: SwitchVlanProfile;
  /** owner/admin → actions render; members/viewers → read-only facts only. */
  canWrite: boolean;
  /** status.protected_port — the uplink whose edits are blocked. */
  protectedPort: number | null;
  onClose: () => void;
  onAction: (action: SwitchAction) => void;
}

/** A single Write safety chip — orange, sits at the right edge of each action. */
function WriteChip() {
  return (
    <span className="inline-flex items-center gap-1 type-caption-2 font-semibold text-system-orange bg-system-orange/10 px-2 py-0.5 rounded-full flex-none">
      <ShieldCheck size={10} aria-hidden="true" />
      Write
    </span>
  );
}

function Fact({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-2.5 border-t border-[var(--card-bd)] first:border-t-0 type-footnote">
      <span className="w-24 flex-none text-[color:var(--text-muted)] type-caption-1">{k}</span>
      <span className="flex items-center min-w-0 text-[color:var(--text)]">{children}</span>
    </div>
  );
}

/**
 * Port detail drawer — reuses the §2.6 device side-drawer primitive
 * (<Dialog placement="right">) for ARIA / focus-trap / ESC / scroll-lock.
 *
 * Facts (reads) render for everyone. The admin action list is gated three
 * ways:
 *   1. RBAC — hidden entirely for non-owner/admin (`canWrite === false`).
 *   2. Protected uplink — replaced by a locked note (no actions at all).
 *   3. Camera-safe (§6) — Change VLAN disabled for a camera while flat-lan,
 *      so an admin can't strand a camera that can't yet be isolated.
 */
export function SwitchPortDrawer({
  port,
  profile,
  canWrite,
  protectedPort,
  onClose,
  onAction,
}: Props) {
  const headingId = useId();
  const { Icon } = ROLE[port.role];
  const label = roleLabel(port);
  const tone = STATUS_TONE[port.status];
  const isProtected = protectedPort != null && port.port === protectedPort;
  const poeDelivering = port.poe?.delivering ?? false;
  const poePct = port.poe && poeDelivering ? pct(port.poe.power_w, port.poe.max_power_w) : 0;
  // Camera-safe gate: a camera can only change VLAN once the fabric is segmented.
  const canIsolate = profile === "segmented" || port.role !== "camera";
  const targetVlan = port.vlan === 100 ? 1 : 100;
  const name = portName(port);

  return (
    <Dialog open onClose={onClose} labelledBy={headingId} placement="right">
      {/* Body inset comes from the <Dialog> primitive's default `p-5`
          (WARP-1153 — replaces the off-scale p-[18px]). */}
      <div>
        {/* Header */}
        <div className="flex items-center gap-3 pb-3.5 border-b border-[var(--card-bd)] mb-3.5">
          <span className="w-[38px] h-[38px] rounded-[10px] bg-[var(--brand-subtle)] text-[color:var(--brand)] flex items-center justify-center flex-none">
            <Icon size={18} aria-hidden="true" />
          </span>
          <div className="flex-1 min-w-0">
            <h2 id={headingId} className="type-subheadline font-semibold text-[color:var(--text)] truncate">
              {name}
            </h2>
            <div className="type-caption-1 text-[color:var(--text-muted)] mt-px font-mono">
              {port.label} · {port.is_sfp ? "SFP uplink" : "RJ45 copper"}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1 text-[color:var(--text-muted)] hover:text-[color:var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] rounded-sm"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Facts (reads) */}
        <div className="flex flex-col mb-[18px]">
          <Fact k="Link">
            <span
              className={[styles.led, styles.ledLink, styles.ledInline, port.link_up ? styles.ledLinkOn : ""].join(" ")}
              aria-hidden="true"
            />
            <span className="ml-1.5">{port.link_up ? `${port.speed} · full duplex` : "down"}</span>
          </Fact>
          <Fact k="Role">
            <span className="inline-flex items-center gap-1.5 type-caption-2 text-[color:var(--text-muted)] bg-[var(--card-inner)] px-2.5 py-1 rounded-full">
              <Icon size={11} aria-hidden="true" />
              {label}
            </span>
          </Fact>
          <Fact k="VLAN / PVID">
            <span className="font-mono">
              VLAN {port.vlan} · {port.vlan_name}
            </span>
          </Fact>
          <Fact k="PoE">
            {port.poe
              ? poeDelivering
                ? `PoE+ · ${port.poe.power_w.toFixed(1)} W · class ${port.poe.class ?? "—"}`
                : "disabled"
              : "not a powered port"}
          </Fact>
          {port.poe && poeDelivering && (
            <Fact k="Draw">
              <span className="flex items-center flex-1 min-w-0">
                <span className="block h-1 w-[120px] flex-none bg-[var(--inset)] rounded-full overflow-hidden mr-2">
                  <span className={styles.poeMiniFill} style={{ width: `${poePct}%` }} />
                </span>
                <span className="type-caption-2 text-[color:var(--text-muted)] font-mono">
                  {port.poe.power_w.toFixed(1)} / {port.poe.max_power_w} W
                </span>
              </span>
            </Fact>
          )}
          {port.device?.ip && (
            <Fact k="Device">
              <span className="font-mono">{port.device.ip}</span>
            </Fact>
          )}
          <Fact k="Status">
            <span className={`inline-flex items-center type-caption-2 px-2 py-0.5 rounded-full ${CHIP_CLASS[tone]}`}>
              {port.status}
            </span>
          </Fact>
          {isProtected && (
            <Fact k="Protected">
              <span className="inline-flex items-center gap-1 type-caption-2 text-[color:var(--brand)] bg-[var(--brand-subtle)] px-2 py-0.5 rounded-full">
                <ShieldCheck size={10} aria-hidden="true" />
                uplink · writes locked
              </span>
            </Fact>
          )}
        </div>

        {/* Admin actions — gated by RBAC + protected-uplink */}
        {canWrite && (
          <>
            <p className="type-caption-1 font-semibold uppercase tracking-wider text-[color:var(--text-muted)] mb-2.5">
              Admin actions
            </p>
            {isProtected ? (
              <div className="flex gap-2 items-start p-3 bg-[var(--inset)] rounded-[10px] type-caption-1 leading-relaxed text-[color:var(--text-muted)]">
                <Lock size={13} className="flex-none mt-px" aria-hidden="true" />
                This is the uplink to rack-1. Port edits are blocked to keep the appliance reachable.
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {/* Change VLAN — camera-safe gated */}
                <button
                  type="button"
                  disabled={!canIsolate}
                  onClick={() =>
                    onAction({
                      kind: "vlan",
                      port,
                      vlanId: targetVlan,
                      what:
                        port.vlan === 100
                          ? `Move ${port.label} back to VLAN 1 · LAN?`
                          : `Move ${port.label} to VLAN 100 · Cameras?`,
                      blast: `${name} and anything on it will briefly drop while the port re-homes.`,
                    })
                  }
                  className="flex items-center gap-2.5 p-3 border border-[var(--card-bd)] rounded-[10px] bg-[var(--card-bg)] text-left w-full transition-all duration-150 hover:not-disabled:border-[color-mix(in_srgb,var(--brand)_40%,var(--card-bd))] hover:not-disabled:bg-[var(--brand-subtle)] disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
                >
                  <span className="w-[30px] h-[30px] rounded-lg bg-[var(--card-inner)] flex items-center justify-center flex-none text-[color:var(--text-muted)]">
                    <Tag size={14} aria-hidden="true" />
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block type-footnote font-medium text-[color:var(--text)]">Change VLAN</span>
                    <span className="block type-caption-2 text-[color:var(--text-muted)] mt-px">
                      {canIsolate ? "Move this port to another segment" : "Isolation available after router setup"}
                    </span>
                  </span>
                  <WriteChip />
                </button>

                {/* Cut / Restore PoE — only on powered ports */}
                {port.poe && (
                  <button
                    type="button"
                    onClick={() =>
                      onAction({
                        kind: "poe",
                        port,
                        enabled: !poeDelivering,
                        what: poeDelivering ? `Cut PoE on ${port.label}?` : `Restore PoE on ${port.label}?`,
                        blast: poeDelivering
                          ? `${name} is powered over this port — cutting PoE powers it off immediately.`
                          : `PoE power will be restored on this port — ${name} will power back on.`,
                      })
                    }
                    className="flex items-center gap-2.5 p-3 border border-[var(--card-bd)] rounded-[10px] bg-[var(--card-bg)] text-left w-full transition-all duration-150 hover:border-[color-mix(in_srgb,var(--brand)_40%,var(--card-bd))] hover:bg-[var(--brand-subtle)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
                  >
                    <span className="w-[30px] h-[30px] rounded-lg bg-[var(--card-inner)] flex items-center justify-center flex-none text-[color:var(--text-muted)]">
                      <Zap size={14} aria-hidden="true" />
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block type-footnote font-medium text-[color:var(--text)]">
                        {poeDelivering ? "Cut PoE power" : "Restore PoE power"}
                      </span>
                      <span className="block type-caption-2 text-[color:var(--text-muted)] mt-px">
                        Toggle power delivery on this port
                      </span>
                    </span>
                    <WriteChip />
                  </button>
                )}

                {/* Enable / Disable port */}
                <button
                  type="button"
                  onClick={() =>
                    onAction({
                      kind: "enable",
                      port,
                      enabled: port.status === "blocked",
                      what: port.status === "blocked" ? `Re-enable ${port.label}?` : `Disable ${port.label}?`,
                      blast:
                        port.status === "blocked"
                          ? "Traffic on this port resumes immediately."
                          : `${name} loses its connection until re-enabled.`,
                    })
                  }
                  className="flex items-center gap-2.5 p-3 border border-[var(--card-bd)] rounded-[10px] bg-[var(--card-bg)] text-left w-full transition-all duration-150 hover:border-[color-mix(in_srgb,var(--brand)_40%,var(--card-bd))] hover:bg-[var(--brand-subtle)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
                >
                  <span className="w-[30px] h-[30px] rounded-lg bg-[var(--card-inner)] flex items-center justify-center flex-none text-[color:var(--text-muted)]">
                    <Lock size={14} aria-hidden="true" />
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block type-footnote font-medium text-[color:var(--text)]">
                      {port.status === "blocked" ? "Enable port" : "Disable port"}
                    </span>
                    <span className="block type-caption-2 text-[color:var(--text-muted)] mt-px">
                      {port.status === "blocked" ? "Currently disabled by an admin" : "Administratively shut the port"}
                    </span>
                  </span>
                  <WriteChip />
                </button>
              </div>
            )}
          </>
        )}

        {/* Footer — safety reminder, always shown */}
        <div className="flex gap-2 items-center mt-4 pt-3 border-t border-[var(--card-bd)] type-caption-2 text-[color:var(--text-muted)]">
          <ShieldCheck size={12} aria-hidden="true" />
          Reads stay on LAN · every write is logged to Activity
        </div>
      </div>
    </Dialog>
  );
}
