"use client";

// The shared rich-text editor for work-item comments (WARP-3519 / WS-2) — and,
// in a later slice, descriptions. Tiptap over ProseMirror, per ADR-026 and the
// design brief §4.3.
//
// What it emits is HTML the SERVER then sanitizes (orchestrator
// `sanitizePmHtml`), and the server's allowlist is the contract: the editor is
// configured so it can only PRODUCE allowlisted structures —
//   p br strong em ul ol li a[href] code pre blockquote  and
//   <span data-mention-id="<User.id>">@Name</span>
// — rather than producing more and relying on the sanitizer to strip it. A
// heading, rule, strike or underline cannot be typed, pasted or shortcut in.
//
// It is UNCONTROLLED after mount: `initialHtml` seeds it and a parent that wants
// a different document remounts it with a new `key`. A controlled rich-text
// value needs a document diff on every keystroke; nothing here wants one.

import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Mention from "@tiptap/extension-mention";
import { Placeholder } from "@tiptap/extension-placeholder";
import { ListItem } from "@tiptap/extension-list";
import { autoUpdate, computePosition, flip, offset, shift } from "@floating-ui/dom";
import { Bold, Code, Italic, Link2, List, ListOrdered, Quote, SquareCode } from "lucide-react";
import { PM_MENTION_ATTR } from "@droplet/shared-types";
import "./editor.css";
import {
  hasAllowedLinkScheme,
  isBlankHtml,
  isEditorEmpty,
  matchMentionCandidates,
  parseLinkInput,
  type MentionCandidate,
} from "./helpers";

export type { MentionCandidate } from "./helpers";

export interface RichTextEditorHandle {
  focus(): void;
  clear(): void;
  getHTML(): string;
  isEmpty(): boolean;
}

export interface RichTextEditorProps {
  /** Accessible name of the editing surface. */
  ariaLabel: string;
  placeholder?: string;
  /** Seeds the document once, at mount. Remount with a new `key` to reset. */
  initialHtml?: string;
  /** Who `@` offers. `undefined` = the people list is not available. */
  mentionCandidates: readonly MentionCandidate[] | undefined;
  onChange?: (state: { html: string; isEmpty: boolean }) => void;
  /** Cmd/Ctrl+Enter. Without it that chord is an ordinary line break. */
  onSubmit?: () => void;
  /** Escape, when no list or row is open to close first. */
  onCancel?: () => void;
  disabled?: boolean;
  autoFocus?: boolean;
}

// ── schema ───────────────────────────────────────────────────────────────────

/**
 * The list item with Enter and nothing else. Tiptap's own binds Tab and
 * Shift-Tab to indent / outdent, which makes a list a keyboard trap: Tab is how
 * a person leaves the editor and reaches Send.
 */
const PlainListItem = ListItem.extend({
  addKeyboardShortcuts() {
    return { Enter: () => this.editor.commands.splitListItem(this.name) };
  },
});

/**
 * The link mark with `href` and nothing else. Tiptap's default attribute set
 * (target, rel, class) is READ BACK from whatever markup is loaded or pasted, so
 * a pasted `<a target="_blank" rel="nofollow">` would carry both into the output;
 * the server keeps only `href` anyway, and the editor should not say otherwise.
 * Typed addresses still autolink, to https by default, and a scheme outside
 * http / https / mailto is never a link (`isAllowedUri`).
 */
const PlainLink = Link.extend({
  addAttributes() {
    return { href: { default: null, parseHTML: (el: HTMLElement) => el.getAttribute("href") } };
  },
}).configure({
  openOnClick: false,
  autolink: true,
  linkOnPaste: true,
  defaultProtocol: "https",
  // `configure` MERGES, so `{}` would keep Tiptap's target/rel defaults; null removes them.
  HTMLAttributes: { target: null, rel: null, class: null },
  isAllowedUri: (url) => hasAllowedLinkScheme(url),
});

/**
 * Tiptap's mention node, re-spelled to the one shape the server reads:
 * `<span data-mention-id="<User.id>">@Name</span>` — no `data-type`, `data-id`,
 * `data-label` or class, because the sanitizer keeps exactly one attribute and
 * the server parses mentions out of exactly that.
 */
const MentionChip = Mention.extend({
  addAttributes() {
    return {
      id: {
        default: null,
        rendered: false,
        parseHTML: (el: HTMLElement) => el.getAttribute(PM_MENTION_ATTR),
      },
      label: {
        default: null,
        rendered: false,
        parseHTML: (el: HTMLElement) => (el.textContent ?? "").replace(/^@/, "") || null,
      },
      mentionSuggestionChar: { default: "@", rendered: false },
    };
  },
  parseHTML() {
    return [{ tag: `span[${PM_MENTION_ATTR}]` }];
  },
  renderHTML({ node }) {
    return [
      "span",
      { [PM_MENTION_ATTR]: String(node.attrs.id) },
      `@${node.attrs.label ?? node.attrs.id}`,
    ];
  },
});

interface Suggest {
  query: string;
  command: (item: { id: string; label: string }) => void;
  clientRect: (() => DOMRect | null) | null;
}

// ── toolbar ──────────────────────────────────────────────────────────────────

type ToolId = "bold" | "italic" | "bulletList" | "orderedList" | "link" | "code" | "codeBlock" | "blockquote";

const TOOLS: ReadonlyArray<{ id: ToolId; label: string; icon: ReactNode }> = [
  { id: "bold", label: "Bold", icon: <Bold size={15} aria-hidden /> },
  { id: "italic", label: "Italic", icon: <Italic size={15} aria-hidden /> },
  { id: "bulletList", label: "Bulleted list", icon: <List size={15} aria-hidden /> },
  { id: "orderedList", label: "Numbered list", icon: <ListOrdered size={15} aria-hidden /> },
  { id: "link", label: "Link", icon: <Link2 size={15} aria-hidden /> },
  { id: "code", label: "Inline code", icon: <Code size={15} aria-hidden /> },
  { id: "codeBlock", label: "Code block", icon: <SquareCode size={15} aria-hidden /> },
  { id: "blockquote", label: "Quote", icon: <Quote size={15} aria-hidden /> },
];

/** Focus the editing surface NOW. Tiptap's `commands.focus()` moves DOM focus on
 *  the next animation frame; a control that hands focus back (Apply link, picking
 *  a person) must not leave a frame in which it has gone nowhere. */
function focusNow(editor: Editor): void {
  if (!editor.view.hasFocus()) editor.view.focus();
}

function runTool(editor: Editor, id: ToolId): void {
  focusNow(editor);
  const chain = editor.chain().focus();
  switch (id) {
    case "bold":
      chain.toggleBold().run();
      break;
    case "italic":
      chain.toggleItalic().run();
      break;
    case "bulletList":
      chain.toggleBulletList().run();
      break;
    case "orderedList":
      chain.toggleOrderedList().run();
      break;
    case "code":
      chain.toggleCode().run();
      break;
    case "codeBlock":
      chain.toggleCodeBlock().run();
      break;
    case "blockquote":
      chain.toggleBlockquote().run();
      break;
    case "link":
      break; // opens the row — see the component
  }
}

// ── link row ─────────────────────────────────────────────────────────────────

const LINK_ERROR = "Use a link that starts with http, https or mailto.";

function LinkRow({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const errorId = useId();
  // Seeded once: the row opens on the caret's own link, if there is one.
  const [value, setValue] = useState(() => (editor.getAttributes("link").href as string | undefined) ?? "");
  const [invalid, setInvalid] = useState(false);
  const hasLink = editor.isActive("link");

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const apply = () => {
    const href = parseLinkInput(value);
    if (href === null) {
      setInvalid(true);
      return;
    }
    focusNow(editor);
    const chain = editor.chain().focus();
    if (hasLink || !editor.state.selection.empty) {
      // A caret inside a link widens to the whole link; a selection links as is.
      chain.extendMarkRange("link").setLink({ href }).run();
    } else {
      // Nothing selected and no link here: the address becomes its own text.
      chain.insertContent({ type: "text", text: href, marks: [{ type: "link", attrs: { href } }] }).run();
    }
    onClose();
  };

  const remove = () => {
    focusNow(editor);
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
    onClose();
  };

  return (
    <div className="pm-rte-linkrow">
      <input
        ref={inputRef}
        type="text"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        className="pm-rte-linkinput"
        aria-label="Link address"
        aria-invalid={invalid ? "true" : undefined}
        aria-describedby={invalid ? errorId : undefined}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setInvalid(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            // Not a form submit, and not the editor's: just this row's Apply.
            e.preventDefault();
            apply();
          } else if (e.key === "Escape") {
            // Closes the row ONLY — not the dialog around it, not the editor's onCancel.
            e.preventDefault();
            e.stopPropagation();
            onClose();
            focusNow(editor);
          }
        }}
      />
      <button type="button" className="pm-btn sm" onClick={apply}>
        Apply link
      </button>
      <button type="button" className="pm-btn ghost sm" onClick={remove} disabled={!hasLink}>
        Remove link
      </button>
      {invalid && (
        <p id={errorId} role="alert" className="pm-rte-linkerr">
          {LINK_ERROR}
        </p>
      )}
    </div>
  );
}

// ── the editor ───────────────────────────────────────────────────────────────

export const RichTextEditor = forwardRef<RichTextEditorHandle, RichTextEditorProps>(function RichTextEditor(
  {
    ariaLabel,
    placeholder,
    initialHtml,
    mentionCandidates,
    onChange,
    onSubmit,
    onCancel,
    disabled = false,
    autoFocus = false,
  },
  ref,
) {
  const listId = useId();
  const popRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);

  const [sug, setSug] = useState<Suggest | null>(null);
  const [active, setActive] = useState(0);
  const [linkOpen, setLinkOpen] = useState(false);
  const [roving, setRoving] = useState(0);

  // The editor is created once; everything it calls back into goes through refs
  // that always hold the latest props and state.
  const onChangeRef = useRef(onChange);
  const onSubmitRef = useRef(onSubmit);
  const onCancelRef = useRef(onCancel);
  const placeholderRef = useRef(placeholder);
  const initialHtmlRef = useRef(initialHtml);
  const sugRef = useRef<Suggest | null>(null);
  const optionsRef = useRef<MentionCandidate[]>([]);
  const activeRef = useRef(0);
  const disabledRef = useRef(disabled);
  onChangeRef.current = onChange;
  onSubmitRef.current = onSubmit;
  onCancelRef.current = onCancel;
  placeholderRef.current = placeholder;
  disabledRef.current = disabled;
  sugRef.current = sug;

  // Who the open list shows. Computed in render from the live query and the live
  // directory — not from what the suggestion plugin fetched — so a directory
  // that arrives after `@` was typed fills the list in without another keystroke.
  const options = useMemo(
    () => (sug && mentionCandidates ? matchMentionCandidates(mentionCandidates, sug.query) : []),
    [sug, mentionCandidates],
  );
  const activeIndex = options.length === 0 ? 0 : Math.min(active, options.length - 1);
  optionsRef.current = options;
  activeRef.current = activeIndex;
  const listOpen = sug !== null && options.length > 0;
  const optionId = (i: number) => `${listId}-opt-${i}`;

  const extensions = useMemo(
    () => [
      StarterKit.configure({
        // Nothing the server's allowlist drops can be written.
        heading: false,
        horizontalRule: false,
        strike: false,
        underline: false,
        // A trailing empty paragraph after every block would be serialised.
        trailingNode: false,
        // Replaced by PlainListItem: no Tab trap.
        listItem: false,
        listKeymap: false,
        // Replaced by PlainLink: href only.
        link: false,
      }),
      PlainListItem,
      PlainLink,
      Placeholder.configure({
        placeholder: () => placeholderRef.current ?? "",
        // A disabled composer still says what it is for.
        showOnlyWhenEditable: false,
      }),
      MentionChip.configure({
        suggestion: {
          char: "@",
          // Matching is synchronous and in-memory (the directory is already
          // loaded), so the plugin never fetches; the rows come from render.
          minQueryLength: Number.MAX_SAFE_INTEGER,
          // `@` inside a code block is code. (A mid-word `@`, an e-mail
          // address, is already excluded by the default allowed prefixes.)
          allow: ({ state, range }) => state.doc.resolve(range.from).parent.type.spec.code !== true,
          command: ({ editor, range, props }) => {
            // Swallow the space the person already typed after the query.
            const after = editor.view.state.selection.$to.nodeAfter;
            if (after?.text?.startsWith(" ")) range.to += 1;
            focusNow(editor);
            editor
              .chain()
              .focus()
              .insertContentAt(range, [
                { type: "mention", attrs: props },
                { type: "text", text: " " },
              ])
              .run();
          },
          render: () => ({
            onStart: (p) => {
              setActive(0);
              setSug({ query: p.query, command: p.command, clientRect: p.clientRect ?? null });
            },
            onUpdate: (p) => {
              if (p.query !== sugRef.current?.query) setActive(0);
              setSug({ query: p.query, command: p.command, clientRect: p.clientRect ?? null });
            },
            onExit: () => setSug(null),
            onKeyDown: ({ event }) => {
              const opts = optionsRef.current;
              if (opts.length === 0) return false;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                const step = event.key === "ArrowDown" ? 1 : -1;
                setActive((activeRef.current + step + opts.length) % opts.length);
                return true;
              }
              const pick =
                (event.key === "Enter" && !event.ctrlKey && !event.metaKey) ||
                (event.key === "Tab" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey);
              if (!pick) return false;
              const chosen = opts[activeRef.current];
              if (!chosen) return false;
              sugRef.current?.command({ id: chosen.id, label: chosen.name });
              return true;
            },
          }),
        },
      }),
    ],
    [],
  );

  const editor = useEditor({
    extensions,
    content: initialHtml ?? "",
    editable: !disabled,
    // Client-only: the document is created after mount, so the server and the
    // first client render agree (an empty shell with the toolbar).
    immediatelyRender: false,
    onUpdate: ({ editor: e }) => {
      onChangeRef.current?.({ html: e.getHTML(), isEmpty: isEditorEmpty(e) });
    },
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": ariaLabel,
        "aria-autocomplete": "list",
        "aria-haspopup": "listbox",
        "aria-expanded": listOpen ? "true" : "false",
        ...(listOpen ? { "aria-controls": listId, "aria-activedescendant": optionId(activeIndex) } : {}),
        ...(disabled ? { "aria-disabled": "true" } : {}),
        // The same typography as a stored comment is read back in.
        class: "pm-rte-content pm-prose",
      },
      handleKeyDown: (_view, event) => {
        if (event.key === "Escape") {
          // An open list or note closes first, and that Escape is the editor's:
          // it must not also reach the dialog around it.
          if (sugRef.current !== null) {
            event.stopPropagation();
            return false; // the suggestion plugin dismisses itself
          }
          if (onCancelRef.current) {
            event.stopPropagation();
            onCancelRef.current();
            return true;
          }
          return false;
        }
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && onSubmitRef.current) {
          if (disabledRef.current) return false;
          onSubmitRef.current();
          return true;
        }
        return false;
      },
      handleDOMEvents: {
        // Leaving the editor closes the list; typing again re-opens it.
        blur: () => {
          setSug(null);
          return false;
        },
      },
    },
  });

  // Editable follows `disabled`. `emitUpdate = false`: switching it is not an edit.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.setEditable(!disabled, false);
    if (disabled) {
      setSug(null);
      setLinkOpen(false);
    }
  }, [editor, disabled]);

  useEffect(() => {
    if (!editor || editor.isDestroyed || !autoFocus) return;
    focusNow(editor);
    editor.commands.focus("end");
  }, [editor, autoFocus]);

  // Anchor the people popup at the caret. It lives INSIDE the widget (absolute,
  // not a portal) so it stays within a dialog's focus trap and scrolls with it.
  const popupOpen = sug !== null;
  useEffect(() => {
    const floating = popRef.current;
    if (!popupOpen || !floating || !editor || editor.isDestroyed) return;
    let cancelled = false;
    const reference = {
      getBoundingClientRect: () => sugRef.current?.clientRect?.() ?? editor.view.dom.getBoundingClientRect(),
      contextElement: editor.view.dom,
    };
    const update = () => {
      void computePosition(reference, floating, {
        placement: "bottom-start",
        strategy: "absolute",
        middleware: [offset(4), flip(), shift({ padding: 8 })],
      }).then(({ x, y }) => {
        if (cancelled) return;
        floating.style.left = `${x}px`;
        floating.style.top = `${y}px`;
        floating.dataset.ready = "true";
      });
    };
    const stop = autoUpdate(reference, floating, update);
    return () => {
      cancelled = true;
      stop();
    };
  }, [popupOpen, editor]);

  const editorRef = useRef<Editor | null>(null);
  editorRef.current = editor;
  useImperativeHandle(
    ref,
    () => ({
      focus() {
        const e = editorRef.current;
        if (!e || e.isDestroyed) return;
        // Already focused: the caret is wherever the person left it.
        if (e.view.hasFocus()) return;
        focusNow(e);
        e.commands.focus("end");
      },
      clear() {
        const e = editorRef.current;
        if (e && !e.isDestroyed) e.commands.clearContent(true);
      },
      getHTML() {
        const e = editorRef.current;
        return e && !e.isDestroyed ? e.getHTML() : (initialHtmlRef.current ?? "");
      },
      isEmpty() {
        const e = editorRef.current;
        return e && !e.isDestroyed ? isEditorEmpty(e) : isBlankHtml(initialHtmlRef.current);
      },
    }),
    [],
  );

  const toolState = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e?.isActive("bold") ?? false,
      italic: e?.isActive("italic") ?? false,
      bulletList: e?.isActive("bulletList") ?? false,
      orderedList: e?.isActive("orderedList") ?? false,
      link: e?.isActive("link") ?? false,
      code: e?.isActive("code") ?? false,
      codeBlock: e?.isActive("codeBlock") ?? false,
      blockquote: e?.isActive("blockquote") ?? false,
    }),
  });

  // One tab stop for the whole toolbar; the arrow keys move within it.
  const onToolbarKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const buttons = [...(toolbarRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0 || buttons.length === 0) return;
    let next = at;
    if (e.key === "ArrowRight") next = (at + 1) % buttons.length;
    else if (e.key === "ArrowLeft") next = (at - 1 + buttons.length) % buttons.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = buttons.length - 1;
    else return;
    e.preventDefault();
    buttons[next]?.focus();
  };

  return (
    <div className="pm-rte" data-disabled={disabled ? "true" : undefined}>
      <div
        ref={toolbarRef}
        className="pm-rte-toolbar"
        role="toolbar"
        aria-label="Text formatting"
        onKeyDown={onToolbarKeyDown}
      >
        {TOOLS.map((tool, i) => (
          <button
            key={tool.id}
            type="button"
            className="pm-rte-btn"
            aria-label={tool.label}
            aria-pressed={toolState?.[tool.id] ?? false}
            tabIndex={i === roving ? 0 : -1}
            disabled={disabled || !editor}
            // A press must not move focus out of the text being edited.
            onMouseDown={(e) => e.preventDefault()}
            onFocus={() => setRoving(i)}
            onClick={() => {
              if (!editor) return;
              if (tool.id === "link") setLinkOpen((open) => !open);
              else runTool(editor, tool.id);
            }}
          >
            {tool.icon}
          </button>
        ))}
      </div>

      {linkOpen && editor && <LinkRow editor={editor} onClose={() => setLinkOpen(false)} />}

      <EditorContent editor={editor} className="pm-rte-surface" />

      {sug && (
        <div ref={popRef} className="pm-rte-pop" onMouseDown={(e) => e.preventDefault()}>
          {options.length > 0 ? (
            <ul role="listbox" id={listId} aria-label="People" className="pm-rte-list">
              {options.map((person, i) => (
                <li
                  key={person.id}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === activeIndex}
                  className="pm-rte-opt"
                  onMouseMove={() => setActive(i)}
                  onClick={() => sug.command({ id: person.id, label: person.name })}
                >
                  {person.name}
                </li>
              ))}
            </ul>
          ) : (
            <p role="status" className="pm-rte-note">
              {mentionCandidates === undefined ? "People aren't available right now." : "No people match."}
            </p>
          )}
        </div>
      )}
    </div>
  );
});
