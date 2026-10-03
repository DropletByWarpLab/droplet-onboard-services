/**
 * WARP-3509 — the Events page, end to end through its own wiring.
 *
 * The cards and modals are tested on their own; what only the page can get
 * wrong is whether it hands them the name the household gave each camera, and
 * whether a failed mark-viewed reaches the operator as a toast. Both were
 * broken on Frigate 0.17: cards said "warp lab office" under a filter chip
 * that said "Warp Lab Office", and the viewed POST's 500 was swallowed.
 *
 * ShellPage is a passthrough and the three data hooks are stubbed, so this
 * asserts what the page does with the data, not how SWR fetches it.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, fireEvent, screen, within } from "@testing-library/react";
import React from "react";
import type { CameraInfo, EventDetail, ReviewItem } from "@/lib/types";

vi.mock("@/components/shell/ShellPage", () => ({
  ShellPage: ({ title, sub, children, actions }: { title?: string; sub?: string; children?: React.ReactNode; actions?: React.ReactNode }) => (
    <div>
      {title ? <h1>{title}</h1> : null}
      {sub ? <p>{sub}</p> : null}
      {actions}
      {children}
    </div>
  ),
}));

const h = vi.hoisted(() => ({
  markViewed: vi.fn(),
  cameras: [] as unknown[],
  reviews: [] as unknown[],
  events: [] as unknown[],
}));

vi.mock("@/lib/hooks/useCameras", () => ({ useCameras: () => ({ cameras: h.cameras }) }));
vi.mock("@/lib/hooks/useEvents", () => ({
  useEvents: () => ({
    events: h.events,
    isLoading: false,
    isLoadingMore: false,
    hasMore: false,
    loadMore: vi.fn(),
    error: undefined,
    refresh: vi.fn().mockResolvedValue(undefined),
  }),
}));
vi.mock("@/lib/hooks/useReviews", () => ({
  useReviews: () => ({
    reviews: h.reviews,
    isLoading: false,
    isLoadingMore: false,
    hasMore: false,
    loadMore: vi.fn(),
    error: undefined,
    markViewed: h.markViewed,
    refresh: vi.fn().mockResolvedValue(undefined),
  }),
}));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  searchEventsSemantic: vi.fn(),
  setEventRetain: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role: "owner" } }) }));

import EventsPage from "./page";
import { ToastProvider } from "@/components/Toast";

afterEach(() => cleanup());

function camera(name: string, displayName: string): CameraInfo {
  return {
    name,
    displayName,
    manufacturer: null,
    model: null,
    ipAddress: "192.168.9.10",
    macAddress: null,
    enabled: true,
    autoDiscovered: false,
    status: "recording",
    lastSeen: "2026-10-03T00:00:00Z",
    lastDetection: null,
  };
}

const REVIEW: ReviewItem = {
  id: "1791059989.433851-qrgete",
  camera: "front_door",
  startTime: 1_800_000_000,
  endTime: 1_800_000_060,
  severity: "alert",
  hasBeenReviewed: false,
  objects: ["person"],
  audio: [],
  zones: [],
  detectionIds: ["d1"],
  previewUrl: "/api/cameras/reviews/1791059989.433851-qrgete/preview",
  thumbnailUrl: "/api/cameras/reviews/1791059989.433851-qrgete/thumbnail",
};

const EVENT: EventDetail = {
  id: "1791059989.433851-abc123",
  camera: "front_door",
  label: "dog",
  score: 0.8,
  startTime: 1_800_000_000,
  endTime: 1_800_000_030,
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
};

beforeEach(() => {
  h.markViewed.mockReset().mockResolvedValue(undefined);
  // `front_door` has been renamed by the household; `warp_lab_office` still
  // carries the default name derived from its key.
  h.cameras = [camera("front_door", "Lobby"), camera("warp_lab_office", "Warp Lab Office")];
  h.reviews = [REVIEW];
  h.events = [EVENT];
});

function renderPage() {
  return render(
    <ToastProvider>
      <EventsPage />
    </ToastProvider>,
  );
}

describe("EventsPage camera names", () => {
  it("a review card names its camera as the filter chip does", () => {
    renderPage();

    // The chip and the card are the same string for the same camera.
    const chip = screen.getByRole("button", { name: "Lobby" });
    const card = screen.getByRole("button", { name: /alert on Lobby/i });
    expect(within(card).getByText("Lobby").textContent).toBe(chip.textContent);
    expect(within(card).queryByText("front door")).toBeNull();
  });

  it("an event card names its camera as the filter chip does", () => {
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: /All events/ }));

    const card = screen.getByRole("button", { name: /dog on Lobby/i });
    expect(within(card).getByText("Lobby")).toBeInTheDocument();
    expect(within(card).queryByText("front door")).toBeNull();
  });

  it("a camera the list does not carry still reads as a name, not a key", () => {
    h.reviews = [{ ...REVIEW, camera: "side_gate" }];
    renderPage();

    const card = screen.getByRole("button", { name: /alert on Side Gate/i });
    expect(within(card).getByText("Side Gate")).toBeInTheDocument();
  });

  it("the review modal names the camera the same way", () => {
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: /alert on Lobby/i }));

    expect(screen.getByText(/Lobby ·/)).toBeInTheDocument();
  });
});

describe("EventsPage mark viewed", () => {
  it("opening a review marks it viewed through the hook", async () => {
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: /alert on Lobby/i }));

    await vi.waitFor(() => expect(h.markViewed).toHaveBeenCalledWith(REVIEW.id));
  });

  it("a failed mark-viewed is a toast, and the review modal stays open", async () => {
    h.markViewed.mockRejectedValue(new Error("Failed to mark review viewed: 503"));
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: /alert on Lobby/i }));

    expect(
      await screen.findByText("We couldn't mark that as viewed. Try again in a moment."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open camera/ })).toBeInTheDocument();
  });
});
