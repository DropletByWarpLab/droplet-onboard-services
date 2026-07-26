/**
 * WARP-1528 (UX pass) — SyncChip's live region.
 *
 * §13 requires the sync-state change to ANNOUNCE. The region used to be
 * created together with its content (an early `return null` when there was
 * nothing to show), so at the moment the state flipped the `role="status"`
 * element did not yet exist in the DOM. Screen readers only reliably announce
 * mutations inside a region they were already observing — creating the region
 * and its content in the same commit makes the announcement a coin-flip across
 * SR/browser pairs. This path is exercised for the first time now that the
 * chip actually renders, so it has to be right.
 *
 * The empty region must also be layout-inert: both call sites are flex rows
 * WITH a gap (`.acc-rolecard .meta` 6px, the role-detail header 12px), so a
 * permanently-mounted empty flex item would inject a phantom gap onto every
 * role card. `display: contents` generates no box while keeping the element —
 * and its explicit, non-generic `status` role — in the accessibility tree.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SyncChip } from "./bits";
import { ACCESS_COPY } from "./copy";

describe("<SyncChip> live region", () => {
  it("mounts the status region even with NOTHING to announce", () => {
    render(<SyncChip state={null} />);
    // Present before any state change — that is the whole point.
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("keeps the region mounted for the resting `synced` value too", () => {
    render(<SyncChip state="synced" />);
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.queryByText(ACCESS_COPY.applied)).not.toBeInTheDocument();
  });

  it("is layout-inert when empty (no phantom flex gap on every role card)", () => {
    render(<SyncChip state={null} />);
    expect(screen.getByRole("status")).toHaveStyle({ display: "contents" });
  });

  it("becomes a real inline-flex box once it has a chip to show", () => {
    render(<SyncChip state="pending" />);
    const region = screen.getByRole("status");
    expect(region).toHaveStyle({ display: "inline-flex" });
    expect(screen.getByText(ACCESS_COPY.applying)).toBeInTheDocument();
  });

  it("announces politely, not assertively (a sync chip must not interrupt)", () => {
    render(<SyncChip state="pending" />);
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
  });

  it("renders the SAME region element across a null → pending transition", () => {
    // The region must survive the state change rather than be replaced, or the
    // SR is observing a node that no longer exists.
    const { rerender } = render(<SyncChip state={null} />);
    const before = screen.getByRole("status");
    rerender(<SyncChip state="pending" />);
    expect(screen.getByRole("status")).toBe(before);
    expect(screen.getByText(ACCESS_COPY.applying)).toBeInTheDocument();
  });

  it("carries the §12 word for each state, never colour alone", () => {
    const { rerender } = render(<SyncChip state="pending" />);
    expect(screen.getByText(ACCESS_COPY.applying)).toBeInTheDocument();
    rerender(<SyncChip state="applied" />);
    expect(screen.getByText(ACCESS_COPY.applied)).toBeInTheDocument();
    rerender(<SyncChip state="failed" />);
    expect(screen.getByText(ACCESS_COPY.needsAttention)).toBeInTheDocument();
  });
});
