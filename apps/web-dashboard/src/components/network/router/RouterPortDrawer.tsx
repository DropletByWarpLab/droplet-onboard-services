"use client";

import { useId } from "react";
import { AlertTriangle, Power, ShieldCheck } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import type { RouterPort } from "@/lib/types/router-ports";
import {
  CHIP_CLASS,
  ROLE,
  STATUS_LABEL,
  STATUS_TONE,
  formatBytes,
  networksLabel,
  portName,
  type RouterAction,
} from "./helpers";
import styles from "../switch/switch.module.css";

interface Props {
  port: RouterPort;
  /** owner/admin → the action renders; members and viewers get facts only. */
  canWrite: boolean;
  onClose: () => void;
  onAction: (action: RouterAction) => void;
}

/** The orange Write safety chip. Imported in spirit from SwitchPortDrawer and
 *  spelled identically — the two drawers sit on one page and a second, subtly
 *  different safety marker would read as a different level of danger. */
function WriteChip() {
  return (
    <span className="inline-flex items-center gap-1 type-caption-2 font-semibold text-system-orange bg-system-orange/10 px-2 py-0.5 rounded-full flex-none">
      <ShieldCheck size={10} aria-hidden="true" />
      Write
    </span>
  );
}

/**
 * The blast-radius sentence for turning a jack OFF.
 *
 * Two rules the first draft got wrong, both from the UX review:
 *
 * **Name what goes dark.** "Whatever is plugged into p3" tells the user nothing
 * they didn't already know. The switch drawer names the device; a `RouterPort`
 * has no device join, but it does carry what the jack is FOR (`portName` —
 * "Internet" / "LAN" / "Guest") and which interfaces ride it (`networksLabel`),
 * both already on screen as Facts. This matters most on an unguarded live jack
 * — `guest`, `other` — which gets no second dialog, so this sentence is the
 * only thing the user reads before cutting it.
 *
 * **Only promise a manual restore where that is the truth.** "until you turn
 * the port back on" is right for an unguarded jack and wrong for a live
 * management one, which safe_apply puts back by itself after a minute — and it
 * contradicts the escalation dialog that follows. Step 1 states the loss; step
 * 2 owns the restoration promise, so the clause is dropped whenever step 2 is
 * going to appear.
 *
 * **And say the networks only when they add something.** Naming them
 * unconditionally reads "Internet (wan) on p1" / "LAN (lan) on p2" — the
 * parenthetical restating the label back in installer vocabulary, promoted out
 * of the labelled Networks Fact row into the primary consequence sentence. That
 * is the COMMON shape, not an edge case: every RB5009 LAN jack is a `br-lan`
 * member, so most jacks carry exactly one network named after their role, and
 * the degenerate cases include the two most dangerous jacks. It earns its place
 * twice and is suppressed otherwise (see `networksAddInformation`).
 */

/**
 * Whether the `(networks)` parenthetical carries information the label doesn't.
 *
 *   - **more than one network** — `LAN (lan · guest) on p4` is the only place a
 *     user learns the guest VLAN rides that jack;
 *   - **`role === "other"`** — "Other" is contentless by construction (it is what
 *     `derive_ports` reports for an interface we have no vocabulary for), so
 *     here the parenthetical IS the information: `Other (iot) on p5`.
 */
function networksAddInformation(port: RouterPort): boolean {
  return port.networks.length > 1 || port.role === "other";
}

export function disableBlast(
  port: RouterPort,
  guard: RouterPort["disable_guard"],
): string {
  const what = portName(port);
  // The emptiness check is NOT redundant with `networksAddInformation`. The
  // server only reports `role: "other"` for a jack that HAS networks, but this
  // is a JSON consumer: a malformed or older payload pairing them would render
  // "Other () on p5", and an empty parenthetical is worse than none.
  const carries =
    port.networks.length > 0 && networksAddInformation(port)
      ? ` (${networksLabel(port)})`
      : "";
  if (!port.link_up) {
    return `Nothing is plugged into ${port.id} right now, so nothing drops — but anything connected here later stays offline until you turn it back on.`;
  }
  const loses = `${what}${carries} on ${port.id} loses its connection`;
  // The escalation that follows owns the restore story, and for a management
  // jack "until you turn it back on" is simply false.
  return guard ? `${loses}.` : `${loses} until you turn the port back on.`;
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
 * Router port detail drawer — WARP-1907.
 *
 * Deliberately the same object as `../switch/SwitchPortDrawer`: the shared
 * `<Dialog placement="right">` primitive (ARIA / focus trap / ESC / scroll
 * lock), the same `Fact` rows, the same orange Write chip, the same RBAC gate.
 * The two port maps stack on one /network page, and a router jack that opened a
 * differently-shaped panel would read as a different kind of thing.
 *
 * What differs is what a router jack actually is. There is no PoE and no
 * per-port VLAN, so those rows are absent rather than rendered empty; there IS
 * an `absent` state the switch has no word for, and it is the one case with no
 * action at all — an empty SFP cage reports no netifd device, so there is
 * nothing to shut, and writing `enabled 0` for a device netifd never realised
 * would stage a section that does nothing and report success.
 *
 * The guard banner is rendered where the decision is made, not only in the
 * dialog that follows it. `reason` is the server's sentence, verbatim: whether
 * a jack is a management jack depends on `DROPLET_MGMT_INTERFACES`, and the two
 * codes differ on a fact the user is about to rely on (a management jack comes
 * back by itself after a minute; the WAN jack does not come back at all).
 */
export function RouterPortDrawer({ port, canWrite, onClose, onAction }: Props) {
  const headingId = useId();
  const { Icon } = ROLE[port.role];
  const tone = STATUS_TONE[port.status];
  const name = portName(port);
  const isDisabled = port.status === "disabled";
  // `present: false` is "we have no reading", not "this is down" — the whole
  // point of the read contract. There is no jack here to act on.
  const actionable = port.present;
  // The guard only describes a DISABLE. Restoring a jack is never escalated.
  const guard = isDisabled ? null : port.disable_guard;

  return (
    <Dialog open onClose={onClose} labelledBy={headingId} placement="right">
      <div>
        {/* Header */}
        <div className="flex items-center gap-3 pb-3.5 border-b border-[var(--card-bd)] mb-3.5">
          <span className="w-[38px] h-[38px] rounded-[10px] bg-[var(--brand-subtle)] text-[color:var(--brand)] flex items-center justify-center flex-none">
            <Icon size={18} aria-hidden="true" />
          </span>
          <div className="flex-1 min-w-0">
            <h2
              id={headingId}
              className="type-subheadline font-semibold text-[color:var(--text)] truncate"
            >
              {name}
            </h2>
            <div className="type-caption-1 text-[color:var(--text-muted)] mt-px font-mono">
              {port.id} · {port.is_sfp ? "SFP cage" : "RJ45 copper"}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1 text-[color:var(--text-muted)] hover:text-[color:var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] rounded-sm"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Facts (reads) */}
        <div className="flex flex-col mb-[18px]">
          <Fact k="Link">
            <span
              className={[
                styles.led,
                styles.ledLink,
                styles.ledInline,
                port.link_up ? styles.ledLinkOn : "",
              ].join(" ")}
              aria-hidden="true"
            />
            <span className="ml-1.5">
              {port.link_up
                ? `${port.speed ?? "up"}${port.duplex ? ` · ${port.duplex} duplex` : ""}`
                : "nothing plugged in"}
            </span>
          </Fact>
          <Fact k="Role">
            <span className="inline-flex items-center gap-1.5 type-caption-2 text-[color:var(--text-muted)] bg-[var(--card-inner)] px-2.5 py-1 rounded-full">
              <Icon size={11} aria-hidden="true" />
              {ROLE[port.role].label}
            </span>
          </Fact>
          <Fact k="Networks">
            <span className="font-mono truncate">{networksLabel(port)}</span>
          </Fact>
          {port.traffic && (
            <Fact k="Traffic">
              <span className="font-mono type-caption-2 text-[color:var(--text-muted)]">
                ↓{formatBytes(port.traffic.rx_bytes)} ↑{formatBytes(port.traffic.tx_bytes)}
              </span>
            </Fact>
          )}
          {port.mac && (
            <Fact k="MAC">
              <span className="font-mono type-caption-2">{port.mac}</span>
            </Fact>
          )}
          <Fact k="Status">
            <span
              className={`inline-flex items-center type-caption-2 px-2 py-0.5 rounded-full ${CHIP_CLASS[tone]}`}
            >
              {STATUS_LABEL[port.status]}
            </span>
          </Fact>
        </div>

        {/* The server's own warning, at the point of decision. `reason` only —
            the "confirm again" half is a separate field on the guard, because
            here the user has not been asked to confirm anything yet. */}
        {canWrite && actionable && guard && (
          <div
            role="note"
            className="flex gap-2 items-start p-3 mb-3 bg-system-orange/10 rounded-[10px] type-caption-1 leading-relaxed text-[color:var(--text)]"
          >
            <AlertTriangle
              size={13}
              className="flex-none mt-px text-system-orange"
              aria-hidden="true"
            />
            {guard.reason}
          </div>
        )}

        {/* Why this jack has no reading. A FACT about the hardware, so it sits
            outside the RBAC gate — a member who opens an empty SFP cage
            deserves the explanation, not just a "no module" chip with no
            account of what that means. */}
        {!actionable && (
          <div className="flex gap-2 items-start p-3 mb-3 bg-[var(--inset)] rounded-[10px] type-caption-1 leading-relaxed text-[color:var(--text-muted)]">
            <AlertTriangle size={13} className="flex-none mt-px" aria-hidden="true" />
            {port.is_sfp
              ? "This cage has no module in it, so the router reports no reading for it."
              : "The router reports no reading for this port."}
            {canWrite ? " There's nothing here to switch on or off." : ""}
          </div>
        )}

        {/* Admin action — gated by RBAC, and by having a reading at all */}
        {canWrite && actionable && (
          <>
            <p className="type-caption-1 font-semibold uppercase tracking-wider text-[color:var(--text-muted)] mb-2.5">
              Admin actions
            </p>
            {(
              <button
                type="button"
                onClick={() =>
                  onAction({
                    kind: "enable",
                    port,
                    enabled: isDisabled,
                    what: isDisabled ? `Turn ${port.id} back on?` : `Turn off ${port.id}?`,
                    blast: isDisabled
                      ? `Anything plugged into ${port.id} reconnects as soon as the change applies.`
                      : disableBlast(port, guard),
                    guard,
                  })
                }
                className="flex items-center gap-2.5 p-3 border border-[var(--card-bd)] rounded-[10px] bg-[var(--card-bg)] text-left w-full transition-all duration-150 hover:border-[color-mix(in_srgb,var(--brand)_40%,var(--card-bd))] hover:bg-[var(--brand-subtle)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
              >
                <span className="w-[30px] h-[30px] rounded-lg bg-[var(--card-inner)] flex items-center justify-center flex-none text-[color:var(--text-muted)]">
                  <Power size={14} aria-hidden="true" />
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block type-footnote font-medium text-[color:var(--text)]">
                    {isDisabled ? "Turn on this port" : "Turn off this port"}
                  </span>
                  <span className="block type-caption-2 text-[color:var(--text-muted)] mt-px">
                    {isDisabled
                      ? "Currently switched off by an admin"
                      : "Shut the jack until you switch it back on"}
                  </span>
                </span>
                <WriteChip />
              </button>
            )}
          </>
        )}

        {/* Footer — safety reminder, always shown. Same sentence as the switch
            drawer: it is a statement about the appliance, not about a device. */}
        <div className="flex gap-2 items-center mt-4 pt-3 border-t border-[var(--card-bd)] type-caption-2 text-[color:var(--text-muted)]">
          <ShieldCheck size={12} aria-hidden="true" />
          Reads stay on LAN · every write is logged to Activity
        </div>
      </div>
    </Dialog>
  );
}
