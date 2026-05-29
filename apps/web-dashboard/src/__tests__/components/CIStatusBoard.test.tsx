/**
 * WARP-300 audit — <CIStatusBoard>.
 *
 * Audit decision: the only `opacity-0 group-hover:opacity-100` on this
 * surface is the decorative `ExternalLink` glyph layered inside the
 * card's parent `<a>`. The card itself is the single actionable
 * target, gets its accessible name from `workflow_name`, and is
 * reachable for touch + keyboard via the link role. The glyph carries
 * `aria-hidden="true"` so it's never announced — it's a hover/focus
 * progressive-enhancement cue, not the discovery channel for an
 * action. Per WARP-300 AC, this surface is a documented exception
 * rather than a migration.
 *
 * Invariants enforced here:
 *   - Each CI run renders as an `<a>` (single actionable target).
 *   - The link's accessible name is `workflow_name` (no hover required
 *     to discover what the row points at).
 *   - The decorative glyph keeps `aria-hidden`.
 *   - The reveal pattern includes `group-focus-within:opacity-100` so
 *     keyboard users tabbing onto the card also get the hover cue.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";

import { CIStatusBoard } from "@/components/claude-activity/CIStatusBoard";
import type { GitHubCIRun } from "@/components/claude-activity/types";

function makeRun(overrides: Partial<GitHubCIRun> = {}): GitHubCIRun {
  return {
    id: 1,
    workflow_name: "test-suite",
    branch: "main",
    event: "push",
    status: "completed",
    conclusion: "success",
    url: "https://example.com/run/1",
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("CIStatusBoard — WARP-300 audit (decorative hover cue, not a migration)", () => {
  it("renders each run as a single actionable link named by workflow_name", () => {
    render(<CIStatusBoard runs={[makeRun({ workflow_name: "test-suite" })]} />);

    const link = screen.getByRole("link", { name: /test-suite/i });
    expect(link).toBeInTheDocument();
    expect(link.tagName).toBe("A");
    // Accessible name comes from visible text — no hover required to
    // discover what the row links to.
    expect(link).toHaveTextContent(/test-suite/i);
  });

  it("the hover-revealed ExternalLink glyph is aria-hidden (decorative only)", () => {
    const { container } = render(
      <CIStatusBoard runs={[makeRun({ workflow_name: "test-suite" })]} />,
    );

    // Locate the opacity-0 element — it should be the decorative
    // external-link icon, and it must carry aria-hidden so it is
    // never announced to screen readers.
    const hidden = container.querySelector(".opacity-0");
    expect(hidden).not.toBeNull();
    expect(hidden?.getAttribute("aria-hidden")).toBe("true");
  });

  it("reveal pattern includes focus-within so keyboard users get the cue", () => {
    const { container } = render(
      <CIStatusBoard runs={[makeRun({ workflow_name: "test-suite" })]} />,
    );

    const hidden = container.querySelector(".opacity-0");
    // group-focus-within:opacity-100 keeps the glyph visible when the
    // parent <a> is focused via Tab, not just hovered.
    expect(hidden?.getAttribute("class") ?? "").toMatch(/group-focus-within:opacity-100/);
  });
});
