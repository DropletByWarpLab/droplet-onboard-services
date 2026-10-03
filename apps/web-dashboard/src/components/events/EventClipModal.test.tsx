/**
 * WARP-3509 — the event modal's camera naming and picture fallback, the same
 * two fixes as the review modal. Everything else about this modal (retain,
 * tag, regenerate, download) is unchanged and out of scope here.
 *
 * The modal is built on <Dialog>, which portals to document.body: query
 * through `screen` / `document`, not the render container.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import React from "react";

vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role: "owner" } }) }));

import { EventClipModal } from "./EventClipModal";
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
    hasClip: false,
    hasSnapshot: true,
    subLabel: null,
    subLabelScore: null,
    zones: [],
    retainIndefinitely: false,
    clipUrl: null,
    snapshotUrl: "/api/cameras/events/1791059989.433851-abc123/snapshot",
    description: null,
    ...overrides,
  };
}

describe("EventClipModal camera name", () => {
  it("names the camera by its display name in the details line", () => {
    render(<EventClipModal event={makeEvent({ camera: "front_door" })} cameraName="Lobby" onClose={vi.fn()} />);

    expect(screen.getByText(/Lobby ·/)).toBeInTheDocument();
    expect(screen.queryByText(/front door/)).toBeNull();
  });

  it("falls back to the prettified key, never the raw lower-case key", () => {
    render(<EventClipModal event={makeEvent()} onClose={vi.fn()} />);

    expect(screen.getByText(/Warp Lab Office ·/)).toBeInTheDocument();
    expect(screen.queryByText(/warp lab office/)).toBeNull();
  });

  it("names the camera by its display name in the picture's alt text", () => {
    render(<EventClipModal event={makeEvent({ camera: "front_door" })} cameraName="Lobby" onClose={vi.fn()} />);

    expect(document.querySelector("img")!.getAttribute("alt")).toBe("person on Lobby");
  });

  it("still links to the camera by its key", () => {
    render(<EventClipModal event={makeEvent()} cameraName="Warp Lab Office" onClose={vi.fn()} />);

    expect(screen.getByRole("link", { name: /Open camera/ }).getAttribute("href")).toBe("/cameras/warp_lab_office");
  });
});

describe("EventClipModal picture failure", () => {
  it("a snapshot that fails to load becomes a placeholder, with no alt text left to print", () => {
    render(<EventClipModal event={makeEvent()} cameraName="Warp Lab Office" onClose={vi.fn()} />);

    fireEvent.error(document.querySelector("img")!);

    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("[data-testid='thumb-fallback']")).not.toBeNull();
    expect(document.body.innerHTML).not.toContain("person on Warp Lab Office");
  });

  it("the thumbnail used when there is neither a clip nor a snapshot gets the same fallback", () => {
    render(
      <EventClipModal event={makeEvent({ snapshotUrl: null, hasSnapshot: false })} onClose={vi.fn()} />,
    );

    expect(document.querySelector("img")!.getAttribute("src")).toBe(
      "/api/cameras/events/1791059989.433851-abc123/thumbnail",
    );
    fireEvent.error(document.querySelector("img")!);

    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("[data-testid='thumb-fallback']")).not.toBeNull();
  });
});
