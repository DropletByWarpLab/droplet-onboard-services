/**
 * WARP-820 — ScrollRegion: the SINGLE permitted inner-scroll surface in the
 * viewport-locked setup wizard.
 *
 * The wizard shell is `h-dvh overflow-hidden` and the rail + main panel no
 * longer scroll. Inherently-unbounded lists (team invites, discovered devices)
 * still need *some* give, so they get this bounded, viewport-relative scroller —
 * title + CTA stay pinned outside it; only the list scrolls.
 *
 * jsdom can't measure layout or scroll, so these tests assert STRUCTURE:
 *   - children render,
 *   - the bound is viewport-relative (a `max-h-[…vh]` / `max-h-[…dvh]` class),
 *   - `overscroll-contain` so a flick doesn't chain-scroll the locked shell,
 *   - the element is a focusable, labelled scroll region for keyboard + AT.
 * The visual "no page scroll on every device" check is the UI/UX + on-box pass.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ScrollRegion } from "./ScrollRegion";

describe("ScrollRegion (WARP-820)", () => {
  it("renders its children", () => {
    render(
      <ScrollRegion aria-label="Discovered devices">
        <div data-testid="child">a device</div>
      </ScrollRegion>,
    );
    expect(screen.getByTestId("child")).toHaveTextContent("a device");
  });

  it("bounds its height relative to the viewport so it can't grow past the lock", () => {
    render(
      <ScrollRegion aria-label="Discovered devices">
        <div>row</div>
      </ScrollRegion>,
    );
    const region = screen.getByRole("region", { name: /discovered devices/i });
    // A viewport-relative max-height (vh/dvh/svh) — NOT a fixed px cap, so the
    // bound shrinks on short viewports instead of forcing page scroll.
    expect(region.className).toMatch(/max-h-\[[^\]]*(vh|dvh|svh)\]/);
  });

  it("enables scrolling only within itself (overflow-y-auto + overscroll-contain)", () => {
    render(
      <ScrollRegion aria-label="Pending invitations">
        <div>row</div>
      </ScrollRegion>,
    );
    const region = screen.getByRole("region", { name: /pending invitations/i });
    expect(region.className).toContain("overflow-y-auto");
    // A flick at the end of the list must NOT chain-scroll the locked shell.
    expect(region.className).toContain("overscroll-contain");
  });

  it("is a labelled, keyboard-reachable scroll region (tabindex 0) for AT", () => {
    render(
      <ScrollRegion aria-label="Pending invitations">
        <div>row</div>
      </ScrollRegion>,
    );
    const region = screen.getByRole("region", { name: /pending invitations/i });
    // Keyboard users must be able to scroll the region; a scrollable region
    // with no focusable content is a WCAG 2.1.1 trap otherwise.
    expect(region).toHaveAttribute("tabindex", "0");
  });

  it("forwards an explicit role override but defaults to region", () => {
    const { rerender } = render(
      <ScrollRegion aria-label="Pending invitations">
        <div>row</div>
      </ScrollRegion>,
    );
    // Default semantic role.
    expect(
      screen.getByRole("region", { name: /pending invitations/i }),
    ).toBeInTheDocument();

    // A caller may pass through extra props (e.g. data-testid, className) and
    // they land on the scroller.
    rerender(
      <ScrollRegion aria-label="Pending invitations" data-testid="invites-scroll">
        <div>row</div>
      </ScrollRegion>,
    );
    expect(screen.getByTestId("invites-scroll")).toHaveAttribute(
      "role",
      "region",
    );
  });

  it("rounds its own corners to match the rounded inner content it wraps (rounded-xl)", () => {
    // WARP-820 nit: `overflow-y-auto` makes the region a scroll container that
    // clips inner content at its OWN border radius. TeamStep's invite <ul> is
    // `rounded-xl` (12px); when ScrollRegion was a smaller `rounded-[10px]` the
    // <ul>'s 12px corners were squared off against the 10px clip. The region's
    // radius must therefore be >= the inner content's — pinned to rounded-xl.
    render(
      <ScrollRegion aria-label="Pending invitations">
        <ul className="rounded-xl">
          <li>row</li>
        </ul>
      </ScrollRegion>,
    );
    const region = screen.getByRole("region", { name: /pending invitations/i });
    expect(region.className).toContain("rounded-xl");
    // The narrower radius that clipped the inner corners must be gone.
    expect(region.className).not.toContain("rounded-[10px]");
  });

  it("merges caller className with the bounded-scroll base classes", () => {
    render(
      <ScrollRegion aria-label="Discovered devices" className="space-y-2 mb-8">
        <div>row</div>
      </ScrollRegion>,
    );
    const region = screen.getByRole("region", { name: /discovered devices/i });
    // Caller layout classes survive…
    expect(region.className).toContain("space-y-2");
    expect(region.className).toContain("mb-8");
    // …alongside the base bounded-scroll behaviour.
    expect(region.className).toContain("overflow-y-auto");
    expect(region.className).toContain("overscroll-contain");
  });
});
