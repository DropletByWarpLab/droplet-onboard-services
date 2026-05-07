/**
 * /knowledge — page-level tab + URL-param tests. The three tab
 * components are tested individually below; here we verify only the
 * tab-switching, URL round-trip, and the layout shell.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

// ─────────────────────────────────────────────────────────────────────────
// Module mocks. All hoisted so they install before any import below.
// ─────────────────────────────────────────────────────────────────────────

const replaceMock = vi.fn();
const searchParamsMock = vi.fn(() => ({
  get: (_k: string): string | null => null,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: replaceMock, back: vi.fn() }),
  useSearchParams: () => searchParamsMock(),
  usePathname: () => "/knowledge",
}));

vi.mock("next/link", () => ({
  default: ({ children, ...props }: any) => {
    const React = require("react");
    return React.createElement("a", props, children);
  },
}));

vi.mock("@/lib/api", () => ({
  getRecentFiles: vi.fn().mockResolvedValue({ items: [], nextBefore: null }),
  searchKnowledge: vi.fn().mockResolvedValue({ hits: [] }),
  getBrainMemoryItems: vi.fn().mockResolvedValue({ items: [], unavailable: true }),
}));

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn().mockResolvedValue({
    ok: false,
    status: 404,
    json: async () => ({}),
  }),
}));

import KnowledgePage from "@/app/knowledge/page";

function setSearchParam(map: Record<string, string>) {
  searchParamsMock.mockReturnValue({
    get: (k: string) => (k in map ? map[k] : null),
  } as any);
}

describe("KnowledgePage", () => {
  beforeEach(() => {
    cleanup();
    replaceMock.mockClear();
    searchParamsMock.mockReset();
    setSearchParam({});
  });

  it("renders the heading and the three tabs", async () => {
    render(<KnowledgePage />);
    expect(
      await screen.findByRole("heading", { name: /knowledge/i })
    ).toBeInTheDocument();
    expect(screen.getByTestId("knowledge-tab-recent")).toBeInTheDocument();
    expect(screen.getByTestId("knowledge-tab-search")).toBeInTheDocument();
    expect(screen.getByTestId("knowledge-tab-brain")).toBeInTheDocument();
  });

  it("defaults to the Recently indexed tab when no ?tab param is set", async () => {
    render(<KnowledgePage />);
    const recentTab = await screen.findByTestId("knowledge-tab-recent");
    expect(recentTab.getAttribute("aria-selected")).toBe("true");
  });

  it("respects an initial ?tab=search URL param", async () => {
    setSearchParam({ tab: "search" });
    render(<KnowledgePage />);
    const searchTab = await screen.findByTestId("knowledge-tab-search");
    expect(searchTab.getAttribute("aria-selected")).toBe("true");
    // Search input visible
    expect(screen.getByTestId("knowledge-search-input")).toBeInTheDocument();
  });

  it("falls back to the Recently indexed tab when ?tab is unrecognised", async () => {
    setSearchParam({ tab: "garbage" });
    render(<KnowledgePage />);
    const recentTab = await screen.findByTestId("knowledge-tab-recent");
    expect(recentTab.getAttribute("aria-selected")).toBe("true");
  });

  it("syncs the active tab into the URL on change", async () => {
    render(<KnowledgePage />);
    const brainTab = await screen.findByTestId("knowledge-tab-brain");
    fireEvent.click(brainTab);
    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalled();
    });
    const url = replaceMock.mock.calls[replaceMock.mock.calls.length - 1][0];
    expect(url).toContain("tab=brain");
  });

  it("hydrates the search input from ?q= and round-trips it back to the URL", async () => {
    setSearchParam({ tab: "search", q: "lasagna" });
    render(<KnowledgePage />);
    const input = (await screen.findByTestId(
      "knowledge-search-input"
    )) as HTMLInputElement;
    expect(input.value).toBe("lasagna");

    fireEvent.change(input, { target: { value: "tagliatelle" } });
    fireEvent.submit(input.closest("form")!);

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalled();
    });
    const url = replaceMock.mock.calls[replaceMock.mock.calls.length - 1][0];
    expect(url).toContain("tab=search");
    expect(url).toContain("q=tagliatelle");
  });

  it("preserves source + since params when switching tabs", async () => {
    setSearchParam({
      tab: "recent",
      source: "brain",
      since: "2026-04-01T00:00:00.000Z",
    });
    render(<KnowledgePage />);
    const searchTab = await screen.findByTestId("knowledge-tab-search");
    fireEvent.click(searchTab);
    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalled();
    });
    const url = replaceMock.mock.calls[replaceMock.mock.calls.length - 1][0];
    expect(url).toContain("source=brain");
    expect(url).toContain("since=");
  });
});
