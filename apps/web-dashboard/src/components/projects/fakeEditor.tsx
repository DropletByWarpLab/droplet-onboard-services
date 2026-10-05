// Test double for ./editor/RichTextEditor (the Tiptap editor), so the Activity
// section's tests exercise OUR wiring — send / edit / cancel / mention
// candidates — without ProseMirror in jsdom. Tests install it with
//
//   vi.mock("./editor/RichTextEditor", () => import("./fakeEditor"));
//
// It is a plain <textarea> that honours the editor's contract: `ariaLabel`,
// `placeholder`, `initialHtml` (uncontrolled after mount), `onChange({html,
// isEmpty})`, ⌘/Ctrl+Enter → `onSubmit`, Escape → `onCancel`, `disabled`,
// `autoFocus` and the imperative handle. Two deliberate worst cases: Escape
// does NOT stop propagation (the host dialog must protect itself), and
// `clear()` does NOT fire `onChange` (the host must not rely on it).

import { forwardRef, useImperativeHandle, useRef, useState } from "react";

// Types come from the real module (erased at build), so the double cannot drift
// from the editor's contract: a changed prop is a compile error here too.
import type {
  MentionCandidate,
  RichTextEditorHandle,
  RichTextEditorProps,
} from "./editor/RichTextEditor";

export type { MentionCandidate, RichTextEditorHandle, RichTextEditorProps };

const htmlToText = (html: string): string =>
  html
    .replace(/<[^>]*(?:>|$)/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

const textToHtml = (text: string): string =>
  text.trim() === ""
    ? ""
    : `<p>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>`;

export const RichTextEditor = forwardRef<RichTextEditorHandle, RichTextEditorProps>(
  function FakeRichTextEditor(props, ref) {
    const [text, setText] = useState(() => htmlToText(props.initialHtml ?? ""));
    const latest = useRef(text);
    const area = useRef<HTMLTextAreaElement>(null);

    useImperativeHandle(
      ref,
      () => ({
        focus: () => area.current?.focus(),
        clear: () => {
          latest.current = "";
          setText("");
        },
        getHTML: () => textToHtml(latest.current),
        isEmpty: () => latest.current.trim() === "",
      }),
      [],
    );

    const { mentionCandidates } = props;
    return (
      <textarea
        ref={area}
        aria-label={props.ariaLabel}
        placeholder={props.placeholder}
        disabled={props.disabled}
        autoFocus={props.autoFocus}
        data-mention-candidates={
          mentionCandidates === undefined
            ? "unavailable"
            : mentionCandidates.map((c) => `${c.id}=${c.name}`).join(",")
        }
        value={text}
        onChange={(e) => {
          latest.current = e.target.value;
          setText(e.target.value);
          props.onChange?.({ html: textToHtml(e.target.value), isEmpty: e.target.value.trim() === "" });
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") props.onSubmit?.();
          if (e.key === "Escape") props.onCancel?.();
        }}
      />
    );
  },
);
