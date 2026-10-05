import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { EventDetail } from "@/lib/types";
import { EventClipModal } from "./EventClipModal";

vi.mock("@/components/recordings/HlsPlayer", () => ({
  HlsPlayer: ({ src, onError }: { src: string; onError: (message: string) => void }) =>
    <button data-src={src} onClick={() => onError("Missing recording")}>Recording player</button>,
}));
vi.mock("@/components/Dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div>,
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role: "member" } }) }));
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/api", () => ({ regenerateEventDescription: vi.fn(), tagEventAsFace: vi.fn(), getEventHlsUrl: (id: string, refresh: number) => `/api/cameras/events/${id}/playback.m3u8${refresh ? `?refresh=${refresh}` : ""}` }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const startTime = new Date(2026, 7, 13, 12, 34).getTime() / 1000;
const event: EventDetail = {
  id: "event1", camera: "warp_lab_office", label: "person", score: 0.9,
  startTime, endTime: startTime + 60, thumbnail: "/thumbnail.jpg", hasClip: true,
  hasSnapshot: false, subLabel: null, subLabelScore: null, zones: [],
  retainIndefinitely: false, clipUrl: "/api/cameras/clips/event/event1",
  snapshotUrl: null, description: null,
};

describe("event playback recovery", () => {
  it("does not restart an ongoing recording after unrelated rerenders", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue((startTime + 600) * 1000);
    const active = { ...event, endTime: null };
    const { container, rerender } = render(<EventClipModal event={active} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Recording player" }));
    const initialUrl = screen.getByRole("button", { name: "Recording player" }).getAttribute("data-src");
    now.mockReturnValue((startTime + 660) * 1000);
    rerender(<EventClipModal event={{ ...active }} onClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Recording player" })).toHaveAttribute("data-src", initialUrl);
  });
  it("falls back from the clip to HLS and retries the same event with a fresh player", () => {
    const { container } = render(<EventClipModal event={event} onClose={vi.fn()} />);
    const originalUrl = screen.getByRole("button", { name: "Recording player" }).getAttribute("data-src");
    fireEvent.click(screen.getByRole("button", { name: "Recording player" }));
    const recording = screen.getByRole("button", { name: "Recording player" });
    expect(recording).toHaveAttribute("data-src", `/api/cameras/warp_lab_office/playback.m3u8?after=${startTime}&before=${startTime + 60}`);
    fireEvent.click(recording);
    expect(screen.getByRole("alert")).toHaveTextContent("This clip can't be played right now");
    expect(screen.getByRole("link", { name: "Browse recordings" })).toHaveAttribute("href", "/cameras/warp_lab_office/recordings?date=2026-08-13");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByRole("button", { name: "Recording player" })).toHaveAttribute("data-src", `${originalUrl}?refresh=1`);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the retry available when the event thumbnail is also unavailable", () => {
    const { container } = render(<EventClipModal event={event} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Recording player" }));
    fireEvent.click(screen.getByRole("button", { name: "Recording player" }));
    fireEvent.error(container.querySelector("img")!);
    expect(screen.getByTestId("thumb-fallback")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByRole("button", { name: "Recording player" })).toHaveAttribute("data-src", "/api/cameras/events/event1/playback.m3u8?refresh=1");
  });

  it("resets a failed playback state when a different event is opened", () => {
    const { container, rerender } = render(<EventClipModal event={event} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Recording player" }));
    fireEvent.click(screen.getByRole("button", { name: "Recording player" }));
    rerender(<EventClipModal event={{ ...event, id: "event2", clipUrl: "/clip2" }} onClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Recording player" })).toHaveAttribute("data-src", "/api/cameras/events/event2/playback.m3u8");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a clear image fallback for events without a saved clip", () => {
    const { container } = render(<EventClipModal event={{ ...event, hasClip: false, clipUrl: null }} onClose={vi.fn()} />);
    expect(container.querySelector("video")).toBeNull();
    fireEvent.error(container.querySelector("img")!);
    expect(screen.getByTestId("thumb-fallback")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
