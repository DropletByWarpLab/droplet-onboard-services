"use client";

/**
 * Patient peek (design brief §4.3) — a right-side panel with a read-only
 * demographics + balance summary. PHI: carries the Read chip; renders inside a
 * portaled Dialog (global token scope). Missing fields show an em-dash rather
 * than a fake value (the full summary loads from the backend when connected).
 */

import { useId } from "react";
import { UserRound, X } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import { SafetyChip } from "@/components/integrations/SafetyChip";
import type { PatientSummary } from "@/lib/erp-types";
import { formatDate, formatUsd } from "@/lib/erp-format";

export type PatientPeekTarget = Partial<PatientSummary> & { id: string; name: string };

const mono: React.CSSProperties = { fontFamily: "var(--font-mono, ui-monospace, monospace)" };
const DASH = "—";

export function PatientPeek({
  patient,
  open,
  onClose,
}: {
  patient: PatientPeekTarget | null;
  open: boolean;
  onClose: () => void;
}) {
  const headingId = useId();
  const rows: [string, React.ReactNode][] = patient
    ? [
        ["Date of birth", <span style={mono}>{patient.dob ? formatDate(patient.dob) : DASH}</span>],
        ["Phone", <span style={mono}>{patient.phone ?? DASH}</span>],
        ["Chart #", <span style={mono}>{patient.chartNumber ?? DASH}</span>],
        ["Balance", <span style={mono}>{patient.balanceCents != null ? formatUsd(patient.balanceCents, { cents: true }) : DASH}</span>],
        ["Last visit", <span style={mono}>{patient.lastVisit ? formatDate(patient.lastVisit) : DASH}</span>],
        ["Next visit", <span style={mono}>{patient.nextVisit ? formatDate(patient.nextVisit) : DASH}</span>],
      ]
    : [];

  return (
    <Dialog open={open} onClose={onClose} labelledBy={headingId} placement="right">
      <div className="flex flex-col h-full">
        <div className="flex items-center justify-between px-5 h-16 border-b border-separator">
          <div className="flex items-center gap-3 min-w-0">
            <span className="w-9 h-9 rounded-full bg-accent-subtle flex items-center justify-center shrink-0 text-accent">
              <UserRound size={18} />
            </span>
            <h2 id={headingId} className="type-headline text-label-primary truncate">
              {patient?.name ?? "Patient"}
            </h2>
          </div>
          <button type="button" className="p-1.5 rounded-sm text-label-tertiary hover:text-label-primary" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="px-5 py-4">
          <SafetyChip variant="read-phi" />
          <dl className="mt-4 rounded-sm border border-separator divide-y divide-separator">
            {rows.map(([k, v]) => (
              <div key={k} className="flex items-center justify-between px-4 py-3">
                <dt className="type-footnote text-label-secondary">{k}</dt>
                <dd className="type-footnote text-label-primary">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="type-caption-1 text-label-tertiary mt-3">
            Read from your Eaglesoft database — stays on your network.
          </p>
        </div>
      </div>
    </Dialog>
  );
}
