"use client";

// WARP-3520 -- the project's labels: create, rename, recolour and delete. Deleting
// a label removes it from every item that has it, so it asks first and says so.

import { useState, type JSX } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { translateError } from "@/lib/friendly-errors";
import { PmIcon } from "../icons";
import { SafetyChip } from "../bits";
import { DraftInput } from "../detail/fields";
import { editActions, pmKeys, useRevalidate } from "../useEditing";
import { useProjectLabels } from "../usePm";
import type { PmLabel, PmProject } from "../types";
import { DEFAULT_COLOR, ErrorStrip, SwatchDot, SwatchPicker, useSettingsAction } from "./parts";

export function LabelsTab({
  project,
  onItemsChanged,
}: {
  project: PmProject;
  onItemsChanged: () => void;
}): JSX.Element {
  const { toast } = useToast();
  const { labels } = useProjectLabels(project.id);
  const revalidate = useRevalidate();
  const { run, busy, error } = useSettingsAction();
  const [deleting, setDeleting] = useState<PmLabel | null>(null);
  const actions = editActions();
  const key = pmKeys.labels(project.id);
  const refresh = async () => {
    await revalidate(key);
    onItemsChanged();
  };
  const change = async (write: () => Promise<unknown>) => {
    const ok = await run(write, refresh);
    if (!ok) await revalidate(key);
    return ok;
  };

  return (
    <div>
      <ErrorStrip message={error} />
      {labels === undefined ? (
        <div className="pm-set-note">Loading labels…</div>
      ) : labels.length === 0 ? (
        <div className="pm-set-note">No labels in this project yet.</div>
      ) : (
        <ul className="pm-set-list" aria-label="Labels">
          {labels.map((l) => (
            <LabelRow
              key={l.id}
              label={l}
              busy={busy}
              onRename={(name) => void change(() => actions.updateLabel(l.id, { name }))}
              onColor={(color) => void change(() => actions.updateLabel(l.id, { color }))}
              onDelete={() => setDeleting(l)}
            />
          ))}
        </ul>
      )}

      <AddLabel busy={busy} onAdd={(name, color) => change(() => actions.createLabel(project.id, { name, color }))} />

      <ConfirmDialog
        open={deleting !== null}
        title={`Delete the label “${deleting?.name ?? ""}”?`}
        description="It is removed from every item that has it. The items themselves are not deleted."
        confirmLabel="Delete label"
        accessory={<SafetyChip tier="write" />}
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await actions.deleteLabel(deleting.id);
          } catch (e) {
            // A throw keeps the dialog open for a retry; ConfirmDialog says nothing
            // itself, so the reason goes in a toast.
            toast(translateError(e, "projects"), "error");
            throw e;
          }
          setDeleting(null);
          await refresh();
        }}
      />
    </div>
  );
}

function LabelRow({
  label,
  busy,
  onRename,
  onColor,
  onDelete,
}: {
  label: PmLabel;
  busy: boolean;
  onRename: (name: string) => void;
  onColor: (color: string) => void;
  onDelete: () => void;
}): JSX.Element {
  const [colorOpen, setColorOpen] = useState(false);
  return (
    <li className="pm-set-item">
      <div className="pm-set-row">
        <SwatchDot color={label.color} label={`Color of ${label.name}`} expanded={colorOpen} onClick={() => setColorOpen((v) => !v)} />
        <span className="grow">
          <DraftInput label={`Name of label ${label.name}`} value={label.name} maxLength={100} required disabled={busy} onCommit={onRename} />
        </span>
        <button type="button" className="pm-iconbtn" aria-label={`Delete label ${label.name}`} disabled={busy} onClick={onDelete}>
          <PmIcon name="trash" size={14} />
        </button>
      </div>
      {colorOpen && (
        <SwatchPicker
          value={label.color}
          label={`Color of ${label.name}`}
          onPick={(hex) => {
            setColorOpen(false);
            onColor(hex);
          }}
        />
      )}
    </li>
  );
}

function AddLabel({
  busy,
  onAdd,
}: {
  busy: boolean;
  onAdd: (name: string, color: string) => Promise<boolean>;
}): JSX.Element {
  const [name, setName] = useState("");
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [pickingColor, setPickingColor] = useState(false);
  return (
    <form
      className="pm-set-add"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim() || busy) return;
        if (await onAdd(name.trim(), color)) setName("");
      }}
    >
      <SwatchDot color={color} label="New label color" expanded={pickingColor} onClick={() => setPickingColor((v) => !v)} />
      <input className="pm-input sm" style={{ width: 200 }} placeholder="New label name" aria-label="New label name" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
      <button type="submit" className="pm-btn sm" disabled={busy || !name.trim()}>
        <PmIcon name="plus" size={12} />
        Add label
      </button>
      {pickingColor && (
        <div style={{ flexBasis: "100%" }}>
          <SwatchPicker value={color} label="New label color" onPick={(hex) => { setColor(hex); setPickingColor(false); }} />
        </div>
      )}
    </form>
  );
}
