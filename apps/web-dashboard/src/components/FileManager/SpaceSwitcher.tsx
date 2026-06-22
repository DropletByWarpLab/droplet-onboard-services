"use client";

import { FolderLock, Users } from "lucide-react";
import type { FileSpace, FileSpaceId } from "@/lib/types";

interface SpaceSwitcherProps {
  spaces: FileSpace[];
  active: FileSpaceId;
  onChange: (space: FileSpaceId) => void;
}

const SPACE_ICON: Record<FileSpaceId, typeof FolderLock> = {
  personal: FolderLock,
  shared: Users,
};

/**
 * WARP-883 (ADR-027 WS-5) — segmented control to switch between the user's
 * private "My Files" space and the shared "Household" space.
 *
 * Restraint-first: a quiet inset track (no lone toggle when there's nothing to
 * switch to). The control only renders when the shared space is actually
 * available — with just the personal space there is nothing to toggle, so we
 * render nothing rather than a single dead segment. The active segment carries
 * the indigo accent; inactive segments stay secondary. Transition is colour-
 * only and fast (150ms) so the flip feels purposeful, not playful.
 */
export function SpaceSwitcher({ spaces, active, onChange }: SpaceSwitcherProps) {
  const visible = spaces.filter((s) => s.available);
  // Nothing to switch between → don't show a lone control.
  if (visible.length < 2) return null;

  return (
    <div
      role="tablist"
      aria-label="File space"
      className="inline-flex items-center gap-1 rounded-md bg-surface-secondary p-1"
    >
      {visible.map((space) => {
        const Icon = SPACE_ICON[space.id];
        const isActive = space.id === active;
        return (
          <button
            key={space.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(space.id)}
            className={`inline-flex items-center gap-1.5 rounded-sm px-3 py-1.5 type-subheadline transition-colors duration-150 ${
              isActive
                ? "bg-surface-primary text-accent font-medium shadow-sm"
                : "text-label-secondary hover:text-label-primary"
            }`}
          >
            <Icon size={14} className={isActive ? "text-accent" : "text-label-tertiary"} />
            {space.name}
          </button>
        );
      })}
    </div>
  );
}
