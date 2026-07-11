/**
 * WARP-1139/WARP-1140 — honest search states + result→space mapping.
 *
 * The droplet.local "burrito" report: content search rendered "No content
 * matches" for files the indexer had simply never looked at, and picking a
 * result could land in the wrong space. These specs pin:
 *   - empty-state variants: "still indexing" (explicit FileIndexStatus
 *     counts / zero chunks) vs a genuine "no match";
 *   - the search-unavailable error path renders as an ERROR, not an empty
 *     result list;
 *   - the results popover keeps its raised z-index class (the layering fix
 *     for the dropdown vs the My Files / Household scope tabs);
 *   - resolveSearchResultTarget / toSpaceRelativePath (pure helpers used by
 *     the Files page to open a result in the right space).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { SearchReadinessStatus } from "@/lib/api";

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

vi.mock("./Thumbnail", () => ({
  Thumbnail: () => <div data-testid="thumb" />,
}));

import { searchFileContent, fetchSearchStatus } from "@/lib/api";
import { SearchBar } from "./SearchBar";
import {
  resolveSearchResultTarget,
  toSpaceRelativePath,
} from "./search-target";

const searchFileContentMock = vi.mocked(searchFileContent);
const fetchSearchStatusMock = vi.mocked(fetchSearchStatus);

function readiness(overrides: Partial<SearchReadinessStatus> = {}): SearchReadinessStatus {
  return {
    state: "ready",
    gatewayHealthy: true,
    pgvectorReady: true,
    indexedCount: 10,
    lastIndexedAt: null,
    pendingCount: 0,
    failedCount: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useRealTimers();
  searchFileContentMock.mockReset();
  fetchSearchStatusMock.mockReset();
  useFileSearchMock.mockReset();
  useFileSearchMock.mockReturnValue({ items: [], isLoading: false, error: null });
  fetchSearchStatusMock.mockResolvedValue(readiness());
  searchFileContentMock.mockResolvedValue([]);
});

function selectMode(name: RegExp) {
  fireEvent.click(screen.getByRole("radio", { name }));
}

function typeQuery(value: string) {
  fireEvent.change(screen.getByPlaceholderText(/search files/i), {
    target: { value },
  });
}

describe("SearchBar empty-state honesty (WARP-1139)", () => {
  it("shows 'still indexing N files' when the indexer reports pending files (keyword)", async () => {
    fetchSearchStatusMock.mockResolvedValue(readiness({ pendingCount: 3 }));
    render(<SearchBar onPickResult={vi.fn()} />);

    selectMode(/keyword/i);
    typeQuery("burrito");

    const empty = await screen.findByTestId("content-empty-state", undefined, {
      timeout: 1500,
    });
    expect(empty).toHaveAttribute("data-variant", "still-indexing");
    expect(empty.textContent).toMatch(/still indexing 3 files/i);
    expect(empty.textContent).not.toMatch(/no content matches/i);
  });

  it("shows 'still indexing your files' when zero chunks exist yet (semantic)", async () => {
    fetchSearchStatusMock.mockResolvedValue(
      readiness({ state: "indexing", indexedCount: 0 })
    );
    render(<SearchBar onPickResult={vi.fn()} />);

    selectMode(/semantic/i);
    typeQuery("burrito");

    const empty = await screen.findByTestId("content-empty-state", undefined, {
      timeout: 1500,
    });
    expect(empty).toHaveAttribute("data-variant", "still-indexing");
    expect(empty.textContent).toMatch(/still indexing your files/i);
  });

  it("shows the genuine no-match copy when the index is ready and nothing pends", async () => {
    render(<SearchBar onPickResult={vi.fn()} />);

    selectMode(/keyword/i);
    typeQuery("nothinghere");

    const empty = await screen.findByTestId("content-empty-state", undefined, {
      timeout: 1500,
    });
    expect(empty).toHaveAttribute("data-variant", "no-match");
    expect(empty.textContent).toMatch(/no content matches/i);
  });

  it("tolerates an orchestrator without the new counts (pendingCount omitted)", async () => {
    fetchSearchStatusMock.mockResolvedValue({
      state: "ready",
      gatewayHealthy: true,
      pgvectorReady: true,
      indexedCount: 5,
      lastIndexedAt: null,
    });
    render(<SearchBar onPickResult={vi.fn()} />);

    selectMode(/semantic/i);
    typeQuery("nothinghere");

    const empty = await screen.findByTestId("content-empty-state", undefined, {
      timeout: 1500,
    });
    expect(empty).toHaveAttribute("data-variant", "no-match");
  });

  it("renders search-unavailable as an ERROR, never an empty result list", async () => {
    // api.ts now throws on 503 instead of returning [] (the old behaviour
    // masked a down gateway as "No content matches").
    searchFileContentMock.mockRejectedValue(
      new Error(
        "Content search is unavailable right now — the AI search stack may still be starting."
      )
    );
    render(<SearchBar onPickResult={vi.fn()} />);

    selectMode(/semantic/i);
    typeQuery("burrito");

    expect(
      await screen.findByText(/content search is unavailable/i, undefined, {
        timeout: 1500,
      })
    ).toBeInTheDocument();
    expect(screen.queryByTestId("content-empty-state")).not.toBeInTheDocument();
  });

  it("keeps the raised z-index class on the results popover (scope-tab layering fix)", async () => {
    searchFileContentMock.mockResolvedValue([
      { path: "/Docs/burrito.txt", score: 0.9, text: "burrito text" },
    ]);
    render(<SearchBar onPickResult={vi.fn()} />);

    selectMode(/keyword/i);
    typeQuery("burrito");

    await screen.findByText(/burrito text/i, undefined, { timeout: 1500 });
    // WARP-1066: the popover chrome moved from the old `.dp-card` utility to
    // the indigo shell's `.card` component class — the z-40 layering fix
    // this test guards is unaffected by the rename.
    const popover = screen.getByText(/burrito text/i).closest(".card");
    expect(popover?.className).toContain("z-40");
  });
});

describe("resolveSearchResultTarget / toSpaceRelativePath (WARP-1140)", () => {
  it("maps a path under the shared root to the shared space, prefix stripped", () => {
    expect(resolveSearchResultTarget("/Household/Trips/burrito.txt", "/Household")).toEqual({
      space: "shared",
      path: "/Trips/burrito.txt",
    });
  });

  it("maps the shared root itself to the shared space root", () => {
    expect(resolveSearchResultTarget("/Household", "/Household")).toEqual({
      space: "shared",
      path: "/",
    });
  });

  it("keeps personal paths in the personal space", () => {
    expect(resolveSearchResultTarget("/Docs/burrito.txt", "/Household")).toEqual({
      space: "personal",
      path: "/Docs/burrito.txt",
    });
  });

  it("does NOT treat a sibling folder with the prefix as shared (no /Householdish match)", () => {
    expect(resolveSearchResultTarget("/Householdish/x.txt", "/Household")).toEqual({
      space: "personal",
      path: "/Householdish/x.txt",
    });
  });

  it("resolves everything to personal when the shared space is unavailable", () => {
    expect(resolveSearchResultTarget("/Household/Trips/x.txt", null)).toEqual({
      space: "personal",
      path: "/Household/Trips/x.txt",
    });
  });

  it("strips exactly ONE leading prefix (nested child named like the root survives)", () => {
    expect(toSpaceRelativePath("/Household/Household/x.txt", "/Household")).toBe(
      "/Household/x.txt"
    );
  });

  it("passes non-shared paths through toSpaceRelativePath verbatim", () => {
    expect(toSpaceRelativePath("/Docs/a.txt", "/Household")).toBe("/Docs/a.txt");
    expect(toSpaceRelativePath("/Docs/a.txt", null)).toBe("/Docs/a.txt");
  });
});
