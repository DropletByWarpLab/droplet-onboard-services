import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ children, ...props }: any) => {
    const React = require("react");
    return React.createElement("a", props, children);
  },
}));

const searchKnowledgeMock = vi.fn();
vi.mock("@/lib/api", () => ({
  searchKnowledge: (...args: any[]) => searchKnowledgeMock(...args),
}));

import { SearchTab } from "@/app/knowledge/SearchTab";

describe("SearchTab", () => {
  beforeEach(() => {
    cleanup();
    searchKnowledgeMock.mockReset();
  });

  it("renders the input and the helper text in idle state", () => {
    render(<SearchTab />);
    expect(screen.getByTestId("knowledge-search-input")).toBeInTheDocument();
    expect(screen.getByText(/Type at least 2 characters/)).toBeInTheDocument();
  });

  it("disables the submit button until 2+ chars are entered", () => {
    render(<SearchTab />);
    const button = screen.getByRole("button", { name: /search/i });
    expect(button).toBeDisabled();
    const input = screen.getByTestId("knowledge-search-input");
    fireEvent.change(input, { target: { value: "hi" } });
    expect(button).not.toBeDisabled();
  });

  it("calls searchKnowledge on submit and renders the hits", async () => {
    searchKnowledgeMock.mockResolvedValue({
      hits: [
        {
          source: "nextcloud",
          path: "/docs/spec.pdf",
          score: 0.7,
          snippet: "the answer is 42",
          pageNumber: 5,
          brainItemId: null,
        },
      ],
    });
    render(<SearchTab />);
    const input = screen.getByTestId("knowledge-search-input");
    fireEvent.change(input, { target: { value: "answer" } });
    fireEvent.submit(input.closest("form")!);
    const list = await screen.findByTestId("knowledge-search-results");
    expect(list).toBeInTheDocument();
    expect(list.textContent).toContain("the answer is 42");
    expect(list.textContent).toContain("spec.pdf");
  });

  /**
   * WARP-1603 — /knowledge is the second consumer of `relevancePct`, and
   * its hits come off the orchestrator's `/api/files/knowledge/search`
   * route, which still returns RAW BGE-reranker logits. The renderer-side
   * fix has to hold here too: a negative logit is a weak match, not a 0%
   * one.
   */
  it("renders a negative reranker logit as a small-but-nonzero percent", async () => {
    searchKnowledgeMock.mockResolvedValue({
      hits: [
        {
          source: "nextcloud",
          path: "/docs/spec.pdf",
          score: -1, // sigmoid(-1) ≈ 0.269 → 27%
          snippet: "the answer is 42",
          pageNumber: 5,
          brainItemId: null,
        },
      ],
    });
    render(<SearchTab />);
    const input = screen.getByTestId("knowledge-search-input");
    fireEvent.change(input, { target: { value: "answer" } });
    fireEvent.submit(input.closest("form")!);
    const list = await screen.findByTestId("knowledge-search-results");
    expect(list.textContent).toContain("27%");
    expect(list.textContent).not.toContain("0%");
  });

  it("renders the persona-on-tone unavailable card when WARP-202 hasn't merged", async () => {
    searchKnowledgeMock.mockResolvedValue({
      unavailable: true,
      retryAfterSeconds: 30,
    });
    render(<SearchTab />);
    const input = screen.getByTestId("knowledge-search-input");
    fireEvent.change(input, { target: { value: "lasagna" } });
    fireEvent.submit(input.closest("form")!);
    const card = await screen.findByTestId("knowledge-search-unavailable");
    expect(card.textContent).toMatch(/Search will be online soon/);
  });

  it("renders an empty-results card when the hit list is empty", async () => {
    searchKnowledgeMock.mockResolvedValue({ hits: [] });
    render(<SearchTab />);
    const input = screen.getByTestId("knowledge-search-input");
    fireEvent.change(input, { target: { value: "lasagna" } });
    fireEvent.submit(input.closest("form")!);
    const card = await screen.findByTestId("knowledge-search-empty");
    expect(card.textContent).toMatch(/No matches/);
  });

  it("auto-runs an initial query passed via props", async () => {
    searchKnowledgeMock.mockResolvedValue({ hits: [] });
    render(<SearchTab initialQuery="bootstrapped" />);
    await waitFor(() => {
      expect(searchKnowledgeMock).toHaveBeenCalled();
    });
    expect(searchKnowledgeMock.mock.calls[0][0]).toMatchObject({
      q: "bootstrapped",
    });
  });
});
