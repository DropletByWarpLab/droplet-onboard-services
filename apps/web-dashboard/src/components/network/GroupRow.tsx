"use client";
import { useState } from "react";
import * as Icons from "lucide-react";
import type { DeviceGroupWithCount, Schedule } from "@/lib/types";
import { IconPicker, type DeviceIconName } from "./IconPicker";
import { useSchedules } from "@/lib/hooks/useSchedules";
import { ScheduleEditorModal } from "./ScheduleEditorModal";
import { QuickSchedulePopover } from "./QuickSchedulePopover";

/**
 * Single row in the GroupManagerDialog list — extracted from the inline `.map`
 * body in WARP-98 so we can hang the schedule summary, Quick Schedule popover,
 * and future per-group actions off a named component without exploding the
 * parent.
 *
 * Behavior preserved from the original inline block: rename-on-blur, color
 * swatch picker, icon picker, inline delete-confirm. Those paths flow through
 * the mutation callbacks passed in by the parent (which still owns the toast).
 */

// Preset color swatches — mirror of the palette defined in
// `GroupManagerDialog`. Kept duplicated (not exported) so GroupRow can stand
// alone for tests without a harness.
const PRESET_COLORS = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#06b6d4",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
];

interface Props {
  group: DeviceGroupWithCount;
  onRename: (
    id: string,
    patch: { name?: string; color?: string | null; icon?: string | null },
  ) => void | Promise<void>;
  onDelete: (id: string) => void | Promise<void>;
}

export function GroupRow({ group: g, onRename, onDelete }: Props) {
  const count = g._count.devices;
  const countLabel = `${count} device${count === 1 ? "" : "s"}`;

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [iconOpen, setIconOpen] = useState(false);
  const [schedulesExpanded, setSchedulesExpanded] = useState(false);
  const [quickScheduleOpen, setQuickScheduleOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);

  const { data: schedulesData } = useSchedules();
  const allSchedules: Schedule[] = schedulesData?.schedules ?? [];
  const groupSchedules = allSchedules.filter(
    (s) => s.subjectType === "group" && s.groupId === g.id,
  );

  return (
    <li className="p-3">
      <div className="flex items-center gap-2">
        <input
          defaultValue={g.name}
          onBlur={(e) => {
            const next = e.target.value.trim();
            if (next && next !== g.name) {
              void onRename(g.id, { name: next });
            }
          }}
          className="type-body text-[color:var(--text)] bg-transparent border-b border-transparent hover:border-[var(--card-bd)] focus:border-[var(--brand)] outline-none flex-1 min-w-0"
          aria-label={`Rename ${g.name}`}
        />
        <span className="type-caption-1 text-[color:var(--text-muted)] whitespace-nowrap">
          {countLabel}
        </span>

        {/* Quick Schedule button — new in WARP-98. Kept next to the delete
            button per the ticket spec. */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setQuickScheduleOpen((o) => !o)}
            aria-label={`Quick schedule for ${g.name}`}
            className="type-caption-1 px-2 py-1 rounded text-[color:var(--text-muted)] hover:bg-[var(--hover)]"
            title="Quick schedule"
          >
            <Icons.CalendarClock className="w-4 h-4" />
          </button>
          {quickScheduleOpen && (
            <QuickSchedulePopover
              subject={{ type: "group", groupId: g.id }}
              onClose={() => setQuickScheduleOpen(false)}
            />
          )}
        </div>

        {!confirmDelete ? (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            aria-label={`Delete ${g.name}`}
            className="type-caption-1 text-system-red px-2 py-1 rounded hover:bg-system-red/10"
          >
            Delete
          </button>
        ) : (
          <div className="flex items-center gap-1">
            <span className="type-caption-1 text-[color:var(--text-muted)]">
              {count} ungrouped. Delete?
            </span>
            <button
              type="button"
              onClick={async () => {
                await onDelete(g.id);
                setConfirmDelete(false);
              }}
              className="type-caption-1 px-2 py-1 bg-system-red text-white rounded"
            >
              Yes
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              className="type-caption-1 px-2 py-1 bg-[var(--card-inner)] rounded"
            >
              Cancel
            </button>
          </div>
        )}
      </div>

      {/* Color swatches */}
      <div className="flex items-center gap-2 mt-2 flex-wrap">
        <span className="type-caption-1 text-[color:var(--text-muted)]">Color</span>
        {PRESET_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => void onRename(g.id, { color: c })}
            aria-label={`Color ${c}`}
            className={`w-5 h-5 rounded-full border ${
              g.color === c ? "ring-2 ring-[var(--brand)]" : "border-[var(--card-bd)]"
            }`}
            style={{ backgroundColor: c }}
          />
        ))}
        <button
          type="button"
          onClick={() => void onRename(g.id, { color: null })}
          className="type-caption-1 text-[color:var(--text-muted)] ml-1"
        >
          None
        </button>
      </div>

      {/* Icon picker toggle */}
      <div className="mt-2">
        <button
          type="button"
          onClick={() => setIconOpen((o) => !o)}
          className="type-caption-1 text-[color:var(--text-muted)]"
        >
          {iconOpen ? "Hide icon picker" : `Icon: ${g.icon ?? "None"}`}
        </button>
        {iconOpen && (
          <div className="mt-2">
            <IconPicker
              value={g.icon ?? null}
              onSelect={(icon: DeviceIconName) => {
                void onRename(g.id, { icon });
                setIconOpen(false);
              }}
            />
          </div>
        )}
      </div>

      {/* Schedule summary — new in WARP-98 */}
      <div className="mt-2">
        <button
          type="button"
          onClick={() => setSchedulesExpanded((o) => !o)}
          aria-expanded={schedulesExpanded}
          className="type-caption-1 text-[color:var(--text-muted)] hover:text-[color:var(--text)]"
        >
          {renderScheduleSummary(groupSchedules)}
        </button>

        {schedulesExpanded && (
          <div className="mt-2 space-y-1">
            {groupSchedules.length === 0 ? (
              <p className="type-caption-1 text-[color:var(--text-muted)]">
                No schedules for this group yet.
              </p>
            ) : (
              <ul className="space-y-1">
                {groupSchedules.map((s) => (
                  <li
                    key={s.id}
                    className="flex items-center justify-between gap-2 px-2 py-1 rounded bg-[var(--card-inner)]"
                  >
                    <span className="type-caption-1 text-[color:var(--text)] truncate">
                      {s.name}
                    </span>
                    <span className="type-caption-2 text-[color:var(--text-muted)] whitespace-nowrap">
                      {s.enabled ? "enabled" : "disabled"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <button
              type="button"
              onClick={() => setEditorOpen(true)}
              className="btn sm"
            >
              + New schedule
            </button>
          </div>
        )}
      </div>

      {editorOpen && (
        <ScheduleEditorModal
          scheduleId="new"
          initialSubject={{ type: "group", groupId: g.id }}
          onClose={() => setEditorOpen(false)}
        />
      )}
    </li>
  );
}

function renderScheduleSummary(groupSchedules: Schedule[]): string {
  if (groupSchedules.length === 0) return "0 schedules";
  const first = groupSchedules[0];
  const firstLabel = `${first.name} (${first.enabled ? "enabled" : "disabled"})`;
  if (groupSchedules.length === 1) return firstLabel;
  return `${firstLabel} · +${groupSchedules.length - 1} more`;
}
