"use client";
import { ThemedDateInput } from "@/components/ui/ThemedDateInput";


// WARP-3522 — the filter bar (brief §3.9): a search box, a "Filter" menu that
// reaches every field of the filter language, and the active filters as chips.
//
// It edits a `PmFilter` (the shared DSL) and nothing else: the page owns where
// that filter lives (the URL), and the server owns what it means. The search
// box is the filter's `text` condition; every other top-level condition is a
// chip; anything the bar cannot represent is one read-only "Custom filter" chip
// that can still be removed (see filter-model.ts).
//
// Keyboard and screen readers (brief §5): every control is a native button,
// input or select; the Filter menu and the chip editor are popovers that take
// focus on open, close on Escape and hand focus back to what opened them; a
// chip's edit and remove controls are separate buttons with their own names.

import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode, type RefObject } from "react";
import { isPmFilterGroup, type PmFilter, type PmFilterField } from "@droplet/shared-types";
import { PmIcon } from "./icons";
import { PRIORITY, PRIORITY_ORDER } from "./config";
import type { DepartmentOption } from "./department";
import {
  DATE_PRESETS,
  FIELD_LABEL,
  NULLABLE_DATE_FIELDS,
  PRESENCE_LABEL,
  STAGE_LABEL,
  availableFields,
  describeChip,
  joinFilter,
  multiChip,
  presenceChip,
  readMulti,
  splitFilter,
  withChip,
  withText,
  withoutChip,
  type Choice,
  type ChipLookups,
  type FieldUi,
  type FilterScope,
  type MultiMode,
} from "./filter-model";
import type { PmLabel, PmProject, PmState, StateGroup } from "./types";
import { ThemedSelect } from "@/components/ui/ThemedSelect";

// ── popover ─────────────────────────────────────────────────────────────────

/**
 * A small panel under its trigger. Takes focus when it opens, closes on Escape
 * (and gives focus back to the trigger) or a click outside, and is otherwise
 * ordinary DOM — nothing is trapped, so Tab leaves it like any other region.
 */
export function Popover({
  open,
  onClose,
  anchorRef,
  label,
  role = "dialog",
  children,
}: {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  label: string;
  role?: "dialog" | "menu";
  children: ReactNode;
}): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // Read lazily: the effect below must run when the popover OPENS, not each time a
  // parent hands it a new ref object — a re-run would pull focus back to the
  // first control while someone is typing in another.
  const anchorLatest = useRef(anchorRef);
  anchorLatest.current = anchorRef;

  useEffect(() => {
    if (!open) return;
    ref.current
      ?.querySelector<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled])")
      ?.focus();
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || anchorLatest.current.current?.contains(target)) return;
      closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      closeRef.current();
      anchorLatest.current.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!open) return null;
  return (
    <div ref={ref} className="pm-pop" role={role} aria-label={label}>
      {children}
    </div>
  );
}

// ── editors ─────────────────────────────────────────────────────────────────

export interface EditorOptions {
  scope: FilterScope;
  states: PmState[];
  labels: PmLabel[];
  /** People to pick from, WITHOUT `me` and `nobody` — those are added here. */
  people: Choice[];
  departments: DepartmentOption[];
  projects: PmProject[];
}

function choicesFor(field: PmFilterField, o: EditorOptions): Choice[] {
  switch (field) {
    case "state":
      return [...o.states].sort((a, b) => a.sortOrder - b.sortOrder).map((s) => ({ value: s.id, label: s.name }));
    case "stateGroup":
      return (Object.keys(STAGE_LABEL) as StateGroup[]).map((g) => ({ value: g, label: STAGE_LABEL[g] }));
    case "priority":
      return PRIORITY_ORDER.map((p) => ({ value: p, label: PRIORITY[p].label }));
    case "assignee":
      return [{ value: "me", label: "Me" }, { value: "none", label: "Nobody" }, ...o.people];
    case "createdBy":
      return [{ value: "me", label: "Me" }, ...o.people];
    case "label":
      return o.labels.map((l) => ({ value: l.id, label: l.name }));
    case "department":
      return [
        { value: "none", label: "No department" },
        ...o.departments.map((d) => ({ value: d.id, label: d.kind === "TEAM" ? `${d.name} (team)` : d.name })),
      ];
    case "project":
      return o.projects.filter((p) => !p.archived).map((p) => ({ value: p.id, label: p.name }));
    default:
      return [];
  }
}

const EMPTY_CHOICES: Partial<Record<PmFilterField, string>> = {
  label: "No labels in this project yet.",
  state: "This project has no states yet.",
  project: "There are no projects yet.",
};

function MultiEditor({
  field,
  initial,
  options,
  onApply,
  onCancel,
}: {
  field: PmFilterField;
  initial?: PmFilter;
  options: EditorOptions;
  onApply: (chip: PmFilter) => void;
  onCancel: () => void;
}): JSX.Element {
  const choices = useMemo(() => choicesFor(field, options), [field, options]);
  const start = initial ? readMulti(initial) : null;
  const [mode, setMode] = useState<MultiMode>(start?.mode ?? "any");
  // A value the list no longer offers (a deleted label) is not carried forward
  // invisibly: the editor shows only what can be seen and unchecked.
  const [picked, setPicked] = useState<string[]>(
    (start?.values ?? []).filter((v) => choices.some((c) => c.value === v)),
  );
  const toggle = (v: string) => setPicked((p) => (p.includes(v) ? p.filter((x) => x !== v) : [...p, v]));

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (picked.length > 0) onApply(multiChip(field, mode, picked));
      }}
    >
      <ThemedSelect className="pm-input" aria-label="Match" value={mode} onChange={(e) => setMode(e.target.value as MultiMode)}>
        <option value="any">is any of</option>
        <option value="none">is none of</option>
      </ThemedSelect>
      <fieldset className="pm-pop-list">
        <legend className="sr-only">{FIELD_LABEL[field]}</legend>
        {choices.length === 0 && <div className="pm-pop-empty">{EMPTY_CHOICES[field] ?? "Nothing to pick from yet."}</div>}
        {choices.map((c) => (
          <label key={c.value} className="pm-pop-row">
            <input type="checkbox" checked={picked.includes(c.value)} onChange={() => toggle(c.value)} />
            <span>{c.label}</span>
          </label>
        ))}
      </fieldset>
      <div className="pm-pop-f">
        <button type="button" className="pm-btn sm" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="pm-btn primary sm" disabled={picked.length === 0}>
          Apply
        </button>
      </div>
    </form>
  );
}

type DateOp = "is" | "before" | "after" | "between";

function DateEditor({
  field,
  onApply,
  onCancel,
}: {
  field: PmFilterField;
  onApply: (chip: PmFilter) => void;
  onCancel: () => void;
}): JSX.Element {
  const nullable = NULLABLE_DATE_FIELDS.has(field);
  const [op, setOp] = useState<DateOp>("before");
  const [a, setA] = useState("");
  const [b, setB] = useState("");

  const submit = () => {
    if (!a || (op === "between" && !b)) return;
    if (op === "between") {
      // ISO dates order as strings; a reversed range is swapped, not sent to match nothing.
      const [from, to] = a <= b ? [a, b] : [b, a];
      onApply({ field, op: "between", value: [from, to] } as PmFilter);
    } else {
      onApply({ field, op, value: a } as PmFilter);
    }
  };

  return (
    <div>
      <div className="pm-pop-sect">Quick choices</div>
      <div className="pm-pop-grid">
        {DATE_PRESETS.map((p) => (
          <button key={p.id} type="button" className="pm-chip" onClick={() => onApply(p.chip(field))}>
            {p.label}
          </button>
        ))}
        {nullable && (
          <>
            <button type="button" className="pm-chip" onClick={() => onApply({ field, op: "isEmpty" } as PmFilter)}>
              No date
            </button>
            <button type="button" className="pm-chip" onClick={() => onApply({ field, op: "isNotEmpty" } as PmFilter)}>
              Has a date
            </button>
          </>
        )}
      </div>
      <div className="pm-pop-sect">Pick dates</div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="pm-row" style={{ gap: 8, flexWrap: "wrap" }}>
          <ThemedSelect className="pm-input" style={{ width: "auto" }} aria-label="Condition" value={op} onChange={(e) => setOp(e.target.value as DateOp)}>
            <option value="is">on</option>
            <option value="before">before</option>
            <option value="after">after</option>
            <option value="between">between</option>
          </ThemedSelect>
          <ThemedDateInput className="pm-input pm-mono" style={{ width: "auto" }} type="date" aria-label={op === "between" ? "From" : "Date"} value={a} onChange={(e) => setA(e.target.value)} />
          {op === "between" && (
            <ThemedDateInput className="pm-input pm-mono" style={{ width: "auto" }} type="date" aria-label="To" value={b} onChange={(e) => setB(e.target.value)} />
          )}
        </div>
        <div className="pm-pop-f">
          <button type="button" className="pm-btn sm" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="pm-btn primary sm" disabled={!a || (op === "between" && !b)}>
            Apply
          </button>
        </div>
      </form>
    </div>
  );
}

function PresenceEditor({
  field,
  onApply,
  onCancel,
}: {
  field: PmFilterField;
  onApply: (chip: PmFilter) => void;
  onCancel: () => void;
}): JSX.Element {
  const words = PRESENCE_LABEL[field] ?? { has: "Has one", hasNot: "Has none" };
  return (
    <div>
      <div className="pm-pop-grid">
        <button type="button" className="pm-chip" onClick={() => onApply(presenceChip(field, true))}>
          {words.has}
        </button>
        <button type="button" className="pm-chip" onClick={() => onApply(presenceChip(field, false))}>
          {words.hasNot}
        </button>
      </div>
      <div className="pm-pop-f">
        <button type="button" className="pm-btn sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function FieldEditor({
  ui,
  initial,
  options,
  onApply,
  onCancel,
}: {
  ui: FieldUi;
  initial?: PmFilter;
  options: EditorOptions;
  onApply: (chip: PmFilter) => void;
  onCancel: () => void;
}): JSX.Element {
  switch (ui.editor) {
    case "multi":
      return <MultiEditor field={ui.field} initial={initial} options={options} onApply={onApply} onCancel={onCancel} />;
    case "date":
      return <DateEditor field={ui.field} onApply={onApply} onCancel={onCancel} />;
    case "presence":
      return <PresenceEditor field={ui.field} onApply={onApply} onCancel={onCancel} />;
    case "toggle":
      return (
        <div>
          <div className="pm-pop-grid">
            <button
              type="button"
              className="pm-chip"
              onClick={() => onApply({ field: ui.field, op: "is", value: true } as PmFilter)}
            >
              Archived items only
            </button>
          </div>
          <div className="pm-pop-f">
            <button type="button" className="pm-btn sm" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </div>
      );
  }
}

// ── the bar ─────────────────────────────────────────────────────────────────

export interface FilterBarProps {
  scope: FilterScope;
  filter: PmFilter;
  onChange: (next: PmFilter) => void;
  options: EditorOptions;
  lookups: ChipLookups;
}

/** The search box and the "Filter" menu. The chips are {@link FilterChips}. */
export function FilterBar({ scope, filter, onChange, options }: FilterBarProps): JSX.Element {
  const parts = useMemo(() => splitFilter(filter), [filter]);
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // The box shows what the user is typing; the filter takes it 250 ms after they
  // stop, so one keystroke is not one query. `committed` is the text the filter
  // last agreed to, which is how an EXTERNAL change (Clear filters, picking a
  // view, Back) is told from the user's own typing and replaces the box.
  const [text, setText] = useState(parts.text);
  const committed = useRef(parts.text);
  useEffect(() => {
    if (parts.text !== committed.current) {
      committed.current = parts.text;
      setText(parts.text);
    }
  }, [parts.text]);
  useEffect(() => {
    if (text.trim() === committed.current.trim()) return;
    const timer = setTimeout(() => {
      const next = withText(filterRef.current, text);
      committed.current = splitFilter(next).text;
      onChangeRef.current(next);
    }, 250);
    return () => clearTimeout(timer);
  }, [text]);

  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<FieldUi | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const fields = useMemo(
    () => availableFields(scope, { departments: options.departments.length > 0 }),
    [scope, options.departments.length],
  );
  const close = () => {
    setAdding(false);
    setPicked(null);
  };
  const apply = (chip: PmFilter) => {
    onChange(withChip(filter, -1, chip));
    close();
    addRef.current?.focus();
  };

  return (
    <div className="pm-row" style={{ gap: 10, flexWrap: "wrap" }}>
      <div className="pm-search" style={{ minWidth: 240 }}>
        <PmIcon name="search" size={14} />
        <input
          placeholder="Search work items"
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="Search work items"
        />
      </div>
      <div className="pm-pop-anchor">
        <button
          ref={addRef}
          type="button"
          className="pm-btn"
          aria-haspopup="dialog"
          aria-expanded={adding}
          onClick={() => (adding ? close() : setAdding(true))}
        >
          <PmIcon name="filter" size={14} />
          Filter
        </button>
        <Popover open={adding} onClose={close} anchorRef={addRef} label="Add a filter">
          {picked ? (
            <>
              <div className="pm-pop-h">
                <button type="button" className="pm-btn ghost sm" onClick={() => setPicked(null)}>
                  <PmIcon name="chevL" size={13} />
                  Back
                </button>
                <strong>{picked.label}</strong>
              </div>
              <FieldEditor ui={picked} options={options} onApply={apply} onCancel={close} />
            </>
          ) : (
            <ul className="pm-pop-menu">
              {fields.map((f) => (
                <li key={f.field}>
                  <button type="button" className="pm-pop-item" onClick={() => setPicked(f)}>
                    {f.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Popover>
      </div>
    </div>
  );
}

function FilterChip({
  chip,
  words,
  ui,
  options,
  editing,
  onToggleEdit,
  onCloseEdit,
  onApply,
  onRemove,
}: {
  chip: PmFilter;
  words: string;
  ui: FieldUi | undefined;
  options: EditorOptions;
  editing: boolean;
  onToggleEdit: () => void;
  onCloseEdit: () => void;
  onApply: (next: PmFilter) => void;
  onRemove: () => void;
}): JSX.Element {
  const editRef = useRef<HTMLButtonElement>(null);
  return (
    <span className="pm-fchip pm-pop-anchor" role="listitem">
      {ui ? (
        <button
          ref={editRef}
          type="button"
          className="pm-fchip-b"
          aria-haspopup="dialog"
          aria-expanded={editing}
          aria-label={`Edit filter: ${words}`}
          onClick={onToggleEdit}
        >
          {words}
        </button>
      ) : (
        <span className="pm-fchip-b static">{words}</span>
      )}
      <button type="button" className="pm-fchip-x" aria-label={`Remove filter: ${words}`} onClick={onRemove}>
        <PmIcon name="x" size={12} />
      </button>
      {ui && (
        <Popover open={editing} onClose={onCloseEdit} anchorRef={editRef} label={`Edit ${ui.label} filter`}>
          <FieldEditor ui={ui} initial={chip} options={options} onApply={onApply} onCancel={onCloseEdit} />
        </Popover>
      )}
    </span>
  );
}

/** The active filters as chips, each editable and removable, plus "Clear filters". */
export function FilterChips({ scope, filter, onChange, options, lookups }: FilterBarProps): JSX.Element | null {
  const parts = useMemo(() => splitFilter(filter), [filter]);
  const [editing, setEditing] = useState<number | null>(null);
  const fields = useMemo(
    () => availableFields(scope, { departments: options.departments.length > 0 }),
    [scope, options.departments.length],
  );
  if (parts.chips.length === 0) return null;

  return (
    <div className="pm-row pm-fchips" role="list" aria-label="Active filters">
      {parts.chips.map((chip, i) => {
        const words = describeChip(chip, lookups);
        return (
          <FilterChip
            key={`${i}:${words}`}
            chip={chip}
            words={words}
            ui={isPmFilterGroup(chip) ? undefined : fields.find((f) => f.field === chip.field)}
            options={options}
            editing={editing === i}
            onToggleEdit={() => setEditing(editing === i ? null : i)}
            onCloseEdit={() => setEditing(null)}
            onApply={(next) => {
              setEditing(null);
              onChange(withChip(filter, i, next));
            }}
            onRemove={() => {
              setEditing(null);
              onChange(withoutChip(filter, i));
            }}
          />
        );
      })}
      <button type="button" className="pm-btn ghost sm" onClick={() => onChange(joinFilter({ text: "", chips: [] }))}>
        Clear filters
      </button>
    </div>
  );
}
