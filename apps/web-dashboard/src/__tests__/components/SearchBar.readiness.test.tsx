/**
 * WARP-310 — the AI/semantic toggle on the Files search bar surfaces a
 * readiness traffic-light fed by `GET /api/files/search/status`. Users
 * can tell at a glance whether semantic search is actually wired up
 * (green), still empty (yellow), or down (red) — instead of typing
 * into a search box that silently returns nothing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const { fetchSearchStatusMock, searchFileContentMock, useFileSearchMock } =
  vi.hoisted(() => ({
    fetchSearchStatusMock: vi.fn(),
    searchFileContentMock: vi.fn(),
    useFileSearchMock: vi.fn(() => ({ items: [], isLoading: false, error: null })),
  }));

vi.mock("@/lib/api", () => ({
  fetchSearchStatus: fetchSearchStatusMock,
  searchFileContent: searchFileContentMock,
}));

vi.mock("@/lib/hooks/useFileSearch", () => ({
  useFileSearch: useFileSearchMock,
}));

vi.mock("./Thumbnail", () => ({
  Thumbnail: () => null,
}));

import { SearchBar } from "@/components/FileManager/SearchBar";

function clickToggle() {
  // The button containing the Sparkles icon — its accessible name is
  // either "Semantic" or "AI" depending on state.
  const toggle = screen.getByRole("button", { name: /AI|Semantic/i });
  fireEvent.click(toggle);
}

describe("SearchBar — AI search readiness pill (WARP-310)", () => {
  beforeEach(() => {
    fetchSearchStatusMock.mockReset();
    searchFileContentMock.mockReset();
    useFileSearchMock.mockReturnValue({
      items: [],
      isLoading: false,
      error: null,
    });
  });

  it("does not render the readiness pill until the AI toggle is on", () => {
    fetchSearchStatusMock.mockResolvedValue({
      state: "ready",
      gatewayHealthy: true,
      pgvectorReady: true,
      indexedCount: 42,
      lastIndexedAt: new Date().toISOString(),
    });
    render(<SearchBar onPickResult={vi.fn()} />);
    // Toggle is off → no probe fires.
    expect(fetchSearchStatusMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("search-readiness")).toBeNull();
  });

  it("renders a green dot when the indexer is ready", async () => {
    fetchSearchStatusMock.mockResolvedValue({
      state: "ready",
      gatewayHealthy: true,
      pgvectorReady: true,
      indexedCount: 7,
      lastIndexedAt: new Date().toISOString(),
    });
    render(<SearchBar onPickResult={vi.fn()} />);
    clickToggle();
    const pill = await screen.findByTestId("search-readiness");
    expect(pill.getAttribute("data-state")).toBe("ready");
    expect(pill.getAttribute("aria-label")).toMatch(/ready.*7/i);
  });

  it("renders a yellow dot when the indexer is up but no chunks exist yet", async () => {
    fetchSearchStatusMock.mockResolvedValue({
      state: "indexing",
      gatewayHealthy: true,
      pgvectorReady: true,
      indexedCount: 0,
      lastIndexedAt: null,
    });
    render(<SearchBar onPickResult={vi.fn()} />);
    clickToggle();
    const pill = await screen.findByTestId("search-readiness");
    expect(pill.getAttribute("data-state")).toBe("indexing");
    expect(pill.getAttribute("aria-label")).toMatch(/initializing|no files/i);
  });

  it("renders a red dot when the gateway or pgvector is down", async () => {
    fetchSearchStatusMock.mockResolvedValue({
      state: "unavailable",
      gatewayHealthy: false,
      pgvectorReady: true,
      indexedCount: 0,
      lastIndexedAt: null,
    });
    render(<SearchBar onPickResult={vi.fn()} />);
    clickToggle();
    const pill = await screen.findByTestId("search-readiness");
    expect(pill.getAttribute("data-state")).toBe("unavailable");
    // The tooltip pinpoints which dependency is down.
    expect(pill.getAttribute("title")).toMatch(/gateway/i);
  });

  it("clears the pill when the user toggles AI search back off", async () => {
    fetchSearchStatusMock.mockResolvedValue({
      state: "ready",
      gatewayHealthy: true,
      pgvectorReady: true,
      indexedCount: 1,
      lastIndexedAt: new Date().toISOString(),
    });
    render(<SearchBar onPickResult={vi.fn()} />);
    clickToggle();
    await screen.findByTestId("search-readiness");
    clickToggle();
    await waitFor(() =>
      expect(screen.queryByTestId("search-readiness")).toBeNull(),
    );
  });
});
