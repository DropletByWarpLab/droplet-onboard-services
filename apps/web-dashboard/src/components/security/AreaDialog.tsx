"use client";

/**
 * WARP-2977 P2b (ADR-059 §3.4) — add an area, or change one's name and type.
 *
 * "Area" is the UI noun (ADR-002 lists "zones" as installer jargon); the code
 * and the routes keep `zone`. A right-edge side panel, which the shell turns
 * into a full-width sheet on a phone, so it owns a labelled Close control
 * (WARP-1787, `a11y.side-panel-close.test.ts`).
 *
 * Presentational: the Areas panel does the write, shows any failure as a
 * `translateError(err, "security")` toast and rethrows, and this dialog stays
 * open on a rejection so the person can retry or back out. Rendered only for
 * someone whose Security level is manage — the server refuses anyone below.
 *
 * Editing sends `expectedVersion` from the version the form was filled from,
 * and only the fields that changed. When the area changes under an open form
 * (someone else saved it; the panel refreshes after a conflict), the form is
 * refilled from the new version rather than silently overwriting it.
 */
import { useEffect, useId, useState, type FormEvent } from "react";
import { Loader2, X } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import type {
  SecurityZoneCreateBody,
  SecurityZoneKind,
  SecurityZonePatchBody,
  SecurityZoneView,
} from "@/lib/types";

/** The server's cap (`SecurityZone.name` VarChar(60), trimmed). */
export const AREA_NAME_MAX = 60;

/** Pill order in the form, and the order the panel lists nothing else by. */
export const KIND_ORDER: readonly SecurityZoneKind[] = ["entry", "interior", "perimeter", "parking", "restricted"];

/** The owner-facing name of each area type. */
export const KIND_LABEL: Record<SecurityZoneKind, string> = {
  entry: "Way in",
  interior: "Inside",
  perimeter: "Outside",
  parking: "Parking",
  restricted: "Staff only",
};

/** Suggestion chips: one tap fills the name AND the type. */
export const SUGGESTIONS: ReadonlyArray<{ name: string; kind: SecurityZoneKind }> = [
  { name: "Front door", kind: "entry" },
  { name: "Stock room", kind: "restricted" },
  { name: "Shop floor", kind: "interior" },
  { name: "Car park", kind: "parking" },
];

export const COPY = {
  addTitle: "Add an area",
  editTitle: "Change this area",
  sub: "A place you care about, like a door, a room or the car park. You choose which cameras cover it afterwards.",
  nameLabel: "Name",
  suggestions: "Suggestions",
  kindLabel: "What kind of place is it?",
  nameRequired: "Give the area a name.",
  nameTooLong: "Keep the name to 60 characters or fewer.",
  nameBadChars: "The name can't contain tabs or line breaks.",
  nameHiddenChars: "The name can't contain hidden characters that change how text reads or looks.",
  kindRequired: "Choose what kind of place it is.",
  cancel: "Cancel",
  add: "Add area",
  save: "Save",
} as const;

/** The server's NAME_FORBIDDEN: control characters, and the line / paragraph separators. */
const NAME_FORBIDDEN = /[\p{Cc}\p{Zl}\p{Zp}]/u;
/**
 * A lone surrogate — the server's `chainSafeText` refuses it (the audit chain
 * can't store it). Iterating by code point, a well-formed pair is ONE code
 * point above U+FFFF, so any code point left in D800–DFFF is unpaired. (No
 * regex lookbehind: older Safari fails to parse it at module load.)
 */
function hasLoneSurrogate(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (c >= 0xd800 && c <= 0xdfff) return true;
  }
  return false;
}

/**
 * The server's NAME_INVISIBLE, checked on what was typed (edges included):
 * every format character (\p{Cf}: bidi controls and marks, zero-width
 * characters, the soft hyphen, the TAG block …) and the blanks that are not
 * \p{Cf} but render as nothing (CGJ, the Hangul fillers, the Khmer inherent
 * vowels, the Braille blank). Variation selectors stay allowed.
 */
const NAME_INVISIBLE = /[\p{Cf}\u034F\u115F\u1160\u17B4\u17B5\u2800\u3164\uFFA0]/u;
/** The server's NAME_VISIBLE: a character a person can actually see. */
const NAME_VISIBLE = /[^\p{White_Space}\p{C}\p{Z}\p{M}\p{Default_Ignorable_Code_Point}]/u;

/**
 * The same rule the server applies (`normaliseZoneName`): NFC, trimmed, runs
 * of spaces made one, 1–60 CHARACTERS (code points, not UTF-16 units), at
 * least one of them visible, no control characters, line or paragraph
 * separators, lone surrogates or invisible characters. Null when fine.
 */
export function areaNameProblem(raw: string): string | null {
  const nfc = raw.normalize("NFC");
  if (NAME_INVISIBLE.test(nfc)) return COPY.nameHiddenChars;
  const name = nfc.trim().replace(/\p{Zs}+/gu, " ");
  const length = [...name].length;
  if (length === 0 || !NAME_VISIBLE.test(name)) return COPY.nameRequired;
  if (length > AREA_NAME_MAX) return COPY.nameTooLong;
  if (NAME_FORBIDDEN.test(name) || hasLoneSurrogate(name)) return COPY.nameBadChars;
  return null;
}

export interface AreaDialogProps {
  open: boolean;
  /** Absent or null → "Add an area". Present → change that area's name and type. */
  zone?: SecurityZoneView | null;
  onClose: () => void;
  /** Reject to keep the dialog open (the caller shows the error). */
  onCreate: (body: SecurityZoneCreateBody) => Promise<unknown>;
  /** Reject to keep the dialog open (the caller shows the error). */
  onUpdate: (id: string, body: SecurityZonePatchBody) => Promise<unknown>;
}

export function AreaDialog({ open, zone, onClose, onCreate, onUpdate }: AreaDialogProps) {
  const uid = useId();
  const titleId = `${uid}-title`;
  const subId = `${uid}-sub`;
  const nameId = `${uid}-name`;
  const errId = `${uid}-err`;
  const suggestionsId = `${uid}-suggestions`;
  const kindId = `${uid}-kind`;

  const editing = zone ?? null;
  const [name, setName] = useState(editing?.name ?? "");
  const [kind, setKind] = useState<SecurityZoneKind | null>(editing?.kind ?? null);
  const [baseVersion, setBaseVersion] = useState(editing?.version ?? 0);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Refill on every open, and whenever the area being edited moves to a new
  // version — the form must never save over a change it has not shown.
  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? "");
    setKind(editing?.kind ?? null);
    setBaseVersion(editing?.version ?? 0);
    setProblem(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing?.id, editing?.version]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    const found = areaNameProblem(name) ?? (kind ? null : COPY.kindRequired);
    if (found || !kind) {
      setProblem(found ?? COPY.kindRequired);
      return;
    }
    setProblem(null);
    // What the server will store (NFC, one space per run), so an unchanged name is never sent as a change.
    const trimmed = name.normalize("NFC").trim().replace(/\p{Zs}+/gu, " ");
    setPending(true);
    try {
      if (editing) {
        const body: SecurityZonePatchBody = { expectedVersion: baseVersion };
        if (trimmed !== editing.name) body.name = trimmed;
        if (kind !== editing.kind) body.kind = kind;
        // Nothing changed: no request, no audit row.
        if (body.name !== undefined || body.kind !== undefined) await onUpdate(editing.id, body);
      } else {
        await onCreate({ name: trimmed, kind });
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

        <div style={{ display: "grid", gap: 20, padding: 20, flex: 1 }}>
          <p id={subId} style={{ margin: 0, fontSize: 13, color: "var(--text-muted)" }}>
            {COPY.sub}
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
              maxLength={AREA_NAME_MAX}
              autoComplete="off"
              onChange={(e) => setName(e.target.value)}
              aria-invalid={problem !== null && problem !== COPY.kindRequired}
              aria-describedby={problem ? errId : undefined}
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

          {!editing && (
            <div style={{ display: "grid", gap: 8 }}>
              <span id={suggestionsId} style={{ fontSize: 12.5, fontWeight: 500, color: "var(--text-muted)" }}>
                {COPY.suggestions}
              </span>
              <div className="chiprow" role="group" aria-labelledby={suggestionsId}>
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s.name}
                    type="button"
                    className="chip"
                    onClick={() => {
                      setName(s.name);
                      setKind(s.kind);
                      setProblem(null);
                    }}
                  >
                    {s.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div style={{ display: "grid", gap: 8 }}>
            <span id={kindId} style={{ fontSize: 12.5, fontWeight: 500, color: "var(--text-muted)" }}>
              {COPY.kindLabel}
            </span>
            <div className="chiprow" role="group" aria-labelledby={kindId}>
              {KIND_ORDER.map((k) => (
                <button
                  key={k}
                  type="button"
                  className={`chip${kind === k ? " on" : ""}`}
                  aria-pressed={kind === k}
                  data-kind={k}
                  onClick={() => {
                    setKind(k);
                    if (problem === COPY.kindRequired) setProblem(null);
                  }}
                >
                  {KIND_LABEL[k]}
                </button>
              ))}
            </div>
          </div>

          {problem && (
            <p id={errId} role="alert" style={{ margin: 0, fontSize: 13, color: "var(--danger)" }}>
              {problem}
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
            {editing ? COPY.save : COPY.add}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
