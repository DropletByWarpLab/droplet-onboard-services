"use client";

// "Unscheduled" side panel of the calendar: open work with no dates. Drag a card
// onto a day to schedule it (due date), or — for keyboard, touch and screen-reader
// users, who cannot drag — pick a day with the native date control on the card.

import type { DragEvent, JSX } from "react";
import { PriorityFlag } from "../bits";
import type { PmWorkItem } from "../types";
import { isDateOnly, type DateOnly } from "./dateOnly";

export function UnscheduledPanel({
  items,
  readOnly,
  onOpen,
  onSchedule,
  onDragStart,
  onDragEnd,
}: {
  items: PmWorkItem[];
  readOnly: boolean;
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
              {!readOnly && (
                <input
                  type="date"
                  className="pm-input pm-mono pm-cal-dateinput"
                  aria-label={`Set due date for ${item.key}`}
                  value=""
                  onChange={(e) => {
                    const v = e.target.value;
                    if (isDateOnly(v)) onSchedule(item, v);
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
