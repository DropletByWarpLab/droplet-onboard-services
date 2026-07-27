/**
 * WARP-1555 — <TrashPage /> renders four distinct states, not two.
 *
 * The worst instance of the sub-view defect: `useTrash`'s `error` was dropped,
 * so a failed read rendered "Trash is empty" — which a user reads as "my
 * deleted files are gone for good". `fetchTrash` made it worse by converting
 * the backend's 501 (no trashbin at all) into an empty array, so an
 * unsupported trash was indistinguishable from an empty one.
 *
 * States now: unsupported → failed (retryable) → loading → empty → rows.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { TrashItemInfo } from "@/lib/types";

// ── Data hook (mutable per-test state, read at render time) ──
const refresh = vi.fn();
const trashState: {
  items: TrashItemInfo[];
  isLoading: boolean;
  error: unknown;
} = { items: [], isLoading: false, error: undefined };

vi.mock("@/lib/hooks/useTrash", () => ({
  useTrash: () => ({
    items: trashState.items,
    isLoading: trashState.isLoading,
    error: trashState.error,
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

// Keep the real api module — TrashView's `isTrashUnsupportedError` guard and
// the `TrashUnsupportedError` the test constructs must be the same code.
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchSystemHealth: vi.fn().mockResolvedValue({ status: "ok" }),
  };
});

import { TrashUnsupportedError } from "@/lib/api";
import TrashPage from "./page";

const ITEM: TrashItemInfo = {
  name: "budget.xlsx.d1712860391",
  originalName: "budget.xlsx",
  originalLocation: "/Documents",
  isDirectory: false,
  size: 4096,
  deletedAt: "2026-07-20T10:00:00.000Z",
};

beforeEach(() => {
  refresh.mockClear();
  trashState.items = [];
  trashState.isLoading = false;
  trashState.error = undefined;
});

describe("<TrashPage /> — fetch failure ≠ empty trash (WARP-1555)", () => {
  it("renders an error state, never 'Trash is empty', when the fetch fails", () => {
    trashState.error = new Error("Failed to fetch trash: 500");
    render(<TrashPage />);

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/couldn't load your trash/i)).toBeInTheDocument();
    expect(screen.queryByText(/trash is empty/i)).not.toBeInTheDocument();
  });

  it("reassures that nothing was destroyed, rather than 'something went wrong'", () => {
    trashState.error = new Error("boom");
    render(<TrashPage />);

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/nothing has been deleted for good/i);
    expect(alert.textContent).not.toMatch(/something went wrong/i);
  });

  it("offers a retry that re-runs the fetch", () => {
    trashState.error = new Error("boom");
    render(<TrashPage />);

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("renders the 501 as 'trash isn't available', not as empty or as a failure", () => {
    trashState.error = new TrashUnsupportedError();
    render(<TrashPage />);

    expect(screen.getByText(/trash isn't available on this droplet/i)).toBeInTheDocument();
    // Deleting is immediate here — say so, rather than implying a safety net.
    expect(screen.getByRole("alert").textContent).toMatch(/removes it straight away/i);
    expect(screen.queryByText(/trash is empty/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/couldn't load your trash/i)).not.toBeInTheDocument();
    // Retrying cannot make a backend grow a trash bin.
    expect(screen.queryByRole("button", { name: /try again/i })).not.toBeInTheDocument();
  });

  it("still shows the empty state when the trash is genuinely empty", () => {
    render(<TrashPage />);

    expect(screen.getByText(/trash is empty/i)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the loading state while the first fetch is in flight", () => {
    trashState.isLoading = true;
    render(<TrashPage />);

    expect(screen.getByText(/loading/i)).toBeInTheDocument();
    expect(screen.queryByText(/trash is empty/i)).not.toBeInTheDocument();
  });

  it("keeps showing trashed items when a background refresh fails", () => {
    trashState.items = [ITEM];
    trashState.error = new Error("poll failed");
    render(<TrashPage />);

    expect(screen.getByText("budget.xlsx")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
