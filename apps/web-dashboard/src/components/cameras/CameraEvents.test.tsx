/**
 * WARP-3509 — "Recent detections" on /cameras named each camera by its Frigate
 * key with the underscores swapped for spaces ("warp lab office"): lower case,
 * and not the name the household gave the camera, which the Events page, the
 * filter chips and the camera cards all use. It now takes the same labeler.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import React from "react";
import { CameraEvents } from "./CameraEvents";
import type { DetectionEvent } from "@/lib/types";

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
        events={[makeEvent({ id: "a", camera: "front_door" }), makeEvent({ id: "b", camera: "back_yard" })]}
      />,
    );

    expect(screen.getByText("Front Door")).toBeInTheDocument();
    expect(screen.getByText("Back Yard")).toBeInTheDocument();
  });
});
