"use client";

/**
 * WARP-2979 (ADR-059 P4 §8) — why Droplet linked a camera to an area: opened
 * from the "Linked by Droplet" chip on an Areas card. A right-edge panel (a
 * full-width sheet on a phone) with the evidence in sentences
 * (link-evidence-copy.ts), or — when the box sent no evidence to this viewer
 * (it names a camera they can't see) — "Droplet linked this from what its
 * cameras saw."
 *
 * At manage only: Keep (primary) and Undo (secondary). Undo is one tap with
 * no confirm: it is reversible (tick the camera in What covers it? to link it
 * yourself). Below manage the buttons are not rendered. In an Inside or Staff
 * only area the panel says alerts from this camera start once it is kept.
 *
 * Presentational: the panel does the writes and the toasts; a rejection keeps
 * this open.
 */
import { useId, useState } from "react";
import { Loader2, X } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import type { SecurityZoneKind, SecurityZoneLinkView } from "@/lib/types";
import { evidenceSentences, LINK_COPY, provenanceLine } from "./link-evidence-copy";
import { linkPhrase } from "./AreaLinksDialog";
import { fill } from "./TimezoneSelect";

export const WHY_COPY = {
  title: "Why Droplet linked {link}",
  keep: "Keep",
  undo: "Undo",
  alertsOnceKept: "Alerts from this camera start once you keep it.",
  close: "Close",
} as const;

/** The area kinds whose people-after-hours alerts need a person-kept link (after_hours_presence's areas). */
const ALERTING_KINDS: readonly SecurityZoneKind[] = ["interior", "restricted"];

export interface LinkWhyPopoverProps {
  open: boolean;
  link: SecurityZoneLinkView | null;
  zoneKind: SecurityZoneKind | null;
  canManage: boolean;
  tz: string;
  now: Date;
  onClose: () => void;
  /** Reject to keep it open (the caller shows why). */
  onKeep: (link: SecurityZoneLinkView) => Promise<unknown>;
  onUndo: (link: SecurityZoneLinkView) => Promise<unknown>;
}

export function LinkWhyPopover({ open, link, zoneKind, canManage, tz, now, onClose, onKeep, onUndo }: LinkWhyPopoverProps) {
  const uid = useId();
  const titleId = `${uid}-title`;
  const [pending, setPending] = useState<"keep" | "undo" | null>(null);

  const act = async (which: "keep" | "undo") => {
    if (!link || pending) return;
    setPending(which);
    try {
      await (which === "keep" ? onKeep(link) : onUndo(link));
      onClose();
    } catch {
      // The panel has shown why; stay open to retry.
    } finally {
      setPending(null);
    }
  };

  const sentences = link?.evidence ? evidenceSentences(link.evidence, tz, now) : [LINK_COPY.noEvidence];

  return (
    <Dialog open={open} onClose={onClose} placement="right" labelledBy={titleId} flush>
      <div style={{ display: "flex", flexDirection: "column", minHeight: "100%" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "16px 20px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <h2 id={titleId} style={{ margin: 0, fontSize: 17, fontWeight: 600, color: "var(--text)", overflowWrap: "anywhere" }}>
            {fill(WHY_COPY.title, { link: link ? linkPhrase(link) : "" })}
          </h2>
          <button type="button" className="icon-btn" aria-label={WHY_COPY.close} onClick={onClose}>
            <X size={18} aria-hidden />
          </button>
        </div>
        <div style={{ display: "grid", gap: 10, padding: 20, flex: 1, alignContent: "start" }} data-why>
          {sentences.map((s) => (
            <p key={s} style={{ margin: 0, fontSize: 13.5, color: "var(--text)", overflowWrap: "anywhere" }}>
              {s}
            </p>
          ))}
          {link && (
            <p style={{ margin: 0, fontSize: 12.5, color: "var(--text-muted)" }}>{provenanceLine("linked", link.stateChangedAt, tz)}</p>
          )}
          {zoneKind && ALERTING_KINDS.includes(zoneKind) && (
            <p style={{ margin: 0, fontSize: 12.5, color: "var(--text-muted)" }} data-alerts-once-kept>
              {WHY_COPY.alertsOnceKept}
            </p>
          )}
        </div>
        {canManage && (
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              flexWrap: "wrap",
              gap: 8,
              padding: "14px 20px",
              borderTop: "1px solid var(--border)",
            }}
          >
            <button type="button" className="btn ghost" onClick={() => void act("undo")} disabled={pending !== null}>
              {pending === "undo" ? <Loader2 size={16} className="animate-spin" aria-hidden /> : null}
              {WHY_COPY.undo}
            </button>
            <button type="button" className="btn primary" onClick={() => void act("keep")} disabled={pending !== null}>
              {pending === "keep" ? <Loader2 size={16} className="animate-spin" aria-hidden /> : null}
              {WHY_COPY.keep}
            </button>
          </div>
        )}
      </div>
    </Dialog>
  );
}
