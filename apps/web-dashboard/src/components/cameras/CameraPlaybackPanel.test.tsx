import { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DetectionEvent, RecordingSegment, TimelineEntry } from "@/lib/types";
import { CameraPlaybackPanel, type CameraPlaybackSelection } from "./CameraPlaybackPanel";

const mocks = vi.hoisted(() => ({
  seek: vi.fn(), refresh: vi.fn(),
  summaryLoading: false, dayLoading: false, rangeLoading: false,
  dayError: null as Error | null,
  rangeError: null as Error | null,
  segments: [] as RecordingSegment[],
  rangeSegments: null as RecordingSegment[] | null,
  timeline: [] as TimelineEntry[],
  metadataCalls: [] as Array<{ after: number; before: number; refreshInterval: number }>,
}));

vi.mock("@/lib/hooks/useRecordings", () => ({
  useRecordingsSummary: () => ({ days: [], isLoading: mocks.summaryLoading, error: null, refresh: mocks.refresh }),
  useRecordingsRange: (_camera: string, after: number | null, before: number | null, refreshInterval = 0) => {
    const isDay = after !== null && new Date(after * 1000).getHours() === 0;
    if (isDay && before !== null) mocks.metadataCalls.push({ after: after!, before, refreshInterval });
    return {
      segments: after === null || before === null ? [] : isDay || mocks.rangeSegments === null ? mocks.segments : mocks.rangeSegments,
      timeline: isDay ? mocks.timeline : [],
      isLoading: isDay ? mocks.dayLoading : mocks.rangeLoading,
      error: isDay ? mocks.dayError : mocks.rangeError,
      refresh: mocks.refresh,
    };
  },
}));

vi.mock("@/lib/api", () => ({
  getEventHlsUrl: (id: string, refresh = 0) => `/api/cameras/events/${encodeURIComponent(id)}/playback.m3u8${refresh ? `?refresh=${refresh}` : ""}`,
  getRecordingHlsUrl: (name: string, after: number, before: number) => `/api/cameras/${name}/playback.m3u8?after=${after}&before=${before}`,
}));

vi.mock("@/components/recordings/HlsPlayer", () => ({
  HlsPlayer: forwardRef(function Player({ src, onReady, onError, onTimeUpdate }: {
    src: string; onReady: () => void; onError: (message: string) => void; onTimeUpdate: (time: number) => void;
  }, ref) {
    useImperativeHandle(ref, () => ({ seek: mocks.seek }));
    return <div data-testid="player" data-src={src}>
      <button onClick={onReady}>Player ready</button>
      <button onClick={() => onError("Could not play recording")}>Player error</button>
      <button onClick={() => onTimeUpdate(15)}>Advance player</button>
    </div>;
  }),
}));

vi.mock("@/components/recordings/RecordingsTimeline", () => ({
  RecordingsTimeline: ({ day, playheadSec, selectedEventId, onScrubTo, onSelectEvent }: {
    day: string; playheadSec?: number; selectedEventId?: string; onScrubTo: (seconds: number) => void; onSelectEvent: (event: TimelineEntry) => void;
  }) => <div data-testid="timeline" data-day={day} data-playhead={playheadSec} data-event={selectedEventId}>
    <button onClick={() => onScrubTo(9 * 3600 + 15)}>Seek recording gap</button>
    {mocks.timeline.map((entry) => <button key={entry.sourceId} onClick={() => onSelectEvent(entry)}>Open timeline event {entry.sourceId}</button>)}
  </div>,
}));

const now = new Date(2026, 9, 8, 12, 0, 0);
const start = new Date(2026, 9, 8, 9, 0, 0).getTime() / 1000;
const event: DetectionEvent = { id: "person-event", camera: "office", label: "person", score: 0.9, startTime: start, endTime: start + 30, thumbnail: "/thumb.jpg", hasClip: true, hasSnapshot: true };
const segment = (id: string, from: number, to: number): RecordingSegment => ({ id, startTime: from, endTime: to, duration: to - from, motion: 4, objects: 1 });

function panel(selection: CameraPlaybackSelection | null = null, callbacks: { onReturnToLive?: () => void; onActiveItemChange?: (key: string | null) => void; onPlaybackChange?: (active: boolean) => void; returnToLiveRequest?: number; onDayChange?: (day: string) => void } = {}) {
  return <CameraPlaybackPanel cameraName="office" selection={selection} onReturnToLive={callbacks.onReturnToLive ?? vi.fn()} onActiveItemChange={callbacks.onActiveItemChange} onPlaybackChange={callbacks.onPlaybackChange} returnToLiveRequest={callbacks.returnToLiveRequest} onDayChange={callbacks.onDayChange}><div data-testid="live">Live camera</div></CameraPlaybackPanel>;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  mocks.seek.mockReset();
  mocks.refresh.mockReset();
  mocks.summaryLoading = false;
  mocks.dayLoading = false;
  mocks.rangeLoading = false;
  mocks.dayError = null;
  mocks.rangeError = null;
  mocks.rangeSegments = null;
  mocks.metadataCalls = [];
  mocks.segments = [segment("first", start, start + 10), segment("second", start + 20, start + 30)];
  mocks.timeline = [{ sourceId: event.id, timestamp: start, label: "person", classType: "visible", zone: null, score: 0.9 }];
});

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("main camera playback", () => {
  it("shows the timeline and date picker while the camera remains live", () => {
    render(panel());
    expect(screen.getByTestId("live")).toBeInTheDocument();
    expect(screen.getByLabelText("Timeline date")).toHaveValue("2026-10-08");
    expect(screen.getByRole("button", { name: "Next day" })).toBeDisabled();
    expect(screen.queryByTestId("player")).not.toBeInTheDocument();
  });

  it("opens the exact event id from a timeline marker and returns to live", () => {
    const onReturnToLive = vi.fn(), onActiveItemChange = vi.fn();
    render(panel(null, { onReturnToLive, onActiveItemChange }));
    fireEvent.click(screen.getByRole("button", { name: `Open timeline event ${event.id}` }));
    expect(screen.getByTestId("player")).toHaveAttribute("data-src", "/api/cameras/events/person-event/playback.m3u8");
    expect(onActiveItemChange).toHaveBeenLastCalledWith("event:person-event");
    fireEvent.click(screen.getByRole("button", { name: "Return to live" }));
    expect(screen.getByTestId("live")).toBeInTheDocument();
    expect(onReturnToLive).toHaveBeenCalledOnce();
    expect(onActiveItemChange).toHaveBeenLastCalledWith(null);
  });

  it("skips an archive gap and seeks through concatenated recording segments", () => {
    render(panel());
    fireEvent.click(screen.getByRole("button", { name: "Seek recording gap" }));
    expect(screen.getByText(/Showing the next recording/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Player ready" }));
    expect(mocks.seek).toHaveBeenLastCalledWith(10);
    fireEvent.click(screen.getByRole("button", { name: "Advance player" }));
    expect(screen.getByTestId("timeline")).toHaveAttribute("data-playhead", String(9 * 3600 + 25));
  });

  it("reopens a fresh request for the same event after seeking the timeline", () => {
    const { rerender } = render(panel({ kind: "event", event }));
    fireEvent.click(screen.getByRole("button", { name: "Seek recording gap" }));
    expect(screen.getByTestId("player").getAttribute("data-src")).toContain("/api/cameras/office/playback.m3u8");
    rerender(panel({ kind: "event", event }));
    expect(screen.getByTestId("player")).toHaveAttribute("data-src", "/api/cameras/events/person-event/playback.m3u8");
  });

  it("keeps the event marker at its known timestamp rather than assuming HLS padding", () => {
    render(panel({ kind: "event", event }));
    fireEvent.click(screen.getByRole("button", { name: "Advance player" }));
    expect(screen.getByTestId("timeline")).toHaveAttribute("data-playhead", String(9 * 3600));
  });

  it("falls back to the event's retained recording range when event playback fails", () => {
    render(panel({ kind: "event", event }));
    fireEvent.click(screen.getByRole("button", { name: "Player error" }));
    expect(screen.getByTestId("player")).toHaveAttribute("data-src", `/api/cameras/office/playback.m3u8?after=${start}&before=${start + 30}`);
  });

  it("shows an empty state rather than loading an empty recording range", () => {
    mocks.rangeSegments = [];
    render(panel({ kind: "event", event: { ...event, hasSnapshot: false } }));
    fireEvent.click(screen.getByRole("button", { name: "Player error" }));
    expect(screen.queryByTestId("player")).not.toBeInTheDocument();
    expect(screen.getByText("No recording is available at this time.")).toBeInTheDocument();
  });

  it("preserves a no-clip event's saved image after attempting its recording", () => {
    mocks.rangeSegments = [];
    const onReturnToLive = vi.fn();
    render(panel({ kind: "event", event: { ...event, hasClip: false } }, { onReturnToLive }));
    expect(screen.getByTestId("player")).toHaveAttribute("data-src", "/api/cameras/events/person-event/playback.m3u8");
    fireEvent.click(screen.getByRole("button", { name: "Player error" }));
    expect(screen.queryByTestId("player")).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Saved image of person" })).toHaveAttribute("src", "/api/cameras/events/person-event/snapshot");
    expect(screen.getByText("Image only")).toBeInTheDocument();
    expect(screen.getByText("Clip unavailable. Saved snapshot or event preview.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry clip" }));
    expect(screen.getByTestId("player")).toHaveAttribute("data-src", "/api/cameras/events/person-event/playback.m3u8?refresh=1");
    fireEvent.click(screen.getByRole("button", { name: "Return to live" }));
    expect(screen.getByTestId("live")).toBeInTheDocument();
    expect(onReturnToLive).toHaveBeenCalledOnce();
  });

  it("uses the snapshot and authenticated preview after both playback sources fail", () => {
    render(panel({ kind: "event", event }));
    fireEvent.click(screen.getByRole("button", { name: "Player error" }));
    expect(screen.getByTestId("player").getAttribute("data-src")).toContain("/api/cameras/office/playback.m3u8");
    fireEvent.click(screen.getByRole("button", { name: "Player error" }));
    const image = screen.getByRole("img", { name: "Saved image of person" });
    expect(image).toHaveAttribute("src", "/api/cameras/events/person-event/snapshot");
    fireEvent.error(image);
    expect(screen.getByRole("img", { name: "Saved image of person" })).toHaveAttribute("src", "/api/cameras/events/person-event/thumbnail");
    expect(screen.getByText("person snapshot")).toBeInTheDocument();
    expect(screen.getByText("Image only")).toBeInTheDocument();
  });

  it("preserves a known saved image when the retained recording read fails", () => {
    mocks.rangeError = new Error("Recording service unavailable");
    render(panel({ kind: "event", event }));
    fireEvent.click(screen.getByRole("button", { name: "Player error" }));
    expect(screen.getByRole("img", { name: "Saved image of person" })).toHaveAttribute("src", "/api/cameras/events/person-event/snapshot");
  });

  it("does not assume a snapshot is available for a timeline-only event", () => {
    mocks.rangeSegments = [];
    render(panel());
    fireEvent.click(screen.getByRole("button", { name: `Open timeline event ${event.id}` }));
    fireEvent.click(screen.getByRole("button", { name: "Player error" }));
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("No recording is available at this time.")).toBeInTheDocument();
  });

  it("refreshes in-progress footage with a new event playlist URL", () => {
    render(panel({ kind: "event", event: { ...event, endTime: null } }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh clip" }));
    expect(screen.getByTestId("player")).toHaveAttribute("data-src", "/api/cameras/events/person-event/playback.m3u8?refresh=1");
  });

  it("changes the timeline date and clears active playback", () => {
    const onReturnToLive = vi.fn(), onDayChange = vi.fn();
    render(panel({ kind: "event", event }, { onReturnToLive, onDayChange }));
    fireEvent.change(screen.getByLabelText("Timeline date"), { target: { value: "2026-10-07" } });
    expect(screen.getByTestId("live")).toBeInTheDocument();
    expect(screen.getByTestId("timeline")).toHaveAttribute("data-day", "2026-10-07");
    expect(onDayChange).toHaveBeenLastCalledWith("2026-10-07");
    expect(onReturnToLive).toHaveBeenCalledOnce();
  });

  it("shows a timeline failure separately from an empty day", () => {
    mocks.dayError = new Error("Camera service unavailable");
    render(panel());
    expect(screen.getByRole("alert")).toHaveTextContent("The recording timeline can't be loaded right now.");
    fireEvent.click(screen.getByRole("button", { name: "Retry timeline" }));
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
  });

  it("lets the page return an internal timeline seek to live without a callback loop", () => {
    const onReturnToLive = vi.fn(), onPlaybackChange = vi.fn();
    const { rerender } = render(panel(null, { onReturnToLive, onPlaybackChange, returnToLiveRequest: 4 }));
    fireEvent.click(screen.getByRole("button", { name: "Seek recording gap" }));
    expect(onPlaybackChange).toHaveBeenLastCalledWith(true);
    rerender(panel(null, { onReturnToLive, onPlaybackChange, returnToLiveRequest: 5 }));
    expect(screen.getByTestId("live")).toBeInTheDocument();
    expect(onPlaybackChange).toHaveBeenLastCalledWith(false);
    expect(onReturnToLive).not.toHaveBeenCalled();
  });

  it("does not cancel an initial event when the page supplies its live request counter", () => {
    render(panel({ kind: "event", event }, { returnToLiveRequest: 7 }));
    expect(screen.getByTestId("player")).toHaveAttribute("data-src", "/api/cameras/events/person-event/playback.m3u8");
  });

  it("revalidates today's metadata under stable day bounds across clock ticks", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    render(panel());
    const initialRange = mocks.metadataCalls[0];
    act(() => { vi.advanceTimersByTime(90_000); });
    expect(mocks.metadataCalls.length).toBeGreaterThan(1);
    expect(mocks.metadataCalls.every((range) => range.after === initialRange.after && range.before === initialRange.before)).toBe(true);
    expect(initialRange.before).toBe(new Date(2026, 9, 9).getTime() / 1000);
    expect(mocks.metadataCalls.every((range) => range.refreshInterval === 30_000)).toBe(true);
    fireEvent.change(screen.getByLabelText("Timeline date"), { target: { value: "2026-10-07" } });
    expect(mocks.metadataCalls.at(-1)?.refreshInterval).toBe(0);
  });
});
