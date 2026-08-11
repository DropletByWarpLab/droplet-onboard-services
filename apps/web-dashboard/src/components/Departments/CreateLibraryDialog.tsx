"use client";

/**
 * The create-a-department/team dialog.
 *
 * WARP-1270 built this inline in `DepartmentsPanel`. WARP-1506 gave
 * "Company files" a second, real entry point into the same creation — the
 * Libraries section there had no action at all — so it lives on its own
 * rather than being copied and left to drift. `DepartmentsPanel` is
 * unchanged from the user's side: same heading, same fields, same slug
 * preview, same submit copy.
 *
 * The dialog owns only the FORM. What happens after a successful create —
 * reload the list, select the new row, toast — belongs to the caller, which
 * is the only part the two surfaces disagree about.
 *
 * Honest state (WARP-1270, design brief §3): the server returns
 * `state=pending` and a reconciler provisions the groupfolder, so callers
 * re-read rather than fabricating an active row.
 */

import { useEffect, useId, useState } from "react";
import { Dialog } from "@/components/Dialog";
import { createDepartment, createTeam } from "@/lib/api";
import { storageInputToBytes, type StorageUnit } from "@/lib/storage-units";
import type { Department } from "@/lib/types";

/** Client-side slug preview only — the server (nameToSlug in
 *  routes/departments.ts) is the authoritative slug generator. */
export function slugPreview(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

interface QuotaFormState {
  value: string;
  unit: StorageUnit;
}

/** `undefined` (omit the field) rather than the shared encoder's `null`: the
 *  create payload has no "clear the quota" case, so an empty field means
 *  "don't send one" — the server default applies. */
function quotaToBytes(q: QuotaFormState): string | undefined {
  return storageInputToBytes(q.value, q.unit) ?? undefined;
}

const fieldStyle: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-input)",
  color: "var(--text)",
};

// Shell typography (WARP-1347 — indigo idiom, no legacy `type-*`
// utilities). Metrics mirror the old `type-headline` / `type-caption-1` /
// `type-footnote` classes 1:1 so the visual hierarchy is unchanged.
const DIALOG_HEADING_STYLE: React.CSSProperties = {
  margin: 0,
  fontSize: 17,
  lineHeight: "22px",
  fontWeight: 600,
  letterSpacing: "-0.41px",
  color: "var(--text)",
};
const FIELD_LABEL_STYLE: React.CSSProperties = {
  fontSize: 12,
  lineHeight: "16px",
  color: "var(--text-muted)",
};
const FOOTNOTE_STYLE: React.CSSProperties = {
  fontSize: 13,
  lineHeight: "18px",
  letterSpacing: "-0.08px",
};

export interface CreateLibraryDialogProps {
  open: boolean;
  /** `null` → a new department. A Department → a new team under it. */
  parent?: Department | null;
  onClose: () => void;
  /** Called after the server accepted the create. The caller re-reads. */
  onCreated: (created: Department) => void | Promise<void>;
  triggerRef?: React.MutableRefObject<HTMLButtonElement | null>;
  /** Company files calls a department a "library" — its own section noun.
   *  Defaults keep the departments admin's shipped copy verbatim. */
  heading?: string;
  submitLabel?: string;
}

export function CreateLibraryDialog({
  open,
  parent = null,
  onClose,
  onCreated,
  triggerRef,
  heading,
  submitLabel,
}: CreateLibraryDialogProps) {
  const headingId = useId();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [quota, setQuota] = useState<QuotaFormState>({ value: "", unit: "GB" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Every open starts from a blank form — a half-typed abandoned name must
  // not reappear on the next attempt.
  useEffect(() => {
    if (!open) return;
    setName("");
    setDescription("");
    setQuota({ value: "", unit: "GB" });
    setError(null);
  }, [open]);

  const close = () => {
    if (busy) return;
    onClose();
  };

  async function handleSubmit() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Name is required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const payload = {
        name: trimmed,
        description: description.trim() || undefined,
        quotaBytes: quotaToBytes(quota),
      };
      const created = parent
        ? (await createTeam(parent.id, payload)).team
        : (await createDepartment(payload)).department;
      onClose();
      await onCreated(created);
    } catch (err) {
      setError((err as Error)?.message || "Failed to create");
    } finally {
      setBusy(false);
    }
  }

  const headingLabel =
    heading ?? (parent ? `New team in ${parent.name}` : "New department");
  const submitText =
    submitLabel ?? (parent ? "Create team" : "Create department");

  return (
    <Dialog
      open={open}
      onClose={close}
      triggerRef={triggerRef}
      labelledBy={headingId}
      maxWidth="sm"
    >
      <div className="space-y-3">
        <h2 id={headingId} style={DIALOG_HEADING_STYLE}>
          {headingLabel}
        </h2>
        <div>
          <label className="mb-1.5 block" style={FIELD_LABEL_STYLE}>
            Name
          </label>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={parent ? "Platform" : "Finance"}
            className="w-full px-3 py-2.5 outline-none focus:ring-2 focus:ring-[var(--brand)] transition-shadow"
            style={fieldStyle}
          />
          {name.trim() && (
            <p className="mt-1.5" style={FIELD_LABEL_STYLE}>
              <span className="mono">
                {parent ? `${parent.slug}-` : ""}
                <b style={{ color: "var(--brand)" }}>{slugPreview(name)}</b>
              </span>
            </p>
          )}
        </div>
        <div>
          <label className="mb-1.5 block" style={FIELD_LABEL_STYLE}>
            Description (optional)
          </label>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full px-3 py-2.5 outline-none focus:ring-2 focus:ring-[var(--brand)] transition-shadow"
            style={fieldStyle}
          />
        </div>
        <div>
          <label className="mb-1.5 block" style={FIELD_LABEL_STYLE}>
            Storage quota (optional)
          </label>
          <div className="flex gap-1.5">
            <input
              type="number"
              min={0}
              step="any"
              inputMode="decimal"
              value={quota.value}
              onChange={(e) => setQuota((q) => ({ ...q, value: e.target.value }))}
              placeholder="No limit"
              aria-label="Quota amount"
              className="flex-1 px-3 py-2.5 outline-none focus:ring-2 focus:ring-[var(--brand)] transition-shadow"
              style={fieldStyle}
            />
            <select
              value={quota.unit}
              onChange={(e) => setQuota((q) => ({ ...q, unit: e.target.value as StorageUnit }))}
              aria-label="Quota unit"
              className="px-2.5 py-2.5 outline-none focus:ring-2 focus:ring-[var(--brand)] transition-shadow"
              style={fieldStyle}
            >
              <option value="GB">GB</option>
              <option value="TB">TB</option>
            </select>
          </div>
        </div>
        {error && (
          <p role="alert" className="text-system-red" style={FOOTNOTE_STYLE}>
            {error}
          </p>
        )}
        <div className="flex items-center justify-end gap-2 pt-1">
          <button type="button" onClick={close} className="btn ghost" disabled={busy}>
            Cancel
          </button>
          <button type="button" onClick={handleSubmit} className="btn primary" disabled={busy}>
            {busy ? "Creating…" : submitText}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
