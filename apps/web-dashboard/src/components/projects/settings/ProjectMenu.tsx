"use client";

// WARP-3520 -- the project header's menu: Project settings (writers) and Archived
// items (everyone who can read the project). It owns the open/closed state of the
// two dialogs, so the Projects page needs one element and no new state.

import { useRef, useState, type JSX } from "react";
import { MenuButton } from "../MenuButton";
import type { PmProject } from "../types";
import { ArchivedItemsDialog } from "./ArchivedItemsDialog";
import { ProjectSettingsDialog } from "./ProjectSettingsDialog";

export function ProjectMenu({
  project,
  readOnly,
  canDeleteItems,
  canManageFields,
  onProjectChanged,
  onItemsChanged,
}: {
  project: PmProject;
  /** Members, viewers and guests: no settings, restore or delete. */
  readOnly: boolean;
  /** Owner / admin: may delete an archived item for good. */
  canDeleteItems: boolean;
  /** Owner / admin / the project's lead: may define custom fields. */
  canManageFields: boolean;
  onProjectChanged: () => void;
  onItemsChanged: () => void;
}): JSX.Element {
  const [open, setOpen] = useState<"settings" | "archived" | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  // The dialogs are unmounted, not closed (they have no `open` flag to flip), so
  // the Dialog primitive never restores focus: put it back on the menu button.
  const close = () => {
    setOpen(null);
    setTimeout(() => triggerRef.current?.focus(), 0);
  };
  return (
    <>
      <MenuButton
        label="Project settings and archived items"
        className="btn"
        buttonRef={triggerRef}
        items={[
          { id: "settings", label: "Project settings", icon: "settings", hidden: readOnly, onSelect: () => setOpen("settings") },
          { id: "archived", label: "Archived items", icon: "archive", onSelect: () => setOpen("archived") },
        ]}
      />
      {open === "settings" && (
        <ProjectSettingsDialog
          project={project}
          canManageFields={canManageFields}
          onClose={close}
          onProjectChanged={onProjectChanged}
          onItemsChanged={onItemsChanged}
        />
      )}
      {open === "archived" && (
        <ArchivedItemsDialog
          project={project}
          readOnly={readOnly}
          canDelete={canDeleteItems}
          onClose={close}
          onItemsChanged={onItemsChanged}
        />
      )}
    </>
  );
}
