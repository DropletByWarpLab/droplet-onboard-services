/**
 * WARP-225 — StatCards smoke test.
 * WARP-2056 — the "Not indexed" card.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatCards } from "../StatCards";

describe("<StatCards />", () => {
  it("renders all 5 labels even when values are 0", () => {
    render(<StatCards files={0} chunks={0} queued={0} skipped={0} failed={0} />);
    expect(screen.getByText(/Files/)).toBeInTheDocument();
    expect(screen.getByText(/Chunks/)).toBeInTheDocument();
    expect(screen.getByText(/Queued/)).toBeInTheDocument();
    expect(screen.getByText(/Not indexed/)).toBeInTheDocument();
    expect(screen.getByText(/Failed/)).toBeInTheDocument();
  });

  it("renders without crashing with high values", () => {
    render(
      <StatCards files={847} chunks={142309} queued={2} skipped={9} failed={1} />,
    );
    // The tabular-nums class should be present on the counter spans.
    expect(document.querySelectorAll(".tabular-nums").length).toBe(5);
  });

  it("surfaces the not-indexed count, so `files` is never read as searchable", () => {
    // The gap this card exists to close: 622 known, 505 searchable.
    render(
      <StatCards files={622} chunks={6141} queued={0} skipped={117} failed={0} />,
    );

    const card = screen.getByText(/Not indexed/).closest("div");
    expect(card).not.toBeNull();
    expect(card).toHaveTextContent("117");
  });

  it("does not colour a skip as an error — it is normal for photos", () => {
    render(
      <StatCards files={10} chunks={5} queued={0} skipped={4} failed={0} />,
    );

    const card = screen.getByText(/Not indexed/).closest("div");
    expect(card?.querySelector(".text-system-red")).toBeNull();
  });
});
