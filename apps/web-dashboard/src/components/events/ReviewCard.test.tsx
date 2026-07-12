/**
 * WARP-1089 — regression guard for the indigo conversion.
 *
 * The "unreviewed" indicator ring must compose with the focus-visible
 * ring. Expressing it as an inline `style={{ boxShadow }}` (as the first
 * conversion pass did) makes it permanently beat the stylesheet focus
 * ring — inline styles win the cascade — so keyboard users tabbing
 * through unreviewed cards get no focus indicator (focus:outline-none
 * strips the native outline too). The pre-conversion behaviour used a
 * Tailwind ring utility class for BOTH rings so :focus-visible correctly
 * overrode the base ring on focus. These tests lock that mechanism in.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import React from "react";
import { ReviewCard } from "./ReviewCard";
import type { ReviewItem } from "@/lib/types";

afterEach(() => cleanup());

function makeReview(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: "rev-1",
    camera: "front_door",
    startTime: Math.floor(Date.now() / 1000) - 120,
    endTime: Math.floor(Date.now() / 1000) - 60,
    severity: "alert",
    hasBeenReviewed: false,
    objects: ["person"],
    audio: [],
    zones: [],
    detectionIds: ["d1", "d2"],
    previewUrl: null,
    thumbnailUrl: "/thumb.jpg",
    ...overrides,
  };
}

// The base (non-focus) ring utility that expresses the unreviewed
// indicator — `ring-2 ring-[...]` preceded by a boundary so the
// `focus-visible:ring-2` never matches.
const BASE_RING = /(^| )ring-2 ring-\[/;

describe("ReviewCard unreviewed indicator (WARP-1089)", () => {
  it("keeps the focus-visible ring on every card", () => {
    const { container } = render(
      <ReviewCard review={makeReview()} onClick={vi.fn()} />,
    );
    const btn = container.querySelector("button")!;
    expect(btn.className).toContain("focus-visible:ring-2");
    expect(btn.className).toContain("focus-visible:ring-[var(--brand)]");
  });

  it("expresses the unreviewed ring as a composing utility class, not an inline box-shadow", () => {
    const { container } = render(
      <ReviewCard review={makeReview({ hasBeenReviewed: false })} onClick={vi.fn()} />,
    );
    const btn = container.querySelector("button")! as HTMLButtonElement;
    // Regression: an inline box-shadow would unconditionally override the
    // focus-visible ring. There must be none.
    expect(btn.style.boxShadow).toBe("");
    // The indicator must be a base ring utility so :focus-visible can win.
    expect(btn.className).toMatch(BASE_RING);
  });

  it("drops the unreviewed ring once a card has been reviewed", () => {
    const { container } = render(
      <ReviewCard review={makeReview({ hasBeenReviewed: true })} onClick={vi.fn()} />,
    );
    const btn = container.querySelector("button")! as HTMLButtonElement;
    expect(btn.style.boxShadow).toBe("");
    expect(btn.className).not.toMatch(BASE_RING);
  });
});
