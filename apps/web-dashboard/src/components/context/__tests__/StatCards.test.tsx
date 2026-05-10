/**
 * WARP-225 — StatCards smoke test.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatCards } from "../StatCards";

describe("<StatCards />", () => {
  it("renders all 4 labels even when values are 0", () => {
    render(<StatCards files={0} chunks={0} queued={0} failed={0} />);
    expect(screen.getByText(/Files/)).toBeInTheDocument();
    expect(screen.getByText(/Chunks/)).toBeInTheDocument();
    expect(screen.getByText(/Queued/)).toBeInTheDocument();
    expect(screen.getByText(/Failed/)).toBeInTheDocument();
  });

  it("renders without crashing with high values", () => {
    render(
      <StatCards files={847} chunks={142309} queued={2} failed={1} />,
    );
    // The tabular-nums class should be present on the counter spans.
    expect(document.querySelectorAll(".tabular-nums").length).toBe(4);
  });
});
