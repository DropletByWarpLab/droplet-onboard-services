/**
 * WARP-298 — Knowledge tabs WAI-ARIA pattern.
 *
 * Validates the full pattern from
 * https://www.w3.org/WAI/ARIA/apg/patterns/tabs/:
 *   - each tab has id + aria-controls pointing at its panel
 *   - each panel has id + aria-labelledby pointing at its tab
 *   - only the active tab is tabIndex=0
 *   - ArrowLeft / ArrowRight move + activate (manual activation is also OK,
 *     but our implementation uses automatic — assert that).
 *   - Home / End jump to first / last
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";

// Stable singleton for useSearchParams so the page's `useEffect` watching
// it doesn't fire on every render and revert local state.
const _sp = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => _sp,
}));

// Stub out the tab body components so we don't drag their data
// dependencies into this a11y test.
vi.mock("@/app/knowledge/RecentlyIndexedTab", () => ({
  RecentlyIndexedTab: () => <div data-testid="recent-body" />,
}));
vi.mock("@/app/knowledge/SearchTab", () => ({
  SearchTab: () => <div data-testid="search-body" />,
}));
vi.mock("@/app/knowledge/BrainMemoryTab", () => ({
  BrainMemoryTab: () => <div data-testid="brain-body" />,
}));

import KnowledgePage from "@/app/knowledge/page";

describe("Knowledge tabs WAI-ARIA (WARP-298)", () => {
  beforeEach(() => {});

  it("each tab has an id and aria-controls; panel has aria-labelledby", () => {
    render(<KnowledgePage />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.length).toBe(3);
    for (const tab of tabs) {
      expect(tab.id).toBeTruthy();
      const controls = tab.getAttribute("aria-controls");
      expect(controls).toBeTruthy();
      const panel = document.getElementById(controls!);
      expect(panel).not.toBeNull();
      expect(panel!.getAttribute("aria-labelledby")).toBe(tab.id);
    }
  });

  it("only the active tab has tabIndex=0; siblings are tabIndex=-1", () => {
    render(<KnowledgePage />);
    const tabs = screen.getAllByRole("tab");
    const active = tabs.find((t) => t.getAttribute("aria-selected") === "true");
    expect(active).toBeDefined();
    expect(active!.getAttribute("tabindex")).toBe("0");
    for (const t of tabs) {
      if (t !== active) expect(t.getAttribute("tabindex")).toBe("-1");
    }
  });

  it("ArrowRight on the active tab activates the next tab", () => {
    render(<KnowledgePage />);
    const tabs = screen.getAllByRole("tab");
    const first = tabs[0];
    fireEvent.keyDown(first, { key: "ArrowRight" });
    // After activation, the second tab should be aria-selected=true.
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
  });

  it("ArrowLeft from the first tab wraps to the last", () => {
    render(<KnowledgePage />);
    const tabs = screen.getAllByRole("tab");
    fireEvent.keyDown(tabs[0], { key: "ArrowLeft" });
    expect(tabs[tabs.length - 1].getAttribute("aria-selected")).toBe("true");
  });

  it("Home jumps to the first tab, End to the last", () => {
    render(<KnowledgePage />);
    const tabs = screen.getAllByRole("tab");
    fireEvent.keyDown(tabs[1], { key: "End" });
    expect(tabs[tabs.length - 1].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(tabs[tabs.length - 1], { key: "Home" });
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
  });

  it("click still works (mouse users)", () => {
    render(<KnowledgePage />);
    const tabs = screen.getAllByRole("tab");
    fireEvent.click(tabs[2]);
    expect(tabs[2].getAttribute("aria-selected")).toBe("true");
  });
});
