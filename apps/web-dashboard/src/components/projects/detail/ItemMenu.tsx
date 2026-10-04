"use client";

// WARP-3520 -- the drawer's Archive / Restore / Delete menu.
//
// Archive and restore are ordinary writer actions and fully reversible, so they
// run on the click. Delete is not: it is owner/admin only on the server, takes
// the item's comments and history with it, and asks for the item's key to be
// typed first (the shared DestructiveConfirm).

import { useState, type JSX } from "react";
import { DestructiveConfirm } from "@/components/DestructiveConfirm";
import { useToast } from "@/components/Toast";
import { translateError } from "@/lib/friendly-errors";
import { MenuButton } from "../MenuButton";
import { editActions } from "../useEditing";
import type { PmWorkItem } from "../types";

export function ItemMenu({
  item,
  readOnly,
  canDelete,
  onChanged,
  onClose,
}: {
  item: Pick<PmWorkItem, "id" | "key" | "name" | "isArchived">;
  readOnly: boolean;
  /** Owner / admin: may hard-delete. */
  canDelete: boolean;
  onChanged: () => void;
  /** Close the drawer — the item is no longer in the list it was opened from. */
  onClose: () => void;
}): JSX.Element {
  const { toast } = useToast();
  const [confirming, setConfirming] = useState(false);
  const archived = item.isArchived === true;

  const run = async (what: "archive" | "restore") => {
    try {
      const actions = editActions();
      await (what === "archive" ? actions.archiveItem(item.id) : actions.restoreItem(item.id));
      toast(
        what === "archive" ? "Item archived. You can restore it from Archived items." : "Item restored.",
        "success",
      );
      onChanged();
      if (what === "archive") onClose();
    } catch (e) {
      toast(translateError(e, "projects"), "error");
    }
  };

  return (
    <>
      <MenuButton
        label="Item actions"
        items={[
          { id: "archive", label: "Archive", icon: "archive", hidden: readOnly || archived, onSelect: () => void run("archive") },
          { id: "restore", label: "Restore", icon: "restore", hidden: readOnly || !archived, onSelect: () => void run("restore") },
          { id: "delete", label: "Delete…", icon: "trash", danger: true, hidden: !canDelete, onSelect: () => setConfirming(true) },
        ]}
      />
      <DestructiveConfirm
        open={confirming}
        title="Delete this item?"
        consequence="This permanently deletes the item with its comments and history. It can't be undone."
        targetSummary={
          <span>
            <span className="pm-mono">{item.key}</span> · {item.name}
          </span>
        }
        confirmPhrase={item.key}
        confirmLabel="Delete item"
        busyLabel="Deleting…"
        onCancel={() => setConfirming(false)}
        onConfirm={async () => {
          try {
            await editActions().deleteItem(item.id);
          } catch (e) {
            // DestructiveConfirm shows the thrown message; make it the friendly one.
            throw new Error(translateError(e, "projects"));
          }
          toast("Item deleted.", "success");
          setConfirming(false);
          onChanged();
          onClose();
        }}
      />
    </>
  );
}
