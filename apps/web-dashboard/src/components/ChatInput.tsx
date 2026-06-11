"use client";

import {
  useState,
  useRef,
  useMemo,
  useCallback,
  useEffect,
  useImperativeHandle,
  forwardRef,
} from "react";
import { ArrowUpRight, Loader2, Mic, Paperclip, Square, Wrench } from "lucide-react";
import { transcribeAudio, SttUnavailable } from "@/lib/api";
import { canCaptureAudio, PcmRecorder } from "@/lib/audio-capture";
import type { ChatAttachment, ToolCatalogEntry } from "@/lib/types";
import { AttachmentChip } from "./AttachmentChip";

interface ChatInputProps {
  onSend: (content: string) => void;
  disabled?: boolean;
  /**
   * WARP-203: chat-attached files. Pass the `attachments` array, the
   * `onAttach(file)` handler (POSTs the file via the brain-upload route),
   * and `onRemoveAttachment(localId)` so the chip's X button can drop
   * a pending or failed item. When omitted, the drop-zone affordance
   * is hidden and ChatInput renders as it did pre-WARP-203.
   */
  attachments?: ChatAttachment[];
  onAttach?: (file: File) => void | Promise<unknown>;
  onRemoveAttachment?: (localId: string) => void;
  /**
   * WARP-295: while the agent loop is streaming, the send button swaps
   * to a Stop button that calls `onStop()`. Both props are required to
   * surface the Stop affordance — without `onStop` ChatInput falls back
   * to the disabled Send button for back-compat.
   */
  isStreaming?: boolean;
  onStop?: () => void;
  /**
   * Slash-command tool menu. When a non-empty `slashTools` list is provided,
   * typing "/" at the START of an empty-ish composer opens a filterable menu
   * of tools; picking one fires `onToolCommand(tool)` (the chat page seeds the
   * composer + shows its "Ready to use X" indicator, mirroring the WARP-829
   * /tools hand-off). Omitted everywhere else (home hero, etc.) so those
   * composers don't fetch the catalog or grow a menu.
   */
  slashTools?: ToolCatalogEntry[];
  onToolCommand?: (tool: ToolCatalogEntry) => void;
}

/**
 * WARP-295: imperative handle exposed to the chat page so the
 * message-actions "Quote" affordance can prepend a `> quoted text`
 * block into the composer's textarea without prop-drilling the value
 * back up. The page wires this via a ref on `<ChatInput>`.
 */
export interface ChatInputHandle {
  insertQuote: (text: string) => void;
  /**
   * WARP-829: seed the composer with a starter line and hand the user the
   * caret. Unlike `insertQuote` (which prepends a `> quote` block ahead of
   * any draft), `seed` REPLACES the value — it's used when `/tools` primes
   * the chat with a tool's starter sentence for the user to finish and
   * send. Seeding never sends; the user edits and submits themselves.
   */
  seed: (text: string) => void;
}

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput({
  onSend,
  disabled,
  attachments,
  onAttach,
  onRemoveAttachment,
  isStreaming,
  onStop,
  slashTools,
  onToolCommand,
}, ref) {
  const [value, setValue] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  // WARP-844 — voice input. "unavailable" hides the mic after the
  // orchestrator answers 503 (whisper sidecar not deployed); jsdom and
  // non-secure contexts hide it via canCaptureAudio().
  const [voiceState, setVoiceState] = useState<
    "idle" | "recording" | "transcribing" | "unavailable"
  >(typeof window !== "undefined" && canCaptureAudio() ? "idle" : "unavailable");
  const recorderRef = useRef<PcmRecorder | null>(null);

  // Release the microphone if the composer unmounts mid-recording
  // (navigation away) — otherwise the tab's mic indicator stays on and
  // the capture stream leaks until the page is torn down.
  useEffect(() => {
    return () => {
      const rec = recorderRef.current;
      recorderRef.current = null;
      if (rec) void rec.stop().catch(() => undefined);
    };
  }, []);

  const toggleRecording = async () => {
    if (voiceState === "transcribing" || voiceState === "unavailable") return;
    if (voiceState === "recording") {
      setVoiceState("transcribing");
      try {
        const rec = recorderRef.current;
        recorderRef.current = null;
        if (!rec) {
          setVoiceState("idle");
          return;
        }
        const { pcm, rate } = await rec.stop();
        const { text } = await transcribeAudio(pcm, rate);
        if (text) {
          setValue((prev) => (prev ? `${prev} ${text}` : text));
          textareaRef.current?.focus();
        }
        setVoiceState("idle");
      } catch (err) {
        if (err instanceof SttUnavailable) {
          setVoiceState("unavailable");
        } else {
          // eslint-disable-next-line no-console
          console.warn("[voice] transcription failed:", err);
          setVoiceState("idle");
        }
      }
      return;
    }
    try {
      const rec = new PcmRecorder();
      await rec.start();
      recorderRef.current = rec;
      setVoiceState("recording");
    } catch {
      // Mic permission denied / no device — treat as unavailable for
      // this session rather than erroring on every click.
      setVoiceState("unavailable");
    }
  };
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Slash-command tool menu (gated on `slashTools`). Opens when the composer
  // text starts with "/"; the query is everything after it. A "/" anywhere
  // other than the start is just a literal slash, so normal messages are
  // unaffected.
  const slashEnabled = Boolean(slashTools && slashTools.length > 0 && onToolCommand);
  const [slashActiveIdx, setSlashActiveIdx] = useState(0);
  const slashQuery =
    slashEnabled && value.startsWith("/") ? value.slice(1).trimStart() : null;
  const slashOpen = slashQuery !== null;
  const slashMatches = useMemo(() => {
    if (!slashEnabled || slashQuery === null) return [];
    const q = slashQuery.toLowerCase();
    const list = q
      ? (slashTools ?? []).filter(
          (t) =>
            t.name.toLowerCase().includes(q) ||
            t.homeDescription.toLowerCase().includes(q),
        )
      : (slashTools ?? []);
    return list.slice(0, 8);
  }, [slashEnabled, slashQuery, slashTools]);

  const pickTool = useCallback(
    (tool: ToolCatalogEntry) => {
      // Hand off to the page (seeds the composer + shows the indicator). The
      // seed REPLACES the "/query" text, so the menu closes on its own.
      onToolCommand?.(tool);
      setSlashActiveIdx(0);
    },
    [onToolCommand],
  );

  const handleSubmit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [value, disabled, onSend]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // WARP-295: IME composition guard — while a CJK / accented input is
    // mid-composition, Enter commits the candidate, it doesn't submit
    // the message. Reading `nativeEvent.isComposing` covers the cases
    // React's synthetic event misses on Safari/Firefox.
    if (e.nativeEvent.isComposing) return;
    // Slash-menu keyboard nav takes precedence while it's open with matches.
    if (slashOpen && slashMatches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashActiveIdx((i) => Math.min(i + 1, slashMatches.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashActiveIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        pickTool(slashMatches[Math.min(slashActiveIdx, slashMatches.length - 1)]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        // Drop the leading "/" so the menu closes but any typed text stays.
        setValue((v) => v.replace(/^\/+/, ""));
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleInput = () => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    }
  };

  const handleFiles = useCallback(
    (files: FileList | File[] | null) => {
      if (!files || !onAttach) return;
      for (const f of Array.from(files)) {
        // Fire-and-forget: the parent owns the upload + chip state. We
        // intentionally don't await so a slow upload doesn't block the
        // next file in a multi-drop.
        void onAttach(f);
      }
    },
    [onAttach],
  );

  const handleFileInputChange: React.ChangeEventHandler<HTMLInputElement> = (
    e,
  ) => {
    handleFiles(e.target.files);
    // Reset so re-selecting the same file fires the change event again.
    e.target.value = "";
  };

  const onDragOver: React.DragEventHandler = (e) => {
    if (!onAttach) return;
    e.preventDefault();
    setIsDragging(true);
  };
  const onDragLeave: React.DragEventHandler = (e) => {
    if (!onAttach) return;
    // Only end dragging when leaving the panel itself (not crossing
    // into one of its children).
    if (e.currentTarget === e.target) setIsDragging(false);
  };
  const onDrop: React.DragEventHandler = (e) => {
    if (!onAttach) return;
    e.preventDefault();
    setIsDragging(false);
    handleFiles(e.dataTransfer.files);
  };

  // Paste-to-attach: a clipboard paste carrying files (screenshot, file
  // copied from Finder/Explorer, ...) routes through the same attach path
  // as drag-and-drop. Text-only pastes fall through to the default
  // textarea behavior untouched.
  const onPaste: React.ClipboardEventHandler<HTMLTextAreaElement> = (e) => {
    if (!onAttach) return;
    const files = e.clipboardData?.files;
    if (!files || files.length === 0) return;
    e.preventDefault();
    handleFiles(files);
  };

  // Expose insertQuote to the parent — see ChatInputHandle. Wraps the
  // text in markdown blockquote syntax (matches what users would type
  // by hand) and focuses the textarea so they can keep typing their
  // follow-up. Auto-resizes via the same scrollHeight handler.
  useImperativeHandle(
    ref,
    () => ({
      insertQuote: (text: string) => {
        const quoted = text
          .split("\n")
          .map((l) => `> ${l}`)
          .join("\n");
        setValue((prev) => {
          const sep = prev.length === 0 ? "" : "\n\n";
          return `${quoted}${sep}${prev}`;
        });
        // Defer focus + size until the next frame so the controlled
        // textarea has flushed the new value.
        queueMicrotask(() => {
          const el = textareaRef.current;
          if (!el) return;
          el.focus();
          // Cursor lands at the end of the new value.
          const end = el.value.length;
          el.setSelectionRange(end, end);
          el.style.height = "auto";
          el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
        });
      },
      // WARP-829: replace the composer value with a starter line (from the
      // /tools "Use in chat" hand-off) and focus the textarea with the caret
      // at the end so the user keeps typing. No send — the user submits.
      seed: (text: string) => {
        setValue(text);
        queueMicrotask(() => {
          const el = textareaRef.current;
          if (!el) return;
          el.focus();
          const end = el.value.length;
          el.setSelectionRange(end, end);
          el.style.height = "auto";
          el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
        });
      },
    }),
    [],
  );

  const hasText = value.trim().length > 0;
  const showAttachmentRow = attachments && attachments.length > 0;
  const dropEnabled = Boolean(onAttach);
  // WARP-295: Stop button replaces Send while a stream is in flight.
  // Both props must be present — `isStreaming` is the discriminator,
  // `onStop` is the handler. Without `onStop` we keep the historical
  // behavior (disabled Send while `disabled` is true).
  const showStop = Boolean(isStreaming && onStop);

  return (
    <div
      data-testid="chat-input"
      data-dragging={isDragging || undefined}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className="chat-composer relative"
    >
      {/* Design-handoff composer card. The card is the visual focus
          boundary — chat-indigo.css suppresses every inner focus ring. */}
      <div
        className={`chat-composer-inner ${isDragging ? "ring-2 ring-accent ring-inset" : ""}`}
      >
      {showAttachmentRow ? (
        <div
          data-testid="attachment-row"
          className="flex flex-wrap gap-1.5"
        >
          {attachments!.map((a) => (
            <AttachmentChip
              key={a.localId}
              attachment={a}
              onRemove={onRemoveAttachment}
            />
          ))}
        </div>
      ) : null}
      {slashOpen && slashMatches.length > 0 ? (
        <ul
          role="listbox"
          aria-label="Tools"
          data-testid="slash-tool-menu"
          className="absolute bottom-full left-3 right-3 mb-2 max-h-64 overflow-y-auto
            rounded-xl border border-separator bg-surface-primary dp-material shadow-lg z-50 py-1"
        >
          {slashMatches.map((tool, idx) => (
            <li
              key={tool.name}
              role="option"
              aria-selected={idx === slashActiveIdx}
              onMouseDown={(e) => {
                // preventDefault so the textarea keeps focus through the click.
                e.preventDefault();
                pickTool(tool);
              }}
              onMouseEnter={() => setSlashActiveIdx(idx)}
              className={`flex items-start gap-2.5 px-3 py-2 cursor-pointer ${
                idx === slashActiveIdx
                  ? "bg-accent-subtle"
                  : "hover:bg-surface-secondary"
              }`}
            >
              <Wrench
                size={14}
                className="mt-0.5 flex-none text-accent"
                aria-hidden="true"
              />
              <span className="min-w-0">
                <span className="block type-footnote font-medium text-label-primary">
                  {humanizeToolName(tool.name)}
                </span>
                <span className="block type-caption-1 text-label-tertiary line-clamp-2">
                  {tool.homeDescription}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setSlashActiveIdx(0);
        }}
        onKeyDown={handleKeyDown}
        onInput={handleInput}
        onPaste={onPaste}
        placeholder="Ask Droplet anything…"
        disabled={disabled}
        rows={1}
      />
      <div className="chat-crow">
        {dropEnabled ? (
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={handleFileInputChange}
              data-testid="chat-file-input"
              aria-label="Attach files"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled}
              aria-label="Attach a file"
              className="chat-iconbtn"
            >
              <Paperclip size={15} />
            </button>
          </>
        ) : null}
        {voiceState !== "unavailable" ? (
          <button
            type="button"
            onClick={() => void toggleRecording()}
            disabled={disabled || voiceState === "transcribing"}
            aria-label={
              voiceState === "recording"
                ? "Stop recording"
                : voiceState === "transcribing"
                  ? "Transcribing…"
                  : "Dictate a message"
            }
            aria-pressed={voiceState === "recording"}
            className={`chat-iconbtn ${voiceState === "recording" ? "is-rec animate-pulse" : ""}`}
          >
            {voiceState === "transcribing" ? (
              <Loader2 size={15} className="animate-spin" />
            ) : (
              <Mic size={15} />
            )}
          </button>
        ) : null}
        {showStop ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="Stop generating"
            className="chat-send chat-stop"
          >
            <Square size={13} fill="currentColor" aria-hidden="true" />
          </button>
        ) : (
          <button
            onClick={handleSubmit}
            disabled={disabled || !hasText}
            aria-label="Send message"
            className="chat-send"
          >
            <ArrowUpRight size={15} strokeWidth={2.4} />
          </button>
        )}
      </div>
      </div>
      <p className="chat-hint">
        Responses are generated locally on your Droplet — nothing leaves the
        device.
      </p>
    </div>
  );
});

/** "block_network_device" → "Block network device" for the slash menu. */
function humanizeToolName(name: string): string {
  const spaced = name.replace(/_/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
