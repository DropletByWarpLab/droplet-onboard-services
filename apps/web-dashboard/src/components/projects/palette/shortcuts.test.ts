/**
 * WARP-3537 — the shortcut registry: one list that the document handler matches
 * against AND the `?` sheet draws, so a shortcut cannot work without being listed
 * or be listed without working. And the rule for when a key is typing.
 */
import { describe, it, expect } from "vitest";
import { SHORTCUTS, isRichTextTarget, isTypingTarget, ownsKeys, shortcutFor, type ShortcutId } from "./shortcuts";

function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
}
const idFor = (e: KeyboardEvent): ShortcutId | null => shortcutFor(e)?.id ?? null;

describe("the registry", () => {
  it("has a unique id and at least one key label for every entry, sentence-case labels, no exclamation marks", () => {
    expect(new Set(SHORTCUTS.map((s) => s.id)).size).toBe(SHORTCUTS.length);
    for (const s of SHORTCUTS) {
      expect(s.keys.length).toBeGreaterThan(0);
      expect(s.label[0]).toBe(s.label[0].toUpperCase());
      expect(s.label).not.toMatch(/!/);
    }
  });

  it("lists the spec's shortcuts: c, /, j, k, x, e, a, s, p, ? — and the palette", () => {
    const labelled = SHORTCUTS.flatMap((s) => s.keys.map((k) => k.toLowerCase()));
    for (const k of ["c", "/", "j", "k", "x", "e", "a", "s", "p", "?"]) expect(labelled).toContain(k);
    expect(SHORTCUTS.some((s) => s.id === "palette")).toBe(true);
  });

  it("marks what writes, so a reader is not shown keys that do nothing for them", () => {
    const writes = SHORTCUTS.filter((s) => s.write).map((s) => s.id).sort();
    expect(writes).toEqual(["assign", "create", "edit", "priority", "state"]);
  });
});

describe("shortcutFor: what a key press means", () => {
  it.each([
    ["c", "create"],
    ["/", "search"],
    ["?", "help"],
    ["j", "next"],
    ["k", "prev"],
    ["x", "select"],
    ["e", "edit"],
    ["a", "assign"],
    ["s", "state"],
    ["p", "priority"],
    ["Escape", "clear"],
  ] as const)("%s is %s", (key, id) => {
    expect(idFor(press(key))).toBe(id);
  });

  it("reads a letter whatever the caps lock says", () => {
    expect(idFor(press("C"))).toBe("create");
    expect(idFor(press("J"))).toBe("next");
  });

  it("⌘K and Ctrl+K are the palette", () => {
    expect(idFor(press("k", { metaKey: true }))).toBe("palette");
    expect(idFor(press("k", { ctrlKey: true }))).toBe("palette");
    expect(idFor(press("K", { ctrlKey: true }))).toBe("palette");
  });

  it("a plain k is move-up, not the palette — the chord is what summons it", () => {
    expect(idFor(press("k"))).toBe("prev");
  });

  it("leaves every other modified key alone: the browser's and the shell's (Alt+digit) are not ours", () => {
    expect(idFor(press("c", { ctrlKey: true }))).toBeNull(); // copy
    expect(idFor(press("c", { metaKey: true }))).toBeNull();
    expect(idFor(press("a", { ctrlKey: true }))).toBeNull(); // select all
    expect(idFor(press("s", { metaKey: true }))).toBeNull(); // save
    expect(idFor(press("1", { altKey: true }))).toBeNull(); // WorkspaceShell's Alt+digit
    expect(idFor(press("e", { altKey: true }))).toBeNull();
    expect(idFor(press("k", { metaKey: true, shiftKey: true }))).toBeNull();
  });

  it("ignores shifted letters — Shift+J is not j", () => {
    expect(idFor(press("J", { shiftKey: true }))).toBeNull();
  });

  it("does not know keys it was never given", () => {
    expect(idFor(press("z"))).toBeNull();
    expect(idFor(press("Enter"))).toBeNull(); // the table's own, where the focus is
    expect(idFor(press("ArrowDown"))).toBeNull();
  });
});

function el(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return host.firstElementChild as HTMLElement;
}

describe("isTypingTarget: when a key is the person typing, not a shortcut", () => {
  it.each([
    ['<input type="text">'],
    ["<input>"],
    ['<input type="search">'],
    ['<input type="date">'],
    ["<textarea></textarea>"],
    ["<select><option>a</option></select>"],
    ['<div contenteditable="true"></div>'],
    ['<div contenteditable=""></div>'],
    ['<div role="textbox"></div>'],
    ['<div role="combobox"></div>'],
    ['<div class="ProseMirror"></div>'],
    ['<div class="tiptap"></div>'],
  ])("%s is typing", (html) => {
    expect(isTypingTarget(el(html))).toBe(true);
  });

  it("is typing for an element INSIDE one — the text in a rich editor is a child of the editable", () => {
    const host = el('<div contenteditable="true"><p><strong id="deep">x</strong></p></div>');
    expect(isTypingTarget(host.querySelector("#deep"))).toBe(true);
    const tip = el('<div class="tiptap ProseMirror"><p id="para">x</p></div>');
    expect(isTypingTarget(tip.querySelector("#para"))).toBe(true);
  });

  it.each([
    ['<input type="checkbox">'],
    ['<input type="radio">'],
    ['<input type="button">'],
    ["<button>b</button>"],
    ['<div role="row" tabindex="0"></div>'],
    ['<div contenteditable="false"></div>'],
    ["<div></div>"],
  ])("%s is not typing — a row's checkbox must not swallow the next j", (html) => {
    expect(isTypingTarget(el(html))).toBe(false);
  });

  it("is not typing for no target at all", () => {
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe("isRichTextTarget: where even ⌘K is the editor's (a link, in Tiptap)", () => {
  it("is a rich-text editor and a contenteditable, and not a plain input", () => {
    expect(isRichTextTarget(el('<div class="tiptap"></div>'))).toBe(true);
    expect(isRichTextTarget(el('<div contenteditable="true"></div>'))).toBe(true);
    expect(isRichTextTarget(el("<input>"))).toBe(false);
    expect(isRichTextTarget(el("<textarea></textarea>"))).toBe(false);
  });
});

describe("ownsKeys: typing, or inside a widget that keeps its own keys", () => {
  it("is everything typing is", () => {
    expect(ownsKeys(el("<input>"))).toBe(true);
    expect(ownsKeys(el('<div class="tiptap"></div>'))).toBe(true);
  });

  it("and anything inside an open menu, listbox or dialog — an `x` in a popover's checkbox is not 'select the row'", () => {
    const menu = el('<div role="menu"><button role="menuitem" id="m">go</button></div>');
    expect(ownsKeys(menu.querySelector("#m"))).toBe(true);
    const dialog = el('<div role="dialog"><label><input type="checkbox" id="c"></label></div>');
    expect(ownsKeys(dialog.querySelector("#c"))).toBe(true);
    const list = el('<div role="listbox"><div role="option" id="o">x</div></div>');
    expect(ownsKeys(list.querySelector("#o"))).toBe(true);
  });

  it("but not the page itself, a row, or a plain button", () => {
    expect(ownsKeys(document.body)).toBe(false);
    expect(ownsKeys(el('<div role="row" tabindex="0"></div>'))).toBe(false);
    expect(ownsKeys(el("<button>b</button>"))).toBe(false);
    expect(ownsKeys(null)).toBe(false);
  });
});
