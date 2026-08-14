/**
 * WARP-1914 — per-mode search failures must surface per-mode copy.
 *
 * QA repro: Semantic search for "dental" rendered the generic files banner
 * ("We couldn't load those files right now. Try again in a moment.") instead
 * of saying Semantic search is unavailable. Root cause on this side: every
 * search failure translated through the "files" domain, whose fallback is
 * the file-LOADING copy — and `translateError` never surfaces `err.message`,
 * so the orchestrator's specific reason was discarded.
 *
 * These specs run the REAL `friendly-errors` translator and the REAL
 * `useFileSearch` hook (only the api module is mocked) so the flattening
 * defect is visible: each mode must render copy that names the mode, and the
 * generic files banner must never appear for a search failure. A semantic
 * SUCCESS spec completes the per-mode result coverage (Name and Keyword
 * successes are pinned in SearchBar.mode-toggle.test.tsx).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("@/lib/api", () => ({
  searchFiles: vi.fn(),
  searchFileContent: vi.fn(),
  fetchSearchStatus: vi.fn(),
}));

vi.mock("./Thumbnail", () => ({
  Thumbnail: () => <div data-testid="thumb" />,
}));

import { searchFiles, searchFileContent, fetchSearchStatus } from "@/lib/api";
import { SearchBar } from "./SearchBar";

const searchFilesMock = vi.mocked(searchFiles);
const searchFileContentMock = vi.mocked(searchFileContent);
const fetchSearchStatusMock = vi.mocked(fetchSearchStatus);

const GENERIC_FILES_BANNER = /couldn't load those files/i;

/** Error shaped like api.ts's FileSearchError (status + wire code on Error). */
function wireError(status: number, code?: string, message = "boom"): Error {
  return Object.assign(new Error(message), { status, code });
}

function selectMode(name: RegExp) {
  fireEvent.click(screen.getByRole("radio", { name }));
}

function typeQuery(value: string) {
  fireEvent.change(screen.getByPlaceholderText(/search files/i), {
    target: { value },
  });
}

beforeEach(() => {
  vi.useRealTimers();
  searchFilesMock.mockReset();
  searchFileContentMock.mockReset();
  fetchSearchStatusMock.mockReset();
  searchFilesMock.mockResolvedValue([]);
  searchFileContentMock.mockResolvedValue([]);
  fetchSearchStatusMock.mockResolvedValue({
    state: "ready",
    gatewayHealthy: true,
    pgvectorReady: true,
    indexedCount: 10,
    lastIndexedAt: null,
    pendingCount: 0,
    failedCount: 0,
  });
});

describe("SearchBar per-mode error states (WARP-1914)", () => {
  it("semantic failure renders Semantic-specific copy, never the generic files banner", async () => {
    searchFileContentMock.mockRejectedValue(
      wireError(503, "semantic_unavailable", "Embedding service unavailable"),
    );
    render(<SearchBar onPickResult={vi.fn()} />);

    selectMode(/semantic/i);
    typeQuery("dental");

    expect(
      await screen.findByText(/semantic search isn't available/i, undefined, {
        timeout: 2500,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText(GENERIC_FILES_BANNER)).toBeNull();
  });

  it("keyword failure renders Keyword-specific copy, never the generic files banner", async () => {
    searchFileContentMock.mockRejectedValue(wireError(500));
    render(<SearchBar onPickResult={vi.fn()} />);

    selectMode(/keyword/i);
    typeQuery("dental");

    expect(
      await screen.findByText(/keyword search isn't working/i, undefined, {
        timeout: 2500,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText(GENERIC_FILES_BANNER)).toBeNull();
  });

  it("name-mode failure renders search copy, never the generic files banner", async () => {
    searchFilesMock.mockRejectedValue(wireError(500));
    render(<SearchBar onPickResult={vi.fn()} />);

    // Default mode is Name (filename) — just type.
    typeQuery("dental");

    expect(
      await screen.findByText(/couldn't search your files/i, undefined, {
        timeout: 2500,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText(GENERIC_FILES_BANNER)).toBeNull();
  });

  it("semantic success renders the matched file with its score (regression pin)", async () => {
    searchFileContentMock.mockResolvedValue([
      {
        path: "/Dental Hygenists/hygiene-plan.pdf",
        score: 0.87,
        text: "…dental hygiene visit schedule…",
      },
    ]);
    render(<SearchBar onPickResult={vi.fn()} />);

    selectMode(/semantic/i);
    typeQuery("dental");

    expect(
      await screen.findByText(/hygiene-plan\.pdf/i, undefined, { timeout: 2500 }),
    ).toBeInTheDocument();
    expect(screen.getByText("87%")).toBeInTheDocument();
  });
});
