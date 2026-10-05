"use client";

// WARP-3537 — the floating action bar: what to do with the rows that are ticked
// (spec: state, priority, assignee, labels, archive — with an undo toast, which the
// action's hook raises). It draws the choices and hands the one picked up as a
// `BulkOp`; it does not know what a bulk edit is.
//
// Shown only for a person who can write and only with something selected (brief §8:
// hidden, not disabled-and-teasing). In a workspace-wide table there is no state or
// label to offer — those are per project, and the rows are in many — so the bar has
// priority, assignee and archive only.
//
// Each action is a button that opens the SAME menu a table cell opens, upward (the bar
// is at the bottom of the screen). Applying an assignee set REPLACES the assignees of
// every selected item, so "nobody" is its own named button and an empty tick-list
// cannot be applied by accident.

import "./bulk.css";
import { useRef, useState, type JSX, type ReactNode } from "react";
import { PM_BULK_MAX_IDS, type PmTableScope } from "@droplet/shared-types";
import { PmIcon } from "../icons";
import { FloatingMenu } from "../table/FloatingMenu";
import { AssigneeMenu, LabelMenu, PriorityMenu, StateMenu, type PersonChoice } from "../table/menus";
import type { PmLabel, PmState } from "../types";
import type { BulkOp } from "./plan";

type MenuName = "state" | "priority" | "assignees" | "labels";

export interface BulkBarProps {
  count: number;
  /** The last selection hit the cap and left some rows out. */
  capped: boolean;
  /** A bulk write is in flight. */
  busy: boolean;
  scope: PmTableScope;
  states: PmState[];
  labels: PmLabel[];
  people: PersonChoice[];
  /** False when the rows on screen are archived already — archiving them again is no action. */
  canArchive: boolean;
  onRun: (op: BulkOp) => void;
  onClear: () => void;
}

function BarMenu({
  name,
  label,
  open,
  setOpen,
  role = "menu",
  disabled,
  children,
}: {
  name: MenuName;
  label: string;
  open: MenuName | null;
  setOpen: (m: MenuName | null) => void;
  role?: "menu" | "dialog";
  disabled: boolean;
  children: (close: () => void) => ReactNode;
}): JSX.Element {
  const btn = useRef<HTMLButtonElement>(null);
  const isOpen = open === name;
  return (
    <>
      <button
        ref={btn}
        type="button"
        className="pm-btn sm"
        aria-haspopup={role}
        aria-expanded={isOpen}
        disabled={disabled}
        onClick={() => setOpen(isOpen ? null : name)}
      >
        {label}
        <PmIcon name="chevD" size={12} />
      </button>
      <FloatingMenu anchor={btn.current} open={isOpen} onClose={() => setOpen(null)} label={label} role={role} preferUp>
        {children(() => setOpen(null))}
      </FloatingMenu>
    </>
  );
}

export function BulkBar(p: BulkBarProps): JSX.Element {
  const [open, setOpen] = useState<MenuName | null>(null);
  const run = (op: BulkOp) => {
    setOpen(null);
    p.onRun(op);
  };
  const perProject = p.scope === "project";

  return (
    <div className="pm-bulkbar" role="region" aria-label="Bulk actions">
      <span className="pm-bulkbar-count" role="status" aria-live="polite">
        <strong>{p.count}</strong> selected
      </span>
      {p.capped && (
        <span className="pm-bulkbar-note">
          That is the most one change can cover ({PM_BULK_MAX_IDS}).
        </span>
      )}
      <span className="pm-bulkbar-sep" aria-hidden />

      {perProject && p.states.length > 0 && (
        <BarMenu name="state" label="State" open={open} setOpen={setOpen} disabled={p.busy}>
          {() => <StateMenu states={p.states} onPick={(s) => run({ kind: "state", stateId: s.id })} />}
        </BarMenu>
      )}
      <BarMenu name="priority" label="Priority" open={open} setOpen={setOpen} disabled={p.busy}>
        {() => <PriorityMenu onPick={(priority) => run({ kind: "priority", priority })} />}
      </BarMenu>
      <BarMenu name="assignees" label="Assignee" open={open} setOpen={setOpen} role="dialog" disabled={p.busy}>
        {(close) => (
          <AssigneeMenu
            people={p.people}
            initial={[]}
            allowEmpty={false}
            applyLabel="Assign"
            onApply={(assigneeIds) => run({ kind: "assignees", assigneeIds })}
            onClear={() => run({ kind: "assignees", assigneeIds: [] })}
            onCancel={close}
          />
        )}
      </BarMenu>
      {perProject && p.labels.length > 0 && (
        <BarMenu name="labels" label="Labels" open={open} setOpen={setOpen} disabled={p.busy}>
          {() => <LabelMenu labels={p.labels} onPick={(labelId, mode) => run({ kind: "label", labelId, mode })} />}
        </BarMenu>
      )}
      {p.canArchive && (
        <button type="button" className="pm-btn sm" disabled={p.busy} onClick={() => run({ kind: "archive" })}>
          <PmIcon name="trash" size={13} />
          Archive
        </button>
      )}

      <span className="pm-bulkbar-sep" aria-hidden />
      <button type="button" className="pm-btn ghost sm" onClick={p.onClear}>
        <PmIcon name="x" size={13} />
        Clear selection
      </button>
    </div>
  );
}
