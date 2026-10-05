// WARP-3537 — the Projects shortcut registry (brief §5.6).
//
// ONE list. The document handler (`useProjectShortcuts`) matches key presses
// against it and the `?` sheet draws it, so a shortcut cannot work without being
// listed or be listed without working — and the test that walks it is the test that
// "every shortcut is listed on the sheet".
//
// What is NOT in `match`: Enter and the arrow keys. They belong to the focused row
// of the table (its own `onKeyDown`), where the focus is, and are listed here only
// so the sheet tells the whole truth.
//
// Rules the handler holds, kept here because they are the contract:
//   • single keys are disabled while someone is typing — an input, a textarea, a
//     select, a contenteditable, the Tiptap editor — and while a modal is open;
//   • any other chord is left alone: Ctrl+C, Cmd+S and the shell's Alt+digit are the
//     browser's and the app's, not ours. ⌘K / Ctrl+K is the one chord we own;
//   • `?` is also Help's key everywhere else in the dashboard (HelpLauncher listens
//     on window). On this page the shortcut sheet takes it — see the handler.

export type ShortcutId =
  | "palette"
  | "create"
  | "search"
  | "help"
  | "next"
  | "prev"
  | "select"
  | "edit"
  | "assign"
  | "state"
  | "priority"
  | "clear"
  // Handled by the focused row, not the document:
  | "open"
  | "move";

export interface Shortcut {
  id: ShortcutId;
  /** How the keys read on the sheet. */
  keys: readonly string[];
  /** Sentence case, no exclamation marks (brief §6). */
  label: string;
  group: "Anywhere" | "In the table";
  /** Changes data, so a reader neither has nor is shown it. */
  write: boolean;
  /** For the ones the DOCUMENT owns; null for the ones the focused row owns. */
  match: ((e: KeyboardEvent) => boolean) | null;
}

const unmodified = (e: KeyboardEvent) => !e.ctrlKey && !e.metaKey && !e.altKey;
/** A single letter key, whatever the caps lock says, but not with Shift held (Shift+J is not j). */
const letter = (l: string) => (e: KeyboardEvent) =>
  unmodified(e) && !e.shiftKey && e.key.length === 1 && e.key.toLowerCase() === l;
const exact = (key: string) => (e: KeyboardEvent) => unmodified(e) && e.key === key;

export const SHORTCUTS: readonly Shortcut[] = [
  {
    id: "palette",
    keys: ["⌘ K", "Ctrl K"],
    label: "Open the command palette",
    group: "Anywhere",
    write: false,
    match: (e) => (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k",
  },
  { id: "create", keys: ["C"], label: "Create a work item in this project", group: "Anywhere", write: true, match: letter("c") },
  { id: "search", keys: ["/"], label: "Search work items", group: "Anywhere", write: false, match: exact("/") },
  { id: "help", keys: ["?"], label: "Show these shortcuts", group: "Anywhere", write: false, match: exact("?") },
  { id: "next", keys: ["J"], label: "Move to the next row", group: "In the table", write: false, match: letter("j") },
  { id: "prev", keys: ["K"], label: "Move to the previous row", group: "In the table", write: false, match: letter("k") },
  { id: "move", keys: ["↑", "↓"], label: "Move between rows", group: "In the table", write: false, match: null },
  { id: "open", keys: ["Enter"], label: "Open the row's details", group: "In the table", write: false, match: null },
  { id: "select", keys: ["X"], label: "Select or unselect the row", group: "In the table", write: false, match: letter("x") },
  { id: "edit", keys: ["E"], label: "Edit the row's title", group: "In the table", write: true, match: letter("e") },
  { id: "assign", keys: ["A"], label: "Change who it is assigned to", group: "In the table", write: true, match: letter("a") },
  { id: "state", keys: ["S"], label: "Change its state", group: "In the table", write: true, match: letter("s") },
  { id: "priority", keys: ["P"], label: "Change its priority", group: "In the table", write: true, match: letter("p") },
  { id: "clear", keys: ["Esc"], label: "Clear the selection", group: "In the table", write: false, match: exact("Escape") },
];

/** The shortcut a key press is, among the ones the document owns. */
export function shortcutFor(e: KeyboardEvent): Shortcut | null {
  for (const s of SHORTCUTS) if (s.match && s.match(e)) return s;
  return null;
}

/** Inputs that take no text: a click on one must not turn the next `j` into a typed letter. */
const NON_TEXT_INPUT = new Set(["checkbox", "radio", "button", "submit", "reset", "image", "file", "range", "color"]);

const RICH_TEXT = '[contenteditable]:not([contenteditable="false"]), .ProseMirror, .tiptap';

/** Is the key press someone TYPING — in an input, a textarea, a select, a contenteditable, the Tiptap
 *  editor, a combobox or a textbox — and not a shortcut? An ancestor counts: the text in a rich editor
 *  is a child of the editable element. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(RICH_TEXT)) return true;
  if (target.closest('[role="textbox"], [role="combobox"], [role="searchbox"]')) return true;
  const field = target.closest("input, textarea, select");
  if (!field) return false;
  if (field instanceof HTMLInputElement && NON_TEXT_INPUT.has(field.type)) return false;
  return true;
}

const OWNS_KEYS = '[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"]';

/**
 * Typing, OR inside a widget that keeps its own keys: an open menu (a state picker, whose
 * arrows walk its items) or a dialog (the filter popover, the drawer). Single-key shortcuts
 * and the table's row keys stand aside for both — `x` in a popover's checkbox must not
 * select a row behind it. A portal's key events bubble, through React, to the row the
 * menu was opened from; this is also what stops the row hearing them.
 */
export function ownsKeys(target: EventTarget | null): boolean {
  return isTypingTarget(target) || (target instanceof Element && target.closest(OWNS_KEYS) !== null);
}

/** A rich-text editor (contenteditable / Tiptap), where ⌘K is the editor's own — inserting a link — not ours. */
export function isRichTextTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(RICH_TEXT) !== null;
}
