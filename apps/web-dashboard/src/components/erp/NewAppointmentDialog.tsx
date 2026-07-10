"use client";

/**
 * New-appointment form — the entry point that feeds the write-confirm modal
 * (design brief §6). Only reachable when writes are enabled. It does NOT write;
 * it builds an AppointmentWriteRequest and hands it to WriteConfirmModal, where
 * the human confirms.
 */

import { useId, useState } from "react";
import { CalendarPlus } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import type { AppointmentWriteRequest } from "@/lib/erp-types";

export function NewAppointmentDialog({
  open,
  onClose,
  onReady,
}: {
  open: boolean;
  onClose: () => void;
  onReady: (req: AppointmentWriteRequest) => void;
}) {
  const headingId = useId();
  const [patientName, setPatientName] = useState("");
  const [provider, setProvider] = useState("");
  const [operatory, setOperatory] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [reason, setReason] = useState("");

  const canReview = !!(patientName && provider && operatory && startsAt);

  function review() {
    if (!canReview) return;
    onReady({
      command: "erp_schedule_appointment",
      patientName,
      provider,
      operatory,
      startsAt: new Date(startsAt).toISOString(),
      reason: reason || undefined,
    });
  }

  return (
    <Dialog open={open} onClose={onClose} labelledBy={headingId} maxWidth="md">
      <div className="p-5">
        <h2 id={headingId} className="type-title-3 text-label-primary flex items-center gap-2">
          <CalendarPlus size={18} className="text-accent" /> Schedule an appointment
        </h2>
        <div className="mt-4 space-y-3">
          <Labeled label="Patient">
            <input className="dp-input" value={patientName} onChange={(e) => setPatientName(e.target.value)} placeholder="Full name" />
          </Labeled>
          <div className="grid grid-cols-2 gap-3">
            <Labeled label="Provider">
              <input className="dp-input" value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="Dr. Lee" />
            </Labeled>
            <Labeled label="Chair">
              <input className="dp-input" value={operatory} onChange={(e) => setOperatory(e.target.value)} placeholder="Op 2" />
            </Labeled>
          </div>
          <Labeled label="Date & time">
            <input type="datetime-local" className="dp-input" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
          </Labeled>
          <Labeled label="Reason (optional)">
            <input className="dp-input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Recall, exam, …" />
          </Labeled>
        </div>
        <div className="mt-5 flex items-center justify-end gap-2">
          <button type="button" className="type-footnote text-label-secondary px-3" onClick={onClose}>Cancel</button>
          <button type="button" className="dp-btn-primary" disabled={!canReview} onClick={review}>Review</button>
        </div>
      </div>
    </Dialog>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="type-footnote text-label-secondary">{label}</span>
      <div className="mt-1.5">{children}</div>
    </label>
  );
}
