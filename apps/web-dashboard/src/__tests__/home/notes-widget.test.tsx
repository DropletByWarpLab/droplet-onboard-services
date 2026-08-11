/**
 * NotesWidget — notes on the box, pinnable, with legible save feedback.
 *
 * Notes used to be a single string in this browser's localStorage: unsynced,
 * unpinnable, and wiped by "New note". They now live behind /api/notes, many
 * per user, each pinnable so Home can surface the pinned ones. These tests
 * pin: the list + its pin/delete affordances, the debounced "Saving…" →
 * "Saved" status against the API, the no-lost-typing unmount flush, and the
 * one-time import that stops the old localStorage note from vanishing.
 *
 * The save-feedback and unmount-flush cases carry over from the original
 * localStorage widget (Samantha QA, #bugs) — the storage moved, the contract
 * with the customer did not.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type MockNote = {
  id: string;
  userId: string;
  body: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
};

const notesRef: { current: MockNote[] } = { current: [] };
const refreshMock = vi.fn();
const createNoteMock = vi.fn();
const updateNoteMock = vi.fn();
const deleteNoteMock = vi.fn();

vi.mock("@/lib/hooks/useNotes", () => ({
  useNotes: () => ({
    notes: notesRef.current,
    error: undefined,
    isLoading: false,
    refresh: refreshMock,
  }),
  createNote: (...a: unknown[]) => createNoteMock(...a),
  updateNote: (...a: unknown[]) => updateNoteMock(...a),
  deleteNote: (...a: unknown[]) => deleteNoteMock(...a),
}));

import { NotesWidget } from "@/components/home/widgets";

const LEGACY_KEY = "droplet-home-notes";
const IMPORTED_KEY = "droplet-home-notes-imported";

function note(over: Partial<MockNote> = {}): MockNote {
  return {
    id: "n1",
    userId: "alice",
    body: "buy milk",
    pinned: false,
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
    ...over,
  };
}

// fileURLToPath, not `new URL(...).pathname` — the latter yields "/C:/..."
// on Windows, which path.resolve doubles into "C:\C:\...".
const here = path.dirname(fileURLToPath(import.meta.url));
const cssPath = path.resolve(here, "../../components/home/home-widgets.css");

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  // Default: nothing to import, so the legacy path stays out of the way.
  window.localStorage.setItem(IMPORTED_KEY, "1");
  notesRef.current = [];
  refreshMock.mockReset().mockResolvedValue(undefined);
  createNoteMock.mockReset().mockResolvedValue({ note: note({ id: "new", body: "" }) });
  updateNoteMock.mockReset().mockResolvedValue({ note: note() });
  deleteNoteMock.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  window.localStorage.clear();
});

describe("the notes list", () => {
  it("names each note by its first non-empty line, in server order", () => {
    notesRef.current = [
      note({ id: "a", body: "pinned one", pinned: true }),
      note({ id: "b", body: "\n\nsecond note\nmore" }),
    ];
    render(<NotesWidget />);
    const names = screen
      .getAllByRole("button", { name: /^(pinned one|second note)$/ })
      .map((b) => b.textContent);
    expect(names).toEqual(["pinned one", "second note"]);
  });

  it("says so honestly when there are no notes", () => {
    render(<NotesWidget />);
    expect(screen.getByText(/no notes yet/i)).toBeInTheDocument();
  });

  it("pins an unpinned note", async () => {
    notesRef.current = [note({ body: "groceries" })];
    render(<NotesWidget />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pin groceries" }));
    });
    expect(updateNoteMock).toHaveBeenCalledWith("n1", { pinned: true });
  });

  it("unpins a pinned note", async () => {
    notesRef.current = [note({ body: "groceries", pinned: true })];
    render(<NotesWidget />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Unpin groceries" }));
    });
    expect(updateNoteMock).toHaveBeenCalledWith("n1", { pinned: false });
  });

  it("shows how many notes are pinned", () => {
    notesRef.current = [
      note({ id: "a", body: "one", pinned: true }),
      note({ id: "b", body: "two", pinned: true }),
      note({ id: "c", body: "three" }),
    ];
    render(<NotesWidget />);
    expect(screen.getByText("2 pinned")).toBeInTheDocument();
  });

  it("deletes a note", async () => {
    notesRef.current = [note({ body: "scratch" })];
    render(<NotesWidget />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete scratch" }));
    });
    expect(deleteNoteMock).toHaveBeenCalledWith("n1");
  });

  it("'New note' creates one on the box and opens it", async () => {
    render(<NotesWidget />);
    notesRef.current = [note({ id: "new", body: "" })];
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /new note/i }));
    });
    expect(createNoteMock).toHaveBeenCalledWith({ body: "" });
    expect(screen.getByLabelText("Note")).toBeInTheDocument();
  });
});

describe("editing a note", () => {
  function openNote() {
    notesRef.current = [note({ body: "buy milk" })];
    render(<NotesWidget />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "buy milk" }));
    });
    return screen.getByLabelText("Note") as HTMLTextAreaElement;
  }

  it("shows 'Saving…' while debouncing, then 'Saved' once the box has it", async () => {
    const ta = openNote();

    act(() => {
      fireEvent.change(ta, { target: { value: "buy oat milk" } });
    });

    // Immediately after a keystroke the user sees that a save is pending.
    expect(screen.getByText(/saving/i)).toBeInTheDocument();
    expect(updateNoteMock).not.toHaveBeenCalled();

    // Advance past the ~500ms debounce window.
    await act(async () => {
      vi.advanceTimersByTime(600);
    });

    expect(updateNoteMock).toHaveBeenCalledWith("n1", { body: "buy oat milk" });
    expect(screen.getByText(/^saved$/i)).toBeInTheDocument();
  });

  it("flushes an in-flight edit on unmount (no lost typing)", () => {
    notesRef.current = [note({ body: "buy milk" })];
    const { unmount } = render(<NotesWidget />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "buy milk" }));
    });
    const ta = screen.getByLabelText("Note") as HTMLTextAreaElement;

    act(() => {
      fireEvent.change(ta, { target: { value: "half-typed" } });
    });
    expect(updateNoteMock).not.toHaveBeenCalled();

    // Widget goes away before the debounce fires (navigate off Home / remove
    // the tile). The pending edit must still land.
    act(() => {
      unmount();
    });

    expect(updateNoteMock).toHaveBeenCalledWith("n1", { body: "half-typed" });
  });

  it("'All notes' returns to the list", () => {
    openNote();
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /all notes/i }));
    });
    expect(screen.queryByLabelText("Note")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "buy milk" })).toBeInTheDocument();
  });
});

describe("the old browser-local note", () => {
  it("is uploaded once, then cleared from localStorage", async () => {
    window.localStorage.removeItem(IMPORTED_KEY);
    window.localStorage.setItem(LEGACY_KEY, "the note I already had");

    await act(async () => {
      render(<NotesWidget />);
    });

    expect(createNoteMock).toHaveBeenCalledWith({ body: "the note I already had" });
    expect(window.localStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(window.localStorage.getItem(IMPORTED_KEY)).toBe("1");
  });

  it("is kept for a later attempt if the upload fails — never dropped", async () => {
    window.localStorage.removeItem(IMPORTED_KEY);
    window.localStorage.setItem(LEGACY_KEY, "precious");
    createNoteMock.mockRejectedValueOnce(new Error("offline"));

    await act(async () => {
      render(<NotesWidget />);
    });

    expect(window.localStorage.getItem(LEGACY_KEY)).toBe("precious");
    expect(window.localStorage.getItem(IMPORTED_KEY)).toBeNull();
  });

  it("is not re-uploaded on a later mount", async () => {
    window.localStorage.setItem(IMPORTED_KEY, "1");
    window.localStorage.setItem(LEGACY_KEY, "stale leftover");

    await act(async () => {
      render(<NotesWidget />);
    });

    expect(createNoteMock).not.toHaveBeenCalled();
  });
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
