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
 *
 * Since the move, every failure path is a data-loss story rather than a
 * cosmetic one: there is no browser-local copy left to fall back on. The
 * failure cases below (load error ≠ empty account, refused save keeps the
 * typing, one-time import can't double-upload, delete is confirm-gated) pin
 * exactly that.
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
const errorRef: { current: unknown } = { current: undefined };
const refreshMock = vi.fn();
const createNoteMock = vi.fn();
const updateNoteMock = vi.fn();
const deleteNoteMock = vi.fn();

// Spread the real module so NOTE_MAX_BODY stays the production number — the
// textarea cap is only worth anything if it's the same one the box enforces.
vi.mock("@/lib/hooks/useNotes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hooks/useNotes")>()),
  useNotes: () => ({
    notes: notesRef.current,
    error: errorRef.current,
    isLoading: false,
    refresh: refreshMock,
  }),
  createNote: (...a: unknown[]) => createNoteMock(...a),
  updateNote: (...a: unknown[]) => updateNoteMock(...a),
  deleteNote: (...a: unknown[]) => deleteNoteMock(...a),
}));

import { NotesWidget } from "@/components/home/widgets";
import { NOTE_MAX_BODY } from "@/lib/hooks/useNotes";

const LEGACY_KEY = "droplet-home-notes";
const IMPORTED_KEY = "droplet-home-notes-imported";

/** The version the editor opens on, and therefore the one every body save
 *  declares it was based on (WARP-1885). */
const BASE = "2026-08-11T00:00:00.000Z";

function note(over: Partial<MockNote> = {}): MockNote {
  return {
    id: "n1",
    userId: "alice",
    body: "buy milk",
    pinned: false,
    createdAt: BASE,
    updatedAt: BASE,
    ...over,
  };
}

/** A save the box refused because the note moved on — shaped like apiFetch's
 *  TypedError, which carries `.status` and the parsed response `.body`. */
function conflict(theirs: MockNote) {
  return Object.assign(new Error("note_conflict"), {
    status: 409,
    body: { error: "note_conflict", note: theirs },
  });
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
  errorRef.current = undefined;
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

  it("a failed load reads as unreachable, never as an empty account", () => {
    // The customer's notes were just migrated off their browser. If a dead
    // fetch renders the empty state they conclude the migration ate them.
    errorRef.current = Object.assign(new Error("boom"), { status: 500 });
    render(<NotesWidget />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      /couldn't reach your notes/i,
    );
    expect(screen.queryByText(/no notes yet/i)).not.toBeInTheDocument();
  });

  it("a failed load does not say the notes are gone", () => {
    errorRef.current = new Error("boom");
    render(<NotesWidget />);
    expect(screen.getByRole("alert")).toHaveTextContent(/safe on your droplet/i);
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

  it("deletes a note once the confirmation is accepted", async () => {
    notesRef.current = [note({ body: "scratch" })];
    render(<NotesWidget />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete scratch" }));
    });
    // The trash icon opens the gate; it does not destroy anything.
    expect(deleteNoteMock).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toHaveTextContent(/delete this note\?/i);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    });
    expect(deleteNoteMock).toHaveBeenCalledWith("n1");
  });

  it("backing out of the confirmation keeps the note", async () => {
    // The trash target sits beside Pin at the right edge of a scrollable list;
    // on a phone a flick-scroll that lands as a tap must be recoverable, and
    // there is no localStorage copy left to recover from.
    notesRef.current = [note({ body: "scratch" })];
    render(<NotesWidget />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete scratch" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /keep it/i }));
    });
    expect(deleteNoteMock).not.toHaveBeenCalled();
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

    expect(updateNoteMock).toHaveBeenCalledWith("n1", { body: "buy oat milk", expectedUpdatedAt: BASE });
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

    expect(updateNoteMock).toHaveBeenCalledWith("n1", { body: "half-typed", expectedUpdatedAt: BASE });
  });

  it("caps the textarea at the length the box accepts", () => {
    // Without this the server's 400 is reachable by typing, and a 400 on an
    // autosave used to discard the text silently.
    const ta = openNote();
    expect(ta.maxLength).toBe(NOTE_MAX_BODY);
  });

  it("says so when the box refuses the save — never a blank status line", async () => {
    const ta = openNote();
    updateNoteMock.mockRejectedValueOnce(new Error("offline"));

    act(() => {
      fireEvent.change(ta, { target: { value: "buy oat milk" } });
    });
    await act(async () => {
      vi.advanceTimersByTime(600);
    });

    expect(updateNoteMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Not saved — retrying")).toBeInTheDocument();
    expect(screen.queryByText(/^saved$/i)).not.toBeInTheDocument();
  });

  it("retries a refused save on its own, and recovers", async () => {
    const ta = openNote();
    updateNoteMock.mockRejectedValueOnce(new Error("offline"));

    act(() => {
      fireEvent.change(ta, { target: { value: "buy oat milk" } });
    });
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(updateNoteMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(3100);
    });
    expect(updateNoteMock).toHaveBeenCalledTimes(2);
    expect(updateNoteMock).toHaveBeenLastCalledWith("n1", { body: "buy oat milk", expectedUpdatedAt: BASE });
    expect(screen.getByText(/^saved$/i)).toBeInTheDocument();
  });

  it("a refused save stays pending, so the unmount flush still carries it", async () => {
    notesRef.current = [note({ body: "buy milk" })];
    const { unmount } = render(<NotesWidget />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "buy milk" }));
    });
    const ta = screen.getByLabelText("Note") as HTMLTextAreaElement;
    updateNoteMock.mockRejectedValueOnce(new Error("offline"));

    act(() => {
      fireEvent.change(ta, { target: { value: "half-typed" } });
    });
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(updateNoteMock).toHaveBeenCalledTimes(1);

    act(() => {
      unmount();
    });

    // The failed attempt did NOT clear the pending flag, so the text the
    // customer typed still reaches the box on the way out.
    expect(updateNoteMock).toHaveBeenCalledTimes(2);
    expect(updateNoteMock).toHaveBeenLastCalledWith("n1", { body: "half-typed", expectedUpdatedAt: BASE });
  });

  // Guard is the RUN, not the assertion: without a .catch on the flush this
  // rejects after the component is gone and vitest fails the file with an
  // "Unhandled Rejection" — which on a real box is a console error every time
  // someone closes a note while the Droplet is unreachable.
  it("a flush that also fails doesn't surface as an unhandled rejection", async () => {
    notesRef.current = [note({ body: "buy milk" })];
    const { unmount } = render(<NotesWidget />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "buy milk" }));
    });
    const ta = screen.getByLabelText("Note") as HTMLTextAreaElement;
    updateNoteMock.mockRejectedValue(new Error("still offline"));

    act(() => {
      fireEvent.change(ta, { target: { value: "half-typed" } });
    });
    await act(async () => {
      unmount();
      await Promise.resolve();
    });

    expect(updateNoteMock).toHaveBeenCalledWith("n1", { body: "half-typed", expectedUpdatedAt: BASE });
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

/**
 * WARP-1885. The editor holds a copy of the note from the moment it opened. If
 * the note changes elsewhere in the meantime — the other half of the "your data
 * follows you between devices" promise this tile just gained — a blind save
 * destroys that change, permanently, while reporting "Saved". These pin that
 * the editor declares what it was based on, and that when the box refuses, the
 * customer picks the winner rather than the race.
 */
describe("a note changed on another device", () => {
  const THEIR_TIME = "2026-08-11T02:00:00.000Z";

  function openNote() {
    notesRef.current = [note({ body: "buy milk" })];
    render(<NotesWidget />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "buy milk" }));
    });
    return screen.getByLabelText("Note") as HTMLTextAreaElement;
  }

  async function typeIntoAConflict() {
    const ta = openNote();
    updateNoteMock.mockRejectedValueOnce(
      conflict(note({ body: "two more paragraphs", updatedAt: THEIR_TIME })),
    );
    act(() => {
      fireEvent.change(ta, { target: { value: "laptop text" } });
    });
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    return ta;
  }

  it("says which version it was based on, so the box can refuse a stale one", async () => {
    const ta = openNote();
    act(() => {
      fireEvent.change(ta, { target: { value: "buy oat milk" } });
    });
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(updateNoteMock).toHaveBeenCalledWith("n1", {
      body: "buy oat milk",
      expectedUpdatedAt: BASE,
    });
  });

  it("a refused save shows both versions and stops — it never picks one", async () => {
    await typeIntoAConflict();

    expect(screen.getByRole("alert")).toHaveTextContent(
      /changed on another device/i,
    );
    expect(screen.getByText("Not saved — changed elsewhere")).toBeInTheDocument();
    expect(screen.queryByText(/^saved$/i)).not.toBeInTheDocument();

    // A conflict is not a blip. The generic retry would 409 forever and the
    // customer would never be asked.
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(updateNoteMock).toHaveBeenCalledTimes(1);
  });

  it("'Keep mine' overwrites theirs deliberately, on top of what the box now holds", async () => {
    await typeIntoAConflict();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));
    });

    expect(updateNoteMock).toHaveBeenCalledTimes(2);
    // Rebased onto the version that refused us — otherwise this second attempt
    // is refused too and the choice goes nowhere.
    expect(updateNoteMock).toHaveBeenLastCalledWith("n1", {
      body: "laptop text",
      expectedUpdatedAt: THEIR_TIME,
    });
    expect(
      screen.queryByText(/changed on another device/i),
    ).not.toBeInTheDocument();
  });

  it("'Use theirs' loads the box's copy into the editor and writes nothing", async () => {
    await typeIntoAConflict();
    updateNoteMock.mockClear();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Use theirs" }));
    });

    expect((screen.getByLabelText("Note") as HTMLTextAreaElement).value).toBe(
      "two more paragraphs",
    );
    // Adopting their version is not an edit; saving it back would be a write
    // the customer never asked for.
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(updateNoteMock).not.toHaveBeenCalled();
  });

  it("a keystroke mid-save waits for the write in flight instead of racing it", async () => {
    const ta = openNote();
    let release!: (v: unknown) => void;
    updateNoteMock.mockImplementationOnce(
      () =>
        new Promise((res) => {
          release = res;
        }),
    );

    act(() => {
      fireEvent.change(ta, { target: { value: "first" } });
    });
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(updateNoteMock).toHaveBeenCalledTimes(1);

    // Types again while the first PATCH is still open.
    act(() => {
      fireEvent.change(ta, { target: { value: "first and second" } });
    });
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    // Still one. A second write now would carry the same base version as the
    // one in flight, and the two would race — with a precondition, the loser is
    // dropped rather than merged.
    expect(updateNoteMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      release({ note: note({ body: "first", updatedAt: THEIR_TIME }) });
    });

    expect(updateNoteMock).toHaveBeenCalledTimes(2);
    expect(updateNoteMock).toHaveBeenLastCalledWith("n1", {
      body: "first and second",
      expectedUpdatedAt: THEIR_TIME,
    });
  });

  it("takes a newer version from the box when nothing is half-typed", async () => {
    notesRef.current = [note({ body: "buy milk" })];
    const { rerender } = render(<NotesWidget />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "buy milk" }));
    });

    // The phone saves; SWR revalidates under an editor sitting idle.
    notesRef.current = [note({ body: "from the phone", updatedAt: THEIR_TIME })];
    await act(async () => {
      rerender(<NotesWidget />);
    });

    expect((screen.getByLabelText("Note") as HTMLTextAreaElement).value).toBe(
      "from the phone",
    );
    // Adopting it is not an edit.
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(updateNoteMock).not.toHaveBeenCalled();
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
    // The claim is released too, so the next mount picks the import back up.
    expect(window.localStorage.getItem(IMPORTED_KEY)).toBeNull();
  });

  it("is claimed before the upload, so a second tab can't double it", async () => {
    // localStorage is shared across tabs with no lock. Writing the guard flag
    // only after the POST resolved let two tabs mounting together both read
    // null and both upload — one old note, two rows on the box.
    window.localStorage.removeItem(IMPORTED_KEY);
    window.localStorage.setItem(LEGACY_KEY, "the note I already had");
    createNoteMock.mockReturnValueOnce(new Promise(() => {})); // never settles

    await act(async () => {
      render(<NotesWidget />);
    });
    expect(createNoteMock).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(IMPORTED_KEY)).toMatch(/^pending:/);

    // Second tab, same browser, upload still in flight.
    await act(async () => {
      render(<NotesWidget />);
    });
    expect(createNoteMock).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(LEGACY_KEY)).toBe("the note I already had");
  });

  it("takes over a claim whose tab went away mid-upload", async () => {
    window.localStorage.setItem(IMPORTED_KEY, `pending:${Date.now() - 60_000}`);
    window.localStorage.setItem(LEGACY_KEY, "precious");

    await act(async () => {
      render(<NotesWidget />);
    });

    expect(createNoteMock).toHaveBeenCalledWith({ body: "precious" });
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

it("colors the failure states with the red-TEXT ramp, not the var(--danger) fill", () => {
  // Same trap, other end of the ramp: `.droplet-home`'s --danger is a FILL
  // token (#b91c1c light / #7f1d1d dark, see home-bento.css). Its dark value
  // is unreadable as 12px text on the dark card, so both failure surfaces use
  // the red-TEXT ramp .w-remote-err already established.
  // Comments stripped first — these rules EXPLAIN in prose why they don't use
  // the fill token, and a bare grep would read that prose as the violation.
  const css = readFileSync(cssPath, "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const selector of [
    '\\.w-notes-status\\[data-state="error"\\]',
    "\\.w-notes-err",
    // A refused-as-stale save is a failure to save like any other (WARP-1885).
    '\\.w-notes-status\\[data-state="conflict"\\]',
    "\\.w-notes-conflict-msg",
  ]) {
    const light = css.match(new RegExp(`\\n\\.droplet-home ${selector}\\s*\\{[^}]*\\}`))?.[0] ?? "";
    const dark = css.match(new RegExp(`\\.dark \\.droplet-home ${selector}\\s*\\{[^}]*\\}`))?.[0] ?? "";
    expect(light, selector).not.toMatch(/var\(--danger\)/);
    expect(light, selector).toMatch(/#b91c1c/i);
    expect(dark, selector).toMatch(/#fca5a5/i);
  }
});
