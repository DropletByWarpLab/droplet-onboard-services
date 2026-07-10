/**
 * WARP-880 / WS-2 — SearchBar 3-mode toggle.
 *
 * The Files-page search bar gains a 3-segment mode control:
 *   - Filename → existing `useFileSearch` hook (Nextcloud name match)
 *   - Keyword  → `searchFileContent(q, 20, "keyword")` (lexical full-text)
 *   - Semantic → `searchFileContent(q, 20, "semantic")` (pgvector)
 *
 * Keyword/Semantic both hit the content-search API (debounced 500ms); the
 * 3rd arg pins the mode. Keyword mode must NOT show the semantic readiness
 * pill (keyword doesn't need the AI gateway). Snippet + score render for
 * content results; empty/error states reuse the existing copy.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { FileEntryInfo } from "@/lib/types";

// useFileSearch (filename) — controllable per test.
const useFileSearchMock = vi.fn();
vi.mock("@/lib/hooks/useFileSearch", () => ({
  useFileSearch: (...args: unknown[]) => useFileSearchMock(...args),
}));

vi.mock("@/lib/api", () => ({
  searchFileContent: vi.fn(),
  fetchSearchStatus: vi.fn(),
}));

vi.mock("@/lib/friendly-errors", () => ({
  translateError: (err: unknown) => (err instanceof Error ? err.message : "error"),
}));

// Thumbnail pulls image data — stub it out for the render harness.
vi.mock("./Thumbnail", () => ({
  Thumbnail: () => <div data-testid="thumb" />,
}));

import { searchFileContent, fetchSearchStatus } from "@/lib/api";
import { SearchBar } from "./SearchBar";

const searchFileContentMock = vi.mocked(searchFileContent);
const fetchSearchStatusMock = vi.mocked(fetchSearchStatus);

function makeFile(overrides: Partial<FileEntryInfo> = {}): FileEntryInfo {
  return {
    name: "report.pdf",
    path: "/Documents/report.pdf",
    isDirectory: false,
    size: 1024,
    mimeType: "application/pdf",
    modifiedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.useRealTimers();
  searchFileContentMock.mockReset();
  fetchSearchStatusMock.mockReset();
  useFileSearchMock.mockReset();
  // Default: filename hook idle/empty.
  useFileSearchMock.mockReturnValue({ items: [], isLoading: false, error: null });
  fetchSearchStatusMock.mockResolvedValue({
    state: "ready",
    gatewayHealthy: true,
    pgvectorReady: true,
    indexedCount: 3,
    lastIndexedAt: null,
  });
  searchFileContentMock.mockResolvedValue([]);
});

/** Click a mode segment (a `radio` in the mode radiogroup) by its name. */
function selectMode(name: RegExp) {
  fireEvent.click(screen.getByRole("radio", { name }));
}

describe("SearchBar mode toggle (WARP-880)", () => {
  it("defaults to filename mode and uses the useFileSearch hook", () => {
    useFileSearchMock.mockReturnValue({
      items: [makeFile()],
      isLoading: false,
      error: null,
    });
    render(<SearchBar onPickResult={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/search files/i), {
      target: { value: "report" },
    });
    // filename hook received the live query; content API not called.
    expect(useFileSearchMock).toHaveBeenCalledWith("report");
    expect(searchFileContentMock).not.toHaveBeenCalled();
  });

  it("keyword mode calls searchFileContent with mode 'keyword'", async () => {
    searchFileContentMock.mockResolvedValue([
      { path: "/Documents/notes.txt", score: 0.91, text: "the keyword snippet" },
    ]);
    render(<SearchBar onPickResult={vi.fn()} />);

    selectMode(/keyword/i);
    fireEvent.change(screen.getByPlaceholderText(/search files/i), {
      target: { value: "budget" },
    });

    await waitFor(
      () => expect(searchFileContentMock).toHaveBeenCalledWith("budget", 20, "keyword"),
      { timeout: 1500 }
    );
  });

  it("semantic mode calls searchFileContent with mode 'semantic'", async () => {
    searchFileContentMock.mockResolvedValue([]);
    render(<SearchBar onPickResult={vi.fn()} />);

    selectMode(/semantic/i);
    fireEvent.change(screen.getByPlaceholderText(/search files/i), {
      target: { value: "quarterly" },
    });

    await waitFor(
      () => expect(searchFileContentMock).toHaveBeenCalledWith("quarterly", 20, "semantic"),
      { timeout: 1500 }
    );
  });

  it("keyword mode renders the snippet and score for a content hit", async () => {
    searchFileContentMock.mockResolvedValue([
      { path: "/Documents/notes.txt", score: 0.42, text: "matching keyword body text" },
    ]);
    render(<SearchBar onPickResult={vi.fn()} />);

    selectMode(/keyword/i);
    fireEvent.change(screen.getByPlaceholderText(/search files/i), {
      target: { value: "match" },
    });

    expect(await screen.findByText(/matching keyword body text/i, undefined, { timeout: 1500 }))
      .toBeInTheDocument();
    // score rendered as a percentage
    expect(screen.getByText("42%")).toBeInTheDocument();
  });

  it("keyword mode does NOT render the semantic readiness pill", async () => {
    render(<SearchBar onPickResult={vi.fn()} />);
    selectMode(/keyword/i);
    fireEvent.change(screen.getByPlaceholderText(/search files/i), {
      target: { value: "anything" },
    });
    await waitFor(() => expect(searchFileContentMock).toHaveBeenCalled(), { timeout: 1500 });
    // WARP-1139: the probe now fires for BOTH content modes (its explicit
    // indexer counts drive the "still indexing" empty state), but keyword
    // never needs the gateway → the traffic-light pill still never renders.
    expect(fetchSearchStatusMock).toHaveBeenCalled();
    expect(screen.queryByTestId("search-readiness")).not.toBeInTheDocument();
  });

  it("semantic mode shows the empty-state copy when no content matches", async () => {
    searchFileContentMock.mockResolvedValue([]);
    render(<SearchBar onPickResult={vi.fn()} />);

    selectMode(/semantic/i);
    fireEvent.change(screen.getByPlaceholderText(/search files/i), {
      target: { value: "nothinghere" },
    });

    expect(await screen.findByText(/no content matches/i, undefined, { timeout: 1500 }))
      .toBeInTheDocument();
  });

  it("keyword mode surfaces an error when the content search throws", async () => {
    searchFileContentMock.mockRejectedValue(new Error("Keyword search failed"));
    render(<SearchBar onPickResult={vi.fn()} />);

    selectMode(/keyword/i);
    fireEvent.change(screen.getByPlaceholderText(/search files/i), {
      target: { value: "boom" },
    });

    expect(await screen.findByText(/Keyword search failed/i, undefined, { timeout: 1500 }))
      .toBeInTheDocument();
  });
});
