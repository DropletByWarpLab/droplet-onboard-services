/**
 * WARP-3509 — the camera toasts named a camera by its Frigate key with the
 * underscores swapped for spaces ("warp lab office"): lower case, and not the
 * name the household gave it. They take the same labeler as the Events page.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import React from "react";
import { CameraNotificationToast } from "./CameraNotificationToast";
import type { CameraSSEEvent } from "@/lib/types";

afterEach(() => cleanup());

const detection = (camera: string): CameraSSEEvent => ({
  type: "detection",
  camera,
  label: "person",
  score: 0.9,
  timestamp: 1,
});

const discovered = (camera: string): CameraSSEEvent => ({
  type: "camera_discovered",
  camera,
  timestamp: 2,
});

describe("CameraNotificationToast camera name (WARP-3509)", () => {
  it("names the camera of a detection the way the household did, through the labeler it is handed", () => {
    render(
      <CameraNotificationToast
        notifications={[detection("front_door")]}
        onDismiss={vi.fn()}
        cameraLabel={(key) => (key === "front_door" ? "Lobby" : key)}
      />,
    );

    expect(screen.getByText(/^Lobby/)).toBeInTheDocument();
    expect(screen.queryByText(/front door/)).toBeNull();
  });

  it("falls back to the prettified key for a detection, never the raw lower-case key", () => {
    render(<CameraNotificationToast notifications={[detection("warp_lab_office")]} onDismiss={vi.fn()} />);

    expect(screen.getByText(/Warp Lab Office/)).toBeInTheDocument();
    expect(screen.queryByText(/warp lab office/)).toBeNull();
  });

  it("keeps the score beside the name", () => {
    render(<CameraNotificationToast notifications={[detection("warp_lab_office")]} onDismiss={vi.fn()} />);

    expect(screen.getByText(/Warp Lab Office · 90%/)).toBeInTheDocument();
  });

  it("names a newly found camera through the labeler too", () => {
    render(
      <CameraNotificationToast
        notifications={[discovered("back_yard")]}
        onDismiss={vi.fn()}
        cameraLabel={(key) => (key === "back_yard" ? "Garden" : key)}
      />,
    );

    expect(screen.getByText("Garden")).toBeInTheDocument();
    expect(screen.queryByText("back yard")).toBeNull();
  });

  it("falls back to the prettified key for a newly found camera", () => {
    render(<CameraNotificationToast notifications={[discovered("back_yard")]} onDismiss={vi.fn()} />);

    expect(screen.getByText("Back Yard")).toBeInTheDocument();
  });
});
