"use client";

// WARP-3537 — the `?` sheet: every shortcut, drawn from the same registry the handler
// matches against (`shortcuts.ts`), so it cannot list a key that does nothing or leave
// out one that does. A reader is shown only the keys that work for them (brief §8).
//
// On this page `?` is the sheet's. Everywhere else in Droplet it opens Help, so the
// sheet says so — a person who presses it here and wonders where Help went is told.

import "./palette.css";
import { useId, type JSX } from "react";
import { Dialog } from "@/components/Dialog";
import { SHORTCUTS, type Shortcut } from "./shortcuts";

export function ShortcutSheet({ open, readOnly, onClose }: { open: boolean; readOnly: boolean; onClose: () => void }): JSX.Element | null {
  const titleId = useId();
  if (!open) return null;
  const visible = SHORTCUTS.filter((s) => !(readOnly && s.write));
  const groups: Array<Shortcut["group"]> = ["Anywhere", "In the table"];

  return (
    <Dialog open onClose={onClose} placement="center" maxWidth="md" labelledBy={titleId} flush>
      <div className="pm-scope pm-dialog-body">
        <h2 id={titleId} style={{ margin: "0 0 4px", fontSize: 18, fontWeight: 600 }}>
          Keyboard shortcuts
        </h2>
        <p style={{ margin: "0 0 16px", fontSize: 13, color: "var(--text-3)" }}>
          They pause while you are typing in a field. Elsewhere in Droplet, <kbd className="pm-kbd">?</kbd> opens Help.
        </p>
        {groups.map((g) => {
          const rows = visible.filter((s) => s.group === g);
          if (rows.length === 0) return null;
          return (
            <section key={g} aria-label={g} style={{ marginBottom: 14 }}>
              <div className="pm-pop-sect">{g}</div>
              <dl className="pm-keys">
                {rows.map((s) => (
                  <div key={s.id} className="pm-keys-row">
                    <dt>
                      {s.keys.map((k, i) => (
                        <span key={k}>
                          {i > 0 && <span className="pm-keys-or"> or </span>}
                          <kbd className="pm-kbd">{k}</kbd>
                        </span>
                      ))}
                    </dt>
                    <dd>{s.label}</dd>
                  </div>
                ))}
              </dl>
            </section>
          );
        })}
        <div className="pm-row" style={{ justifyContent: "flex-end", paddingTop: 12, borderTop: "1px solid var(--border)" }}>
          <button className="pm-btn" type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </Dialog>
  );
}
