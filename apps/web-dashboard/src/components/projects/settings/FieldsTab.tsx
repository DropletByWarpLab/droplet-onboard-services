"use client";

// WARP-3520 -- the project's custom fields: create, rename, reorder, edit a select
// field's options and delete. Defining a field changes what every item in the
// project shows, so it is owner / admin / the project's lead; anyone else sees the
// list and why they cannot change it. A field's TYPE is fixed once created (the
// API refuses to change it), so the type is only chosen when adding.

import { useState, type FormEvent, type JSX } from "react";
import { useSWRConfig } from "swr";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { translateError } from "@/lib/friendly-errors";
import { PmIcon } from "../icons";
import { SafetyChip } from "../bits";
import { PROPERTY_TYPES, PROPERTY_TYPE_ORDER } from "../config";
import { DraftInput } from "../detail/fields";
import { editActions, pmKeys, useProjectProperties, useRevalidate, type PropertyOptionInput } from "../useEditing";
import type { PmProject, PmProperty, PropertyType } from "../types";
import { ErrorStrip, SwatchDot, SwatchPicker, useSettingsAction } from "./parts";

const hasOptions = (t: PropertyType) => t === "select" || t === "multi_select";

export function FieldsTab({
  project,
  canManage,
  onItemsChanged,
}: {
  project: PmProject;
  canManage: boolean;
  onItemsChanged: () => void;
}): JSX.Element {
  const { toast } = useToast();
  const { properties } = useProjectProperties(project.id);
  const { mutate } = useSWRConfig();
  const revalidate = useRevalidate();
  const { run, busy, error } = useSettingsAction();
  const [optionsFor, setOptionsFor] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<PmProperty | null>(null);
  const actions = editActions();
  const key = pmKeys.properties(project.id);
  const list = properties ?? [];

  const refresh = async () => {
    await revalidate(key);
    onItemsChanged();
  };
  const change = async (write: () => Promise<unknown>) => {
    const ok = await run(write, refresh);
    if (!ok) await revalidate(key);
    return ok;
  };

  const move = async (index: number, delta: -1 | 1) => {
    const ids = list.map((p) => p.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    const byId = new Map(list.map((p) => [p.id, p]));
    await mutate(key, { properties: ids.map((id, i) => ({ ...byId.get(id)!, sortOrder: i })) }, { revalidate: false });
    await change(() => actions.reorderProperties(project.id, ids));
  };

  return (
    <div>
      {!canManage && (
        <div className="pm-set-note" style={{ marginTop: 0, marginBottom: 10 }}>
          Only owners, admins and the project lead can change fields.
        </div>
      )}
      <ErrorStrip message={error} />
      {properties === undefined ? (
        <div className="pm-set-note">Loading fields…</div>
      ) : list.length === 0 ? (
        <div className="pm-set-note">No custom fields yet.{canManage ? " Add one below." : ""}</div>
      ) : (
        <ul className="pm-set-list" aria-label="Fields">
          {list.map((p, i) => (
            <li key={p.id} className="pm-set-item">
              <div className="pm-set-row">
                <PmIcon name={PROPERTY_TYPES[p.type].icon} size={15} />
                <span className="grow">
                  {canManage ? (
                    <DraftInput label={`Name of field ${p.name}`} value={p.name} maxLength={60} required disabled={busy} onCommit={(name) => void change(() => actions.updateProperty(p.id, { name }))} />
                  ) : (
                    <span style={{ fontSize: 13.5 }}>{p.name}</span>
                  )}
                </span>
                <span className="pm-tag" style={{ minWidth: 84, justifyContent: "center" }}>{PROPERTY_TYPES[p.type].label}</span>
                {hasOptions(p.type) && (
                  <button
                    type="button"
                    className="pm-btn ghost sm"
                    aria-expanded={optionsFor === p.id}
                    aria-label={`${canManage ? "Edit" : "Show"} options of ${p.name}`}
                    onClick={() => setOptionsFor(optionsFor === p.id ? null : p.id)}
                  >
                    {(p.options ?? []).length} {(p.options ?? []).length === 1 ? "option" : "options"}
                  </button>
                )}
                {canManage && (
                  <>
                    <button type="button" className="pm-iconbtn" aria-label={`Move ${p.name} up`} disabled={busy || i === 0} onClick={() => void move(i, -1)}>
                      <PmIcon name="arrowUp" size={14} />
                    </button>
                    <button type="button" className="pm-iconbtn" aria-label={`Move ${p.name} down`} disabled={busy || i === list.length - 1} onClick={() => void move(i, 1)}>
                      <PmIcon name="arrowDown" size={14} />
                    </button>
                    <button type="button" className="pm-iconbtn" aria-label={`Delete field ${p.name}`} disabled={busy} onClick={() => setDeleting(p)}>
                      <PmIcon name="trash" size={14} />
                    </button>
                  </>
                )}
              </div>
              {optionsFor === p.id && hasOptions(p.type) && (
                <OptionsEditor
                  property={p}
                  canManage={canManage}
                  busy={busy}
                  onSave={async (options) => {
                    const ok = await change(() => actions.updateProperty(p.id, { options }));
                    if (ok) setOptionsFor(null);
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      {canManage && (
        <AddField
          busy={busy}
          onAdd={async (name, type) => {
            let created: PmProperty | undefined;
            const ok = await change(async () => {
              created = (await actions.createProperty(project.id, { name, type, options: hasOptions(type) ? [] : undefined })).property;
            });
            // A select field is useless without options: open its editor straight away.
            if (ok && created && hasOptions(created.type)) setOptionsFor(created.id);
            return ok;
          }}
        />
      )}

      <ConfirmDialog
        open={deleting !== null}
        title={`Delete the field “${deleting?.name ?? ""}”?`}
        description="Its values are removed from every item that has one. The items themselves are not deleted."
        confirmLabel="Delete field"
        accessory={<SafetyChip tier="write" />}
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await actions.deleteProperty(deleting.id);
          } catch (e) {
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

function AddField({
  busy,
  onAdd,
}: {
  busy: boolean;
  onAdd: (name: string, type: PropertyType) => Promise<boolean>;
}): JSX.Element {
  const [name, setName] = useState("");
  const [type, setType] = useState<PropertyType>("text");
  return (
    <form
      className="pm-set-add"
      onSubmit={async (e: FormEvent) => {
        e.preventDefault();
        if (!name.trim() || busy) return;
        if (await onAdd(name.trim(), type)) setName("");
      }}
    >
      <input className="pm-input sm" style={{ width: 200 }} placeholder="New field name" aria-label="New field name" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
      <select className="pm-input sm" style={{ width: "auto" }} aria-label="New field type" value={type} onChange={(e) => setType(e.target.value as PropertyType)}>
        {PROPERTY_TYPE_ORDER.map((t) => (
          <option key={t} value={t}>
            {PROPERTY_TYPES[t].label}
          </option>
        ))}
      </select>
      <button type="submit" className="pm-btn sm" disabled={busy || !name.trim()}>
        <PmIcon name="plus" size={12} />
        Add field
      </button>
    </form>
  );
}

type OptionDraft = { id?: string; label: string; color: string | null };

/** A select field's options. Saving sends the WHOLE list: an option left out is
 *  deleted and cleared from every item that holds it, so the editor says so before
 *  the owner saves. */
function OptionsEditor({
  property,
  canManage,
  busy,
  onSave,
}: {
  property: PmProperty;
  canManage: boolean;
  busy: boolean;
  onSave: (options: PropertyOptionInput[]) => Promise<void>;
}): JSX.Element {
  const original = property.options ?? [];
  const [draft, setDraft] = useState<OptionDraft[]>(() => original.map((o) => ({ id: o.id, label: o.label, color: o.color })));
  const [colorOpen, setColorOpen] = useState<number | null>(null);

  if (!canManage) {
    return (
      <ul className="pm-set-note" aria-label={`Options of ${property.name}`} style={{ listStyle: "none", padding: 0 }}>
        {original.length === 0 ? <li>No options yet.</li> : original.map((o) => <li key={o.id}>{o.label}</li>)}
      </ul>
    );
  }

  const removed = original.filter((o) => !draft.some((d) => d.id === o.id));
  const cleaned = draft.filter((d) => d.label.trim() !== "").map((d) => ({ id: d.id, label: d.label.trim(), color: d.color }));
  const unchanged = JSON.stringify(cleaned) === JSON.stringify(original.map((o) => ({ id: o.id, label: o.label, color: o.color })));
  const patch = (i: number, over: Partial<OptionDraft>) => setDraft((d) => d.map((x, at) => (at === i ? { ...x, ...over } : x)));

  return (
    <form
      style={{ padding: "8px 0 4px 24px" }}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!unchanged && !busy) await onSave(cleaned);
      }}
    >
      {draft.map((d, i) => (
        <div key={d.id ?? `new-${i}`}>
          <div className="pm-set-row">
            <SwatchDot color={d.color} label={`Color of option ${i + 1}`} expanded={colorOpen === i} onClick={() => setColorOpen(colorOpen === i ? null : i)} />
            <input className="pm-input sm grow" aria-label={`Option ${i + 1} name`} placeholder="Option name" maxLength={60} value={d.label} onChange={(e) => patch(i, { label: e.target.value })} />
            <button type="button" className="pm-iconbtn" aria-label={`Remove option ${d.label || i + 1}`} onClick={() => setDraft((x) => x.filter((_, at) => at !== i))}>
              <PmIcon name="x" size={14} />
            </button>
          </div>
          {colorOpen === i && (
            <SwatchPicker value={d.color} label={`Color of option ${i + 1}`} onPick={(hex) => { patch(i, { color: hex }); setColorOpen(null); }} />
          )}
        </div>
      ))}
      <div className="pm-row" style={{ gap: 8, marginTop: 8 }}>
        <button type="button" className="pm-btn ghost sm" onClick={() => setDraft((d) => [...d, { label: "", color: null }])}>
          <PmIcon name="plus" size={12} />
          Add option
        </button>
        <button type="submit" className="pm-btn primary sm" disabled={busy || unchanged}>
          Save options
        </button>
      </div>
      {removed.length > 0 && (
        <div className="pm-set-note" role="status">
          Removing {removed.length} {removed.length === 1 ? "option clears it" : "options clears them"} from every item that uses{" "}
          {removed.length === 1 ? "it" : "them"}.
        </div>
      )}
    </form>
  );
}
