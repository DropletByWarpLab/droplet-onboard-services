/**
 * WARP-3076 — the home "Recent files" widget must not read "No recent files"
 * while the box reports Files unavailable (Nextcloud down); it shows the
 * unavailable copy with a retry. A genuinely empty Recents keeps its empty state.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { FilesUnavailableError } from "@/lib/files-unavailable";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));

const refresh = vi.fn();
let error: unknown = null;
vi.mock("@/lib/hooks/useRecents", () => ({
  useRecents: () => ({ items: [], error, isLoading: false, refresh }),
}));

import { FilesWidget } from "@/components/home/widgets";

describe("Home FilesWidget — Files unavailable (WARP-3076)", () => {
  beforeEach(() => {
    cleanup();
    refresh.mockReset();
    error = null;
  });

  it("shows the unavailable copy with a working retry, not 'No recent files'", () => {
    error = new FilesUnavailableError();
    render(<FilesWidget />);

    expect(screen.getByRole("alert").textContent).toMatch(
      /Files are unavailable right now\. Try again in a moment\./,
    );
    expect(screen.queryByText(/no recent files/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(refresh).toHaveBeenCalled();
  });

  it("keeps 'No recent files' for a genuinely empty Recents", () => {
    render(<FilesWidget />);
    expect(screen.getByText(/no recent files/i)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
