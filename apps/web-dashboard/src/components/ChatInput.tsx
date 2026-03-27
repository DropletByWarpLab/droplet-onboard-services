"use client";

import { useState, useRef, useCallback } from "react";
import { ArrowUp } from "lucide-react";

interface ChatInputProps {
  onSend: (content: string) => void;
  disabled?: boolean;
}

export function ChatInput({ onSend, disabled }: ChatInputProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  const hasText = value.trim().length > 0;

  return (
    <div className="p-3 border-t border-separator bg-[var(--color-toolbar-bg)] dp-material">
      <div className="flex items-end gap-2">
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
