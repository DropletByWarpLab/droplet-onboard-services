"use client";

// WARP-3537 — one table cell per column, and the editors behind the ones that edit
// in place: state, priority, assignees, due date (spec) and the title (brief §4.2).
//
// A cell that edits is a button that opens a `FloatingMenu`; the menu's content is the
// same one the bulk bar uses (`menus.tsx`). A reader — and a workspace-wide table,
// whose rows belong to many projects and so to many sets of states — gets the same
// cell as plain text: hidden, not disabled-and-teasing (brief §8).
//
// Keyboard: inside the ACTIVE row every control is a tab stop; in every other row none
// is (`tabIndex`), so Tab walks the table's header and one row, not four thousand
// buttons. `s`, `p`, `a` and `e` open the matching editor on the active row through
// `request` — a one-shot the table hands down and the cell consumes.

import { useEffect, useRef, useState, type JSX, type KeyboardEvent, type ReactNode } from "react";
import type { PmTableColumnId } from "@droplet/shared-types";
import { AvatarStack, DepartmentTag, LabelTag, PriorityFlag, StatePill } from "../bits";
import { PmIcon } from "../icons";
import { fmtDate, fmtISODate, isOverdue } from "../config";
import type { PmProject, PmState, PmWorkItem } from "../types";
import { FloatingMenu } from "./FloatingMenu";
import { AssigneeMenu, DueMenu, PriorityMenu, StateMenu, type PersonChoice } from "./menus";
import type { TableEdits } from "./useTableEdits";

/** Which editor a keyboard shortcut asks the active row to open. */
export type EditKind = "name" | "state" | "priority" | "assignees";

export interface EditRequest {
  rowId: string;
  kind: EditKind;
  /** Distinguishes two requests for the same editor in a row. */
  nonce: number;
}

export interface CellEnv {
  /** No editing at all: a reader. */
  readOnly: boolean;
  /** A workspace table cannot edit state: its rows are in different projects, with different states. */
  canEditState: boolean;
  states: PmState[];
  people: PersonChoice[];
  edits: TableEdits;
  projects?: PmProject[];
  /** The active row: its controls are tab stops. */
  active: boolean;
  request: EditRequest | null;
  consume: () => void;
}

const PRIORITY_NAME: Record<string, string> = { urgent: "Urgent", high: "High", medium: "Medium", low: "Low", none: "No priority" };

/** A button that opens a FloatingMenu — and opens it when the keyboard asks (`kind`). */
function MenuCell({
  item,
  env,
  kind,
  label,
  menuRole = "menu",
  children,
  render,
}: {
  item: PmWorkItem;
  env: CellEnv;
  /** Which keyboard request opens this one; none for an editor with no shortcut. */
  kind?: EditKind;
  /** The accessible name of the button AND the menu. */
  label: string;
  menuRole?: "menu" | "dialog";
  children: ReactNode;
  render: (close: () => void) => ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const { request, consume } = env;
  useEffect(() => {
    if (kind && request && request.rowId === item.id && request.kind === kind) {
      setOpen(true);
      consume();
    }
  }, [request, item.id, kind, consume]);

  const close = () => setOpen(false);
  return (
    <>
      <button
        ref={btn}
        type="button"
        className="pm-cellbtn"
        tabIndex={env.active ? 0 : -1}
        aria-haspopup={menuRole}
        aria-expanded={open}
        aria-label={`${label} for ${item.key}`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        {children}
      </button>
      <FloatingMenu anchor={btn.current} open={open} onClose={close} label={label} role={menuRole}>
        {render(close)}
      </FloatingMenu>
    </>
  );
}

// ── the title ───────────────────────────────────────────────────────────────

function NameCell({ item, env }: { item: PmWorkItem; env: CellEnv }): JSX.Element {
  const [editing, setEditing] = useState(false);
  const { request, consume, readOnly } = env;
  useEffect(() => {
    if (request && request.rowId === item.id && request.kind === "name") {
      if (!readOnly) setEditing(true);
      consume();
    }
  }, [request, item.id, readOnly, consume]);

  if (editing) return <TitleEditor item={item} onDone={() => setEditing(false)} rename={env.edits.rename} />;
  return (
    <>
      <span className="pm-tname" title={item.name}>
        {item.name}
      </span>
      {!readOnly && (
        <button
          type="button"
          className="pm-cellbtn pm-tedit-btn"
          tabIndex={env.active ? 0 : -1}
          aria-label={`Edit title of ${item.key}`}
          onClick={(e) => {
            e.stopPropagation();
            setEditing(true);
          }}
        >
          <PmIcon name="pencil" size={12} />
        </button>
      )}
    </>
  );
}

/** Brief §4.2: Enter or blur commits, Esc reverts, an empty title is refused in place and the field stays open. */
function TitleEditor({ item, onDone, rename }: { item: PmWorkItem; onDone: () => void; rename: TableEdits["rename"] }): JSX.Element {
  const [value, setValue] = useState(item.name);
  const [error, setError] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const commit = () => {
    if (finished.current) return;
    const next = value.trim();
    if (next === "") {
      setError(true);
      input.current?.focus();
      return;
    }
    finished.current = true;
    onDone();
    if (next !== item.name) void rename(item, next);
  };
  const cancel = () => {
    finished.current = true;
    onDone();
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    // Nothing typed here is a table shortcut, and Esc is this field's, not the selection's.
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  };

  return (
    <span className="pm-tedit" onClick={(e) => e.stopPropagation()}>
      <input
        ref={input}
        className="pm-input"
        value={value}
        maxLength={500}
        aria-label={`Title of ${item.key}`}
        aria-invalid={error || undefined}
        aria-describedby={error ? `${item.id}-name-err` : undefined}
        onChange={(e) => {
          setValue(e.target.value);
          setError(false);
        }}
        onKeyDown={onKey}
        onBlur={commit}
      />
      {error && (
        <span id={`${item.id}-name-err`} role="alert" className="pm-terr">
          Name can&apos;t be empty.
        </span>
      )}
    </span>
  );
}

// ── the cells that edit ─────────────────────────────────────────────────────

function StateCell({ item, env }: { item: PmWorkItem; env: CellEnv }): JSX.Element {
  if (!item.state) return <span className="pm-tmuted">No state</span>;
  if (env.readOnly || !env.canEditState) return <StatePill state={item.state} />;
  return (
    <MenuCell
      item={item}
      env={env}
      kind="state"
      label="Change state"
      render={(close) => (
        <StateMenu
          states={env.states}
          currentId={item.stateId}
          onPick={(s) => {
            close();
            if (s.id !== item.stateId) void env.edits.setState(item, s);
          }}
        />
      )}
    >
      <StatePill state={item.state} />
      <PmIcon name="chevD" size={11} style={{ opacity: 0.6 }} />
    </MenuCell>
  );
}

function PriorityCell({ item, env }: { item: PmWorkItem; env: CellEnv }): JSX.Element {
  const flag = <PriorityFlag p={item.priority} withLabel size={13} />;
  if (env.readOnly) return flag;
  return (
    <MenuCell
      item={item}
      env={env}
      kind="priority"
      label="Change priority"
      render={(close) => (
        <PriorityMenu
          current={item.priority}
          onPick={(p) => {
            close();
            if (p !== item.priority) void env.edits.setPriority(item, p);
          }}
        />
      )}
    >
      {flag}
      <span className="sr-only">{PRIORITY_NAME[item.priority]}</span>
    </MenuCell>
  );
}

function AssigneesCell({ item, env }: { item: PmWorkItem; env: CellEnv }): JSX.Element {
  const stack = <AvatarStack ids={item.assignees} size={22} />;
  if (env.readOnly) return stack;
  return (
    <MenuCell
      item={item}
      env={env}
      kind="assignees"
      label="Change assignees"
      menuRole="dialog"
      render={(close) => (
        <AssigneeMenu
          people={env.people}
          initial={item.assignees}
          allowEmpty
          applyLabel="Save"
          onApply={(ids) => {
            close();
            void env.edits.setAssignees(item, ids);
          }}
          onCancel={close}
        />
      )}
    >
      {stack}
    </MenuCell>
  );
}

function DueCell({ item, env }: { item: PmWorkItem; env: CellEnv }): JSX.Element {
  const overdue = isOverdue(item);
  const text = (
    <span className="pm-mono" style={{ color: overdue ? "var(--warn)" : undefined }}>
      {fmtDate(item.dueDate) ?? "—"}
    </span>
  );
  if (env.readOnly) return text;
  return (
    <MenuCell
      item={item}
      env={env}
      label="Change due date"
      menuRole="dialog"
      render={(close) => (
        <DueMenu
          value={item.dueDate ? fmtISODate(item.dueDate) : null}
          onCancel={close}
          onApply={(ymd) => {
            close();
            void env.edits.setDueDate(item, ymd);
          }}
        />
      )}
    >
      {text}
    </MenuCell>
  );
}

// ── the dispatcher ──────────────────────────────────────────────────────────

export function renderCell(id: PmTableColumnId, item: PmWorkItem, env: CellEnv): JSX.Element {
  switch (id) {
    case "key":
      return (
        <span className="pm-mono pm-tkey" title={item.key}>
          {item.key}
        </span>
      );
    case "name":
      return <NameCell item={item} env={env} />;
    case "project": {
      const p = env.projects?.find((x) => x.id === item.projectId);
      const identifier = item.key.slice(0, item.key.lastIndexOf("-"));
      return (
        <span className="pm-tproject" title={p?.name ?? identifier}>
          <span className="pm-tname">{p?.name ?? identifier}</span>
          <span className="pm-linechip">{identifier}</span>
        </span>
      );
    }
    case "state":
      return <StateCell item={item} env={env} />;
    case "priority":
      return <PriorityCell item={item} env={env} />;
    case "assignees":
      return <AssigneesCell item={item} env={env} />;
    case "labels":
      return (
        <span className="pm-row" style={{ gap: 5, minWidth: 0, overflow: "hidden" }}>
          {item.labels.slice(0, 2).map((l) => (
            <LabelTag key={l.id} label={l} small />
          ))}
          {item.labels.length > 2 && <span className="pm-tmuted">+{item.labels.length - 2}</span>}
        </span>
      );
    case "dueDate":
      return <DueCell item={item} env={env} />;
    case "startDate":
      return <span className="pm-mono pm-tmuted">{fmtDate(item.startDate) ?? "—"}</span>;
    case "createdAt":
      return <span className="pm-mono pm-tmuted">{fmtDate(item.createdAt) ?? "—"}</span>;
    case "updatedAt":
      return <span className="pm-mono pm-tmuted">{fmtDate(item.updatedAt) ?? "—"}</span>;
    case "department":
      return item.department ? <DepartmentTag dept={item.department} small /> : <span className="pm-tmuted">—</span>;
    case "comments":
      return <span className="pm-mono pm-tmuted">{item.commentCount > 0 ? item.commentCount : "—"}</span>;
    case "subItems":
      return <span className="pm-mono pm-tmuted">{item.subItemCount > 0 ? item.subItemCount : "—"}</span>;
  }
}
