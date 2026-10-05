/**
 * WARP-3509 — the event modal, with the REAL HlsPlayer, in a browser that plays
 * HLS natively.
 *
 * Chromium answers `canPlayType("application/vnd.apple.mpegurl")` with "maybe",
 * so the player takes its native branch: it sets `video.src` and the <video>
 * element is the only thing that knows when the playlist fails to load. The
 * player used to listen to nothing, and the modal kept a dead player — controls
 * up, nothing to watch, no notice, no picture. This file drives the whole chain
 * the way Chromium does: playlist fails → the element errors → the modal falls
 * back to the snapshot and says why.
 *
 * (EventClipModal.test.tsx stubs HlsPlayer to pin what the modal does with an
 * `onError`; this one pins that a native failure reaches it at all.)
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import React from "react";

vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role: "owner" } }) }));

import { EventClipModal } from "./EventClipModal";
import type { EventDetail } from "@/lib/types";

const ID = "1791059989.433851-abc123";
const HLS = `/api/cameras/events/${ID}/playback.m3u8`;
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

function makeEvent(overrides: Partial<EventDetail> = {}): EventDetail {
  return {
    id: ID,
    camera: "warp_lab_office",
    label: "person",
    score: 0.91,
    startTime: 1_800_000_000,
    endTime: 1_800_000_060,
    thumbnail: `/api/cameras/events/${ID}/thumbnail`,
    hasClip: true,
    hasSnapshot: true,
    subLabel: null,
    subLabelScore: null,
    zones: [],
    retainIndefinitely: false,
    clipUrl: `/api/cameras/clips/event/${ID}`,
    snapshotUrl: `/api/cameras/events/${ID}/snapshot`,
    description: null,
    ...overrides,
  };
}

/** The element fails the way Chromium's does for a playlist that 404s: error code 4, then `error`. */
function failTheLoad() {
  const video = document.querySelector("video")!;
  Object.defineProperty(video, "error", {
    configurable: true,
    value: { code: MEDIA_ERR_SRC_NOT_SUPPORTED, message: "" },
  });
  fireEvent.error(video);
}

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockImplementation((type) =>
    type === "application/vnd.apple.mpegurl" ? "maybe" : "",
  );
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("EventClipModal in a browser with native HLS", () => {
  it("plays the event's playlist in the video element", () => {
    render(<EventClipModal event={makeEvent()} onClose={vi.fn()} />);

    expect(document.querySelector("video")!.getAttribute("src")).toBe(HLS);
    expect(document.querySelector("img")).toBeNull();
  });

  it("a playlist that fails to load falls back to the snapshot, with a notice, instead of a dead player", () => {
    render(<EventClipModal event={makeEvent()} cameraName="Warp Lab Office" onClose={vi.fn()} />);

    failTheLoad();
    failTheLoad();

    expect(document.querySelector("video")).toBeNull();
    expect(document.querySelector("img")!.getAttribute("src")).toBe(`/api/cameras/events/${ID}/snapshot`);
    expect(screen.getByRole("alert").textContent).toContain("This clip can't be played right now");
  });

  it("an event in progress falls back the same way, and no longer offers footage up to now", () => {
    render(<EventClipModal event={makeEvent({ endTime: null })} onClose={vi.fn()} />);

    failTheLoad();
    failTheLoad();

    expect(document.querySelector("video")).toBeNull();
    expect(document.querySelector("img")).not.toBeNull();
    expect(screen.queryByText(/showing footage up to now/)).toBeNull();
  });

  it("Retry plays the clip again, through a fresh playlist request", () => {
    render(<EventClipModal event={makeEvent()} onClose={vi.fn()} />);
    failTheLoad();
    failTheLoad();

    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));

    expect(document.querySelector("video")!.getAttribute("src")).toBe(`${HLS}?refresh=1`);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("still keeps Download for a clip that will not play", () => {
    render(<EventClipModal event={makeEvent()} onClose={vi.fn()} />);

    failTheLoad();
    failTheLoad();

    expect(screen.getByRole("link", { name: /Download/ })).toBeInTheDocument();
  });
});
