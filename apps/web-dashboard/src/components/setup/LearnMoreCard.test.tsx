/**
 * WARP-820 — LearnMoreCard becomes a disclosure that COLLAPSES on short
 * viewports to recover vertical budget for the zero-scroll wizard, while
 * staying expanded (open) on tall viewports so desktop discoverability is
 * unchanged.
 *
 * It renders a native <details>/<summary> (accessible, keyboard-operable, works
 * with no JS); the only JS is choosing the INITIAL open state from a
 * `min-height` media query. jsdom lets us drive `matchMedia`, so these tests
 * assert: tall → open, short → collapsed, and the content/title/help link are
 * always present in the DOM.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LearnMoreCard } from "./LearnMoreCard";

/** Install a matchMedia stub where the given query strings report `matches`. */
function mockMatchMedia(matches: (query: string) => boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: matches(query),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

describe("LearnMoreCard disclosure (WARP-820)", () => {
  const original = window.matchMedia;
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    window.matchMedia = original;
  });

  it("renders as a native details/summary disclosure with the title in the summary", () => {
    mockMatchMedia(() => true); // tall
    const { container } = render(
      <LearnMoreCard>
        <p>helpful body</p>
      </LearnMoreCard>,
    );
    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    // The toggle (summary) carries the question title.
    expect(
      screen.getByText("How does this work?").closest("summary"),
    ).not.toBeNull();
    // Body content is always in the DOM.
    expect(screen.getByText("helpful body")).toBeInTheDocument();
  });

  it("starts EXPANDED on a tall viewport (min-height matches)", () => {
    mockMatchMedia((q) => q.includes("min-height")); // tall: min-height matches
    const { container } = render(
      <LearnMoreCard>
        <p>helpful body</p>
      </LearnMoreCard>,
    );
    expect(container.querySelector("details")).toHaveAttribute("open");
  });

  it("starts COLLAPSED on a short viewport (min-height does not match)", () => {
    mockMatchMedia(() => false); // short: min-height does NOT match
    const { container } = render(
      <LearnMoreCard>
        <p>helpful body</p>
      </LearnMoreCard>,
    );
    expect(container.querySelector("details")).not.toHaveAttribute("open");
  });

  it("can be toggled open by the user when it started collapsed", () => {
    mockMatchMedia(() => false); // short → collapsed
    const { container } = render(
      <LearnMoreCard>
        <p>helpful body</p>
      </LearnMoreCard>,
    );
    const details = container.querySelector("details")!;
    expect(details).not.toHaveAttribute("open");
    // Native <details> toggles on summary click (jsdom honours this).
    fireEvent.click(screen.getByText("How does this work?"));
    expect(details).toHaveAttribute("open");
  });

  it("still renders a custom title and the help link", () => {
    mockMatchMedia(() => true);
    render(
      <LearnMoreCard title="How to use this on your phone" helpAnchor="roles">
        <p>body</p>
      </LearnMoreCard>,
    );
    expect(
      screen.getByText("How to use this on your phone"),
    ).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /learn more/i });
    expect(link).toHaveAttribute("href", "/help#roles");
  });
});
