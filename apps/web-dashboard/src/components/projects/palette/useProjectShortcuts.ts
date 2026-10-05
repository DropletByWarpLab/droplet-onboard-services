"use client";

// WARP-3537 — the document-level handler for the Projects shortcuts (brief §5.6).
//
// What it will not do, because each of these is a bug somebody would hit:
//   • act while someone is TYPING (an input, a textarea, a select, a contenteditable,
//     the Tiptap editor) — `c` in the search box must type a c;
//   • act while a modal is open (the drawer, New item, the palette, the sheet) — the
//     page behind a dialog is not the thing being worked on. The two toggles for our
//     own dialogs (⌘K, ?) are the exception, so they can close what they opened;
//   • touch a chord that is not ours — Ctrl+C, Cmd+S, the shell's Alt+digit
//     (`shortcuts.ts` `match` already refuses them);
//   • give a reader a write shortcut — hidden, not disabled-and-teasing (brief §8).
//
// `?` is Help's key across the dashboard: HelpLauncher listens for it on `window`.
// The sheet takes it on this page by handling it first, on `document`, and stopping
// it there — one `?`, one thing opens. Where this handler stands aside (typing,
// blocked) the event goes on to Help exactly as before. Esc is the one key that
// defers to an open popover, which closes itself on it.

import { useEffect, useRef } from "react";
import { isRichTextTarget, isTypingTarget, ownsKeys, shortcutFor, type ShortcutId } from "./shortcuts";

/** What a shortcut does. Returning `false` says "nothing here for that key" — it is then left to the
 *  browser (and to Help), as if it had never been ours. */
export type ShortcutActions = Partial<Record<Exclude<ShortcutId, "open" | "move">, () => void | boolean>>;

export interface UseProjectShortcutsArgs {
  /** False where there is no table / page to act on. */
  enabled: boolean;
  /** The page has its own modal up (the drawer, New item): nothing here acts, not even the toggles. */
  blocked: boolean;
  readOnly: boolean;
  actions: ShortcutActions;
}

export function useProjectShortcuts({ enabled, blocked, readOnly, actions }: UseProjectShortcutsArgs): void {
  const latest = useRef({ blocked, readOnly, actions });
  latest.current = { blocked, readOnly, actions };

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const s = shortcutFor(e);
      if (!s || s.id === "open" || s.id === "move") return;
      const { blocked: isBlocked, readOnly: isReader, actions: act } = latest.current;
      if (isBlocked) return;
      if (s.write && isReader) return;

      // ⌘K types nothing, so a plain input does not stop it — but a rich-text editor owns it (a link).
      // `?` is the sheet's own toggle, so it works from inside the sheet (a dialog) as well as from the
      // page: only real typing stops it. Every other key stands aside for typing AND for an open menu
      // or dialog, which keep their own keys.
      const stop =
        s.id === "palette" ? isRichTextTarget(e.target) : s.id === "help" ? isTypingTarget(e.target) : ownsKeys(e.target);
      if (stop) return;

      // Something modal is up: only our two dialog toggles act.
      if (document.querySelector('[aria-modal="true"]') && s.id !== "palette" && s.id !== "help") return;
      // A popover closes itself on Escape; the selection is not also cleared.
      if (s.id === "clear" && document.querySelector(".pm-pop")) return;

      const run = act[s.id as keyof ShortcutActions];
      if (!run) return;
      if (run() === false) return;
      e.preventDefault();
      // Stop it here: HelpLauncher's `?` is on window, and the sheet is the answer on this page.
      e.stopPropagation();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [enabled]);
}
