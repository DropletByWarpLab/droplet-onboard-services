"use client";

import { useState, useRef, useCallback } from "react";
import { ArrowUp, Paperclip } from "lucide-react";
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
}

export function ChatInput({
  onSend,
  disabled,
  attachments,
  onAttach,
  onRemoveAttachment,
}: ChatInputProps) {
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

  const hasText = value.trim().length > 0;
  const showAttachmentRow = attachments && attachments.length > 0;
  const dropEnabled = Boolean(onAttach);

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
      </div>
    </div>
  );
}
