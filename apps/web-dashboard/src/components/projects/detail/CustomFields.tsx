"use client";

// WARP-3520 -- the project's custom fields as rows of the properties card, with
// the right editor per field type. Values are type-tagged JSON (`{text}`,
// `{number}`, `{date}`, `{boolean}`, `{optionIds}`, `{userIds}`); the orchestrator
// validates every one against its field, so what is built here only has to be
// well-shaped — a refused value comes back as a sentence, shown under the row.

import type { JSX } from "react";
import { PmIcon } from "../icons";
import { usePerson } from "../bits";
import { PROPERTY_TYPES } from "../config";
import { editActions, useProjectProperties } from "../useEditing";
import type { PmProperty, PmPropertyValue, PmWorkItem } from "../types";
import { PropRow } from "./PropRow";
import { DateField, DraftInput } from "./fields";
import type { ItemSave } from "./useItemSave";
import type { PersonOption } from "./pickers/PeoplePicker";

const NONE = "";
const NOT_SET = <span style={{ fontSize: 12.5, color: "var(--text-4)" }}>Not set</span>;

type Tagged = Record<string, unknown> | undefined;
const text = (v: Tagged): string => (typeof v?.text === "string" ? v.text : "");
const num = (v: Tagged): number | null => (typeof v?.number === "number" ? v.number : null);
const date = (v: Tagged): string => (typeof v?.date === "string" ? v.date : "");
const bool = (v: Tagged): boolean | null => (typeof v?.boolean === "boolean" ? v.boolean : null);
const optionIds = (v: Tagged): string[] => (Array.isArray(v?.optionIds) ? (v.optionIds as string[]) : []);
const userId = (v: Tagged): string => (Array.isArray(v?.userIds) && typeof v.userIds[0] === "string" ? v.userIds[0] : "");

export function CustomFields({
  view,
  edit,
  readOnly,
  people,
}: {
  view: PmWorkItem;
  edit: ItemSave;
  readOnly: boolean;
  people: PersonOption[] | undefined;
}): JSX.Element | null {
  const { properties } = useProjectProperties(view.projectId);
  if (!properties || properties.length === 0) return null;
  return (
    <>
      {properties.map((p) => (
        <FieldRow key={p.id} property={p} view={view} edit={edit} readOnly={readOnly} people={people} />
      ))}
    </>
  );
}

function FieldRow({
  property,
  view,
  edit,
  readOnly,
  people,
}: {
  property: PmProperty;
  view: PmWorkItem;
  edit: ItemSave;
  readOnly: boolean;
  people: PersonOption[] | undefined;
}): JSX.Element {
  const key = `prop:${property.id}`;
  const value = view.properties?.[property.id] as Tagged;

  /** Set (a value) or clear (null) this field on the item, optimistically. */
  const set = (next: PmPropertyValue | null) => {
    const properties = { ...(view.properties ?? {}) };
    if (next === null) delete properties[property.id];
    else properties[property.id] = next;
    const actions = editActions();
    void edit.save(key, property.name, { properties }, () =>
      next === null ? actions.clearProperty(view.id, property.id) : actions.setProperty(view.id, property.id, next),
    );
  };

  return (
    <PropRow icon={PROPERTY_TYPES[property.type].icon} label={property.name} error={edit.errorFor(key)}>
      {readOnly ? (
        <FieldDisplay property={property} value={value} />
      ) : (
        <FieldEditor property={property} value={value} people={people} busy={edit.isBusy(key)} set={set} />
      )}
    </PropRow>
  );
}

function FieldDisplay({ property, value }: { property: PmProperty; value: Tagged }): JSX.Element {
  const person = usePerson();
  switch (property.type) {
    case "text":
      return text(value) ? <span style={{ fontSize: 13, color: "var(--text-2)" }}>{text(value)}</span> : NOT_SET;
    case "number":
      return num(value) !== null ? <span className="pm-mono" style={{ fontSize: 12.5 }}>{num(value)}</span> : NOT_SET;
    case "date":
      return date(value) ? <span className="pm-mono" style={{ fontSize: 12.5 }}>{date(value)}</span> : NOT_SET;
    case "boolean":
      return bool(value) === null ? NOT_SET : <span style={{ fontSize: 13 }}>{bool(value) ? "Yes" : "No"}</span>;
    case "select":
    case "multi_select": {
      const chosen = (property.options ?? []).filter((o) => optionIds(value).includes(o.id));
      return chosen.length === 0 ? (
        NOT_SET
      ) : (
        <span className="pm-row" style={{ gap: 6, flexWrap: "wrap" }}>
          {chosen.map((o) => (
            <span key={o.id} className="pm-tag">
              <span className="swatch" style={{ background: o.color ?? "var(--text-4)" }} />
              {o.label}
            </span>
          ))}
        </span>
      );
    }
    case "member":
      return userId(value) ? <span style={{ fontSize: 13 }}>{person(userId(value)).name}</span> : NOT_SET;
  }
}

function FieldEditor({
  property,
  value,
  people,
  busy,
  set,
}: {
  property: PmProperty;
  value: Tagged;
  people: PersonOption[] | undefined;
  busy: boolean;
  set: (next: PmPropertyValue | null) => void;
}): JSX.Element {
  const person = usePerson();
  const label = property.name;
  switch (property.type) {
    case "text":
      return (
        <DraftInput
          label={label}
          value={text(value)}
          maxLength={2000}
          disabled={busy}
          onCommit={(t) => set(t === "" ? null : { text: t })}
        />
      );
    case "number":
      return (
        <DraftInput
          label={label}
          type="number"
          step="any"
          value={num(value) === null ? "" : String(num(value))}
          disabled={busy}
          validate={(t) => (Number.isFinite(Number(t)) ? null : "Enter a number.")}
          onCommit={(t) => set(t === "" ? null : { number: Number(t) })}
        />
      );
    case "date":
      return (
        <DateField label={label} value={date(value)} disabled={busy} onCommit={(d) => set(d === null ? null : { date: d })} />
      );
    case "boolean":
      return (
        <select
          className="pm-input sm"
          style={{ width: "auto" }}
          aria-label={label}
          value={bool(value) === null ? NONE : bool(value) ? "yes" : "no"}
          disabled={busy}
          onChange={(e) => set(e.target.value === NONE ? null : { boolean: e.target.value === "yes" })}
        >
          <option value={NONE}>Not set</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      );
    case "select":
      return (
        <select
          className="pm-input sm"
          style={{ width: "auto", maxWidth: "100%" }}
          aria-label={label}
          value={optionIds(value)[0] ?? NONE}
          disabled={busy}
          onChange={(e) => set(e.target.value === NONE ? null : { optionIds: [e.target.value] })}
        >
          <option value={NONE}>Not set</option>
          {(property.options ?? []).map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      );
    case "multi_select": {
      const chosen = optionIds(value);
      return (
        <span className="pm-row" style={{ gap: 6, flexWrap: "wrap" }} role="group" aria-label={label}>
          {(property.options ?? []).map((o) => {
            const on = chosen.includes(o.id);
            return (
              <button
                key={o.id}
                type="button"
                className={"pm-chip" + (on ? " on" : "")}
                aria-pressed={on}
                disabled={busy}
                onClick={() => {
                  const next = on ? chosen.filter((id) => id !== o.id) : [...chosen, o.id];
                  set(next.length === 0 ? null : { optionIds: next });
                }}
              >
                <span className="swatch" style={{ width: 7, height: 7, borderRadius: "50%", background: o.color ?? "var(--text-4)" }} />
                {o.label}
                {on && <PmIcon name="check" size={12} />}
              </button>
            );
          })}
          {(property.options ?? []).length === 0 && <span style={{ fontSize: 12, color: "var(--text-4)" }}>No options yet.</span>}
        </span>
      );
    }
    case "member": {
      const current = userId(value);
      // The directory may be unavailable to this role: the current person is still
      // listed so the control never shows a blank for a value that is set.
      const options = [...(people ?? [])];
      if (current && !options.some((p) => p.id === current)) options.unshift({ id: current, name: person(current).name });
      return (
        <select
          className="pm-input sm"
          style={{ width: "auto", maxWidth: "100%" }}
          aria-label={label}
          value={current}
          disabled={busy || (people === undefined && !current)}
          onChange={(e) => set(e.target.value === NONE ? null : { userIds: [e.target.value] })}
        >
          <option value={NONE}>{people === undefined && !current ? "The people list isn't available" : "Not set"}</option>
          {options.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      );
    }
  }
}
