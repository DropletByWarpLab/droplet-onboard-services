/**
 * WARP-820 (review finding #3) — OrgStep's form (logo + name, the
 * droplet.local slug, three selects, the "nothing leaves the box" privacy
 * footnote, the help card) is taller than a short landscape phone (~568px), and
 * the setup panel is now `overflow-hidden`. Without a scroll surface the privacy
 * footnote + help card clip off the bottom. The form body therefore lives inside
 * a <ScrollRegion> — the wizard's single permitted scroll surface — so it
 * scrolls within the panel instead of clipping. Title + CTA stay pinned in the
 * StepShell.
 *
 * Structure assertion (jsdom can't measure scroll): the form fields render
 * INSIDE the labelled scroll region, and that region carries the bounded-scroll
 * classes. Mirrors DiscoveryStep/TeamStep.scrollregion.test.tsx.
 */
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { OrgStep } from "./OrgStep";

describe("OrgStep form in ScrollRegion (WARP-820)", () => {
  it("renders the workspace form inside a bounded, labelled scroll region", () => {
    render(<OrgStep onComplete={() => {}} />);

    const region = screen.getByRole("region", { name: /workspace details/i });
    // The workspace-name field is at the top of the form body.
    expect(
      within(region).getByPlaceholderText("Acme HQ"),
    ).toBeInTheDocument();

    // …and the region is the bounded-scroll surface.
    expect(region.className).toContain("overflow-y-auto");
    expect(region.className).toContain("overscroll-contain");
    expect(region.className).toMatch(/max-h-\[[^\]]*(vh|dvh|svh)\]/);
  });

  it("keeps the privacy footnote reachable inside the scroll region", () => {
    render(<OrgStep onComplete={() => {}} />);

    const region = screen.getByRole("region", { name: /workspace details/i });
    // The "nothing is sent off the box" footnote is the bottom-most content most
    // at risk of clipping; it must be inside the scrollable region.
    expect(
      within(region).getByText(/nothing is sent off the box/i),
    ).toBeInTheDocument();
  });
});
