"use client";

// WARP-3522 — saved views in the project header (brief §3.9): the five built-in
// views, then this person's and the team's saved ones, then "+ Save view".
//
//   • Empty: with nothing saved, only the built-ins and "+ Save view" show — no
//     empty "Your views" heading.
//   • Save / rename / delete: saving asks for a short name; a saved chip has a
//     small menu (Rename, Delete). Delete is a quiet confirm in the menu, not the
//     destructive red dialog.
//   • The cap (12): past it "+ Save view" stays focusable but inert and says why
//     (`aria-disabled` + a tooltip — a truly `disabled` button can be neither
//     focused nor explained).
//   • A shared view is read-only to people who may not change it: no menu.
//
// Which views exist, what they hold and who may change them is the server's
// word (`canEdit`); this only draws it.

import { useId, useRef, useState, type JSX, type RefObject } from "react";
import { PM_VIEW_NAME_MAX } from "@droplet/shared-types";
import { Dialog } from "@/components/Dialog";
import { translateError } from "@/lib/friendly-errors";
import { PmIcon } from "./icons";
import { Popover } from "./FilterBar";

export interface ViewChipItem {
  id: string;
  name: string;
  scope: "BUILTIN" | "PERSONAL" | "SHARED";
  /** May the caller rename and delete it. */
  canEdit: boolean;
}

export const VIEW_LIMIT_NOTE = "You've reached the saved-view limit — delete one to add another.";

type ScopeChoice = "PERSONAL" | "SHARED";

// ── name dialog (save + rename) ─────────────────────────────────────────────

function NameDialog({
  mode,
  initialName,
  canShare,
  personalFull,
  sharedFull,
  triggerRef,
  onSubmit,
  onClose,
}: {
  mode: "create" | "rename";
  initialName: string;
  canShare: boolean;
  personalFull: boolean;
  sharedFull: boolean;
  triggerRef: RefObject<HTMLElement | null>;
  onSubmit: (input: { name: string; scope: ScopeChoice }) => Promise<void>;
  onClose: () => void;
}): JSX.Element {
  const titleId = useId();
  const [name, setName] = useState(initialName);
  const [scope, setScope] = useState<ScopeChoice>(personalFull && canShare && !sharedFull ? "SHARED" : "PERSONAL");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Give this view a name.");
      return;
    }
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ name: trimmed, scope });
      onClose();
    } catch (e) {
      // Inline, and the dialog stays open: a taken name is fixed by typing another.
      setError(translateError(e, "projects"));
      setBusy(false);
    }
  };

  const creating = mode === "create";
  return (
    <Dialog open onClose={onClose} triggerRef={triggerRef} placement="center" maxWidth="sm" labelledBy={titleId} flush>
      <form
        className="pm-scope pm-dialog-body"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2 id={titleId} style={{ margin: "0 0 16px", fontSize: 18, fontWeight: 600 }}>
          {creating ? "Save view" : "Rename view"}
        </h2>
        <div className="pm-field" style={{ marginBottom: 14 }}>
          <label htmlFor={titleId + "-name"}>Name</label>
          <input
            id={titleId + "-name"}
            className="pm-input"
            value={name}
            maxLength={PM_VIEW_NAME_MAX}
            placeholder="For example, My open bugs"
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? titleId + "-err" : undefined}
          />
          {error && (
            <div id={titleId + "-err"} role="alert" style={{ fontSize: 11.5, color: "var(--err)", marginTop: 4 }}>
              {error}
            </div>
          )}
        </div>
        {creating && canShare && (
          <fieldset className="pm-field" style={{ border: "none", padding: 0, margin: "0 0 14px" }}>
            <legend style={{ fontSize: 12, color: "var(--text-3)", fontWeight: 500, marginBottom: 5, padding: 0 }}>Who can see it</legend>
            <label className="pm-pop-row">
              <input type="radio" name={titleId + "-scope"} checked={scope === "PERSONAL"} disabled={personalFull} onChange={() => setScope("PERSONAL")} />
              <span>Only me{personalFull ? " (you have 12 already)" : ""}</span>
            </label>
            <label className="pm-pop-row">
              <input type="radio" name={titleId + "-scope"} checked={scope === "SHARED"} disabled={sharedFull} onChange={() => setScope("SHARED")} />
              <span>Everyone who can see this project{sharedFull ? " (12 already shared)" : ""}</span>
            </label>
          </fieldset>
        )}
        <div className="pm-row" style={{ justifyContent: "flex-end", gap: 8, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
          <button className="pm-btn" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="pm-btn primary" type="submit" disabled={busy}>
            {busy ? "Working…" : creating ? "Save view" : "Rename"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// ── one chip ────────────────────────────────────────────────────────────────

function ViewChip({
  item,
  active,
  count,
  onPick,
  onRename,
  onDelete,
}: {
  item: ViewChipItem;
  active: boolean;
  count: number | undefined;
  onPick: () => void;
  onRename: () => void;
  onDelete: () => Promise<void>;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const kebabRef = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    setConfirming(false);
  };

  return (
    <span className="pm-vchip pm-pop-anchor">
      <button type="button" className={"pm-chip" + (active ? " on" : "")} aria-current={active ? "true" : undefined} onClick={onPick}>
        {item.scope === "SHARED" && <PmIcon name="users" size={12} />}
        {item.name}
        {item.scope === "SHARED" && <span className="sr-only"> (shared)</span>}
        {count !== undefined && <span className="n">{count}</span>}
      </button>
      {item.canEdit && (
        <>
          <button
            ref={kebabRef}
            type="button"
            className="pm-iconbtn pm-vchip-k"
            aria-label={`Options for ${item.name}`}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => (open ? close() : setOpen(true))}
          >
            <PmIcon name="more" size={14} />
          </button>
          <Popover open={open} onClose={close} anchorRef={kebabRef} label={`Options for ${item.name}`} role="menu">
            {confirming ? (
              <div>
                <div className="pm-pop-sect" style={{ textTransform: "none", letterSpacing: 0 }}>
                  Delete “{item.name}”?
                </div>
                <div className="pm-pop-f">
                  <button type="button" className="pm-btn sm" onClick={close} disabled={busy}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="pm-btn primary sm"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await onDelete();
                      } finally {
                        setBusy(false);
                        close();
                      }
                    }}
                  >
                    {busy ? "Working…" : "Delete"}
                  </button>
                </div>
              </div>
            ) : (
              <ul className="pm-pop-menu">
                <li>
                  <button
                    type="button"
                    role="menuitem"
                    className="pm-pop-item"
                    onClick={() => {
                      close();
                      onRename();
                    }}
                  >
                    Rename
                  </button>
                </li>
                <li>
                  <button type="button" role="menuitem" className="pm-pop-item" onClick={() => setConfirming(true)}>
                    Delete
                  </button>
                </li>
              </ul>
            )}
          </Popover>
        </>
      )}
    </span>
  );
}

// ── the row ─────────────────────────────────────────────────────────────────

export interface ViewChipsProps {
  views: ViewChipItem[];
  /** The active view's id; `all` when there is none. */
  activeId: string;
  counts?: Record<string, number>;
  /** No right to save views here. */
  readOnly: boolean;
  /** May the caller create a SHARED view in this place. */
  canShare: boolean;
  personalFull: boolean;
  sharedFull: boolean;
  onPick: (id: string) => void;
  onSave: (input: { name: string; scope: ScopeChoice }) => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  /** The active view's filter (or layout) has been changed: offer to update it. */
  dirty?: { name: string; canUpdate: boolean; onUpdate: () => Promise<void>; onReset: () => void } | null;
}

export function ViewChips(p: ViewChipsProps): JSX.Element {
  const [dialog, setDialog] = useState<{ mode: "create" } | { mode: "rename"; id: string; name: string } | null>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const atCap = p.personalFull && (!p.canShare || p.sharedFull);
  const builtin = p.views.filter((v) => v.scope === "BUILTIN");
  const saved = p.views.filter((v) => v.scope !== "BUILTIN");

  const chip = (v: ViewChipItem) => (
    <ViewChip
      key={v.id}
      item={v}
      active={p.activeId === v.id}
      count={p.counts?.[v.id]}
      onPick={() => p.onPick(v.id)}
      onRename={() => setDialog({ mode: "rename", id: v.id, name: v.name })}
      onDelete={() => p.onDelete(v.id)}
    />
  );

  return (
    <>
    <div className="pm-row" style={{ gap: 8, flexWrap: "wrap" }} role="group" aria-label="Views">
      {builtin.map(chip)}
      {saved.length > 0 && <span className="pm-vsep" aria-hidden />}
      {saved.map(chip)}
      {!p.readOnly && (
        <button
          ref={saveRef}
          type="button"
          className="pm-chip pm-chip-add"
          aria-disabled={atCap ? true : undefined}
          title={atCap ? VIEW_LIMIT_NOTE : "Save the current filters as a view"}
          onClick={() => {
            if (!atCap) setDialog({ mode: "create" });
          }}
        >
          <PmIcon name="plus" size={12} />
          Save view
        </button>
      )}
      {dialog && (
        <NameDialog
          mode={dialog.mode}
          initialName={dialog.mode === "rename" ? dialog.name : ""}
          canShare={p.canShare}
          personalFull={p.personalFull}
          sharedFull={p.sharedFull}
          triggerRef={saveRef}
          onClose={() => setDialog(null)}
          onSubmit={(input) =>
            dialog.mode === "create" ? p.onSave(input) : p.onRename(dialog.id, input.name)
          }
        />
      )}
    </div>
    {p.dirty && (
      <ViewDirtyBar
        name={p.dirty.name}
        canUpdate={p.dirty.canUpdate}
        canSaveNew={!p.readOnly && !atCap}
        onUpdate={p.dirty.onUpdate}
        onSaveAsNew={() => setDialog({ mode: "create" })}
        onReset={p.dirty.onReset}
      />
    )}
    </>
  );
}

// ── "you've changed this view" ──────────────────────────────────────────────

/** Shown when the filter (or the layout) no longer matches the active view. */
export function ViewDirtyBar({
  name,
  canUpdate,
  canSaveNew,
  onUpdate,
  onSaveAsNew,
  onReset,
}: {
  name: string;
  /** May the caller overwrite the view. A shared view they cannot edit only offers "Save as new". */
  canUpdate: boolean;
  /** Not read-only, and not at the view limit. */
  canSaveNew: boolean;
  onUpdate: () => Promise<void>;
  onSaveAsNew: () => void;
  onReset: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  return (
    <div className="pm-note pm-row" role="status">
      <span>You&apos;ve changed “{name}”.</span>
      {canUpdate && (
        <button
          type="button"
          className="pm-btn primary sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onUpdate();
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Working…" : "Update view"}
        </button>
      )}
      {canSaveNew && (
        <button type="button" className="pm-btn sm" onClick={onSaveAsNew}>
          Save as new
        </button>
      )}
      <button type="button" className="pm-btn ghost sm" onClick={onReset}>
        Reset
      </button>
    </div>
  );
}
