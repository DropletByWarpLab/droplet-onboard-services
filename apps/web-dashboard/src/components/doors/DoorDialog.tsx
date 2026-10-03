"use client";

/**
 * ADR-055 P4b — add a door, or change one's name and where its position comes
 * from. Rendered only for the owner (the server refuses anyone else; see
 * `DoorsPanel`).
 *
 * A right-edge side panel, which the shell turns into a full-width sheet on a
 * phone, so it owns a labelled Close control (WARP-1787). Presentational: the
 * panel does the write, shows a failure as a `translateError(err, "doors")`
 * toast and rethrows, and this dialog stays open on a rejection so the person
 * can retry or back out.
 *
 * The position source has NO default when adding: `none` is a real answer
 * with consequences (Droplet then can't tell a forced or left-open door), so
 * it is chosen, never inherited. Editing sends only the fields that changed,
 * and no request at all when nothing did.
 */
import { useEffect, useId, useState, type FormEvent } from "react";
import { Loader2, X } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import type { DoorCreateBody, DoorPatchBody, DoorPositionSource, DoorView } from "@/lib/types";
import { COPY, SOURCE_CHOICES } from "./door-copy";

/** The server's cap (`AccessPoint.name` is 1–80 characters, trimmed). */
export const DOOR_NAME_MAX = 80;

/** What the server will store: NFC, edge whitespace gone, runs of spaces made one. */
function normalised(raw: string): string {
  return raw.normalize("NFC").trim().replace(/\p{Zs}+/gu, " ");
}

/**
 * What can be checked without asking the box: empty, or over the cap in
 * CHARACTERS (code points, as the server counts). Hidden and control
 * characters are the server's to refuse; it answers INVALID_NAME.
 */
export function doorNameProblem(raw: string): string | null {
  const length = [...normalised(raw)].length;
  if (length === 0) return COPY.nameRequired;
  if (length > DOOR_NAME_MAX) return COPY.nameTooLong;
  return null;
}

export interface DoorDialogProps {
  open: boolean;
  /** Absent or null → "Add a door". Present → change that door. */
  door?: DoorView | null;
  onClose: () => void;
  /** Reject to keep the dialog open (the caller shows the error). */
  onCreate: (body: DoorCreateBody) => Promise<unknown>;
  /** Reject to keep the dialog open (the caller shows the error). */
  onUpdate: (id: string, body: DoorPatchBody) => Promise<unknown>;
}

export function DoorDialog({ open, door, onClose, onCreate, onUpdate }: DoorDialogProps) {
  const uid = useId();
  const titleId = `${uid}-title`;
  const subId = `${uid}-sub`;
  const nameId = `${uid}-name`;
  const errId = `${uid}-err`;

  const editing = door ?? null;
  const [name, setName] = useState(editing?.name ?? "");
  const [source, setSource] = useState<DoorPositionSource | null>(editing?.doorPositionSource ?? null);
  const [problem, setProblem] = useState<{ field: "name" | "source"; text: string } | null>(null);
  const [pending, setPending] = useState(false);

  // Refill on every open, and when the door being edited is a different one.
  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? "");
    setSource(editing?.doorPositionSource ?? null);
    setProblem(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing?.id]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    const nameProblem = doorNameProblem(name);
    if (nameProblem) {
      setProblem({ field: "name", text: nameProblem });
      return;
    }
    if (!source) {
      setProblem({ field: "source", text: COPY.sourceRequired });
      return;
    }
    setProblem(null);
    const trimmed = normalised(name);
    setPending(true);
    try {
      if (editing) {
        const body: DoorPatchBody = {};
        if (trimmed !== editing.name) body.name = trimmed;
        if (source !== editing.doorPositionSource) body.doorPositionSource = source;
        // Nothing changed: no request, no audit row.
        if (body.name !== undefined || body.doorPositionSource !== undefined) await onUpdate(editing.id, body);
      } else {
        await onCreate({ name: trimmed, doorPositionSource: source });
      }
      onClose();
    } catch {
      // The caller has already shown why; stay open so the person can retry.
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} placement="right" labelledBy={titleId} describedBy={subId} flush>
      <form onSubmit={submit} noValidate style={{ display: "flex", flexDirection: "column", minHeight: "100%" }}>
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
          <h2 id={titleId} style={{ margin: 0, fontSize: 17, fontWeight: 600, color: "var(--text)" }}>
            {editing ? COPY.editTitle : COPY.addTitle}
          </h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <X size={18} aria-hidden />
          </button>
        </div>

        <div style={{ display: "grid", gap: 20, padding: 20, flex: 1, alignContent: "start" }}>
          <p id={subId} style={{ margin: 0, fontSize: 13, color: "var(--text-muted)" }}>
            {COPY.formSub}
          </p>

          <div style={{ display: "grid", gap: 6 }}>
            <label htmlFor={nameId} style={{ fontSize: 12.5, fontWeight: 500, color: "var(--text-muted)" }}>
              {COPY.nameLabel}
            </label>
            {/* maxLength counts UTF-16 units, so it is a typing aid that is
                stricter than the rule only for emoji-like characters. */}
            <input
              id={nameId}
              type="text"
              value={name}
              maxLength={DOOR_NAME_MAX}
              autoComplete="off"
              onChange={(e) => setName(e.target.value)}
              aria-invalid={problem?.field === "name"}
              aria-describedby={problem?.field === "name" ? errId : undefined}
              style={{
                width: "100%",
                height: 40,
                padding: "0 12px",
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-input)",
                color: "var(--text)",
                font: "inherit",
                fontSize: 14,
              }}
            />
          </div>

          <fieldset style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
            <legend style={{ padding: 0, marginBottom: 8, fontSize: 12.5, fontWeight: 500, color: "var(--text-muted)" }}>
              {COPY.sourceLegend}
            </legend>
            <div className="rows">
              {SOURCE_CHOICES.map((c) => (
                <label key={c.value} className="lrow" style={{ cursor: "pointer" }}>
                  <input
                    type="radio"
                    name={`${uid}-source`}
                    value={c.value}
                    checked={source === c.value}
                    aria-describedby={problem?.field === "source" ? errId : undefined}
                    onChange={() => {
                      setSource(c.value);
                      if (problem?.field === "source") setProblem(null);
                    }}
                  />
                  <span className="rt">
                    <span className="nm">{c.label}</span>
                    <span className="sub" style={{ whiteSpace: "normal" }}>
                      {c.help}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {problem && (
            <p id={errId} role="alert" style={{ margin: 0, fontSize: 13, color: "var(--danger)" }}>
              {problem.text}
            </p>
          )}
        </div>

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
          <button type="button" className="btn ghost" onClick={onClose} disabled={pending}>
            {COPY.cancel}
          </button>
          <button type="submit" className="btn primary" disabled={pending}>
            {pending ? <Loader2 size={16} className="animate-spin" aria-hidden /> : null}
            {editing ? COPY.save : COPY.addConfirm}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
