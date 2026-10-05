"use client";

// WARP-3520 -- the project's archived items. Archiving hides an item from the
// board and list without deleting anything; this is where it is kept, and where a
// writer restores it. Hard delete is owner/admin only, asks for the item's key,
// and is offered here for the same reason it is in the item menu: an item that is
// already out of the way is the natural one to remove for good.

import { useId, useState, type JSX } from "react";
import { Dialog } from "@/components/Dialog";
import { DestructiveConfirm } from "@/components/DestructiveConfirm";
import { useToast } from "@/components/Toast";
import { translateError } from "@/lib/friendly-errors";
import { formatRelativeTime } from "@/lib/relative-time";
import { EmptyBlock, Skel } from "../bits";
import { TypeIcon } from "../TypeBits";
import { editActions, useArchivedItems } from "../useEditing";
import type { PmProject, PmWorkItem } from "../types";
import "./settings.css";

export function ArchivedItemsDialog({
  project,
  readOnly,
  canDelete,
  onClose,
  onItemsChanged,
}: {
  project: PmProject;
  readOnly: boolean;
  /** Owner / admin: may delete an archived item for good. */
  canDelete: boolean;
  onClose: () => void;
  /** An item came back to the board (or went for good): the board must refresh. */
  onItemsChanged: () => void;
}): JSX.Element {
  const titleId = useId();
  const { toast } = useToast();
  const { items, error, loadError, hasMore, total, mutate } = useArchivedItems(project.id, true);
  const partial = items !== undefined && Boolean(hasMore || loadError || (total !== undefined && items.length < total));
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<PmWorkItem | null>(null);

  const restore = async (item: PmWorkItem) => {
    setBusyId(item.id);
    try {
      await editActions().restoreItem(item.id);
      toast(`${item.key} is back on the board.`, "success");
      await mutate();
      onItemsChanged();
    } catch (e) {
      toast(translateError(e, "projects"), "error");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Dialog open onClose={onClose} placement="center" maxWidth="xl" labelledBy={titleId} flush>
      <div className="pm-scope pm-dialog-body">
        <div className="pm-set-head">
          <h2 id={titleId} style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>
            Archived items
          </h2>
        </div>

        <div className="pm-set-panel" style={{ minHeight: 120 }}>
          {error ? (
            <EmptyBlock
              icon="alert"
              tone="error"
              heading="Couldn't load archived items."
              body="Check the appliance connection and try again."
              cta={
                <button type="button" className="pm-btn ghost" onClick={() => void mutate().catch(() => undefined)}>
                  Try again
                </button>
              }
            />
          ) : items === undefined ? (
            <div aria-busy="true" aria-label="Loading archived items">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="pm-set-row" style={{ padding: "10px 2px" }}>
                  <Skel w={56} h={11} />
                  <Skel w="55%" h={12} />
                </div>
              ))}
            </div>
          ) : items.length === 0 && !partial ? (
            <EmptyBlock icon="archive" heading="Nothing is archived." body="Archived items are kept here until you restore or delete them." />
          ) : (
            <ul className="pm-set-list" aria-label="Archived items">
              {items.map((it) => (
                <li key={it.id} className="pm-set-item">
                  <div className="pm-set-row">
                    <TypeIcon type={it.type} />
                    <span className="pm-mono" style={{ fontSize: 11.5, color: "var(--text-4)", flex: "none" }}>
                      {it.key}
                    </span>
                    <span className="grow" style={{ fontSize: 13.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {it.name}
                    </span>
                    {it.archivedAt && (
                      <span style={{ fontSize: 11.5, color: "var(--text-4)", flex: "none" }}>
                        Archived {formatRelativeTime(it.archivedAt)}
                      </span>
                    )}
                    {!readOnly && (
                      <button
                        type="button"
                        className="pm-btn sm"
                        aria-label={`Restore ${it.key}`}
                        disabled={busyId === it.id}
                        onClick={() => void restore(it)}
                      >
                        Restore
                      </button>
                    )}
                    {canDelete && (
                      <button
                        type="button"
                        className="pm-btn ghost sm"
                        aria-label={`Delete ${it.key}`}
                        disabled={busyId === it.id}
                        onClick={() => setDeleting(it)}
                      >
                        Delete…
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {partial && items !== undefined && (
            <div className="pm-row" role="status" style={{ gap: 8, flexWrap: "wrap", marginTop: 12 }}>
              <span>{total === undefined ? `${items.length} archived items loaded.` : `Showing ${items.length} of ${total} archived items.`}</span>
              {loadError ? (
                <>
                  <span>Some archived items couldn't be loaded.</span>
                  <button type="button" className="pm-btn ghost sm" onClick={() => void mutate().catch(() => undefined)}>Try again</button>
                </>
              ) : hasMore ? <span>Loading more…</span> : (
                <button type="button" className="pm-btn ghost sm" onClick={() => void mutate().catch(() => undefined)}>Refresh incomplete list</button>
              )}
            </div>
          )}
        </div>

        <div className="pm-set-foot">
          <span />
          <button type="button" className="pm-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>

      <DestructiveConfirm
        open={deleting !== null}
        title="Delete this item?"
        consequence="This permanently deletes the item with its comments and history. It can't be undone."
        targetSummary={
          deleting ? (
            <span>
              <span className="pm-mono">{deleting.key}</span> · {deleting.name}
            </span>
          ) : undefined
        }
        confirmPhrase={deleting?.key ?? ""}
        confirmLabel="Delete item"
        busyLabel="Deleting…"
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await editActions().deleteItem(deleting.id);
          } catch (e) {
            throw new Error(translateError(e, "projects"));
          }
          toast("Item deleted.", "success");
          setDeleting(null);
          await mutate();
          onItemsChanged();
        }}
      />
    </Dialog>
  );
}
