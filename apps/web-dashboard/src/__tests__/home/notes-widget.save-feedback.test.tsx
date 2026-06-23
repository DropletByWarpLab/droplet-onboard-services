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
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { NotesWidget } from "@/components/home/widgets";

const KEY = "droplet-home-notes";

// fileURLToPath, not `new URL(...).pathname` — the latter yields "/C:/..."
// on Windows, which path.resolve doubles into "C:\C:\...".
const here = path.dirname(fileURLToPath(import.meta.url));
const cssPath = path.resolve(here, "../../components/home/home-widgets.css");

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

  it("colors the 'Saved' status with the AA-passing green-text token, not var(--success)", () => {
    // `--success` (#16a34a light) is a background-fill token; as 12px normal
    // text on the home card it lands ~3.0–3.3:1, below WCAG AA 4.5:1. The
    // surface's green-TEXT pattern is #15803d (light) / #4ade80 (dark), already
    // used by .w-badge.local and .f-ico.sheet — #15803d clears AA at ~5.0:1.
    const css = readFileSync(cssPath, "utf-8");
    const savedRule =
      css.match(/\.w-notes-status\[data-state="saved"\]\s*\{[^}]*\}/)?.[0] ?? "";
    const savedDark =
      css.match(
        /\.dark[^{]*\.w-notes-status\[data-state="saved"\]\s*\{[^}]*\}/,
      )?.[0] ?? "";

    expect(savedRule).not.toMatch(/var\(--success\)/);
    expect(savedRule).toMatch(/#15803d/i);
    expect(savedDark).toMatch(/#4ade80/i);
  });
});
