"use client";

// The work-item drawer's cycle and module pickers (WARP-3521). Each row follows
// the surface's restraint-first idiom (the Labels editor): an optimistic local
// value that flips at once, a write through the same routes the assistant uses,
// a rollback and a friendly toast if it is refused. Writes are hidden, not
// disabled, for read-only roles (brief §2.11): they get the current value as text.

import { useEffect, useId, useState, type JSX } from "react";
import { useToast } from "@/components/Toast";
import { translateError } from "@/lib/friendly-errors";
import { PmIcon } from "./icons";
import { CYCLE_STATUS_LABEL } from "./planning-bits";
import { pmActions, useProjectCycles, useProjectModules, useWorkItemModules } from "./usePm";
import type { PmWorkItem } from "./types";

const MUTED = { fontSize: 12.5, color: "var(--text-2)" } as const;

/** Which cycle (if any) this item is planned into. A completed cycle is shown
 *  when it is the item's own, but is not offered as a destination — it takes no
 *  new work. */
export function CycleField({
  item,
  readOnly,
  onChanged,
}: {
  item: PmWorkItem;
  readOnly: boolean;
  onChanged: () => void;
}): JSX.Element {
  const { toast } = useToast();
  const selectId = useId();
  const { cycles } = useProjectCycles(item.projectId);
  const [value, setValue] = useState(item.cycleId ?? "");
  const [busy, setBusy] = useState(false);

  // Re-seed when the parent pushes an updated item (SWR revalidation).
  useEffect(() => {
    setValue(item.cycleId ?? "");
  }, [item.cycleId]);

  const current = cycles?.find((c) => c.id === item.cycleId);

  if (readOnly) {
    return item.cycleId ? (
      <span style={{ fontSize: 12.5, color: "var(--text-2)" }}>{current?.name ?? "In a cycle"}</span>
    ) : (
      <span style={MUTED}>No cycle</span>
    );
  }

  const options = (cycles ?? []).filter((c) => c.status !== "completed" || c.id === item.cycleId);

  const change = async (next: string) => {
    if (busy || next === value) return;
    const previous = value;
    setValue(next); // optimistic
    setBusy(true);
    try {
      await pmActions().setItemCycle(item.id, next || null);
      onChanged();
    } catch (e) {
      setValue(previous); // roll back the optimistic flip
      toast(translateError(e, "projects"), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <select
      id={selectId}
      className="pm-input"
      style={{ height: 30, maxWidth: 260 }}
      aria-label="Cycle"
      value={value}
      disabled={busy}
      onChange={(e) => void change(e.target.value)}
    >
      <option value="">No cycle</option>
      {value !== "" && !options.some((o) => o.id === value) && <option value={value}>{current?.name ?? "This cycle"}</option>}
      {options.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name} · {CYCLE_STATUS_LABEL[c.status]}
        </option>
      ))}
    </select>
  );
}

/** The modules this item is in, as removable chips, and a picker to add it to one
 *  more. An item may sit in several modules. */
export function ModulesField({
  item,
  readOnly,
  onChanged,
}: {
  item: PmWorkItem;
  readOnly: boolean;
  onChanged: () => void;
}): JSX.Element {
  const { toast } = useToast();
  const addId = useId();
  const { modules: mine, mutate: mutateMine } = useWorkItemModules(item.id);
  const { modules: all, mutate: mutateAll } = useProjectModules(item.projectId);
  const [busy, setBusy] = useState(false);

  const mineList = mine ?? [];
  const mineIds = new Set(mineList.map((m) => m.id));
  const addable = (all ?? []).filter((m) => !mineIds.has(m.id));

  const run = async (write: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await write();
      await Promise.all([mutateMine(), mutateAll()]);
      onChanged();
    } catch (e) {
      toast(translateError(e, "projects"), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <span style={{ minWidth: 0, display: "inline-flex", flexDirection: "column", gap: 8 }}>
      <span className="pm-row" style={{ gap: 6, flexWrap: "wrap" }}>
        {mineList.length === 0 && (readOnly || mine !== undefined) && <span style={MUTED}>No modules</span>}
        {mineList.map((m) => (
          <span key={m.id} className="pm-tag" title={`Module: ${m.name}`}>
            <PmIcon name="layers" size={12} />
            {m.name}
            {!readOnly && (
              <button
                type="button"
                className="pm-tag-x"
                aria-label={`Remove from ${m.name}`}
                disabled={busy}
                onClick={() => void run(() => pmActions().removeModuleItem(m.id, item.id))}
              >
                <PmIcon name="x" size={11} />
              </button>
            )}
          </span>
        ))}
      </span>
      {!readOnly && addable.length > 0 && (
        <select
          id={addId}
          className="pm-input"
          style={{ height: 30, maxWidth: 260 }}
          aria-label="Add to a module"
          value=""
          disabled={busy}
          onChange={(e) => {
            const id = e.target.value;
            if (id) void run(() => pmActions().addModuleItems(id, [item.id]));
          }}
        >
          <option value="">Add to a module…</option>
          {addable.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      )}
    </span>
  );
}
