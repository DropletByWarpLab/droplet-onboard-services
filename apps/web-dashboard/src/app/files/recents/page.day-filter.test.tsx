/**
 * WARP-1916 — <RecentsPage /> day filter: jump to "what did I touch on
 * July 23" without losing the default Today/Earlier grouping.
 *
 * Fixtures are FIXED local-time dates in July 2026 (the ticket's own
 * example), built from local Date components so day-boundary assertions
 * hold in any timezone. They land in the "Earlier" bucket when
 * unfiltered — deterministic for any run date after July 2026.
 *
 * The hook is mocked; the page and <FileListSimple /> under it are real
 * (same seam as page.test.tsx).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { FileEntryInfo } from "@/lib/types";

// ── Data hook (mutable per-test state, read at render time) ──
const refresh = vi.fn();
const recentsState: {
  items: FileEntryInfo[];
  isLoading: boolean;
  error: unknown;
} = { items: [], isLoading: false, error: undefined };

vi.mock("@/lib/hooks/useRecents", () => ({
  useRecents: () => ({
    items: recentsState.items,
    isLoading: recentsState.isLoading,
    error: recentsState.error,
    refresh,
  }),
}));

vi.mock("@/lib/hooks/useDevice", () => ({
  useDevice: () => ({
    device: { id: "box-1", name: "Droplet", status: "online" },
    devices: [{ id: "box-1", name: "Droplet", status: "online" }],
    health: { status: "ok" },
    isLoading: false,
    error: undefined,
  }),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchSystemHealth: vi.fn().mockResolvedValue({ status: "ok" }),
  };
});

import RecentsPage from "./page";

/** ISO timestamp for a LOCAL wall-clock moment (month is 1-based). */
const localIso = (y: number, m: number, d: number, hh = 12, mm = 0, ss = 0) =>
  new Date(y, m - 1, d, hh, mm, ss).toISOString();

const file = (name: string, modifiedAt: string): FileEntryInfo => ({
  name,
  path: `/${name}`,
  isDirectory: false,
  size: 512,
  modifiedAt,
  mimeType: "text/markdown",
});

// A mid-day file on July 23 and a one-second-to-midnight file on July 22:
// the pair that an off-by-one day boundary would merge.
const JUL23 = file("budget.xlsx", localIso(2026, 7, 23, 14, 5));
const JUL22_LATE = file("late-night.md", localIso(2026, 7, 22, 23, 59, 59));

const JUL23_HEADING = new Date(2026, 6, 23).toLocaleDateString(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
});

const pickDay = (day: string) =>
  fireEvent.change(screen.getByLabelText(/jump to a day/i), {
    target: { value: day },
  });

beforeEach(() => {
  refresh.mockClear();
  recentsState.items = [JUL23, JUL22_LATE];
  recentsState.isLoading = false;
  recentsState.error = undefined;
});

describe("<RecentsPage /> — day filter (WARP-1916)", () => {
  it("shows the default time buckets and no active-filter chip before any day is chosen", () => {
    render(<RecentsPage />);

    expect(screen.getByText("Earlier")).toBeInTheDocument();
    expect(screen.getByText("budget.xlsx")).toBeInTheDocument();
    expect(screen.getByText("late-night.md")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /clear day filter/i })).not.toBeInTheDocument();
  });

  it("narrows the list to the chosen local day, grouped under that day's heading", () => {
    render(<RecentsPage />);
    pickDay("2026-07-23");

    expect(screen.getByText("budget.xlsx")).toBeInTheDocument();
    expect(screen.queryByText("late-night.md")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: JUL23_HEADING })).toBeInTheDocument();
    expect(screen.queryByText("Earlier")).not.toBeInTheDocument();
  });

  it("day boundary is local midnight: filtering July 22 keeps only the 23:59:59 file", () => {
    render(<RecentsPage />);
    pickDay("2026-07-22");

    expect(screen.getByText("late-night.md")).toBeInTheDocument();
    expect(screen.queryByText("budget.xlsx")).not.toBeInTheDocument();
  });

  it("shows an active-filter chip naming the day; clicking it restores the buckets", () => {
    render(<RecentsPage />);
    pickDay("2026-07-23");

    const chip = screen.getByRole("button", { name: /clear day filter/i });
    expect(chip.textContent).toContain(JUL23_HEADING);

    fireEvent.click(chip);

    expect(screen.getByText("Earlier")).toBeInTheDocument();
    expect(screen.getByText("budget.xlsx")).toBeInTheDocument();
    expect(screen.getByText("late-night.md")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /clear day filter/i })).not.toBeInTheDocument();
  });

  it("an empty day renders a 'no files on that day' state with a reset affordance", () => {
    render(<RecentsPage />);
    pickDay("2026-07-21");

    expect(screen.getByText(/no files on/i)).toBeInTheDocument();
    // The generic empty state must NOT swallow the filtered one.
    expect(screen.queryByText(/no recent files/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /show all recents/i }));

    expect(screen.getByText("Earlier")).toBeInTheDocument();
    expect(screen.getByText("budget.xlsx")).toBeInTheDocument();
  });

  it("keeps the error/loading/empty degenerate states untouched (no filter UI without data)", () => {
    recentsState.items = [];
    render(<RecentsPage />);

    expect(screen.getByText(/no recent files/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/jump to a day/i)).not.toBeInTheDocument();
  });
});
