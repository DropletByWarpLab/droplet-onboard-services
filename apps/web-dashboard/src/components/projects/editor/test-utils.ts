// Test helpers for the rich-text editor. jsdom has no layout engine and no
// real text input, so ProseMirror needs a few stand-ins; they live here (not in
// the global setup) because nothing else in the dashboard drives a contenteditable.

import { act } from "@testing-library/react";
import type { Editor } from "@tiptap/core";

const ZERO_RECT = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  width: 0,
  height: 0,
  toJSON: () => ({}),
} as DOMRect;

/** Stand-ins for the layout APIs jsdom leaves out. ProseMirror calls them while
 *  placing the caret (`coordsAtPos`), hit-testing and scrolling a typed
 *  character into view; the mention popup calls them to anchor itself. */
export function installJsdomPolyfills(): void {
  const rects = Object.assign([], { item: () => null }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => ZERO_RECT;
  Range.prototype.getClientRects ??= () => rects;
  document.elementFromPoint ??= () => null;
  Element.prototype.scrollIntoView ??= () => undefined;
  window.scrollTo = () => undefined;
  window.scrollBy = () => undefined;
}

/** Tiptap parks the editor on the view's DOM node, so a test can reach the
 *  instance from the accessible element it already has. */
export function editorOf(textbox: HTMLElement): Editor {
  const { editor } = textbox as HTMLElement & { editor?: Editor };
  if (!editor) throw new Error("not a Tiptap editing surface");
  return editor;
}

/** Type `text` at the caret one character at a time through ProseMirror's
 *  `handleTextInput` hook, the same entry point a real keystroke reaches (input
 *  rules and the mention trigger both hang off it). */
export function typeText(editor: Editor, text: string): void {
  act(() => {
    for (const char of text) {
      const { view } = editor;
      const { from, to } = view.state.selection;
      const handled = view.someProp("handleTextInput", (handler) =>
        handler(view, from, to, char, () => view.state.tr.insertText(char, from, to)),
      );
      if (!handled) view.dispatch(view.state.tr.insertText(char, from, to));
    }
  });
}
