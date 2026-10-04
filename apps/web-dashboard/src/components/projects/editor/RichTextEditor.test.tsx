// RichTextEditor — the shared Tiptap editor for work-item descriptions and
// comments (WARP-3519 / WS-2). ProseMirror runs for real in jsdom here; only the
// layout APIs jsdom lacks and real keystrokes are stood in for (see test-utils).

import { createRef, StrictMode, type ComponentProps } from "react";
import { renderToString } from "react-dom/server";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Editor } from "@tiptap/core";
import { computePosition } from "@floating-ui/dom";
import {
  RichTextEditor,
  type MentionCandidate,
  type RichTextEditorHandle,
} from "./RichTextEditor";
import { editorOf, installJsdomPolyfills, typeText } from "./test-utils";

// Spy on, but keep, the real positioning so the popup test can assert how it is placed.
vi.mock("@floating-ui/dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@floating-ui/dom")>();
  return { ...actual, computePosition: vi.fn(actual.computePosition) };
});

installJsdomPolyfills();

// Ranking for the query "an": Anna and Ana start with it (caller order), Dana only contains it.
const PEOPLE: MentionCandidate[] = [
  { id: "u1", name: "Anna Lee" },
  { id: "u2", name: "Ana Costa" },
  { id: "u3", name: "Dana Fox" },
  { id: "u4", name: "Bob Ray" },
];

type Props = Partial<ComponentProps<typeof RichTextEditor>>;

async function mount(props: Props = {}) {
  const ref = createRef<RichTextEditorHandle>();
  const label = props.ariaLabel ?? "Write a comment";
  const utils = render(
    <RichTextEditor ref={ref} ariaLabel="Write a comment" mentionCandidates={PEOPLE} {...props} />,
  );
  const box = await screen.findByRole("textbox", { name: label });
  return { ...utils, ref, box, editor: editorOf(box), handle: () => ref.current as RichTextEditorHandle };
}

// Tiptap's own `commands.focus` moves DOM focus on the next animation frame; the
// assertions below read focus straight away, so move it now as well.
const focusEditor = (editor: Editor) =>
  act(() => {
    editor.commands.focus("end");
    editor.view.focus();
  });
const selectAll = (editor: Editor) => act(() => void editor.commands.selectAll());
const select = (editor: Editor, from: number, to = from) =>
  act(() => void editor.commands.setTextSelection({ from, to }));
const button = (name: string) => screen.getByRole("button", { name });

/** Focus the editor, type `hi @<query>` and wait for the people list. */
async function openMentions(props: Props = {}, query = "an") {
  const m = await mount(props);
  focusEditor(m.editor);
  typeText(m.editor, `hi @${query}`);
  const listbox = await screen.findByRole("listbox", { name: "People" });
  return { ...m, listbox, options: within(listbox).getAllByRole("option") };
}

beforeEach(() => {
  vi.mocked(console.error).mockClear();
});

afterEach(() => {
  vi.mocked(computePosition).mockClear();
});

describe("RichTextEditor — surface", () => {
  it("is a labelled multiline textbox with the placeholder", async () => {
    const { box, container } = await mount({ ariaLabel: "Edit your comment", placeholder: "Say something" });
    expect(screen.getByRole("textbox", { name: "Edit your comment" })).toBe(box);
    expect(box).toHaveAttribute("aria-multiline", "true");
    expect(box).toHaveAttribute("contenteditable", "true");
    expect(container.querySelector("[data-placeholder]")).toHaveAttribute("data-placeholder", "Say something");
  });

  it("has a labelled toolbar with the eight formatting buttons, in order", async () => {
    await mount();
    const toolbar = screen.getByRole("toolbar", { name: "Text formatting" });
    const buttons = within(toolbar).getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Bold",
      "Italic",
      "Bulleted list",
      "Numbered list",
      "Link",
      "Inline code",
      "Code block",
      "Quote",
    ]);
    for (const b of buttons) expect(b).toHaveAttribute("type", "button");
  });

  it("renders on the server without creating an editor", () => {
    const html = renderToString(<RichTextEditor ariaLabel="Write a comment" mentionCandidates={PEOPLE} />);
    expect(html).toContain('role="toolbar"');
    expect(html).not.toContain('role="textbox"');
  });

  it("survives React strict mode (double mount) with a single editing surface", async () => {
    render(
      <StrictMode>
        <RichTextEditor ariaLabel="Write a comment" mentionCandidates={PEOPLE} />
      </StrictMode>,
    );
    await screen.findByRole("textbox", { name: "Write a comment" });
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
  });
});

describe("RichTextEditor — onChange", () => {
  it("reports each change with the html and whether the editor is empty", async () => {
    const onChange = vi.fn();
    const { editor, handle } = await mount({ onChange });
    expect(onChange).not.toHaveBeenCalled();

    typeText(editor, "hello");
    expect(onChange).toHaveBeenLastCalledWith({ html: "<p>hello</p>", isEmpty: false });

    act(() => handle().clear());
    expect(onChange).toHaveBeenLastCalledWith({ html: "<p></p>", isEmpty: true });
  });

  it("counts whitespace-only content as empty, the way the server does", async () => {
    const onChange = vi.fn();
    const { editor, handle } = await mount({ onChange });
    typeText(editor, "   ");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ isEmpty: true }));
    expect(handle().isEmpty()).toBe(true);
    typeText(editor, "x");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ isEmpty: false }));
    expect(handle().isEmpty()).toBe(false);
  });

  it("does not report the initial content, or a disabled toggle", async () => {
    const onChange = vi.fn();
    const { rerender } = await mount({ onChange, initialHtml: "<p>seed</p>" });
    rerender(
      <RichTextEditor ariaLabel="Write a comment" mentionCandidates={PEOPLE} onChange={onChange} initialHtml="<p>seed</p>" disabled />,
    );
    rerender(
      <RichTextEditor ariaLabel="Write a comment" mentionCandidates={PEOPLE} onChange={onChange} initialHtml="<p>seed</p>" />,
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("uses the latest onChange callback without re-creating the editor", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender, editor, box } = await mount({ onChange: first });
    rerender(<RichTextEditor ariaLabel="Write a comment" mentionCandidates={PEOPLE} onChange={second} />);
    typeText(editor, "x");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(editorOf(screen.getByRole("textbox"))).toBe(editor);
    expect(screen.getByRole("textbox")).toBe(box);
  });
});

describe("RichTextEditor — toolbar", () => {
  it("bold wraps the selection in <strong> and shows the mark as pressed", async () => {
    const { editor, handle } = await mount({ initialHtml: "<p>hello</p>" });
    const bold = button("Bold");
    expect(bold).toHaveAttribute("aria-pressed", "false");

    selectAll(editor);
    fireEvent.click(bold);
    expect(handle().getHTML()).toBe("<p><strong>hello</strong></p>");
    expect(bold).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(bold);
    expect(handle().getHTML()).toBe("<p>hello</p>");
    expect(bold).toHaveAttribute("aria-pressed", "false");
  });

  it.each([
    ["Italic", "<p><em>hello</em></p>"],
    ["Inline code", "<p><code>hello</code></p>"],
    ["Bulleted list", "<ul><li><p>hello</p></li></ul>"],
    ["Numbered list", "<ol><li><p>hello</p></li></ol>"],
    ["Code block", "<pre><code>hello</code></pre>"],
    ["Quote", "<blockquote><p>hello</p></blockquote>"],
  ])("%s produces only allowlisted markup", async (label, expected) => {
    const { editor, handle } = await mount({ initialHtml: "<p>hello</p>" });
    selectAll(editor);
    fireEvent.click(button(label));
    expect(handle().getHTML()).toBe(expected);
    expect(button(label)).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps the pressed state in step with the caret", async () => {
    const { editor } = await mount({ initialHtml: "<p><strong>bold</strong> plain</p>" });
    const bold = button("Bold");
    select(editor, 3); // inside "bold"
    expect(bold).toHaveAttribute("aria-pressed", "true");
    select(editor, 9); // inside "plain"
    expect(bold).toHaveAttribute("aria-pressed", "false");
  });

  it("does not take focus from the editing surface when a button is pressed", async () => {
    const { editor, box } = await mount({ initialHtml: "<p>hello</p>" });
    focusEditor(editor);
    expect(box).toHaveFocus();
    for (const name of ["Bold", "Italic", "Link"]) {
      // preventDefault on mousedown is what stops the browser moving focus to the button.
      expect(fireEvent.mouseDown(button(name))).toBe(false);
    }
    expect(box).toHaveFocus();
  });

  it("is a single tab stop that moves with the arrow keys", async () => {
    await mount();
    const buttons = within(screen.getByRole("toolbar", { name: "Text formatting" })).getAllByRole("button");
    expect(buttons.map((b) => b.tabIndex)).toEqual([0, -1, -1, -1, -1, -1, -1, -1]);

    act(() => buttons[0].focus());
    fireEvent.keyDown(buttons[0], { key: "ArrowRight" });
    expect(buttons[1]).toHaveFocus();
    expect(buttons.map((b) => b.tabIndex)).toEqual([-1, 0, -1, -1, -1, -1, -1, -1]);
    fireEvent.keyDown(buttons[1], { key: "ArrowLeft" });
    fireEvent.keyDown(buttons[0], { key: "ArrowLeft" });
    expect(buttons[7]).toHaveFocus();
    fireEvent.keyDown(buttons[7], { key: "Home" });
    expect(buttons[0]).toHaveFocus();
    fireEvent.keyDown(buttons[0], { key: "End" });
    expect(buttons[7]).toHaveFocus();
  });
});

describe("RichTextEditor — only allowlisted structures", () => {
  it("cannot make headings or rules from markdown shortcuts", async () => {
    const { editor, handle } = await mount();
    typeText(editor, "# Title");
    expect(handle().getHTML()).toBe("<p># Title</p>");
    act(() => handle().clear());
    typeText(editor, "---");
    expect(handle().getHTML()).toBe("<p>---</p>");
    for (const tag of ["<h1", "<h2", "<h3", "<hr"]) expect(handle().getHTML()).not.toContain(tag);
  });

  it("has no heading, rule, strike or underline in its schema, and their shortcuts do nothing", async () => {
    const { editor, box, handle } = await mount({ initialHtml: "<p>hello</p>" });
    expect(Object.keys(editor.schema.nodes)).not.toEqual(expect.arrayContaining(["heading"]));
    expect(Object.keys(editor.schema.nodes)).not.toContain("horizontalRule");
    expect(Object.keys(editor.schema.marks)).not.toContain("strike");
    expect(Object.keys(editor.schema.marks)).not.toContain("underline");

    selectAll(editor);
    fireEvent.keyDown(box, { key: "u", ctrlKey: true });
    fireEvent.keyDown(box, { key: "s", ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(box, { key: "1", ctrlKey: true, altKey: true });
    expect(handle().getHTML()).toBe("<p>hello</p>");
  });

  it("flattens disallowed markup in initial content to plain text", async () => {
    const { handle } = await mount({
      initialHtml:
        '<h2>Title</h2><p><s>gone</s> <u>line</u> <a href="javascript:x(1)">bad</a></p><hr><img src="x" onerror="x(1)">',
    });
    const html = handle().getHTML();
    for (const needle of ["<h", "<hr", "<s>", "<u>", "<img", "javascript", "onerror"]) {
      expect(html).not.toContain(needle);
    }
    expect(html).toContain("Title");
    expect(html).toContain("gone");
    expect(html).toContain("bad");
  });

  it("keeps only href on a link, whatever the source markup carried", async () => {
    const { handle } = await mount({
      initialHtml: '<p><a href="https://x.test/a" target="_blank" rel="nofollow" class="c" title="t">ok</a></p>',
    });
    expect(handle().getHTML()).toBe('<p><a href="https://x.test/a">ok</a></p>');
  });

  it("links a typed address on its own, but never a javascript: one", async () => {
    const { editor, handle } = await mount();
    typeText(editor, "see https://a.test/x now ");
    expect(handle().getHTML()).toBe('<p>see <a href="https://a.test/x">https://a.test/x</a> now </p>');
    act(() => handle().clear());
    typeText(editor, "run javascript:x(1) now ");
    expect(handle().getHTML()).not.toContain("<a");
  });

  it("links a bare domain to https", async () => {
    const { editor, handle } = await mount();
    typeText(editor, "go to example.com ");
    expect(handle().getHTML()).toContain('<a href="https://example.com">example.com</a>');
  });
});

describe("RichTextEditor — mentions", () => {
  it("opens a ranked, capped people list when @ is typed and exposes it to assistive tech", async () => {
    const { box, options, listbox } = await openMentions();
    expect(options.map((o) => o.textContent)).toEqual(["Anna Lee", "Ana Costa", "Dana Fox"]);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(options[1]).toHaveAttribute("aria-selected", "false");
    expect(box).toHaveAttribute("aria-expanded", "true");
    expect(box).toHaveAttribute("aria-controls", listbox.id);
    expect(box).toHaveAttribute("aria-activedescendant", options[0].id);
    expect(options[0].id).not.toBe("");
  });

  it("filters case-insensitively", async () => {
    const { options } = await openMentions({}, "AN");
    expect(options.map((o) => o.textContent)).toEqual(["Anna Lee", "Ana Costa", "Dana Fox"]);
  });

  it("shows at most eight people", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `a${i}`, name: `Alex ${i}` }));
    const { options } = await openMentions({ mentionCandidates: many }, "al");
    expect(options).toHaveLength(8);
  });

  it("moves with ArrowDown and ArrowUp, wrapping, and keeps aria-activedescendant current", async () => {
    const { box, options } = await openMentions();
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    expect(options[0]).toHaveAttribute("aria-selected", "false");
    expect(box).toHaveAttribute("aria-activedescendant", options[1].id);
    fireEvent.keyDown(box, { key: "ArrowUp" });
    fireEvent.keyDown(box, { key: "ArrowUp" });
    expect(options[2]).toHaveAttribute("aria-selected", "true");
    expect(box).toHaveAttribute("aria-activedescendant", options[2].id);
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(options[0]).toHaveAttribute("aria-selected", "true");
  });

  it("Enter inserts the chosen person as a bare mention span and never submits", async () => {
    const onSubmit = vi.fn();
    const { box, handle } = await openMentions({ onSubmit });
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(handle().getHTML()).toBe('<p>hi <span data-mention-id="u2">@Ana Costa</span> </p>');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(box).toHaveAttribute("aria-expanded", "false");
    expect(box).not.toHaveAttribute("aria-controls");
    expect(box).not.toHaveAttribute("aria-activedescendant");
    expect(box).toHaveFocus();
  });

  it("serialises a mention with exactly one attribute", async () => {
    const { box, container, handle } = await openMentions();
    fireEvent.keyDown(box, { key: "Enter" });
    const html = handle().getHTML();
    expect(html).toBe('<p>hi <span data-mention-id="u1">@Anna Lee</span> </p>');
    const span = new DOMParser().parseFromString(html, "text/html").querySelector("span");
    expect(span?.getAttributeNames()).toEqual(["data-mention-id"]);
    // …while the live editor shows the same chip for the shared styling to hit.
    expect(container.querySelector("span[data-mention-id='u1']")).toHaveTextContent("@Anna Lee");
  });

  it("Tab picks the highlighted person instead of moving focus", async () => {
    const { box, handle } = await openMentions();
    expect(fireEvent.keyDown(box, { key: "Tab" })).toBe(false); // default prevented: focus stays
    expect(handle().getHTML()).toContain('<span data-mention-id="u1">@Anna Lee</span>');
    expect(box).toHaveFocus();
  });

  it("Shift+Tab does not pick; it is left to the browser", async () => {
    const { box, handle } = await openMentions();
    expect(fireEvent.keyDown(box, { key: "Tab", shiftKey: true })).toBe(true);
    expect(handle().getHTML()).not.toContain("data-mention-id");
  });

  it("a click on a row inserts that person and leaves focus in the editor", async () => {
    const { box, listbox, handle } = await openMentions();
    const dana = within(listbox).getByRole("option", { name: "Dana Fox" });
    expect(fireEvent.mouseDown(dana)).toBe(false);
    fireEvent.click(dana);
    expect(handle().getHTML()).toBe('<p>hi <span data-mention-id="u3">@Dana Fox</span> </p>');
    expect(box).toHaveFocus();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("hovering a row highlights it", async () => {
    const { options, box } = await openMentions();
    fireEvent.mouseMove(options[2]);
    expect(options[2]).toHaveAttribute("aria-selected", "true");
    expect(box).toHaveAttribute("aria-activedescendant", options[2].id);
  });

  it("Escape closes the list only; a second Escape cancels, and neither reaches a dialog's window listener", async () => {
    const onCancel = vi.fn();
    const onWindowKey = vi.fn();
    window.addEventListener("keydown", onWindowKey);
    try {
      const { box } = await openMentions({ onCancel });
      fireEvent.keyDown(box, { key: "Escape" });
      expect(screen.queryByRole("listbox")).toBeNull();
      expect(box).toHaveAttribute("aria-expanded", "false");
      expect(onCancel).not.toHaveBeenCalled();
      expect(onWindowKey).not.toHaveBeenCalled();

      fireEvent.keyDown(box, { key: "Escape" });
      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(onWindowKey).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", onWindowKey);
    }
  });

  it("lets Escape through to the surrounding dialog when there is no onCancel", async () => {
    const onWindowKey = vi.fn();
    window.addEventListener("keydown", onWindowKey);
    try {
      const { box } = await mount();
      fireEvent.keyDown(box, { key: "Escape" });
      expect(onWindowKey).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("keydown", onWindowKey);
    }
  });

  it("says so, in one non-option line, when nobody matches", async () => {
    const { editor, box } = await mount();
    focusEditor(editor);
    typeText(editor, "hi @zzz");
    const note = await screen.findByText("No people match.");
    expect(note).toHaveAttribute("role", "status");
    expect(screen.queryByRole("option")).toBeNull();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(box).toHaveAttribute("aria-expanded", "false");
  });

  it("Enter with nobody to pick behaves like any Enter and closes the note", async () => {
    const { editor, box, handle } = await mount();
    focusEditor(editor);
    typeText(editor, "hi @zzz");
    await screen.findByText("No people match.");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(handle().getHTML()).not.toContain("data-mention-id");
    expect(screen.queryByText("No people match.")).toBeNull();
  });

  it("says people are unavailable when there is no directory, and still edits plain text", async () => {
    const { editor, handle } = await mount({ mentionCandidates: undefined });
    focusEditor(editor);
    typeText(editor, "hi @an");
    expect(await screen.findByText("People aren't available right now.")).toHaveAttribute("role", "status");
    expect(screen.queryByRole("option")).toBeNull();
    expect(handle().getHTML()).toBe("<p>hi @an</p>");
    fireEvent.click(button("Bold"));
    typeText(editor, "x");
    expect(handle().getHTML()).toContain("<strong>x</strong>");
  });

  it("treats an empty directory as nobody matching", async () => {
    const { editor } = await mount({ mentionCandidates: [] });
    focusEditor(editor);
    typeText(editor, "hi @an");
    expect(await screen.findByText("No people match.")).toBeInTheDocument();
  });

  it("fills the list in when the people arrive after the picker opened", async () => {
    const { editor, rerender } = await mount({ mentionCandidates: undefined });
    focusEditor(editor);
    typeText(editor, "hi @an");
    await screen.findByText("People aren't available right now.");
    rerender(<RichTextEditor ariaLabel="Write a comment" mentionCandidates={PEOPLE} />);
    const listbox = await screen.findByRole("listbox", { name: "People" });
    expect(within(listbox).getAllByRole("option")).toHaveLength(3);
    expect(screen.queryByText("People aren't available right now.")).toBeNull();
  });

  it("does not open in the middle of a word or inside a code block", async () => {
    const { editor, handle } = await mount();
    focusEditor(editor);
    typeText(editor, "mail a@an");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.queryByText("No people match.")).toBeNull();

    act(() => handle().clear());
    fireEvent.click(button("Code block"));
    typeText(editor, "@an");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("closes when the editor loses focus", async () => {
    const { box } = await openMentions();
    fireEvent.blur(box);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(box).toHaveAttribute("aria-expanded", "false");
  });

  it("is rendered inside the editor's own container, placed with flip and shift", async () => {
    const { box, listbox } = await openMentions();
    const wrapper = box.closest(".pm-rte") as HTMLElement;
    expect(wrapper).not.toBeNull();
    expect(wrapper).toContainElement(listbox);

    await waitFor(() => expect(computePosition).toHaveBeenCalled());
    const [, floating, options] = vi.mocked(computePosition).mock.calls.at(-1) as Parameters<typeof computePosition>;
    expect(wrapper).toContainElement(floating as HTMLElement);
    expect(options?.strategy).toBe("absolute");
    expect(options?.placement).toBe("bottom-start");
    expect(options?.middleware?.map((m) => m && m.name)).toEqual(
      expect.arrayContaining(["offset", "flip", "shift"]),
    );
    await waitFor(() => expect((floating as HTMLElement).dataset.ready).toBe("true"));
  });

  it("closes the picker and drops the position loop when the editor is disabled", async () => {
    const { rerender } = await openMentions();
    rerender(<RichTextEditor ariaLabel="Write a comment" mentionCandidates={PEOPLE} disabled />);
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  });
});

describe("RichTextEditor — keyboard", () => {
  it("Cmd/Ctrl+Enter submits and does not insert a line break", async () => {
    const onSubmit = vi.fn();
    const { editor, box, handle } = await mount({ onSubmit });
    typeText(editor, "hi");
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(handle().getHTML()).toBe("<p>hi</p>");
  });

  it("plain Enter never submits", async () => {
    const onSubmit = vi.fn();
    const { editor, box } = await mount({ onSubmit });
    typeText(editor, "hi");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("Cmd/Ctrl+Enter is an ordinary line break when nobody listens for submit", async () => {
    const { editor, box, handle } = await mount();
    typeText(editor, "hi");
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    expect(handle().getHTML()).toContain("<br>");
  });

  it("Escape with no list open calls onCancel and stops there", async () => {
    const onCancel = vi.fn();
    const onWindowKey = vi.fn();
    window.addEventListener("keydown", onWindowKey);
    try {
      const { box } = await mount({ onCancel });
      fireEvent.keyDown(box, { key: "Escape" });
      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(onWindowKey).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", onWindowKey);
    }
  });

  it("never traps Tab, not even in a list", async () => {
    const { editor, box, handle } = await mount({
      initialHtml: "<ul><li><p>one</p></li><li><p>two</p></li></ul>",
    });
    select(editor, 12); // inside the second item
    const before = handle().getHTML();
    expect(fireEvent.keyDown(box, { key: "Tab" })).toBe(true); // not default-prevented
    expect(fireEvent.keyDown(box, { key: "Tab", shiftKey: true })).toBe(true);
    expect(handle().getHTML()).toBe(before);
  });

  it("ignores Cmd/Ctrl+Enter while the editor is disabled", async () => {
    const onSubmit = vi.fn();
    const { box } = await mount({ onSubmit, disabled: true });
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("RichTextEditor — initial content", () => {
  it.each([
    '<p>Hi <span data-mention-id="u1">@Ana</span> there</p>',
    '<p><span data-mention-id="u1">@Ana</span> <span data-mention-id="u2">@Bob Ray</span></p>',
    '<p>a <strong>b</strong> <em>c</em> <code>d</code></p><ul><li><p>e</p></li></ul><ol><li><p>f</p></li></ol><blockquote><p>g</p></blockquote><pre><code>h</code></pre><p><a href="https://x.test/a?b=1">l</a></p>',
  ])("round-trips %s byte for byte", async (html) => {
    const { handle } = await mount({ initialHtml: html });
    expect(handle().getHTML()).toBe(html);
  });

  it("loads a mention span as a mention node", async () => {
    const { editor } = await mount({ initialHtml: '<p>Hi <span data-mention-id="u1">@Ana</span></p>' });
    const mention = editor.getJSON().content?.[0].content?.[1];
    expect(mention).toMatchObject({ type: "mention", attrs: { id: "u1", label: "Ana" } });
  });

  it("is uncontrolled after mount: a new initialHtml is ignored, a new key resets", async () => {
    const { rerender, ref, box } = await mount({ initialHtml: "<p>one</p>" });
    rerender(
      <RichTextEditor ref={ref} ariaLabel="Write a comment" mentionCandidates={PEOPLE} initialHtml="<p>two</p>" />,
    );
    expect(ref.current?.getHTML()).toBe("<p>one</p>");
    expect(box).toHaveTextContent("one");

    rerender(
      <RichTextEditor key="b" ref={ref} ariaLabel="Write a comment" mentionCandidates={PEOPLE} initialHtml="<p>two</p>" />,
    );
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Write a comment" })).toHaveTextContent("two"));
    expect(ref.current?.getHTML()).toBe("<p>two</p>");
  });
});

describe("RichTextEditor — link row", () => {
  async function withSelectedText() {
    const m = await mount({ initialHtml: "<p>hello</p>" });
    selectAll(m.editor);
    fireEvent.click(button("Link"));
    const input = screen.getByRole("textbox", { name: "Link address" });
    return { ...m, input };
  }

  it("opens an inline row with a labelled address field and the two actions", async () => {
    const { input } = await withSelectedText();
    expect(input).toHaveFocus();
    expect(button("Apply link")).toBeInTheDocument();
    expect(button("Remove link")).toBeInTheDocument();
    fireEvent.click(button("Link"));
    expect(screen.queryByRole("textbox", { name: "Link address" })).toBeNull();
  });

  it("applies a valid address to the selection and hands focus back to the editor", async () => {
    const { input, box, handle } = await withSelectedText();
    fireEvent.change(input, { target: { value: "https://example.com/docs" } });
    fireEvent.click(button("Apply link"));
    expect(handle().getHTML()).toBe('<p><a href="https://example.com/docs">hello</a></p>');
    expect(screen.queryByRole("textbox", { name: "Link address" })).toBeNull();
    expect(box).toHaveFocus();
  });

  it("applies on Enter without submitting anything around the editor", async () => {
    const onSubmit = vi.fn();
    const { input, handle } = await (async () => {
      const m = await mount({ initialHtml: "<p>hello</p>", onSubmit });
      selectAll(m.editor);
      fireEvent.click(button("Link"));
      return { ...m, input: screen.getByRole("textbox", { name: "Link address" }) };
    })();
    fireEvent.change(input, { target: { value: "mailto:team@example.com" } });
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false); // default (implicit form submit) prevented
    expect(handle().getHTML()).toBe('<p><a href="mailto:team@example.com">hello</a></p>');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it.each(["javascript:x(1)", "example.com", "ftp://example.com", "https://"])(
    "rejects %s with the explanation and leaves the text alone",
    async (value) => {
      const { input, handle } = await withSelectedText();
      fireEvent.change(input, { target: { value } });
      fireEvent.click(button("Apply link"));
      expect(screen.getByRole("alert")).toHaveTextContent("Use a link that starts with http, https or mailto.");
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(input.getAttribute("aria-describedby")).toBe(screen.getByRole("alert").id);
      expect(handle().getHTML()).toBe("<p>hello</p>");
      // The row stays open so the address can be fixed, and typing clears the complaint.
      fireEvent.change(input, { target: { value: "https://example.com" } });
      expect(screen.queryByRole("alert")).toBeNull();
    },
  );

  it("shows the current address for a link under the caret and removes it", async () => {
    const { editor, handle } = await mount({ initialHtml: '<p><a href="https://x.test">go</a> there</p>' });
    select(editor, 2);
    expect(button("Link")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(button("Link"));
    expect(screen.getByRole("textbox", { name: "Link address" })).toHaveValue("https://x.test");
    fireEvent.click(button("Remove link"));
    expect(handle().getHTML()).toBe("<p>go there</p>");
    expect(screen.queryByRole("textbox", { name: "Link address" })).toBeNull();
  });

  it("changes the address of the link under the caret", async () => {
    const { editor, handle } = await mount({ initialHtml: '<p><a href="https://x.test">go</a> there</p>' });
    select(editor, 2);
    fireEvent.click(button("Link"));
    fireEvent.change(screen.getByRole("textbox", { name: "Link address" }), { target: { value: "https://y.test" } });
    fireEvent.click(button("Apply link"));
    expect(handle().getHTML()).toBe('<p><a href="https://y.test">go</a> there</p>');
  });

  it("inserts the address itself, linked, when nothing is selected", async () => {
    const { editor, handle } = await mount();
    focusEditor(editor);
    fireEvent.click(button("Link"));
    fireEvent.change(screen.getByRole("textbox", { name: "Link address" }), { target: { value: "https://example.com" } });
    fireEvent.click(button("Apply link"));
    expect(handle().getHTML()).toBe('<p><a href="https://example.com">https://example.com</a></p>');
  });

  it("only offers to remove a link that is there", async () => {
    await withSelectedText();
    expect(button("Remove link")).toBeDisabled();
  });

  it("Escape closes the row and returns focus to the editor, without cancelling anything", async () => {
    const onCancel = vi.fn();
    const onWindowKey = vi.fn();
    window.addEventListener("keydown", onWindowKey);
    try {
      const { editor, box } = await mount({ initialHtml: "<p>hello</p>", onCancel });
      selectAll(editor);
      fireEvent.click(button("Link"));
      const input = screen.getByRole("textbox", { name: "Link address" });
      fireEvent.keyDown(input, { key: "Escape" });
      expect(screen.queryByRole("textbox", { name: "Link address" })).toBeNull();
      expect(box).toHaveFocus();
      expect(onCancel).not.toHaveBeenCalled();
      expect(onWindowKey).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", onWindowKey);
    }
  });

  it("closes when the editor becomes disabled", async () => {
    const { rerender } = await withSelectedText();
    rerender(<RichTextEditor ariaLabel="Write a comment" mentionCandidates={PEOPLE} initialHtml="<p>hello</p>" disabled />);
    expect(screen.queryByRole("textbox", { name: "Link address" })).toBeNull();
  });
});

describe("RichTextEditor — disabled", () => {
  it("is not editable, announces itself as disabled, and disables the toolbar", async () => {
    const { box, rerender } = await mount({ disabled: true, initialHtml: "<p>x</p>" });
    expect(box).toHaveAttribute("contenteditable", "false");
    expect(box).toHaveAttribute("aria-disabled", "true");
    expect(box).not.toHaveAttribute("tabindex");
    for (const b of within(screen.getByRole("toolbar")).getAllByRole("button")) expect(b).toBeDisabled();

    rerender(<RichTextEditor ariaLabel="Write a comment" mentionCandidates={PEOPLE} initialHtml="<p>x</p>" />);
    expect(box).toHaveAttribute("contenteditable", "true");
    expect(box).not.toHaveAttribute("aria-disabled");
    for (const b of within(screen.getByRole("toolbar")).getAllByRole("button")) expect(b).toBeEnabled();
  });

  it("still shows the placeholder", async () => {
    const { container } = await mount({ disabled: true, placeholder: "Write a comment" });
    expect(container.querySelector("[data-placeholder]")).not.toBeNull();
  });
});

describe("RichTextEditor — imperative handle", () => {
  it("focuses, clears, reads html and reports emptiness", async () => {
    const onChange = vi.fn();
    const { box, handle, editor } = await mount({ onChange, initialHtml: "<p>seed</p>" });
    expect(handle().isEmpty()).toBe(false);
    expect(handle().getHTML()).toBe("<p>seed</p>");

    act(() => handle().focus());
    expect(box).toHaveFocus();
    // The caret goes to the end, where a person editing an old comment expects it.
    expect(editor.state.selection.from).toBe(5);

    act(() => handle().clear());
    expect(handle().isEmpty()).toBe(true);
    expect(handle().getHTML()).toBe("<p></p>");
    expect(onChange).toHaveBeenLastCalledWith({ html: "<p></p>", isEmpty: true });
  });

  it("leaves the caret where it is when it already has focus", async () => {
    const { handle, editor } = await mount({ initialHtml: "<p>seed</p>" });
    focusEditor(editor);
    select(editor, 2);
    act(() => handle().focus());
    expect(editor.state.selection.from).toBe(2);
  });

  it("works before the editor exists, answering from the initial content", () => {
    let early: { html: string; empty: boolean } | undefined;
    render(
      <RichTextEditor
        ref={(handle) => {
          if (handle && !early) {
            handle.focus();
            handle.clear();
            early = { html: handle.getHTML(), empty: handle.isEmpty() };
          }
        }}
        ariaLabel="Write a comment"
        mentionCandidates={PEOPLE}
        initialHtml="<p>seed</p>"
      />,
    );
    expect(early).toEqual({ html: "<p>seed</p>", empty: false });
  });

  it("answers 'empty' before mount when there is no initial content", () => {
    let early: { html: string; empty: boolean } | undefined;
    render(
      <RichTextEditor
        ref={(handle) => {
          if (handle && !early) early = { html: handle.getHTML(), empty: handle.isEmpty() };
        }}
        ariaLabel="Write a comment"
        mentionCandidates={PEOPLE}
      />,
    );
    expect(early).toEqual({ html: "", empty: true });
  });
});

describe("RichTextEditor — lifecycle", () => {
  it("focuses itself when asked to, with the caret at the end", async () => {
    const { box, editor } = await mount({ autoFocus: true, initialHtml: "<p>seed</p>" });
    await waitFor(() => expect(box).toHaveFocus());
    expect(editor.state.selection.from).toBe(5);
  });

  it("destroys the editor on unmount and leaves no scroll/resize listeners behind", async () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    try {
      const { editor, unmount } = await openMentions();
      await waitFor(() => expect(computePosition).toHaveBeenCalled());
      const watched = (type: string) => type === "scroll" || type === "resize";
      expect(add.mock.calls.filter(([type]) => watched(type)).length).toBeGreaterThan(0);

      unmount();
      await waitFor(() => expect(editor.isDestroyed).toBe(true));

      for (const [type, listener] of add.mock.calls.filter(([t]) => watched(t))) {
        expect(remove.mock.calls.some(([t, l]) => t === type && l === listener)).toBe(true);
      }
      expect(console.error).not.toHaveBeenCalled();
    } finally {
      add.mockRestore();
      remove.mockRestore();
    }
  });

  it("raises no React warnings through a full mention-and-format session", async () => {
    const { editor, box, unmount } = await openMentions();
    fireEvent.keyDown(box, { key: "Enter" });
    typeText(editor, "done");
    fireEvent.click(button("Bold"));
    unmount();
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(console.error).not.toHaveBeenCalled();
  });
});
