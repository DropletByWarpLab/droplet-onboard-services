"use client";

// WARP-3520 -- the drawer's properties card: every built-in property editable in
// place by writers, plain values for readers. State, priority, type and
// department are native `<select>`s (keyboard and screen-reader support come
// free, and there is no popover to clip inside the scrolling drawer); assignees,
// labels and the parent are in-place pickers; dates and the estimate commit on
// blur / Enter; the project's custom fields follow as more rows.
//
// Every write goes through `edit.save` (useItemSave): the control reflects the
// choice at once, and a refused write rolls back with an inline message.

import { useMemo, type JSX, type ReactNode } from "react";
import { DepartmentTag, StatePill, PriorityFlag, AvatarStack, usePerson } from "../bits";
import { PRIORITY, PRIORITY_ORDER, WORK_ITEM_TYPES, WORK_ITEM_TYPE_ORDER, fmtISODate, isOverdue } from "../config";
import { departmentOptions } from "../department";
import { editActions } from "../useEditing";
import { pmActions, useDepartments, usePeople, useProjectStates } from "../usePm";
import type { PmWorkItem, Priority, WorkItemType } from "../types";
import { PropRow } from "./PropRow";
import { LabelsEditor } from "./LabelsEditor";
import { CustomFields } from "./CustomFields";
import { DateField, EstimateField, ParentField } from "./fields";
import { PeoplePicker, toPersonOptions } from "./pickers/PeoplePicker";
import type { ItemSave } from "./useItemSave";
import "../editing.css";
import "./editors.css";
import { ThemedSelect } from "@/components/ui/ThemedSelect";

const MUTED = { fontSize: 12.5, color: "var(--text-4)" } as const;

/**
 * `children` render at the end of the card, after the custom fields: the place
 * for other drawer sections (cycle and module pickers, …) to add their own
 * `PropRow`s without touching this file.
 */
export function PropertiesPanel({
  edit,
  readOnly,
  onChanged,
  children,
}: {
  edit: ItemSave;
  readOnly: boolean;
  onChanged: () => void;
  children?: ReactNode;
}): JSX.Element {
  const view = edit.view;
  const person = usePerson();
  const { states } = useProjectStates(view.projectId);
  const { people: roster } = usePeople();
  const { departments } = useDepartments();
  const people = useMemo(() => toPersonOptions(roster), [roster]);
  const deptChoices = useMemo(() => departmentOptions([view], departments), [view, departments]);
  const patch = (key: string, label: string, optimistic: Partial<PmWorkItem>, body: Record<string, unknown>) =>
    edit.save(key, label, optimistic, () => editActions().patchItem(view.id, body));

  const sortedStates = useMemo(() => [...(states ?? [])].sort((a, b) => a.sortOrder - b.sortOrder), [states]);
  const inheritedDept = view.department?.source === "project" ? view.department : null;

  return (
    <div className="pm-surface" style={{ padding: "4px 16px" }}>
      <span className="pm-sr" role="status" aria-live="polite">
        {edit.announcement}
      </span>

      <PropRow icon="dotCircle" label="State" error={edit.errorFor("state")}>
        {readOnly || !view.state ? (
          view.state ? <StatePill state={view.state} /> : <span style={MUTED}>No state</span>
        ) : (
          <ThemedSelect
            className="pm-input sm"
            style={{ width: "auto" }}
            aria-label="State"
            value={view.stateId ?? ""}
            disabled={edit.isBusy("state")}
            onChange={(e) => {
              const next = sortedStates.find((s) => s.id === e.target.value);
              if (!next) return;
              void edit.save("state", "State", { stateId: next.id, state: next }, () =>
                pmActions().transitionItem(view.id, next.id),
              );
            }}
          >
            {sortedStates.length === 0 && <option value={view.state.id}>{view.state.name}</option>}
            {sortedStates.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </ThemedSelect>
        )}
      </PropRow>

      <PropRow icon="signal" label="Priority" error={edit.errorFor("priority")}>
        {readOnly ? (
          <PriorityFlag p={view.priority} withLabel />
        ) : (
          <ThemedSelect
            className="pm-input sm"
            style={{ width: "auto" }}
            aria-label="Priority"
            value={view.priority}
            disabled={edit.isBusy("priority")}
            onChange={(e) => {
              const priority = e.target.value as Priority;
              void patch("priority", "Priority", { priority }, { priority });
            }}
          >
            {PRIORITY_ORDER.map((p) => (
              <option key={p} value={p}>
                {PRIORITY[p].label}
              </option>
            ))}
          </ThemedSelect>
        )}
      </PropRow>

      <PropRow icon="users" label="Assignees" error={edit.errorFor("assignees")}>
        {readOnly ? (
          view.assignees.length ? (
            <span className="pm-row" style={{ gap: 7 }}>
              <AvatarStack ids={view.assignees} size={22} />
              <span style={{ fontSize: 12.5, color: "var(--text-2)" }}>
                {view.assignees.map((a) => person(a).name).join(", ")}
              </span>
            </span>
          ) : (
            <span style={MUTED}>Unassigned</span>
          )
        ) : (
          <PeoplePicker
            selected={view.assignees}
            people={people}
            disabled={edit.isBusy("assignees")}
            onChange={(assignees) => void patch("assignees", "Assignees", { assignees }, { assignees })}
          />
        )}
      </PropRow>

      <PropRow icon="flag" label="Labels">
        {readOnly ? (
          view.labels.length ? (
            <span className="pm-row" style={{ gap: 6, flexWrap: "wrap" }}>
              {view.labels.map((l) => (
                <span key={l.id} className="pm-tag">
                  <span className="swatch" style={{ background: l.color ?? "var(--text-4)" }} />
                  {l.name}
                </span>
              ))}
            </span>
          ) : (
            <span style={MUTED}>None</span>
          )
        ) : (
          <LabelsEditor item={view} onChanged={onChanged} />
        )}
      </PropRow>

      <PropRow icon="task" label="Type" error={edit.errorFor("type")}>
        {readOnly ? (
          <span style={{ fontSize: 13 }}>{WORK_ITEM_TYPES[view.type ?? "task"].label}</span>
        ) : (
          <ThemedSelect
            className="pm-input sm"
            style={{ width: "auto" }}
            aria-label="Type"
            value={view.type ?? "task"}
            disabled={edit.isBusy("type")}
            onChange={(e) => {
              const type = e.target.value as WorkItemType;
              void patch("type", "Type", { type }, { type });
            }}
          >
            {WORK_ITEM_TYPE_ORDER.map((t) => (
              <option key={t} value={t}>
                {WORK_ITEM_TYPES[t].label}
              </option>
            ))}
          </ThemedSelect>
        )}
      </PropRow>

      <PropRow icon="hash" label="Estimate" error={edit.errorFor("estimate")}>
        {readOnly ? (
          view.estimate === null || view.estimate === undefined ? (
            <span style={MUTED}>Not estimated</span>
          ) : (
            <span className="pm-mono" style={{ fontSize: 12.5, color: "var(--text-2)" }}>
              {view.estimate} {view.estimate === 1 ? "point" : "points"}
            </span>
          )
        ) : (
          <EstimateField
            value={view.estimate ?? null}
            disabled={edit.isBusy("estimate")}
            onCommit={(estimate) => void patch("estimate", "Estimate", { estimate }, { estimate })}
          />
        )}
      </PropRow>

      <PropRow icon="building" label="Department" error={edit.errorFor("department")}>
        {readOnly ? (
          view.department ? (
            <span className="pm-row" style={{ gap: 7 }}>
              <DepartmentTag dept={view.department} />
              <span style={{ fontSize: 12, color: "var(--text-4)" }}>
                {view.department.source === "item" ? "set on this item" : "from the project"}
              </span>
            </span>
          ) : (
            <span style={MUTED}>No department</span>
          )
        ) : (
          <ThemedSelect
            className="pm-input sm"
            style={{ width: "auto", maxWidth: "100%" }}
            aria-label="Department"
            value={view.department?.source === "item" ? view.department.id : ""}
            disabled={edit.isBusy("department")}
            onChange={(e) => {
              const id = e.target.value;
              // "" clears the item's OWN department, so it inherits the project's again.
              const chosen = deptChoices.find((d) => d.id === id);
              void patch(
                "department",
                "Department",
                {
                  department: chosen
                    ? { id: chosen.id, name: chosen.name, kind: chosen.kind, parentId: chosen.parentId, source: "item" }
                    : inheritedDept,
                },
                { department_id: id === "" ? null : id },
              );
            }}
          >
            <option value="">{inheritedDept ? `Project default (${inheritedDept.name})` : "No department"}</option>
            {deptChoices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.kind === "TEAM" ? `${d.name} (team)` : d.name}
              </option>
            ))}
          </ThemedSelect>
        )}
      </PropRow>

      <PropRow icon="cal" label="Start date" error={edit.errorFor("startDate")}>
        {readOnly ? (
          <span className="pm-mono" style={{ fontSize: 12.5, color: "var(--text-2)" }}>
            {fmtISODate(view.startDate)}
          </span>
        ) : (
          <DateField
            label="Start date"
            value={view.startDate?.slice(0, 10) ?? ""}
            disabled={edit.isBusy("startDate")}
            onCommit={(d) =>
              void patch(
                "startDate",
                "Start date",
                { startDate: d === null ? null : `${d}T00:00:00.000Z` },
                { start_date: d },
              )
            }
          />
        )}
      </PropRow>

      <PropRow icon="clock" label="Due date" error={edit.errorFor("dueDate")}>
        {readOnly ? (
          <span className="pm-mono" style={{ fontSize: 12.5, color: isOverdue(view) ? "var(--warn)" : "var(--text-2)" }}>
            {fmtISODate(view.dueDate)}
          </span>
        ) : (
          <DateField
            label="Due date"
            value={view.dueDate?.slice(0, 10) ?? ""}
            disabled={edit.isBusy("dueDate")}
            onCommit={(d) =>
              void patch("dueDate", "Due date", { dueDate: d === null ? null : `${d}T00:00:00.000Z` }, { due_date: d })
            }
          />
        )}
      </PropRow>

      <PropRow icon="branch" label="Parent" error={edit.errorFor("parent")}>
        {readOnly ? (
          view.parentId ? <ParentField item={view} disabled onChange={() => undefined} /> : <span style={MUTED}>No parent</span>
        ) : (
          <ParentField
            item={view}
            disabled={edit.isBusy("parent")}
            onChange={(parent) =>
              void patch("parent", "Parent", { parentId: parent?.id ?? null }, { parent_id: parent?.id ?? null })
            }
          />
        )}
      </PropRow>

      <CustomFields view={view} edit={edit} readOnly={readOnly} people={people} />
      {children}
    </div>
  );
}
