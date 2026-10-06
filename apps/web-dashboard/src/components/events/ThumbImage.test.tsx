/**
 * WARP-3509 — a thumbnail that fails to load must not leave its alt text
 * painted across the card.
 *
 * A broken `<img>` renders its `alt` as visible text in its own box. On an
 * event/review card that box is the whole 16:9 tile, under absolutely-placed
 * badges, so "alert on warp lab office" printed through "Alert", "New" and the
 * duration chip. ThumbImage swaps the failed image for an icon on the tile's
 * own (inherited) background, so there is no text left to overlay anything.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import React from "react";
import { ThumbImage } from "./ThumbImage";

afterEach(() => cleanup());

describe("ThumbImage", () => {
  it("renders the image, with its alt text and classes, while it has not failed", () => {
    const { container } = render(
      <ThumbImage src="/thumb.webp" alt="alert on Warp Lab Office" className="w-full h-full" loading="lazy" />,
    );
    const img = container.querySelector("img")!;

    expect(img.getAttribute("src")).toBe("/thumb.webp");
    expect(img.getAttribute("alt")).toBe("alert on Warp Lab Office");
    expect(img.className).toBe("w-full h-full");
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(container.querySelector("[data-testid='thumb-fallback']")).toBeNull();
  });

  it("swaps a failed image for an icon placeholder, and no alt text is left in the DOM", () => {
    const { container } = render(<ThumbImage src="/gone.webp" alt="alert on Warp Lab Office" />);

    fireEvent.error(container.querySelector("img")!);

    expect(container.querySelector("img")).toBeNull();
    const fallback = container.querySelector("[data-testid='thumb-fallback']")!;
    expect(fallback).not.toBeNull();
    expect(fallback.querySelector("svg")).not.toBeNull();
    // Nothing that could print across a badge.
    expect(container.textContent).toBe("");
    expect(container.innerHTML).not.toContain("alert on Warp Lab Office");
  });

  it("hides the placeholder from assistive tech: it is decoration, the card carries the words", () => {
    const { container } = render(<ThumbImage src="/gone.webp" alt="alert on Warp Lab Office" />);

    fireEvent.error(container.querySelector("img")!);

    expect(container.querySelector("[data-testid='thumb-fallback']")!.getAttribute("aria-hidden")).toBe("true");
  });

  it("sizes the placeholder with placeholderClassName and keeps it centred", () => {
    const { container } = render(
      <ThumbImage src="/gone.webp" alt="x" className="object-cover" placeholderClassName="w-full aspect-video" />,
    );

    fireEvent.error(container.querySelector("img")!);

    const fallback = container.querySelector("[data-testid='thumb-fallback']")!;
    expect(fallback.className).toContain("w-full");
    expect(fallback.className).toContain("aspect-video");
    expect(fallback.className).toContain("items-center");
    expect(fallback.className).toContain("justify-center");
    // The image's own classes (hover zoom, object-fit) do not follow it over.
    expect(fallback.className).not.toContain("object-cover");
  });

  it("uses design tokens for the placeholder's colour, never a literal", () => {
    const { container } = render(<ThumbImage src="/gone.webp" alt="x" />);

    fireEvent.error(container.querySelector("img")!);

    const fallback = container.querySelector("[data-testid='thumb-fallback']")!;
    expect(fallback.className).toContain("var(--text-muted)");
    expect(fallback.className).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it("tries the image again when the src changes", () => {
    const { container, rerender } = render(<ThumbImage src="/gone.webp" alt="x" />);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();

    rerender(<ThumbImage src="/other.webp" alt="x" />);

    expect(container.querySelector("img")!.getAttribute("src")).toBe("/other.webp");
    expect(container.querySelector("[data-testid='thumb-fallback']")).toBeNull();
  });
});

describe("ThumbImage retryKey", () => {
  it("tries the preview after a saved snapshot expires and stops after both fail", () => {
    const { container, rerender } = render(<ThumbImage src="/snapshot" fallbackSrc="/thumbnail" alt="person" retryKey={null} />);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toHaveAttribute("src", "/thumbnail");
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    rerender(<ThumbImage src="/snapshot" fallbackSrc="/thumbnail" alt="person" retryKey={null} />);
    expect(container.querySelector("img")).toBeNull();
    rerender(<ThumbImage src="/snapshot" fallbackSrc="/thumbnail" alt="person" retryKey={5} />);
    expect(container.querySelector("img")).toHaveAttribute("src", "/snapshot");
  });

  // Frigate writes an event's thumbnail some time after the event begins, so the
  // first request for an event in progress can 404 and a later one succeed, at
  // the SAME url. A card that remembered the failure for good never showed it.

  it("tries the same url again when the retry key changes", () => {
    const { container, rerender } = render(<ThumbImage src="/t.webp" alt="x" retryKey={null} />);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[data-testid='thumb-fallback']")).not.toBeNull();

    // The event ended: its end time is the new key.
    rerender(<ThumbImage src="/t.webp" alt="x" retryKey={1_800_000_060} />);

    expect(container.querySelector("img")!.getAttribute("src")).toBe("/t.webp");
    expect(container.querySelector("[data-testid='thumb-fallback']")).toBeNull();
  });

  it("does not try again while the key is unchanged: a re-render is not a new chance", () => {
    const { container, rerender } = render(<ThumbImage src="/t.webp" alt="x" retryKey={1_800_000_060} />);
    fireEvent.error(container.querySelector("img")!);

    rerender(<ThumbImage src="/t.webp" alt="x" className="other" retryKey={1_800_000_060} />);

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[data-testid='thumb-fallback']")).not.toBeNull();
  });

  it("a failure after a retry is remembered against the new key, not retried in a loop", () => {
    const { container, rerender } = render(<ThumbImage src="/t.webp" alt="x" retryKey={null} />);
    fireEvent.error(container.querySelector("img")!);
    rerender(<ThumbImage src="/t.webp" alt="x" retryKey={5} />);
    fireEvent.error(container.querySelector("img")!);

    rerender(<ThumbImage src="/t.webp" alt="x" retryKey={5} />);

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[data-testid='thumb-fallback']")).not.toBeNull();
  });

  it("is optional: without one, a failure holds until the src changes", () => {
    const { container, rerender } = render(<ThumbImage src="/t.webp" alt="x" />);
    fireEvent.error(container.querySelector("img")!);

    rerender(<ThumbImage src="/t.webp" alt="x" />);

    expect(container.querySelector("img")).toBeNull();
  });
});
