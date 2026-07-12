"use client";

import { useState } from "react";
import { Layers, Plus, Pencil, Trash2 } from "lucide-react";
import type { CameraGroupInfo, CameraInfo } from "@/lib/types";

interface Props {
  groups: CameraGroupInfo[];
  cameras: CameraInfo[];
  /** null = "All cameras" pseudo-group selected. */
  selectedGroupId: string | null;
  onSelect: (groupId: string | null) => void;
  onNewGroup: () => void;
  onEditGroup: (group: CameraGroupInfo) => void;
  onDeleteGroup: (group: CameraGroupInfo) => void;
}

/**
 * Horizontal pill rail above the cameras grid.
 *
 * Each pill is a group; the leftmost "All" pseudo-group selects every
 * camera. A "+" tile at the end opens the new-group modal. Right-click
 * (desktop) or the small ✏️ on the active pill opens edit. Active pill
 * carries the accent fill so the operator always knows which slice of
 * the grid they're looking at.
 *
 * Empty-groups still render — operator might create a group ahead of
 * the cameras themselves (provisioning a "Backyard" before the cams
 * arrive). The grid below shows a friendly "no cameras in this group
 * yet" instead of a hard empty state.
 */
export function CameraGroupNav({
  groups,
  cameras,
  selectedGroupId,
  onSelect,
  onNewGroup,
  onEditGroup,
  onDeleteGroup,
}: Props) {
  const allCount = cameras.length;

  return (
    <div className="flex items-center gap-2 overflow-x-auto pb-1 -mx-1 px-1 scrollbar-thin">
      <Pill
        label="All"
        icon={<Layers size={14} />}
        count={allCount}
        active={selectedGroupId === null}
        onClick={() => onSelect(null)}
      />
      {groups.map((group) => (
        <GroupPill
          key={group.id}
          group={group}
          active={selectedGroupId === group.id}
          onSelect={() => onSelect(group.id)}
          onEdit={() => onEditGroup(group)}
          onDelete={() => onDeleteGroup(group)}
        />
      ))}
      <button
        type="button"
        onClick={onNewGroup}
        className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-dashed text-[color:var(--text-muted)] hover:text-[color:var(--text)] hover:border-[color:var(--text-muted)] transition-colors"
        style={{ borderColor: "var(--border)" }}
      >
        <Plus size={14} />
        <span className="type-caption-1">New group</span>
      </button>
    </div>
  );
}

function Pill({
  label,
  icon,
  count,
  active,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`chip flex-shrink-0${active ? " on" : ""}`}
    >
      {icon}
      <span className="type-caption-1 font-medium">{label}</span>
      <span className="type-caption-2" style={{ opacity: active ? 0.8 : 1 }}>
        {count}
      </span>
    </button>
  );
}

function GroupPill({
  group,
  active,
  onSelect,
  onEdit,
  onDelete,
}: {
  group: CameraGroupInfo;
  active: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [showActions, setShowActions] = useState(false);
  const count = group.members.length;

  // Edit / delete only render on the active pill so a non-selected pill
  // is a single click target — keeps the rail visually quiet for
  // operators with many groups. Once the pill is active, the icons
  // become visible and reachable.
  return (
    <div
      className="relative flex-shrink-0"
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
      <button
        type="button"
        onClick={onSelect}
        onContextMenu={(e) => {
          e.preventDefault();
          onEdit();
        }}
        className={`chip${active ? " on" : ""}`}
        style={active ? { paddingRight: 44 } : undefined}
      >
        {group.icon ? (
          <span className="type-caption-1">{group.icon}</span>
        ) : (
          <Layers size={14} />
        )}
        <span className="type-caption-1 font-medium truncate max-w-[12rem]">
          {group.name}
        </span>
        <span className="type-caption-2" style={{ opacity: active ? 0.8 : 1 }}>
          {count}
        </span>
      </button>

      {/* Inline edit / delete only when the pill is active or hovered.
          Click events stop-propagation so they don't re-trigger select. */}
      {(active || showActions) && (
        <div className="absolute top-1/2 right-1 -translate-y-1/2 flex items-center gap-0.5">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
            className="p-1 rounded-full hover:bg-[var(--hover)] text-[color:var(--text-muted)] hover:text-[color:var(--text)] transition-colors"
            title="Edit group"
          >
            <Pencil size={12} />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="p-1 rounded-full hover:bg-[rgba(239,68,68,0.12)] text-[color:var(--text-muted)] hover:text-[color:var(--danger)] transition-colors"
            title="Delete group"
          >
            <Trash2 size={12} />
          </button>
        </div>
      )}
    </div>
  );
}
