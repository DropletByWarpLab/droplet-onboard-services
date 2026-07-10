"use client";

/**
 * Today's schedule (design brief §4.3; Claude Design handoff). A table —
 * TIME · PATIENT · PROVIDER · CHAIR · STATUS — where a row opens the patient
 * peek. Time is mono; status is a pill. The "Schedule appointment" action is
 * ABSENT (not disabled) unless writes are enabled — scheduling is a write.
 * Renders inside ShellPage (.droplet-shell scope; token-driven styling).
 */

import { RefreshCw, ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { Sect, Badge, type BadgeKind } from "@/components/shell/primitives";
import type { AppointmentStatus, ScheduleEntry } from "@/lib/erp-types";
import { formatApptTime } from "@/lib/erp-format";

const APPT: Record<AppointmentStatus, { label: string; kind: BadgeKind }> = {
  scheduled: { label: "Scheduled", kind: "info" },
  "checked-in": { label: "Checked-in", kind: "ok" },
  complete: { label: "Complete", kind: "muted" },
  cancelled: { label: "Cancelled", kind: "danger" },
};

const MONO = "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)";
const th: React.CSSProperties = {
  textAlign: "left",
  padding: "8px 14px",
  fontSize: 11,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  fontWeight: 600,
  color: "var(--text-muted)",
  borderBottom: "1px solid var(--card-bd)",
  whiteSpace: "nowrap",
};
const td: React.CSSProperties = { padding: "11px 14px", color: "var(--text)", verticalAlign: "middle" };

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
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <button type="button" className="icon-btn" style={{ width: 26, height: 26 }} onClick={onPrevDay} aria-label="Previous day">
                <ChevronLeft size={14} />
              </button>
              <span style={{ fontFamily: MONO, fontSize: 12 }}>{dateLabel}</span>
              <button type="button" className="icon-btn" style={{ width: 26, height: 26 }} onClick={onNextDay} aria-label="Next day">
                <ChevronRight size={14} />
              </button>
            </span>
            <button type="button" className="btn sm ghost" onClick={onSyncNow}>
              <RefreshCw size={13} /> Sync now
            </button>
            {writeEnabled && (
              <button type="button" className="btn sm primary" onClick={onSchedule}>
                <Plus size={13} /> Schedule appointment
              </button>
            )}
          </span>
        }
      />
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        {entries.length === 0 ? (
          <div className="empty">
            <div className="eh">No appointments</div>
            <p className="type-footnote">No appointments on the schedule for this day.</p>
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={th}>Time</th>
                  <th style={th}>Patient</th>
                  <th style={th}>Provider</th>
                  <th style={th}>Chair</th>
                  <th style={th}>Status</th>
                  <th style={{ ...th, width: 32 }} aria-hidden />
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => {
                  const s = APPT[e.status];
                  return (
                    <tr
                      key={e.id}
                      className="ev-row"
                      tabIndex={0}
                      role="button"
                      aria-label={`${formatApptTime(e.startsAt)} · ${e.patientName}`}
                      onClick={() => onSelect(e)}
                      onKeyDown={(ev) => {
                        if (ev.key === "Enter" || ev.key === " ") {
                          ev.preventDefault();
                          onSelect(e);
                        }
                      }}
                      style={{ cursor: "pointer", borderTop: "1px solid var(--card-bd)" }}
                    >
                      <td style={{ ...td, fontFamily: MONO, fontSize: 12.5, whiteSpace: "nowrap" }}>{formatApptTime(e.startsAt)}</td>
                      <td style={{ ...td, fontWeight: 500 }}>{e.patientName}</td>
                      <td style={{ ...td, color: "var(--text-muted)" }}>{e.provider}</td>
                      <td style={{ ...td, color: "var(--text-muted)" }}>{e.operatory}</td>
                      <td style={td}><Badge kind={s.kind}>{s.label}</Badge></td>
                      <td style={{ ...td, textAlign: "right" }}>
                        <ChevronRight size={15} style={{ color: "var(--text-muted)" }} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
