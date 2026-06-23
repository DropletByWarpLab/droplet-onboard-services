/**
 * NotesWidget — save feedback + new-note affordance.
 *
 * Source: Samantha QA (#bugs) — the Home "Notes" widget autosaved silently to
 * localStorage with zero feedback and offered no way to start fresh. These
 * tests pin the legible save status (debounced "Saving…" → "Saved") and the
 * "New note" clear affordance. localStorage-only; no backend.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

import { NotesWidget } from "@/components/home/widgets";

const KEY = "droplet-home-notes";

describe("NotesWidget save feedback (Samantha QA #bugs)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    window.localStorage.clear();
  });

  it("shows 'Saving…' while debouncing then 'Saved' after the debounce, persisting to localStorage", () => {
    render(<NotesWidget />);
    const ta = screen.getByLabelText("Notes") as HTMLTextAreaElement;

    act(() => {
      fireEvent.change(ta, { target: { value: "buy milk" } });
    });

    // Immediately after a keystroke the user sees that a save is pending.
    expect(screen.getByText(/saving/i)).toBeInTheDocument();
    // Not yet flushed to storage while the debounce is in flight.
    expect(window.localStorage.getItem(KEY)).not.toBe("buy milk");

    // Advance past the ~500ms debounce window.
    act(() => {
      vi.advanceTimersByTime(600);
    });

    expect(screen.getByText(/^saved$/i)).toBeInTheDocument();
    expect(window.localStorage.getItem(KEY)).toBe("buy milk");
  });

  it("'New note' clears the editor and the persisted note", () => {
    window.localStorage.setItem(KEY, "old note");
    render(<NotesWidget />);
    const ta = screen.getByLabelText("Notes") as HTMLTextAreaElement;

    // Hydrated from storage.
    expect(ta.value).toBe("old note");

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /new note/i }));
    });

    // Editor cleared; pending save flushed so storage reflects the empty note.
    expect(ta.value).toBe("");
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(window.localStorage.getItem(KEY)).toBe("");
  });
});
