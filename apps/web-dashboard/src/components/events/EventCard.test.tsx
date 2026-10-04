/**
 * WARP-3509 — the "All events" tile has the same two defects as the review
 * tile: it named the camera by its Frigate key ("warp lab office") and, when
 * its thumbnail failed, let the alt text print across the badges.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import React from "react";
import { EventCard } from "./EventCard";
import type { EventDetail } from "@/lib/types";

afterEach(() => cleanup());

function makeEvent(overrides: Partial<EventDetail> = {}): EventDetail {
  return {
    id: "1791059989.433851-abc123",
    camera: "warp_lab_office",
    label: "person",
    score: 0.91,
    startTime: 1_800_000_000,
    endTime: 1_800_000_060,
    thumbnail: "/api/cameras/events/1791059989.433851-abc123/thumbnail",
    hasClip: true,
    hasSnapshot: true,
    subLabel: null,
    subLabelScore: null,
    zones: [],
    retainIndefinitely: false,
    clipUrl: "/api/cameras/clips/event/1791059989.433851-abc123",
    snapshotUrl: "/api/cameras/events/1791059989.433851-abc123/snapshot",
    description: null,
    ...overrides,
  };
}

describe("EventCard camera name", () => {
  it("shows the name the household gave the camera, as the filter chip does", () => {
    render(<EventCard event={makeEvent({ camera: "front_door" })} cameraName="Lobby" onClick={vi.fn()} />);

    expect(screen.getByText("Lobby")).toBeInTheDocument();
    expect(screen.queryByText("front door")).toBeNull();
  });

  it("falls back to the prettified key, never the raw lower-case key", () => {
    render(<EventCard event={makeEvent({ camera: "warp_lab_office" })} onClick={vi.fn()} />);

    expect(screen.getByText("Warp Lab Office")).toBeInTheDocument();
    expect(screen.queryByText("warp lab office")).toBeNull();
  });

  it("names the camera by its display name in the thumbnail's alt text too", () => {
    const { container } = render(
      <EventCard event={makeEvent({ camera: "front_door" })} cameraName="Lobby" onClick={vi.fn()} />,
    );

    expect(container.querySelector("img")!.getAttribute("alt")).toBe("person on Lobby");
  });
});

describe("EventCard thumbnail failure", () => {
  it("replaces a thumbnail that fails to load with a placeholder, so alt text cannot print over the badges", () => {
    const { container } = render(<EventCard event={makeEvent()} onClick={vi.fn()} />);

    fireEvent.error(container.querySelector("img")!);

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[data-testid='thumb-fallback']")).not.toBeNull();
    // The badges that were being overprinted are still the card's own.
    expect(screen.getByText("Clip")).toBeInTheDocument();
    expect(screen.getByText("91%")).toBeInTheDocument();
    expect(container.textContent).not.toContain("person on Warp Lab Office");
  });
});

describe("EventCard in-progress event (WARP-3509)", () => {
  it("says 'In progress' on an event that has not ended, so a live event is not a finished one", () => {
    render(<EventCard event={makeEvent({ endTime: null })} onClick={vi.fn()} />);

    expect(screen.getByText("In progress")).toBeInTheDocument();
  });

  it("says it even before Frigate has a clip for it", () => {
    render(<EventCard event={makeEvent({ endTime: null, hasClip: false, clipUrl: null })} onClick={vi.fn()} />);

    expect(screen.getByText("In progress")).toBeInTheDocument();
  });

  it("shows the duration, and not 'In progress', once it has ended", () => {
    render(<EventCard event={makeEvent({ startTime: 1_800_000_000, endTime: 1_800_000_060 })} onClick={vi.fn()} />);

    expect(screen.getByText("1m 0s")).toBeInTheDocument();
    expect(screen.queryByText("In progress")).toBeNull();
  });

  it("tries a thumbnail again once the event has ended: it may only be written then", () => {
    const { container, rerender } = render(<EventCard event={makeEvent({ endTime: null })} onClick={vi.fn()} />);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[data-testid='thumb-fallback']")).not.toBeNull();

    rerender(<EventCard event={makeEvent({ endTime: 1_800_000_060 })} onClick={vi.fn()} />);

    expect(container.querySelector("img")).not.toBeNull();
    expect(container.querySelector("[data-testid='thumb-fallback']")).toBeNull();
  });

  it("does not keep retrying a thumbnail that still fails while nothing has changed", () => {
    const { container, rerender } = render(<EventCard event={makeEvent({ endTime: null })} onClick={vi.fn()} />);
    fireEvent.error(container.querySelector("img")!);

    // The page re-renders the grid on every poll; same event, same end time.
    rerender(<EventCard event={makeEvent({ endTime: null })} onClick={vi.fn()} />);

    expect(container.querySelector("img")).toBeNull();
  });
});

describe("EventCard badges (WARP-3509)", () => {
  it("the Saved badge has a solid fill, not an alpha the stylesheet cannot make", () => {
    render(<EventCard event={makeEvent({ retainIndefinitely: true })} onClick={vi.fn()} />);

    // `bg-system-yellow/90` is a utility Tailwind cannot generate for a colour
    // that is a CSS variable: the badge had no fill at all. Black ink is read
    // against the yellow itself (13.9:1), so the fill has to be there.
    const badge = screen.getByText("Saved").parentElement!;
    expect(badge.className).toMatch(/(^| )bg-system-yellow( |$)/);
    expect(badge.className).not.toMatch(/bg-system-yellow\//);
    expect(badge.className).toContain("text-black");
  });
});
