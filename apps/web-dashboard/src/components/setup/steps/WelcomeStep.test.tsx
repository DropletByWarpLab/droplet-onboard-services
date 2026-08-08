/**
 * WARP-913 — first-page privacy claim.
 *
 * The very first thing a first-time customer reads is the WelcomeStep privacy
 * claim. Before WARP-913 it rendered in the dim `text-label-secondary` token
 * with verbose, jargon-leaning copy, so the single most important promise of
 * the product (your data stays on your premises) read as quiet fine-print.
 *
 * These tests pin the fix: the claim is rendered in a prominent design-system
 * token (NOT the dim secondary one) and in plain, first-time-reader language
 * that stays truthful to the product — local AI on your own hardware, nothing
 * leaves your premises. The supporting trust content stays intact.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { WelcomeStep } from "./WelcomeStep";

describe("WelcomeStep privacy claim (WARP-913)", () => {
  it("renders the privacy claim in a prominent token, not the dim secondary one", () => {
    render(<WelcomeStep onContinue={vi.fn()} />);

    const claim = screen.getByTestId("welcome-privacy-claim");

    // (a) prominence: moved OFF the dim secondary token onto the brighter
    // primary label token (full-opacity #000/#fff), and emphasised in weight.
    expect(claim).not.toHaveClass("text-label-secondary");
    expect(claim).toHaveClass("text-label-primary");
    expect(claim.className).toMatch(/type-(headline|title)/);
  });

  it("rewrites the claim in plain, truthful first-time-reader language", () => {
    render(<WelcomeStep onContinue={vi.fn()} />);

    const claim = screen.getByTestId("welcome-privacy-claim");
    const text = claim.textContent ?? "";

    // Plain language: speaks to a first-time reader, no "powered by local AI
    // running on your hardware" jargon clause leading the sentence.
    // WARP-1810: business build — locative is "on your premises", not "in your
    // home"; the subjects are "connected devices", not "smart home".
    expect(text.toLowerCase()).toMatch(/stays? on your premises/);
    expect(text.toLowerCase()).not.toMatch(/in your home/);
    expect(text.toLowerCase()).toContain("never leaves");
    // Still truthful to the product: the AI is local / on your own hardware.
    expect(text.toLowerCase()).toMatch(/your own (droplet|hardware)|on your droplet/);
  });

  it("keeps the supporting trust content and the Get Started CTA", () => {
    render(<WelcomeStep onContinue={vi.fn()} />);

    expect(
      screen.getByRole("button", { name: /get started/i }),
    ).toBeInTheDocument();
    // The supporting trust chips stay.
    expect(screen.getByText(/nothing leaves the box/i)).toBeInTheDocument();
  });
});
