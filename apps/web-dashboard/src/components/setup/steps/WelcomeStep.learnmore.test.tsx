/**
 * WARP-914 — the FIRST setup page (WelcomeStep) must carry a working
 * "Learn more" affordance.
 *
 * Field report: the welcome page had NO "Learn more" link at all, so a
 * customer who wanted to understand what Droplet is / that the AI runs
 * locally / how privacy works had nowhere to go. Every other wizard step
 * already uses the shared `LearnMoreCard`, whose "Learn more" link points at
 * `/help#<anchor>` and opens in a NEW TAB (WARP-930 — a same-tab nav to /help
 * remounts the wizard and wipes the in-progress step).
 *
 * These tests pin the fix: WelcomeStep renders a "Learn more" link to
 * `/help#privacy`, opening in a new tab with the safe rel.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { WelcomeStep } from "./WelcomeStep";

// LearnMoreCard re-derives its open state from matchMedia in a post-mount
// effect; stub it so the card renders deterministically (tall → expanded, so
// the link is visible/in the DOM without a click).
function mockMatchMedia(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

describe("WelcomeStep — Learn more (WARP-914)", () => {
  const original = window.matchMedia;
  beforeEach(() => {
    vi.clearAllMocks();
    mockMatchMedia(true); // tall viewport → card expanded, link in the DOM
  });
  afterEach(() => {
    window.matchMedia = original;
  });

  it("renders a 'Learn more' link that deep-links to /help#privacy", () => {
    render(<WelcomeStep onContinue={vi.fn()} />);
    const link = screen.getByRole("link", { name: /learn more/i });
    expect(link).toHaveAttribute("href", "/help#privacy");
  });

  it("opens the help destination in a new tab so the wizard isn't remounted (WARP-930)", () => {
    render(<WelcomeStep onContinue={vi.fn()} />);
    const link = screen.getByRole("link", { name: /learn more/i });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  // WARP-1810 — the "What is Droplet?" expander speaks the business register,
  // aligned with the rewritten headline claim: the subjects are "connected
  // devices" (not "smart-home control") and the locative is "your premises"
  // (never "home").
  it("describes Droplet in the business register — premises, never 'home'", () => {
    render(<WelcomeStep onContinue={vi.fn()} />);
    expect(
      screen.getByText(/never leaves your premises/i),
    ).toBeInTheDocument();
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/leaves home/i);
    expect(text).not.toMatch(/smart-home control/i);
  });
});
