"use client";

import { Building2, FolderLock, Users, UsersRound } from "lucide-react";
import type { FileSpace, FileSpaceId } from "@/lib/types";

interface SpaceSwitcherProps {
  spaces: FileSpace[];
  active: FileSpaceId;
  onChange: (space: FileSpaceId) => void;
}

/**
 * WARP-1261 (spaces v2) — the wire contract no longer carries an `available`
 * boolean; the GET /api/files/spaces response only lists spaces the caller can
 * reach and tags each shared space with a provisioning `state`. A space is
 * switchable when it is the personal space (always present) or when its
 * provisioning has completed (`state === "active"`). Failing closed on any
 * non-active state keeps a pending/failed/archiving/archived mount out of the
 * switcher.
 */
function isSpaceUsable(space: FileSpace): boolean {
  if (space.id === "personal") return true;
  return space.state === "active";
}

/**
 * Icon per space kind. Personal has no `kind` on the wire; household/dept/team
 * carry one. Falls back to the household glyph so an unknown future kind still
 * renders a control rather than crashing on an undefined icon.
 */
function iconForSpace(space: FileSpace): typeof FolderLock {
  if (space.id === "personal") return FolderLock;
  switch (space.kind) {
    case "department":
      return Building2;
    case "team":
      return UsersRound;
    case "household":
    default:
      return Users;
  }
}

/**
 * WARP-883 (ADR-027 WS-5) + WARP-1261 (spaces v2) — segmented control to switch
 * between the user's private "My Files" space and any shared spaces they can
 * reach (Household, departments, teams).
 *
 * Restraint-first: the indigo `.pills` segmented control (mirroring the search
 * mode switcher). The control only renders when there is more than one usable
 * space to toggle between — with just the personal space there is nothing to
 * toggle, so we render nothing rather than a single dead segment. The active
 * segment carries the indigo accent (`var(--brand)` text on a
 * `var(--brand-subtle)` wash); inactive segments stay muted. Transition is
 * colour-only so the flip feels purposeful, not playful.
 */
export function SpaceSwitcher({ spaces, active, onChange }: SpaceSwitcherProps) {
  const visible = spaces.filter(isSpaceUsable);
  // Nothing to switch between → don't show a lone control.
  if (visible.length < 2) return null;

  return (
    <div role="tablist" aria-label="File space" className="pills">
      {visible.map((space) => {
        const Icon = iconForSpace(space);
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
