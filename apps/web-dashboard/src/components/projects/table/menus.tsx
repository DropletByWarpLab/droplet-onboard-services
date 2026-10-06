"use client";

// WARP-3537 — the pickers a table cell and the bulk bar share: state, priority,
// assignees, labels, due date. Each is only the CONTENT of a `FloatingMenu`; the
// caller decides what picking does (one row, or the whole selection), which is why a
// cell and the bar behave the same and are tested once.
//
// Copy follows brief §6 (sentence case, no exclamation marks); every control is a
// native button, input or select.

import { useId, useState, type JSX } from "react";
import { PmIcon } from "../icons";
import { PriorityFlag } from "../bits";
import { PRIORITY_ORDER } from "../config";
import type { PmLabel, PmState, Priority } from "../types";

export interface PersonChoice {
  value: string;
  label: string;
}

// ── state ───────────────────────────────────────────────────────────────────

export function StateMenu({
  states,
  currentId,
  onPick,
}: {
  states: PmState[];
  currentId?: string | null;
  onPick: (s: PmState) => void;
}): JSX.Element {
  const sorted = [...states].sort((a, b) => a.sortOrder - b.sortOrder);
  return (
    <ul className="pm-fmenu-list" role="none">
      {sorted.length === 0 && <li className="pm-pop-empty">This project has no states yet.</li>}
      {sorted.map((s) => (
        <li key={s.id} role="none">
          <button type="button" role="menuitemradio" aria-checked={s.id === currentId} className="pm-fmenu-item" onClick={() => onPick(s)}>
            <span className="pm-dot" style={{ background: s.color ?? "var(--text-4)" }} />
            <span className="grow">{s.name}</span>
            {s.id === currentId && <PmIcon name="check" size={13} />}
          </button>
        </li>
      ))}
    </ul>
  );
}

// ── priority ────────────────────────────────────────────────────────────────

export function PriorityMenu({ current, onPick }: { current?: Priority | null; onPick: (p: Priority) => void }): JSX.Element {
  return (
    <ul className="pm-fmenu-list" role="none">
      {PRIORITY_ORDER.map((p) => (
        <li key={p} role="none">
          <button type="button" role="menuitemradio" aria-checked={p === current} className="pm-fmenu-item" onClick={() => onPick(p)}>
            <PriorityFlag p={p} withLabel />
            <span className="grow" />
            {p === current && <PmIcon name="check" size={13} />}
          </button>
        </li>
      ))}
    </ul>
  );
}

// ── assignees ───────────────────────────────────────────────────────────────

/**
 * Pick the COMPLETE set of assignees (brief §4.2: a full-set replacement on the wire,
 * not a delta). People the list does not show — someone who has since left — stay in
 * the set until the person picking removes the whole row's assignees: they are not
 * dropped by a click that never showed them.
 *
 * `allowEmpty` is the single-row case, where "nobody" is a fair thing to apply. For
 * a SELECTION it is not: applying an empty set would unassign every selected item
 * on a stray click, so there it is a separate, named button (`onClear`).
 */
export function AssigneeMenu({
  people,
  initial,
  allowEmpty,
  applyLabel = "Apply",
  onApply,
  onClear,
  onCancel,
}: {
  people: PersonChoice[];
  initial: string[];
  allowEmpty: boolean;
  applyLabel?: string;
  onApply: (assigneeIds: string[]) => void;
  /** Present for a selection: "Clear assignees". */
  onClear?: () => void;
  onCancel: () => void;
}): JSX.Element {
  const [picked, setPicked] = useState<string[]>(initial);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const canApply = allowEmpty || picked.length > 0;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (canApply) onApply(picked);
      }}
    >
      <fieldset className="pm-pop-list" style={{ margin: 0 }}>
        <legend className="sr-only">Assignees</legend>
        {people.length === 0 && <div className="pm-pop-empty">There is no one to assign yet.</div>}
        {people.map((p) => (
          <label key={p.value} className="pm-pop-row">
            <input type="checkbox" checked={picked.includes(p.value)} onChange={() => toggle(p.value)} />
            <span>{p.label}</span>
          </label>
        ))}
      </fieldset>
      <div className="pm-pop-f">
        {onClear && (
          <button type="button" className="pm-btn ghost sm" style={{ marginRight: "auto" }} onClick={onClear}>
            Clear assignees
          </button>
        )}
        <button type="button" className="pm-btn sm" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="pm-btn primary sm" disabled={!canApply}>
          {applyLabel}
        </button>
      </div>
    </form>
  );
}

// ── labels ──────────────────────────────────────────────────────────────────

export function LabelMenu({ labels, onPick }: { labels: PmLabel[]; onPick: (labelId: string, mode: "add" | "remove") => void }): JSX.Element {
  const [mode, setMode] = useState<"add" | "remove">("add");
  const group = useId();
  return (
    <div>
      <div className="pm-pills" role="group" aria-label="What to do with the label" style={{ marginBottom: 8 }}>
        {(["add", "remove"] as const).map((m) => (
          <button key={m} type="button" className={mode === m ? "on" : ""} aria-pressed={mode === m} onClick={() => setMode(m)} id={`${group}-${m}`}>
            {m === "add" ? "Add" : "Remove"}
          </button>
        ))}
      </div>
      <ul className="pm-fmenu-list" role="none">
        {labels.length === 0 && <li className="pm-pop-empty">No labels in this project yet.</li>}
        {labels.map((l) => (
          <li key={l.id} role="none">
            <button type="button" role="menuitem" className="pm-fmenu-item" onClick={() => onPick(l.id, mode)}>
              <span className="pm-dot" style={{ background: l.color ?? "var(--text-4)" }} />
              <span className="grow">{l.name}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── due date ────────────────────────────────────────────────────────────────

/** A calendar date, or none. `value` is `YYYY-MM-DD`. */
export function DueMenu({
  value,
  onApply,
  onCancel,
}: {
  value: string | null;
  onApply: (ymd: string | null) => void;
  onCancel: () => void;
}): JSX.Element {
  const [ymd, setYmd] = useState(value ?? "");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (ymd) onApply(ymd);
      }}
    >
      <label className="pm-field" style={{ display: "block" }}>
        <span className="sr-only">Due date</span>
        <input className="pm-input pm-mono" type="date" aria-label="Due date" value={ymd} onChange={(e) => setYmd(e.target.value)} />
      </label>
      <div className="pm-pop-f">
        {value !== null && (
          <button type="button" className="pm-btn ghost sm" style={{ marginRight: "auto" }} onClick={() => onApply(null)}>
            Clear date
          </button>
        )}
        <button type="button" className="pm-btn sm" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="pm-btn primary sm" disabled={!ymd}>
          Save
        </button>
      </div>
    </form>
  );
}
