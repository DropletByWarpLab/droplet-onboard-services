"use client";

import { useId, useState, type JSX } from "react";
import { PmIcon } from "../../icons";
import { Avatar, usePerson } from "../../bits";

export interface PersonOption {
  id: string;
  name: string;
}

/**
 * The PM roster as the picker offers it. Its `id` is the local User.id used by
 * assignees, leads and member fields; it is already scoped to active accounts.
 */
export function toPersonOptions(
  people: ReadonlyArray<{ id: string; displayName: string }> | undefined,
): PersonOption[] | undefined {
  if (!people) return undefined;
  return people
    .map((u) => ({ id: u.id, name: u.displayName }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Multi-select people picker with search, used for assignees (design brief §4.2:
 * a popover multi-select that sends the COMPLETE desired set, not a delta).
 *
 * Opens in place — no portal — like the labels picker. Choosing or removing a
 * person calls `onChange` with the whole new set straight away. When the
 * roster is unavailable (`people` undefined) the current people are still shown and can be removed, and
 * the panel says why nobody can be added.
 */
export function PeoplePicker({
  selected,
  people,
  onChange,
  disabled,
}: {
  selected: string[];
  people: PersonOption[] | undefined;
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}): JSX.Element {
  const person = usePerson();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const listId = useId();

  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  const needle = query.trim().toLowerCase();
  const shown = (people ?? []).filter((p) => needle === "" || p.name.toLowerCase().includes(needle));

  return (
    <span style={{ minWidth: 0, display: "inline-flex", flexDirection: "column", gap: 8, maxWidth: "100%" }}>
      <span className="pm-row" style={{ gap: 6, flexWrap: "wrap" }}>
        {selected.length === 0 && !open && <span style={{ fontSize: 12.5, color: "var(--text-4)" }}>Unassigned</span>}
        {selected.map((id) => {
          const name = person(id).name;
          return (
            <span key={id} className="pm-tag" style={{ height: 24, paddingRight: 3 }}>
              <Avatar id={id} size={16} />
              {name}
              <button
                type="button"
                className="pm-iconbtn"
                style={{ width: 20, height: 20 }}
                aria-label={`Remove ${name}`}
                disabled={disabled}
                onClick={() => toggle(id)}
              >
                <PmIcon name="x" size={11} />
              </button>
            </span>
          );
        })}
        <button
          type="button"
          className="pm-btn ghost sm"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          onClick={() => setOpen((v) => !v)}
        >
          <PmIcon name={open ? "x" : "plus"} size={12} />
          {open ? "Done" : "Add assignee"}
        </button>
      </span>

      {open && (
        <div
          id={listId}
          className="pm-picker"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setOpen(false);
            }
          }}
        >
          {people === undefined ? (
            <div className="pm-picker-note">The people list isn&apos;t available.</div>
          ) : (
            <>
              <input
                className="pm-input sm"
                type="search"
                placeholder="Search people"
                aria-label="Search people"
                value={query}
                autoFocus
                onChange={(e) => setQuery(e.target.value)}
              />
              <div className="pm-picker-list" role="group" aria-label="People">
                {shown.length === 0 ? (
                  <div className="pm-picker-note">No one matches.</div>
                ) : (
                  shown.map((p) => {
                    const on = selected.includes(p.id);
                    return (
                      <button
                        key={p.id}
                        type="button"
                        className={"pm-picker-item" + (on ? " on" : "")}
                        aria-pressed={on}
                        disabled={disabled}
                        onClick={() => toggle(p.id)}
                      >
                        <Avatar id={p.id} size={18} />
                        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</span>
                        {on && <PmIcon name="check" size={13} />}
                      </button>
                    );
                  })
                )}
              </div>
            </>
          )}
        </div>
      )}
    </span>
  );
}
