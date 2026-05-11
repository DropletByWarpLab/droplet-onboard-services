"use client";

import { useState, useRef, useCallback, useImperativeHandle, forwardRef } from "react";
import { ArrowUp, Paperclip, Square } from "lucide-react";
import type { ChatAttachment } from "@/lib/types";
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
}

/**
 * WARP-295: imperative handle exposed to the chat page so the
 * message-actions "Quote" affordance can prepend a `> quoted text`
 * block into the composer's textarea without prop-drilling the value
 * back up. The page wires this via a ref on `<ChatInput>`.
 */
export interface ChatInputHandle {
  insertQuote: (text: string) => void;
}

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput({
  onSend,
  disabled,
  attachments,
  onAttach,
  onRemoveAttachment,
  isStreaming,
  onStop,
}, ref) {
  const [value, setValue] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
      className={`p-3 border-t border-separator bg-[var(--color-toolbar-bg)] dp-material
        relative
        ${isDragging ? "ring-2 ring-accent ring-inset" : ""}
      `}
    >
      {showAttachmentRow ? (
        <div
          data-testid="attachment-row"
          className="mb-2 flex flex-wrap gap-1.5"
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
      <div className="flex items-end gap-2">
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
              className="w-9 h-9 rounded-full flex items-center justify-center
                bg-surface-secondary text-label-secondary
                hover:text-label-primary hover:bg-label-quaternary/40
                transition-colors duration-150
                disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Paperclip size={16} strokeWidth={2.5} />
            </button>
          </>
        ) : null}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          placeholder="Send a message..."
          disabled={disabled}
          rows={1}
          className="flex-1 resize-none bg-surface-secondary rounded-[22px] px-4 py-2.5
            type-body text-label-primary placeholder:text-label-tertiary
            focus:outline-none focus:ring-2 focus:ring-accent/30
            disabled:opacity-50 disabled:cursor-not-allowed
            transition-all duration-200 ease-smooth"
        />
        {showStop ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="Stop generating"
            className="
              w-9 h-9 rounded-full flex items-center justify-center
              bg-surface-secondary text-system-red
              hover:bg-system-red/10
              transition-all duration-200 ease-smooth
              active:scale-90
            "
          >
            <Square size={14} strokeWidth={2.5} fill="currentColor" aria-hidden="true" />
          </button>
        ) : (
          <button
            onClick={handleSubmit}
            disabled={disabled || !hasText}
            aria-label="Send message"
            className={`
              w-9 h-9 rounded-full flex items-center justify-center
              transition-all duration-200 ease-smooth
              ${
                hasText
                  ? "bg-accent text-white scale-100 opacity-100"
                  : "bg-label-quaternary text-label-tertiary scale-90 opacity-60"
              }
              disabled:cursor-not-allowed
              active:scale-90
            `}
          >
            <ArrowUp size={18} strokeWidth={2.5} />
          </button>
        )}
      </div>
    </div>
  );
});
