"use client";
import { ThemedDateInput } from "@/components/ui/ThemedDateInput";


// WARP-3520 -- the small editors the properties card and the custom fields share:
// a commit-on-blur text/number input, a date input, the estimate field and the
// parent field. Each is a controlled-by-parent value with a local draft, so the
// optimistic layer (`useItemSave`) stays the only place that talks to the API.

import { useEffect, useState, type JSX } from "react";
import { PmIcon } from "../icons";
import { ESTIMATE_MAX, ESTIMATE_MIN } from "../config";
import { useWorkItemLookup } from "../useEditing";
import type { PmWorkItem } from "../types";
import { ItemSearchPicker } from "./pickers/ItemSearchPicker";

/**
 * A text or number input that commits on blur / Enter and cancels on Escape.
 *
 * `value` is what is saved; the draft is what is typed. Committing an unchanged
 * value writes nothing. `validate` (non-empty input only) returns the inline
 * message for a value that must not be sent. Escape only claims the keystroke
 * when there is an edit to cancel — an Escape with nothing typed still reaches
 * the drawer and closes it.
 */
export function DraftInput({
  label,
  value,
  type = "text",
  min,
  max,
  step,
  maxLength,
  disabled,
  required,
  validate,
  onCommit,
}: {
  label: string;
  value: string;
  type?: "text" | "number";
  min?: number;
  max?: number;
  step?: string;
  maxLength?: number;
  disabled?: boolean;
  /** A name that cannot be cleared: an empty draft reverts instead of committing. */
  required?: boolean;
  validate?: (text: string) => string | null;
  /** Called with the trimmed text when it differs from `value`; `""` means clear. */
  onCommit: (text: string) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(value);
    setError(null);
  }, [value]);

  const commit = () => {
    const text = draft.trim();
    if (text === value || (text === "" && required)) {
      setDraft(value);
      setError(null);
      return;
    }
    const problem = text === "" ? null : (validate?.(text) ?? null);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    onCommit(text);
  };

  return (
    <>
      <input
        className={"pm-input sm" + (error ? " invalid" : "")}
        type={type}
        min={min}
        max={max}
        step={step}
        maxLength={maxLength}
        aria-label={label}
        aria-invalid={error ? true : undefined}
        disabled={disabled}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape" && draft !== value) {
            e.stopPropagation();
            setDraft(value);
            setError(null);
          }
        }}
      />
      {error && (
        <div className="pm-field-error" role="alert">
          {error}
        </div>
      )}
    </>
  );
}

/**
 * A calendar-date input. It commits on blur / Enter and sends `YYYY-MM-DD` — the
 * value of an `<input type="date">` — never a Date object, so no timezone can
 * move the day. A partially typed date reads as `""`, which must NEVER clear the
 * field by accident: an empty draft reverts, and clearing is the explicit button.
 */
export function DateField({
  label,
  value,
  disabled,
  onCommit,
}: {
  label: string;
  /** `YYYY-MM-DD`, or "" when unset. */
  value: string;
  disabled?: boolean;
  /** `null` clears. */
  onCommit: (next: string | null) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  const commit = () => {
    if (draft === "" || draft === value) {
      setDraft(value);
      return;
    }
    onCommit(draft);
  };

  return (
    <span className="pm-row" style={{ gap: 6 }}>
      <ThemedDateInput
        clearable={false}
        className="pm-input pm-mono sm"
        style={{ width: "auto" }}
        type="date"
        aria-label={label}
        disabled={disabled}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape" && draft !== value) {
            e.stopPropagation();
            setDraft(value);
          }
        }}
      />
      {value !== "" && !disabled && (
        <button type="button" className="pm-iconbtn" aria-label={`Clear ${label.toLowerCase()}`} onClick={() => onCommit(null)}>
          <PmIcon name="x" size={14} />
        </button>
      )}
    </span>
  );
}

/** Story points, 0..1000 (the orchestrator's CHECK). Empty clears. */
export function EstimateField({
  value,
  disabled,
  onCommit,
}: {
  value: number | null;
  disabled?: boolean;
  onCommit: (next: number | null) => void;
}): JSX.Element {
  return (
    <DraftInput
      label="Estimate"
      type="number"
      min={ESTIMATE_MIN}
      max={ESTIMATE_MAX}
      step="any"
      value={value === null ? "" : String(value)}
      disabled={disabled}
      validate={(text) => {
        const n = Number(text);
        return Number.isFinite(n) && n >= ESTIMATE_MIN && n <= ESTIMATE_MAX
          ? null
          : `Estimate must be between ${ESTIMATE_MIN} and ${ESTIMATE_MAX}.`;
      }}
      onCommit={(text) => onCommit(text === "" ? null : Number(text))}
    />
  );
}

/**
 * The parent (sub-issue) field. Candidates come from the workspace search and are
 * narrowed to this project and away from the item itself; whether a choice would
 * make a loop is the API's call (`parent_cycle`), reported through the shared
 * optimistic layer like any other refused write.
 */
export function ParentField({
  item,
  disabled,
  onChange,
}: {
  item: Pick<PmWorkItem, "id" | "projectId" | "parentId">;
  disabled?: boolean;
  /** `null` clears the parent. */
  onChange: (parent: PmWorkItem | null) => void;
}): JSX.Element {
  const [picking, setPicking] = useState(false);
  const { item: parent } = useWorkItemLookup(item.parentId);

  if (picking) {
    return (
      <ItemSearchPicker
        label="Search for a parent"
        hint="Sub-issues stay in the same project."
        filter={(r) => r.projectId === item.projectId && r.id !== item.id}
        onCancel={() => setPicking(false)}
        onPick={(picked) => {
          setPicking(false);
          onChange(picked);
        }}
      />
    );
  }

  return (
    <span className="pm-row" style={{ gap: 6, flexWrap: "wrap" }}>
      {item.parentId === null ? (
        <span style={{ fontSize: 12.5, color: "var(--text-4)" }}>No parent</span>
      ) : parent ? (
        <span className="pm-tag" style={{ height: 24, maxWidth: "100%" }}>
          <span className="pm-mono">{parent.key}</span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{parent.name}</span>
        </span>
      ) : (
        <span style={{ fontSize: 12.5, color: "var(--text-4)" }}>Loading…</span>
      )}
      {!disabled && (
        <>
          <button type="button" className="pm-btn ghost sm" onClick={() => setPicking(true)}>
            {item.parentId === null ? "Set parent" : "Change parent"}
          </button>
          {item.parentId !== null && (
            <button type="button" className="pm-iconbtn" aria-label="Remove parent" onClick={() => onChange(null)}>
              <PmIcon name="x" size={14} />
            </button>
          )}
        </>
      )}
    </span>
  );
}
