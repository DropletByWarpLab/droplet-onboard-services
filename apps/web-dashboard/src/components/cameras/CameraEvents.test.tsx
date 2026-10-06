/**
 * WARP-3509 — "Recent detections" on /cameras named each camera by its Frigate
 * key with the underscores swapped for spaces ("warp lab office"): lower case,
 * and not the name the household gave the camera, which the Events page, the
 * filter chips and the camera cards all use. It now takes the same labeler.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  render,
  cleanup,
  screen,
  fireEvent,
  within,
} from "@testing-library/react";
import React from "react";
import { CameraEvents } from "./CameraEvents";
import type { DetectionEvent } from "@/lib/types";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { role: "member" } }),
}));
vi.mock("@/components/recordings/HlsPlayer", () => ({
  HlsPlayer: ({ src }: { src: string }) => (
    <div data-testid="hls-player" data-src={src} />
  ),
}));

beforeEach(() => localStorage.clear());

afterEach(() => cleanup());

function makeEvent(overrides: Partial<DetectionEvent> = {}): DetectionEvent {
  return {
    id: "evt-1",
    camera: "warp_lab_office",
    label: "person",
    score: 0.92,
    startTime: Math.floor(Date.now() / 1000) - 30,
    endTime: null,
    thumbnail: "/api/cameras/events/evt-1/thumbnail",
    hasClip: true,
    hasSnapshot: true,
    ...overrides,
  };
}

describe("CameraEvents camera name (WARP-3509)", () => {
  it("shows the name the household gave the camera, through the labeler it is handed", () => {
    render(
      <CameraEvents
        events={[makeEvent({ camera: "front_door" })]}
        cameraLabel={(key) => (key === "front_door" ? "Lobby" : key)}
      />,
    );

    expect(screen.getByText("Lobby")).toBeInTheDocument();
    expect(screen.queryByText("front door")).toBeNull();
  });

  it("falls back to the prettified key, never the raw lower-case key", () => {
    render(<CameraEvents events={[makeEvent()]} />);

    expect(screen.getByText("Warp Lab Office")).toBeInTheDocument();
    expect(screen.queryByText("warp lab office")).toBeNull();
  });

  it("names every row, one camera each", () => {
    render(
      <CameraEvents
        events={[
          makeEvent({ id: "a", camera: "front_door" }),
          makeEvent({ id: "b", camera: "back_yard" }),
        ]}
      />,
    );

    expect(screen.getByText("Front Door")).toBeInTheDocument();
    expect(screen.getByText("Back Yard")).toBeInTheDocument();
  });
});

describe("CameraEvents detection browsing", () => {
  it("opens the full snapshot from a list row and switches to the saved clip", () => {
    render(<CameraEvents events={[makeEvent()]} />);
    fireEvent.click(
      screen.getByRole("button", { name: /View person on Warp Lab Office/ }),
    );

    const viewer = within(screen.getByRole("dialog"));
    expect(viewer.getByRole("img")).toHaveAttribute(
      "src",
      "/api/cameras/events/evt-1/snapshot",
    );
    expect(viewer.getByRole("button", { name: "Photo" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(viewer.getByRole("button", { name: "Clip" }));
    expect(viewer.getByTestId("hls-player")).toHaveAttribute(
      "data-src",
      "/api/cameras/events/evt-1/playback.m3u8",
    );
    fireEvent.click(viewer.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps every detection clickable in grid view and remembers the layout", () => {
    const events = [makeEvent(), makeEvent({ id: "evt-2", label: "car" })];
    const { unmount } = render(<CameraEvents events={events} />);
    fireEvent.click(screen.getByRole("button", { name: "Grid view" }));
    expect(screen.getByRole("button", { name: "Grid view" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(
      within(screen.getByLabelText("Detection grid")).getByRole("button", {
        name: /car on Warp Lab Office/,
      }),
    );
    expect(within(screen.getByRole("dialog")).getByRole("img")).toHaveAttribute(
      "src",
      "/api/cameras/events/evt-2/snapshot",
    );
    unmount();
    render(<CameraEvents events={events} />);
    expect(screen.getByLabelText("Detection grid")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "List view" }));
    expect(screen.getByLabelText("Detection list")).toBeInTheDocument();
  });

  it("filters people in either layout and explains an empty people result", () => {
    const { rerender } = render(
      <CameraEvents
        events={[makeEvent(), makeEvent({ id: "car", label: "car" })]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "People" }));
    expect(screen.queryByRole("button", { name: /View car/ })).toBeNull();
    expect(
      screen.getByRole("button", { name: /View person/ }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Grid view" }));
    expect(screen.queryByText("car")).toBeNull();
    rerender(<CameraEvents events={[makeEvent({ label: "car" })]} />);
    expect(screen.getByText("No recent people detected.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByText("car")).toBeInTheDocument();
  });

  it("uses the thumbnail when no snapshot or clip was saved and contains media failures", () => {
    render(
      <CameraEvents
        events={[
          makeEvent({
            hasClip: false,
            hasSnapshot: false,
            thumbnail: "https://example.com/private-image",
          }),
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /View person/ }));
    const viewer = within(screen.getByRole("dialog"));
    const image = viewer.getByRole("img");
    expect(image).toHaveAttribute("src", "/api/cameras/events/evt-1/thumbnail");
    fireEvent.error(image);
    expect(viewer.getByTestId("thumb-fallback")).toBeInTheDocument();
    expect(viewer.queryByTestId("hls-player")).toBeNull();
  });

  it("shows the event preview when the saved snapshot has expired", () => {
    render(<CameraEvents events={[makeEvent({ hasClip: false })]} />);
    fireEvent.click(screen.getByRole("button", { name: /View person/ }));
    const viewer = within(screen.getByRole("dialog"));
    fireEvent.error(viewer.getByRole("img"));
    expect(viewer.getByRole("img")).toHaveAttribute(
      "src",
      "/api/cameras/events/evt-1/thumbnail",
    );
  });

  it("updates an open detection when its saved photo arrives and keeps it open after it leaves the feed", () => {
    const event = makeEvent({ hasClip: false, hasSnapshot: false });
    const { rerender } = render(<CameraEvents events={[event]} />);
    fireEvent.click(screen.getByRole("button", { name: /View person/ }));
    expect(within(screen.getByRole("dialog")).getByRole("img")).toHaveAttribute(
      "src",
      "/api/cameras/events/evt-1/thumbnail",
    );
    rerender(
      <CameraEvents
        events={[
          { ...event, hasSnapshot: true, endTime: event.startTime + 10 },
        ]}
      />,
    );
    expect(within(screen.getByRole("dialog")).getByRole("img")).toHaveAttribute(
      "src",
      "/api/cameras/events/evt-1/snapshot",
    );
    rerender(<CameraEvents events={[]} />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(within(screen.getByRole("dialog")).getByRole("img")).toHaveAttribute(
      "src",
      "/api/cameras/events/evt-1/snapshot",
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
