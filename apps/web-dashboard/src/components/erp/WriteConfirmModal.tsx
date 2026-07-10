"use client";

/**
 * Write-back confirm (design brief §6). A write NEVER applies silently — it
 * always lands here for a human. Chip: Write · confirm to apply. Shows the
 * before/after for a reschedule. Stages the request (outbox) then confirms;
 * surfaces an honest error if the connector backend isn't wired yet.
 */

import { useId, useState } from "react";
import { PlugZap, AlertTriangle, ArrowRight } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import { SafetyChip } from "@/components/integrations/SafetyChip";
import { createAppointmentWriteRequest, confirmWriteRequest } from "@/lib/api.erp";
import type { AppointmentWriteRequest } from "@/lib/erp-types";
import type { TypedError } from "@/lib/hooks/apiFetch";
import { formatApptTime, formatDate } from "@/lib/erp-format";

const mono: React.CSSProperties = { fontFamily: "var(--font-mono, ui-monospace, monospace)" };

function when(iso: string) {
  return `${formatDate(iso)} · ${formatApptTime(iso)}`;
}

export function WriteConfirmModal({
  request,
  open,
  onClose,
  onDone,
}: {
  request: AppointmentWriteRequest | null;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const headingId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isReschedule = !!request?.previousStartsAt;

  async function handleConfirm() {
    if (!request) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createAppointmentWriteRequest(request);
      if (created.id) await confirmWriteRequest(created.id);
      onDone();
      onClose();
    } catch (err) {
      const code = (err as TypedError)?.code;
      setError(
        code === "NETWORK_ERROR" || code === "UNKNOWN"
          ? "Writing to Eaglesoft isn't available on this Droplet yet — the connector is still being wired up."
          : (err as Error)?.message || "Couldn't write to Eaglesoft. Nothing was changed.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} labelledBy={headingId} maxWidth="md">
      <div className="p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 id={headingId} className="type-title-3 text-label-primary">
            Add this appointment to Eaglesoft?
          </h2>
          <SafetyChip variant="write" />
        </div>

        {request && (
          <div className="mt-4 rounded-sm border border-separator divide-y divide-separator">
            <Field label="Patient" value={request.patientName} />
            {isReschedule ? (
              <div className="flex items-center justify-between px-4 py-3">
                <span className="type-footnote text-label-secondary">Time</span>
                <span className="type-footnote text-label-primary flex items-center gap-2" style={mono}>
                  <span className="line-through opacity-60">{when(request.previousStartsAt!)}</span>
                  <ArrowRight size={13} className="opacity-60" />
                  {when(request.startsAt)}
                </span>
              </div>
            ) : (
              <Field label="When" value={when(request.startsAt)} mono />
            )}
            <Field label="Provider" value={request.provider} />
            <Field label="Chair" value={request.operatory} />
            {request.reason ? <Field label="Reason" value={request.reason} /> : null}
          </div>
        )}

        <p className="type-footnote text-label-secondary mt-3 flex items-center gap-1.5">
          <PlugZap size={13} className="text-accent" />
          This writes directly into Eaglesoft, the same as if the front desk entered it.
        </p>

        {error && (
          <div className="mt-3 flex items-start gap-2 rounded-sm bg-system-red/10 p-3 type-footnote text-system-red">
            <AlertTriangle size={15} className="shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button type="button" className="type-footnote text-label-secondary px-3" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="dp-btn-primary" onClick={handleConfirm} disabled={busy || !request}>
            {busy ? "Writing…" : "Confirm and write"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function Field({ label, value, mono: isMono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <span className="type-footnote text-label-secondary">{label}</span>
      <span className="type-footnote text-label-primary" style={isMono ? mono : undefined}>{value}</span>
    </div>
  );
}
