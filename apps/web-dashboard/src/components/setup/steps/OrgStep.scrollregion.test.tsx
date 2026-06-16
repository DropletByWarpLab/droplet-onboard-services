/**
 * Workspace (Org) step — fits the panel without an inner scroll cap.
 *
 * WARP-820 wrapped this fixed-content form in a <ScrollRegion> capped at
 * `max-h-[44dvh]`. On a desktop viewport that crushed the form into 44% of the
 * screen and forced an inner scrollbar with empty space below — the opposite of
 * the ticket's "zero scroll" goal. The form is fixed-content (not an unbounded
 * list), so it no longer uses a ScrollRegion; the StepShell content panel is
 * scroll-when-needed instead, so a normal viewport shows no scrollbar and a
 * viewport too short scrolls the whole panel rather than clipping.
 *
 * jsdom can't measure layout, so these are STRUCTURE assertions: every field —
 * including the bottom-most privacy footnote — renders and is reachable, and the
 * form is NOT trapped inside a height-capped scroll region.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { OrgStep } from "./OrgStep";

describe("OrgStep fits without an inner scroll cap", () => {
  it("renders the workspace form directly, not inside a height-capped scroll region", () => {
    render(<OrgStep onComplete={() => {}} />);

    // The form's top field renders…
    expect(screen.getByPlaceholderText("Acme HQ")).toBeInTheDocument();

    // …and it is NOT wrapped in the old bounded scroll region (no 44dvh cap).
    expect(
      screen.queryByRole("region", { name: /workspace details/i }),
    ).toBeNull();
  });

  it("keeps the bottom-most privacy footnote reachable (not clipped)", () => {
    render(<OrgStep onComplete={() => {}} />);
    // The "nothing is sent off the box" footnote is the lowest content — the bit
    // that used to clip — so it must still render.
    expect(screen.getByText(/nothing is sent off the box/i)).toBeInTheDocument();
  });
});
