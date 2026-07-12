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

/** Departments/teams and other future spaces fall back to the group glyph. */
function iconForSpace(id: FileSpaceId): typeof FolderLock {
  return SPACE_ICON[id] ?? Users;
}

/**
 * WARP-883 (ADR-027 WS-5) — segmented control to switch between the user's
 * private "My Files" space and the shared "Household" space.
 *
 * Restraint-first: the indigo `.pills` segmented control (mirroring the search
 * mode switcher). The control only renders when the shared space is actually
 * available — with just the personal space there is nothing to toggle, so we
 * render nothing rather than a single dead segment. The active segment carries
 * the indigo accent (`var(--brand)` text on a `var(--brand-subtle)` wash);
 * inactive segments stay muted. Transition is colour-only so the flip feels
 * purposeful, not playful.
 */
export function SpaceSwitcher({ spaces, active, onChange }: SpaceSwitcherProps) {
  // The server only lists spaces the caller can access; non-active
  // departments (provisioning/failed/archived) are not browsable yet.
  const visible = spaces.filter((s) => !s.state || s.state === "active");
  // Nothing to switch between → don't show a lone control.
  if (visible.length < 2) return null;

  return (
    <div role="tablist" aria-label="File space" className="pills">
      {visible.map((space) => {
        const Icon = iconForSpace(space.id);
        const isActive = space.id === active;
        return (
          <button
            key={space.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(space.id)}
            className={isActive ? "active" : undefined}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              whiteSpace: "nowrap",
            }}
          >
            <Icon size={14} aria-hidden="true" />
            {space.name}
          </button>
        );
      })}
    </div>
  );
}
