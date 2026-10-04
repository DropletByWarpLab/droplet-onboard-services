"use client";

// "Unscheduled" side panel of the calendar: open work with no dates. Drag a card
// onto a day to schedule it (due date), or — for keyboard, touch and screen-reader
// users, who cannot drag — pick a day with the native date control on the card
// and press Set.
//
// The control is a small form, not a field that saves on change. A segmented date
// input reports a complete date after every digit typed into its year segment
// ("0002-10-20", "0020-10-20", "0202-10-20", then "2026-10-20"), so saving from
// `change` would schedule the item in year 2 while the person is still typing.
// The value is a draft; Set (or Enter) commits it, and only if it is a date a
// person could mean.

import { useState, type DragEvent, type FormEvent, type JSX } from "react";
import { PriorityFlag } from "../bits";
import type { PmWorkItem } from "../types";
import { isPlausibleScheduleDate, plausibleScheduleRange, type DateOnly } from "./dateOnly";

export function UnscheduledPanel({
  items,
  readOnly,
  today,
  onOpen,
  onSchedule,
  onDragStart,
  onDragEnd,
}: {
  items: PmWorkItem[];
  readOnly: boolean;
  today: DateOnly;
  onOpen: (item: PmWorkItem) => void;
  onSchedule: (item: PmWorkItem, day: DateOnly) => void;
  onDragStart: (e: DragEvent<HTMLElement>, item: PmWorkItem) => void;
  onDragEnd: () => void;
}): JSX.Element {
  return (
    <aside className="pm-cal-panel" aria-label="Unscheduled work items">
      <div className="pm-sect">
        Unscheduled <span className="sx">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <div className="pm-cal-panel-empty">
          <strong>Nothing unscheduled.</strong>
          <span>Open items without a date will show up here.</span>
        </div>
      ) : (
        <ul className="pm-cal-ulist">
          {items.map((item) => (
            <li
              key={item.id}
              className="pm-cal-ucard"
              draggable={!readOnly}
              onDragStart={(e) => onDragStart(e, item)}
              onDragEnd={onDragEnd}
              data-unscheduled-item={item.id}
            >
              <button
                type="button"
                className="pm-cal-ucard-open"
                aria-label={`${item.key}, ${item.name}`}
                onClick={() => onOpen(item)}
              >
                <span className="pm-row" style={{ justifyContent: "space-between", gap: 8 }}>
                  <span className="pm-mono pm-cal-ukey">{item.key}</span>
                  <PriorityFlag p={item.priority} size={13} />
                </span>
                <span className="pm-clamp2 pm-cal-utitle">{item.name}</span>
              </button>
              {!readOnly && <ScheduleControl item={item} today={today} onSchedule={onSchedule} />}
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

function ScheduleControl({
  item,
  today,
  onSchedule,
}: {
  item: PmWorkItem;
  today: DateOnly;
  onSchedule: (item: PmWorkItem, day: DateOnly) => void;
}): JSX.Element {
  const [draft, setDraft] = useState("");
  const { min, max } = plausibleScheduleRange(today);
  const valid = isPlausibleScheduleDate(draft, today);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    onSchedule(item, draft);
    setDraft("");
  };

  return (
    <form className="pm-cal-schedule" onSubmit={submit}>
      <input
        type="date"
        className="pm-input pm-mono pm-cal-dateinput"
        aria-label={`Set due date for ${item.key}`}
        aria-invalid={draft !== "" && !valid ? true : undefined}
        min={min}
        max={max}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <button type="submit" className="pm-btn sm" disabled={!valid} aria-label={`Schedule ${item.key} on the chosen date`}>
        Set
      </button>
    </form>
  );
}
