"use client";

// WARP-3520 -- the project's states (the board's columns): create, rename,
// recolour, reorder, choose the default, and delete with a chosen place for the
// items to go. Every write revalidates the states and refreshes the board, whose
// cards and columns carry a copy of each state's name and colour.

import { useId, useMemo, useState, type JSX } from "react";
import { useSWRConfig } from "swr";
import { Dialog } from "@/components/Dialog";
import { PmIcon } from "../icons";
import { SafetyChip } from "../bits";
import { DraftInput } from "../detail/fields";
import { editActions, pmKeys, useRevalidate } from "../useEditing";
import { useProjectStates } from "../usePm";
import type { PmProject, PmState, StateGroup } from "../types";
import { DEFAULT_COLOR, ErrorStrip, GROUP_LABEL, GROUP_ORDER, SwatchDot, SwatchPicker, useSettingsAction } from "./parts";
import { ThemedSelect } from "@/components/ui/ThemedSelect";

const isTerminal = (g: StateGroup) => g === "completed" || g === "cancelled";

export function StatesTab({
  project,
  onItemsChanged,
}: {
  project: PmProject;
  onItemsChanged: () => void;
}): JSX.Element {
  const { states } = useProjectStates(project.id);
  const { mutate } = useSWRConfig();
  const revalidate = useRevalidate();
  const { run, busy, error } = useSettingsAction();
  const [deleting, setDeleting] = useState<PmState | null>(null);

  const key = pmKeys.states(project.id);
  const sorted = useMemo(() => [...(states ?? [])].sort((a, b) => a.sortOrder - b.sortOrder), [states]);
  const actions = editActions();
  const refresh = async () => {
    await revalidate(key);
    onItemsChanged();
  };
  /** A write, then a refresh — and a refresh on failure too, so a control that
   *  moved optimistically snaps back to what the server holds. */
  const change = async (write: () => Promise<unknown>) => {
    const ok = await run(write, refresh);
    if (!ok) await revalidate(key);
    return ok;
  };

  const move = async (index: number, delta: -1 | 1) => {
    const ids = sorted.map((s) => s.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    const byId = new Map(sorted.map((s) => [s.id, s]));
    await mutate(key, { states: ids.map((id, i) => ({ ...byId.get(id)!, sortOrder: i })) }, { revalidate: false });
    await change(() => actions.reorderStates(project.id, ids));
  };

  return (
    <div>
      <ErrorStrip message={error} />
      {states === undefined ? (
        <div className="pm-set-note">Loading states…</div>
      ) : (
        <ul className="pm-set-list" aria-label="States">
          {sorted.map((s, i) => (
            <StateRow
              key={s.id}
              state={s}
              index={i}
              count={sorted.length}
              busy={busy}
              onRename={(name) => void change(() => actions.updateState(s.id, { name }))}
              onColor={(color) => void change(() => actions.updateState(s.id, { color }))}
              onDefault={() => void change(() => actions.updateState(s.id, { isDefault: true }))}
              onMove={(d) => void move(i, d)}
              onDelete={() => setDeleting(s)}
            />
          ))}
        </ul>
      )}

      <AddState
        busy={busy}
        onAdd={(name, group, color) =>
          change(() =>
            actions.createState(project.id, {
              name,
              group,
              color,
              sortOrder: sorted.reduce((m, s) => Math.max(m, s.sortOrder), -1) + 1,
            }),
          )
        }
      />

      {deleting && (
        <DeleteStateDialog
          state={deleting}
          others={sorted.filter((s) => s.id !== deleting.id)}
          onClose={() => setDeleting(null)}
          onDelete={async (reassignTo) => {
            const ok = await change(() => actions.deleteState(deleting.id, reassignTo));
            if (ok) setDeleting(null);
          }}
        />
      )}
    </div>
  );
}

function StateRow({
  state,
  index,
  count,
  busy,
  onRename,
  onColor,
  onDefault,
  onMove,
  onDelete,
}: {
  state: PmState;
  index: number;
  count: number;
  busy: boolean;
  onRename: (name: string) => void;
  onColor: (color: string) => void;
  onDefault: () => void;
  onMove: (delta: -1 | 1) => void;
  onDelete: () => void;
}): JSX.Element {
  const [colorOpen, setColorOpen] = useState(false);
  const cannotDelete = state.isDefault
    ? "Make another state the default first."
    : count <= 1
      ? "A project needs at least one state."
      : null;
  return (
    <li className="pm-set-item">
      <div className="pm-set-row">
        <SwatchDot color={state.color} label={`Color of ${state.name}`} expanded={colorOpen} onClick={() => setColorOpen((v) => !v)} />
        <span className="grow">
          <DraftInput label={`Name of ${state.name}`} value={state.name} maxLength={100} required disabled={busy} onCommit={onRename} />
        </span>
        <span className="pm-tag" style={{ minWidth: 84, justifyContent: "center" }}>{GROUP_LABEL[state.group]}</span>
        {state.isDefault ? (
          <span className="badge info" title="New items start here">Default</span>
        ) : (
          <button
            type="button"
            className="pm-btn ghost sm"
            disabled={busy || isTerminal(state.group)}
            title={isTerminal(state.group) ? "A done or cancelled state can't be the default." : "New items will start here"}
            aria-label={`Make ${state.name} the default`}
            onClick={onDefault}
          >
            Make default
          </button>
        )}
        <button type="button" className="pm-iconbtn" aria-label={`Move ${state.name} up`} disabled={busy || index === 0} onClick={() => onMove(-1)}>
          <PmIcon name="arrowUp" size={14} />
        </button>
        <button type="button" className="pm-iconbtn" aria-label={`Move ${state.name} down`} disabled={busy || index === count - 1} onClick={() => onMove(1)}>
          <PmIcon name="arrowDown" size={14} />
        </button>
        <button
          type="button"
          className="pm-iconbtn"
          aria-label={`Delete ${state.name}`}
          title={cannotDelete ?? undefined}
          disabled={busy || cannotDelete !== null}
          onClick={onDelete}
        >
          <PmIcon name="trash" size={14} />
        </button>
      </div>
      {colorOpen && (
        <SwatchPicker
          value={state.color}
          label={`Color of ${state.name}`}
          onPick={(hex) => {
            setColorOpen(false);
            onColor(hex);
          }}
        />
      )}
    </li>
  );
}

function AddState({
  busy,
  onAdd,
}: {
  busy: boolean;
  onAdd: (name: string, group: StateGroup, color: string) => Promise<boolean>;
}): JSX.Element {
  const [name, setName] = useState("");
  const [group, setGroup] = useState<StateGroup>("started");
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [pickingColor, setPickingColor] = useState(false);
  return (
    <form
      className="pm-set-add"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim() || busy) return;
        if (await onAdd(name.trim(), group, color)) setName("");
      }}
    >
      <SwatchDot color={color} label="New state color" expanded={pickingColor} onClick={() => setPickingColor((v) => !v)} />
      <input className="pm-input sm" style={{ width: 180 }} placeholder="New state name" aria-label="New state name" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
      <ThemedSelect className="pm-input sm" style={{ width: "auto" }} aria-label="New state group" value={group} onChange={(e) => setGroup(e.target.value as StateGroup)}>
        {GROUP_ORDER.map((g) => (
          <option key={g} value={g}>
            {GROUP_LABEL[g]}
          </option>
        ))}
      </ThemedSelect>
      <button type="submit" className="pm-btn sm" disabled={busy || !name.trim()}>
        <PmIcon name="plus" size={12} />
        Add state
      </button>
      {pickingColor && (
        <div style={{ flexBasis: "100%" }}>
          <SwatchPicker value={color} label="New state color" onPick={(hex) => { setColor(hex); setPickingColor(false); }} />
        </div>
      )}
    </form>
  );
}

function DeleteStateDialog({
  state,
  others,
  onClose,
  onDelete,
}: {
  state: PmState;
  others: PmState[];
  onClose: () => void;
  onDelete: (reassignTo: string) => Promise<void>;
}): JSX.Element {
  const titleId = useId();
  // Items land in the project's default state unless the owner picks another.
  const [target, setTarget] = useState(others.find((s) => s.isDefault)?.id ?? others[0]?.id ?? "");
  const [working, setWorking] = useState(false);
  return (
    <Dialog open onClose={onClose} placement="center" maxWidth="sm" labelledBy={titleId} flush>
      <div className="pm-scope pm-dialog-body">
        <h2 id={titleId} style={{ margin: "0 0 12px", fontSize: 18, fontWeight: 600 }}>
          Delete &ldquo;{state.name}&rdquo;?
        </h2>
        <p style={{ margin: "0 0 12px", fontSize: 13.5, color: "var(--text-2)" }}>
          Items in this state move to the state you pick. Nothing is deleted with it.
        </p>
        <div className="pm-field">
          <label htmlFor={`${titleId}-target`}>Move its items to</label>
          <ThemedSelect id={`${titleId}-target`} className="pm-input" value={target} onChange={(e) => setTarget(e.target.value)}>
            {others.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </ThemedSelect>
        </div>
        <div className="pm-set-foot">
          <SafetyChip tier="write" />
          <span className="pm-row" style={{ gap: 8 }}>
            <button type="button" className="pm-btn" onClick={onClose} disabled={working}>
              Cancel
            </button>
            <button
              type="button"
              className="pm-btn danger"
              disabled={working || !target}
              onClick={async () => {
                setWorking(true);
                await onDelete(target);
                setWorking(false);
              }}
            >
              {working ? "Working…" : "Delete state"}
            </button>
          </span>
        </div>
      </div>
    </Dialog>
  );
}
