"use client";

// Small form pieces shared by the Support dialogs. They mirror the private
// `Field` / `Footer` in components/projects/modals.tsx so a Support dialog is
// laid out exactly like a Projects one.

import type { JSX, ReactNode } from "react";
import { SafetyChip } from "@/components/projects/bits";

export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="pm-field" style={{ marginBottom: 14 }}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? (
        <div role="alert" style={{ fontSize: 11.5, color: "var(--err)", marginTop: 4 }}>
          {error}
        </div>
      ) : (
        hint && <div style={{ fontSize: 11.5, color: "var(--text-4)", marginTop: 4 }}>{hint}</div>
      )}
    </div>
  );
}

export function ModalFooter({
  onClose,
  onSubmit,
  submitLabel,
  busy,
  disabled,
}: {
  onClose: () => void;
  onSubmit: () => void;
  submitLabel: string;
  busy: boolean;
  disabled?: boolean;
}): JSX.Element {
  return (
    <div
      className="pm-row"
      style={{ justifyContent: "space-between", gap: 8, padding: "14px 0 0", borderTop: "1px solid var(--border)", marginTop: 16 }}
    >
      <SafetyChip tier="write" />
      <div className="pm-row" style={{ gap: 8 }}>
        <button className="pm-btn" type="button" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="pm-btn primary" type="button" onClick={onSubmit} disabled={busy || disabled}>
          {busy ? "Working…" : submitLabel}
        </button>
      </div>
    </div>
  );
}

/** The failure strip a dialog shows when its write is refused — friendly copy,
 *  the form stays open. */
export function ErrorStrip({ message }: { message: string | null }): JSX.Element | null {
  if (!message) return null;
  return (
    <div
      role="alert"
      style={{
        background: "var(--err-soft)",
        color: "var(--text)",
        borderRadius: 8,
        padding: "8px 12px",
        fontSize: 12.5,
        marginBottom: 12,
      }}
    >
      {message}
    </div>
  );
}
