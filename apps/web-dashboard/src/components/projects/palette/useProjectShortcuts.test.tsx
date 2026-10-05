/**
 * WARP-3537 — the document-level shortcut handler, as a person meets it: a key is
 * pressed somewhere on the page and something does or does not happen.
 *
 * The contract (brief §5.6 and the spec): every shortcut acts; none acts while
 * someone is typing (an input, a textarea, a select, a contenteditable, the Tiptap
 * editor) or while a modal is open; a reader gets no write shortcut; the keys of the
 * browser and the shell are left alone; and `?` — Help's key everywhere else — is
 * the shortcut sheet's here, without Help also opening.
 */
import { describe, it, expect, vi, afterEach, type Mock } from "vitest";
import { renderHook } from "@testing-library/react";
import { SHORTCUTS } from "./shortcuts";
import { useProjectShortcuts, type ShortcutActions } from "./useProjectShortcuts";

type ActionMock = Mock<() => boolean | void>;

function actions(): { [K in keyof ShortcutActions]-?: ActionMock } {
  return {
    palette: vi.fn<() => boolean | void>(),
    create: vi.fn<() => boolean | void>(),
    search: vi.fn<() => boolean | void>(),
    help: vi.fn<() => boolean | void>(),
    next: vi.fn<() => boolean | void>(),
    prev: vi.fn<() => boolean | void>(),
    select: vi.fn<() => boolean | void>(),
    edit: vi.fn<() => boolean | void>(),
    assign: vi.fn<() => boolean | void>(),
    state: vi.fn<() => boolean | void>(),
    priority: vi.fn<() => boolean | void>(),
    clear: vi.fn<() => boolean | void>(),
  };
}

type Opts = { enabled?: boolean; blocked?: boolean; readOnly?: boolean };
function mount(a: ReturnType<typeof actions>, o: Opts = {}) {
  return renderHook(() =>
    useProjectShortcuts({ enabled: o.enabled ?? true, blocked: o.blocked ?? false, readOnly: o.readOnly ?? false, actions: a }),
  );
}

/** Press a key at `target` (or the body), the way a browser delivers it: bubbling up to the document. */
function press(key: string, init: KeyboardEventInit = {}, target: Element = document.body): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

function add<T extends HTMLElement>(html: string): T {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return host.firstElementChild as T;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("every shortcut acts", () => {
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
  ] as const)("%s runs %s, once, and takes the key from the browser", (key, id) => {
    const a = actions();
    mount(a);
    const e = press(key);
    expect(a[id]).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
    for (const [other, fn] of Object.entries(a)) if (other !== id) expect(fn).not.toHaveBeenCalled();
  });

  it("⌘K and Ctrl+K open the palette", () => {
    const a = actions();
    mount(a);
    press("k", { metaKey: true });
    press("k", { ctrlKey: true });
    expect(a.palette).toHaveBeenCalledTimes(2);
    expect(a.prev).not.toHaveBeenCalled();
  });

  it("the registry and the handler agree: every key the registry says the document owns, the handler runs", () => {
    const a = actions();
    mount(a);
    const owned = SHORTCUTS.filter((s) => s.match !== null);
    for (const s of owned) {
      const key = s.id === "palette" ? "k" : s.id === "clear" ? "Escape" : s.keys[0].toLowerCase();
      press(key, s.id === "palette" ? { ctrlKey: true } : {});
      expect(a[s.id as keyof typeof a], s.id).toHaveBeenCalled();
    }
  });
});

describe("not while someone is typing", () => {
  it.each([
    ["an input", '<input type="text">'],
    ["a search box", '<input type="search">'],
    ["a textarea", "<textarea></textarea>"],
    ["a select", "<select><option>a</option></select>"],
    ["a contenteditable region", '<div contenteditable="true"></div>'],
    ["the Tiptap editor", '<div class="tiptap ProseMirror"><p>hello</p></div>'],
  ])("%s swallows every single-key shortcut", (_name, html) => {
    const a = actions();
    mount(a);
    const field = add(html);
    for (const key of ["c", "/", "?", "j", "k", "x", "e", "a", "s", "p", "Escape"]) {
      const e = press(key, {}, field);
      expect(e.defaultPrevented, key).toBe(false);
    }
    for (const fn of Object.values(a)) expect(fn).not.toHaveBeenCalled();
  });

  it("an element inside the Tiptap editor counts as typing", () => {
    const a = actions();
    mount(a);
    const host = add('<div class="tiptap ProseMirror"><p id="para">hello</p></div>');
    press("c", {}, host.querySelector("#para")!);
    expect(a.create).not.toHaveBeenCalled();
  });

  it("⌘K still opens the palette from a plain input — it types nothing — but not from the rich-text editor, where it is the editor's", () => {
    const a = actions();
    mount(a);
    press("k", { metaKey: true }, add("<input>"));
    expect(a.palette).toHaveBeenCalledTimes(1);
    press("k", { metaKey: true }, add('<div class="tiptap ProseMirror"></div>'));
    press("k", { ctrlKey: true }, add('<div contenteditable="true"></div>'));
    expect(a.palette).toHaveBeenCalledTimes(1);
  });

  it("an open menu or popover keeps its own keys: x in its checkbox is not 'select the row'", () => {
    const a = actions();
    mount(a);
    const menu = add('<div role="menu"><button role="menuitem" id="m">go</button></div>');
    const popover = add('<div class="pm-pop" role="dialog"><label><input type="checkbox" id="c"></label></div>');
    for (const key of ["x", "j", "s", "p", "c"]) {
      press(key, {}, menu.querySelector("#m")!);
      press(key, {}, popover.querySelector("#c")!);
    }
    for (const fn of Object.values(a)) expect(fn).not.toHaveBeenCalled();
  });

  it("a focused checkbox is not typing: after clicking a row's box, j still moves", () => {
    const a = actions();
    mount(a);
    press("j", {}, add('<input type="checkbox">'));
    expect(a.next).toHaveBeenCalledTimes(1);
  });

  it("a focused button is not typing either", () => {
    const a = actions();
    mount(a);
    press("x", {}, add("<button>Open</button>"));
    expect(a.select).toHaveBeenCalledTimes(1);
  });
});

describe("an action that has nothing to do", () => {
  it("leaves the key to the browser — and to Help — by returning false", () => {
    const a = actions();
    a.search.mockReturnValue(false);
    a.help.mockReturnValue(false);
    mount(a);
    const heard: string[] = [];
    const listen = (e: KeyboardEvent) => heard.push(e.key);
    window.addEventListener("keydown", listen);
    expect(press("/").defaultPrevented).toBe(false);
    expect(press("?").defaultPrevented).toBe(false);
    window.removeEventListener("keydown", listen);
    expect(a.search).toHaveBeenCalled();
    // Neither was taken: both went on to whoever else listens (Help, for the `?`).
    expect(heard).toEqual(["/", "?"]);
  });
});

describe("not for the browser's and the shell's keys", () => {
  it("leaves Ctrl+C, Cmd+S, Ctrl+A and Alt+digit alone", () => {
    const a = actions();
    mount(a);
    for (const [key, init] of [
      ["c", { ctrlKey: true }],
      ["c", { metaKey: true }],
      ["s", { metaKey: true }],
      ["a", { ctrlKey: true }],
      ["1", { altKey: true }],
      ["e", { altKey: true }],
    ] as Array<[string, KeyboardEventInit]>) {
      expect(press(key, init).defaultPrevented, `${key} ${JSON.stringify(init)}`).toBe(false);
    }
    for (const fn of Object.values(a)) expect(fn).not.toHaveBeenCalled();
  });
});

describe("a reader", () => {
  it("has the reading shortcuts and not the writing ones", () => {
    const a = actions();
    mount(a, { readOnly: true });
    for (const key of ["c", "e", "a", "s", "p"]) {
      expect(press(key).defaultPrevented, key).toBe(false);
    }
    expect(a.create).not.toHaveBeenCalled();
    expect(a.edit).not.toHaveBeenCalled();
    expect(a.assign).not.toHaveBeenCalled();
    expect(a.state).not.toHaveBeenCalled();
    expect(a.priority).not.toHaveBeenCalled();

    for (const key of ["/", "?", "j", "k", "x", "Escape"]) press(key);
    press("k", { ctrlKey: true });
    expect(a.search).toHaveBeenCalled();
    expect(a.help).toHaveBeenCalled();
    expect(a.next).toHaveBeenCalled();
    expect(a.prev).toHaveBeenCalled();
    expect(a.select).toHaveBeenCalled();
    expect(a.palette).toHaveBeenCalled();
  });
});

describe("when it is off or something else owns the screen", () => {
  it("does nothing when disabled", () => {
    const a = actions();
    mount(a, { enabled: false });
    press("c");
    press("k", { metaKey: true });
    for (const fn of Object.values(a)) expect(fn).not.toHaveBeenCalled();
  });

  it("does nothing while the page says it is blocked (the drawer or a dialog is open)", () => {
    const a = actions();
    mount(a, { blocked: true });
    for (const key of ["c", "j", "?", "/"]) press(key);
    press("k", { metaKey: true });
    for (const fn of Object.values(a)) expect(fn).not.toHaveBeenCalled();
  });

  it("while a modal is open only the two that toggle our own dialogs act — ⌘K and ?", () => {
    const a = actions();
    mount(a);
    add('<div role="dialog" aria-modal="true"><button>ok</button></div>');
    for (const key of ["c", "j", "x", "e", "/", "Escape"]) press(key);
    expect(a.create).not.toHaveBeenCalled();
    expect(a.next).not.toHaveBeenCalled();
    expect(a.select).not.toHaveBeenCalled();
    expect(a.search).not.toHaveBeenCalled();
    expect(a.clear).not.toHaveBeenCalled();
    press("?");
    press("k", { metaKey: true });
    expect(a.help).toHaveBeenCalledTimes(1);
    expect(a.palette).toHaveBeenCalledTimes(1);
  });

  it("? still closes the sheet from inside it — focus is in a dialog, but only real typing stops the toggle", () => {
    const a = actions();
    mount(a);
    const sheet = add('<div role="dialog" aria-modal="true"><button id="close">close</button></div>');
    press("?", {}, sheet.querySelector("#close")!);
    expect(a.help).toHaveBeenCalledTimes(1);
  });

  it("⌘K closes the palette from inside it, input and all", () => {
    const a = actions();
    mount(a);
    const palette = add('<div role="dialog" aria-modal="true"><input id="q"></div>');
    press("k", { metaKey: true }, palette.querySelector("#q")!);
    expect(a.palette).toHaveBeenCalledTimes(1);
  });

  it("Escape does not clear the selection while a popover is open — it closes the popover", () => {
    const a = actions();
    mount(a);
    add('<div class="pm-pop" role="dialog"></div>');
    press("Escape");
    expect(a.clear).not.toHaveBeenCalled();
  });

  it("stops listening when it unmounts", () => {
    const a = actions();
    const { unmount } = mount(a);
    unmount();
    press("c");
    expect(a.create).not.toHaveBeenCalled();
  });
});

describe("? — Help's key everywhere else in the dashboard", () => {
  it("is the shortcut sheet's here: Help (a window listener, like HelpLauncher) does not also open", () => {
    const a = actions();
    mount(a);
    const help = vi.fn();
    window.addEventListener("keydown", help);
    press("?");
    window.removeEventListener("keydown", help);
    expect(a.help).toHaveBeenCalledTimes(1);
    expect(help).not.toHaveBeenCalled();
  });

  it("is Help's again whenever the sheet is not taking it: typing in an input, or blocked", () => {
    const a = actions();
    const { rerender } = renderHook((p: { blocked: boolean }) =>
      useProjectShortcuts({ enabled: true, blocked: p.blocked, readOnly: false, actions: a }),
      { initialProps: { blocked: false } },
    );
    const help = vi.fn();
    window.addEventListener("keydown", help);
    press("?", {}, add("<input>"));
    expect(help).toHaveBeenCalledTimes(1);
    rerender({ blocked: true });
    press("?");
    expect(help).toHaveBeenCalledTimes(2);
    window.removeEventListener("keydown", help);
    expect(a.help).not.toHaveBeenCalled();
  });
});
