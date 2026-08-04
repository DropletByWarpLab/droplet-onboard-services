/**
 * WARP-1605 — the thinking message row and its per-step disclosure.
 *
 * The safety line is the important one here: making the *shape* of the model's
 * work visible must not make the model's *words* visible. Every test that
 * touches the trace text asserts it is absent until the user opts in.
 */
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { ThinkingMessage } from "./ThinkingMessage";
import { ReasoningDisclosure } from "./ReasoningDisclosure";
import { REASONING_STEP_SEPARATOR } from "./reasoning-trace";

const TWO_STEPS = [
  "We need the invoice folder first.",
  "Now summarise what came back.",
].join(REASONING_STEP_SEPARATOR);

describe("ThinkingMessage", () => {
  it("renders as its own message row, labelled and separate from any bubble", () => {
    const { container } = render(<ThinkingMessage trace="thinking…" />);
    const row = container.querySelector('[data-testid="assistant-process"]');
    expect(row).not.toBeNull();
    // Same row primitive as a real message (avatar + column) so the thread's
    // rhythm — and its inter-message gap — reads as a separate message…
    expect(row).toHaveClass("msg");
    expect(row!.querySelector(".msg-ava")).not.toBeNull();
    // …but NOT a bubble: a bubble would read as a second reply.
    expect(row!.querySelector(".msg-bubble")).toBeNull();
    expect(
      screen.getByRole("group", { name: /how the assistant worked on this/i }),
    ).toBeInTheDocument();
  });

  it("keeps the trace collapsed by default (harmony analysis safety)", () => {
    render(<ThinkingMessage trace={TWO_STEPS} />);
    const toggle = screen.getByRole("button", { name: /thought process/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/invoice folder/)).not.toBeInTheDocument();
    expect(screen.queryByTestId("reasoning-steps")).not.toBeInTheDocument();
  });

  it("renders the process-phase children (tool chips) alongside the disclosure", () => {
    render(
      <ThinkingMessage trace={TWO_STEPS}>
        <span data-testid="chip">search_files</span>
      </ThinkingMessage>,
    );
    const row = screen.getByTestId("assistant-process");
    // Chips are process, not answer — they live in this row, unconditionally
    // visible (they are not chain-of-thought).
    expect(row).toContainElement(screen.getByTestId("chip"));
  });
});

describe("ReasoningDisclosure — per-step trace (WARP-1605)", () => {
  it("renders nothing at all for an empty trace", () => {
    const { container } = render(<ReasoningDisclosure trace="" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("summarises the step count without revealing any of the text", () => {
    render(<ReasoningDisclosure trace={TWO_STEPS} />);
    const toggle = screen.getByRole("button", { name: /thought process/i });
    expect(toggle).toHaveAttribute("data-step-count", "2");
    expect(toggle.textContent).toContain("2 steps");
    expect(toggle.textContent).not.toContain("invoice");
  });

  it("expands to one discrete, numbered block per step, in order", () => {
    render(<ReasoningDisclosure trace={TWO_STEPS} />);
    fireEvent.click(screen.getByRole("button", { name: /thought process/i }));

    const steps = screen.getAllByTestId("reasoning-step");
    expect(steps).toHaveLength(2);
    expect(steps[0].textContent).toContain("Step 1");
    expect(steps[0].textContent).toContain("We need the invoice folder first.");
    expect(steps[1].textContent).toContain("Step 2");
    expect(steps[1].textContent).toContain("Now summarise what came back.");
    // The two steps are separate elements — not one pre-wrapped blob with the
    // sentinel showing through as literal text.
    expect(steps[0].textContent).not.toContain("--- step ---");
  });

  it("renders a single-step trace exactly as before — no numbering", () => {
    // Pre-WARP-1602 rows, the setup wizard's one-shot probe, and every
    // single-iteration turn take this path.
    const legacy = "I check the docs.\n\nThen I compare options.";
    render(<ReasoningDisclosure trace={legacy} />);
    const toggle = screen.getByRole("button", { name: /thought process/i });
    expect(toggle.textContent).not.toMatch(/steps/);
    fireEvent.click(toggle);
    const steps = screen.getAllByTestId("reasoning-step");
    expect(steps).toHaveLength(1);
    expect(steps[0].textContent).toBe(legacy);
  });

  it("collapses again on a second click", () => {
    render(<ReasoningDisclosure trace={TWO_STEPS} />);
    const toggle = screen.getByRole("button", { name: /thought process/i });
    fireEvent.click(toggle);
    expect(screen.getByTestId("reasoning-steps")).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("reasoning-steps")).not.toBeInTheDocument();
  });
});
