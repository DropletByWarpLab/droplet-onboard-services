"use client";

/**
 * Today's schedule (design brief §4.3). Time (mono) · patient · provider ·
 * chair · status pill; a row opens the patient peek. The "Schedule appointment"
 * action is ABSENT (not disabled) unless writes are enabled — scheduling is a
 * write. Renders inside ShellPage.
 */

import { RefreshCw, ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { Sect, Badge, type BadgeKind } from "@/components/shell/primitives";
import type { AppointmentStatus, ScheduleEntry } from "@/lib/erp-types";
import { formatApptTime } from "@/lib/erp-format";

const APPT: Record<AppointmentStatus, { label: string; kind: BadgeKind }> = {
  scheduled: { label: "Scheduled", kind: "info" },
  "checked-in": { label: "Checked in", kind: "ok" },
  complete: { label: "Complete", kind: "muted" },
  cancelled: { label: "Cancelled", kind: "danger" },
};

export function ScheduleList({
  entries,
  dateLabel,
  writeEnabled,
  onPrevDay,
  onNextDay,
  onSyncNow,
  onSchedule,
  onSelect,
}: {
  entries: ScheduleEntry[];
  dateLabel: string;
  writeEnabled: boolean;
  onPrevDay: () => void;
  onNextDay: () => void;
  onSyncNow: () => void;
  onSchedule: () => void;
  onSelect: (entry: ScheduleEntry) => void;
}) {
  return (
    <>
      <Sect
        title="Today"
        extra={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <button type="button" className="icon-btn" style={{ width: 26, height: 26 }} onClick={onPrevDay} aria-label="Previous day">
              <ChevronLeft size={14} />
            </button>
            <span style={{ fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: 12 }}>{dateLabel}</span>
            <button type="button" className="icon-btn" style={{ width: 26, height: 26 }} onClick={onNextDay} aria-label="Next day">
              <ChevronRight size={14} />
            </button>
          </span>
        }
      />
      <div className="card" style={{ padding: 6 }}>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "6px 8px 2px" }}>
          <button type="button" className="btn sm ghost" onClick={onSyncNow}>
            <RefreshCw size={13} /> Sync now
          </button>
          {writeEnabled && (
            <button type="button" className="btn sm primary" onClick={onSchedule}>
              <Plus size={13} /> Schedule appointment
            </button>
          )}
        </div>

        {entries.length === 0 ? (
          <div className="empty">
            <div className="eh">No appointments</div>
            <p className="type-footnote">No appointments on the schedule for this day.</p>
          </div>
        ) : (
          <div className="rows">
            {entries.map((e) => {
              const s = APPT[e.status];
              return (
                <button
                  key={e.id}
                  type="button"
                  className="lrow ev-row"
                  style={{ width: "100%", textAlign: "left", background: "transparent", border: 0, cursor: "pointer" }}
                  onClick={() => onSelect(e)}
                >
                  <span className="rmeta mono" style={{ width: 72, flexShrink: 0 }}>{formatApptTime(e.startsAt)}</span>
                  <span className="rt">
                    <span className="nm">{e.patientName}</span>
                    <span className="sub">{e.provider} · {e.operatory}</span>
                  </span>
                  <Badge kind={s.kind}>{s.label}</Badge>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
