"use client";

import { useState, useEffect, type JSX } from "react";
import { useToast } from "@/components/Toast";
import { PmIcon } from "../icons";
import { LabelTag } from "../bits";
import { useProjectLabels, pmActions } from "../usePm";
import type { PmWorkItem } from "../types";
import { translateError } from "@/lib/friendly-errors";

/** Inline Labels editor for the detail panel (WARP-948). The Labels row was
 *  read-only — it rendered the item's labels or a dead "None" with no way to
 *  add/select one. This wires the existing backend: it lists the project's
 *  labels (GET /api/pm/projects/:id/labels) and applies a full-set selection
 *  via PATCH /api/pm/work-items/:id { label_ids } (pm.updateWorkItem already
 *  does the delete-all + re-create replacement and writes an activity row).
 *
 *  Restraint-first interaction: clicking "Add label" reveals an in-place picker
 *  of the project's labels as toggle chips — no portal/positioning needed,
 *  consistent with the surface's existing chip idiom. Selecting/deselecting a
 *  chip immediately persists; the change propagates to the list via onChanged.
 *
 *  Moved verbatim out of detail.tsx (WARP-3520) so the properties card can use
 *  it without importing the drawer. */
export function LabelsEditor({
  item,
  onChanged,
}: {
  item: PmWorkItem;
  onChanged: () => void;
}): JSX.Element {
  const { toast } = useToast();
  const { labels: projectLabels } = useProjectLabels(item.projectId);
  const [editing, setEditing] = useState(false);
  // Optimistic local view of the selected ids so the chips flip instantly;
  // seeded from the item and reconciled to the server response on apply.
  const [selected, setSelected] = useState<string[]>(() => (item.labels ?? []).map((l) => l.id));
  const [busy, setBusy] = useState(false);

  // Re-seed when the parent pushes an updated item (e.g. after SWR revalidation).
  useEffect(() => {
    setSelected((item.labels ?? []).map((l) => l.id));
  }, [item]);

  const actions = pmActions();

  const apply = async (next: string[]) => {
    const prev = selected;
    setSelected(next); // optimistic
    setBusy(true);
    try {
      const { work_item } = await actions.updateItem(item.id, { label_ids: next });
      // Reconcile to the server's authoritative set (handles a label deleted
      // out from under us between read and write).
      if (work_item) setSelected(work_item.labels.map((l) => l.id));
      onChanged();
    } catch (e) {
      setSelected(prev); // roll back the optimistic flip
      toast(translateError(e, "projects"), "error");
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: string) => {
    if (busy) return;
    const next = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
    void apply(next);
  };

  const labels = projectLabels ?? [];
  const chosen = projectLabels
    ? projectLabels.filter((l) => selected.includes(l.id))
    : item.labels.filter((l) => selected.includes(l.id));

  return (
    <span style={{ minWidth: 0, display: "inline-flex", flexDirection: "column", gap: 8 }}>
      <span className="pm-row" style={{ gap: 6, flexWrap: "wrap" }}>
        {chosen.length ? (
          chosen.map((l) => <LabelTag key={l.id} label={l} />)
        ) : !editing ? (
          <span style={{ fontSize: 12.5, color: "var(--text-4)" }}>None</span>
        ) : null}
        <button
          type="button"
          className="pm-btn ghost sm"
          onClick={() => setEditing((v) => !v)}
          aria-expanded={editing}
          aria-label={editing ? "Close label picker" : "Add label"}
        >
          <PmIcon name={editing ? "x" : "plus"} size={12} />
          {editing ? "Done" : "Add label"}
        </button>
      </span>

      {editing && (
        <span className="pm-row" style={{ gap: 6, flexWrap: "wrap" }}>
          {labels.length ? (
            labels.map((l) => {
              const on = selected.includes(l.id);
              return (
                <button
                  key={l.id}
                  type="button"
                  className={"pm-chip" + (on ? " on" : "")}
                  onClick={() => toggle(l.id)}
                  disabled={busy}
                  aria-pressed={on}
                  aria-label={l.name}
                >
                  <span
                    className="swatch"
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: "50%",
                      background: l.color ?? "var(--text-4)",
                      flex: "none",
                    }}
                  />
                  {l.name}
                  {on && <PmIcon name="check" size={12} />}
                </button>
              );
            })
          ) : (
            <span style={{ fontSize: 12, color: "var(--text-4)" }}>
              No labels in this project yet.
            </span>
          )}
        </span>
      )}
    </span>
  );
}
