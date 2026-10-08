import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type {
  CameraInfo,
  DetectionEvent,
  MotionActivity,
  MotionActivityResult,
  RecordingDay,
  RecordingSegment,
} from "@/lib/types";

const h = vi.hoisted(() => ({
  camera: undefined as unknown as CameraInfo,
  events: [] as DetectionEvent[],
  motion: undefined as unknown as MotionActivityResult,
  eventsError: undefined as Error | undefined,
  motionError: undefined as Error | undefined,
  eventsLoading: false,
  motionLoading: false,
  days: [] as RecordingDay[],
  segments: [] as RecordingSegment[],
  push: vi.fn(),
  replace: vi.fn(),
  seek: vi.fn(),
  pause: vi.fn(),
  play: vi.fn(),
  eventsRefresh: vi.fn(),
  motionRefresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ name: "front_door" }),
  useRouter: () => ({ push: h.push, replace: h.replace, back: vi.fn() }),
  usePathname: () => "/cameras/front_door",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
  useAuth: () => ({ user: { role: "family" } }),
}));
vi.mock("@/lib/hooks/useCameras", () => ({
  useCameras: () => ({ cameras: [h.camera], isLoading: false, refresh: vi.fn() }),
}));
vi.mock("@/lib/hooks/useCameraPins", () => ({
  useCameraPins: () => ({ pinnedSet: new Set<string>(), toggle: vi.fn() }),
}));
vi.mock("@/lib/hooks/useRecordings", () => ({
  useRecordingsSummary: () => ({ days: h.days, isLoading: false, error: undefined, refresh: vi.fn() }),
  useRecordingsRange: (_camera: string | null, after: number | null, before: number | null) => ({
    segments: after !== null && before !== null
      ? h.segments.filter((segment) => segment.endTime > after && segment.startTime < before)
      : [],
    timeline: [],
    isLoading: false,
    error: undefined,
    refresh: vi.fn(),
  }),
}));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/api")>(),
  fetchPtzCapabilities: vi.fn(),
  fetchMotionActivity: vi.fn(),
}));
vi.mock("@/components/ptz/PtzOverlay", () => ({ PtzOverlay: () => null }));
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

// Keep page, playback panel, URL helpers, and timeline together. Only the media
// transport is stubbed: jsdom cannot decode video, but receives the real source.
vi.mock("@/components/recordings/HlsPlayer", async () => {
  const React = await import("react");
  return {
    HlsPlayer: React.forwardRef(({ src }: { src: string }, ref) => {
      React.useImperativeHandle(ref, () => ({ seek: h.seek, pause: h.pause, play: h.play }));
      return <video data-testid="camera-playback-source" src={src} />;
    }),
  };
});

vi.mock("swr", () => ({
  default: (key: unknown) => {
    if (typeof key === "string" && key.includes("/events?")) {
      return { data: h.events, error: h.eventsError, isLoading: h.eventsLoading, mutate: h.eventsRefresh };
    }
    if (Array.isArray(key) && key[0] === "camera-recent-motion") {
      return { data: h.motion, error: h.motionError, isLoading: h.motionLoading, mutate: h.motionRefresh };
    }
    return { data: undefined, error: undefined, isLoading: false, mutate: vi.fn() };
  },
}));

import CameraFullscreenPage from "@/app/cameras/[name]/page";

const start = new Date(2026, 9, 8, 9, 57).getTime() / 1000;
const person: DetectionEvent = {
  id: "person/event-1",
  camera: "front_door",
  label: "person",
  score: 0.92,
  startTime: start,
  endTime: start + 10,
  thumbnail: "/api/cameras/events/person%2Fevent-1/thumbnail",
  hasClip: true,
  hasSnapshot: true,
};
const movement: MotionActivity = {
  id: "raw-motion-1",
  camera: "front_door",
  startTime: start - 60,
  endTime: start - 50,
  motion: 3,
  outsideBusinessHours: null,
  playbackUrl: `/api/cameras/front_door/playback.m3u8?after=${start - 60}&before=${start - 50}`,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 8, 10));
  h.camera = {
    name: "front_door",
    displayName: "Front door",
    manufacturer: "Hanwha",
    model: "XNV",
    ipAddress: "192.168.20.10",
    macAddress: null,
    enabled: true,
    autoDiscovered: false,
    status: "recording",
    lastSeen: new Date().toISOString(),
    lastDetection: null,
    recording: {
      degraded: false,
      mode: "continuous",
      retentionDays: { continuous: 3, motion: 8, alerts: 14, detections: 14 },
      lastSegmentAt: new Date().toISOString(),
      usedBytes: 1024,
      bytesPerDay: 1024,
    },
  };
  h.events = [person];
  h.eventsError = undefined;
  h.motionError = undefined;
  h.eventsLoading = false;
  h.motionLoading = false;
  h.motion = {
    activity: [movement],
    nextCursor: null,
    coverage: {
      after: start - 3600,
      before: start + 180,
      partial: false,
      cameras: [{ camera: "front_door", recordedSeconds: 3600, hasGaps: false, available: true }],
    },
  };
  h.days = [{
    day: "2026-10-08",
    events: 1,
    duration: 3600,
    hours: [{ hour: 9, events: 1, duration: 3600, motion: 3, objects: 1 }],
  }];
  h.segments = [{
    id: "retained-hour",
    startTime: start - 57 * 60,
    endTime: start + 3 * 60,
    duration: 3600,
    motion: 3,
    objects: 1,
  }];
  h.play.mockResolvedValue(undefined);
});

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("camera-page event playback", () => {
  it("keeps the timeline on the live camera page and opens the exact detection clip with one click", () => {
    render(<CameraFullscreenPage />);
    expect(screen.getByTestId("timeline-ruler")).toBeInTheDocument();
    expect(screen.queryByTestId("camera-playback-source")).not.toBeInTheDocument();

    const row = screen.getByRole("button", { name: /Play person clip,/ });
    fireEvent.click(row);

    expect(screen.getByTestId("camera-playback-source")).toHaveAttribute(
      "src", "/api/cameras/events/person%2Fevent-1/playback.m3u8",
    );
    expect(row).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.querySelector('img[src$="/snapshot"]')).not.toBeInTheDocument();
    expect(h.push).not.toHaveBeenCalled();
    expect(h.replace).not.toHaveBeenCalled();
  });

  it("plays the selected motion period's bounded URL directly, then returns to live", () => {
    render(<CameraFullscreenPage />);
    const row = screen.getByRole("button", { name: /Play motion clip,/ });
    fireEvent.click(row);

    expect(screen.getByTestId("camera-playback-source")).toHaveAttribute("src", movement.playbackUrl);
    expect(row).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Return to live/i }));
    expect(screen.queryByTestId("camera-playback-source")).not.toBeInTheDocument();
    expect(row).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("img", { name: /Front door.*live/i })).toHaveAttribute("src", "/api/cameras/front_door/live");
    expect(h.push).not.toHaveBeenCalled();
  });

  it("offers saved-photo details without interrupting inline playback or exposing member custody actions", async () => {
    render(<CameraFullscreenPage />);
    fireEvent.click(screen.getByRole("button", { name: /Play person clip,/ }));
    const inlinePlayer = screen.getByTestId("camera-playback-source");
    expect(inlinePlayer).toHaveAttribute("src", "/api/cameras/events/person%2Fevent-1/playback.m3u8");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Event details" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("img", { name: "person on Front door" })).toHaveAttribute(
      "src", "/api/cameras/events/person%2Fevent-1/snapshot",
    );
    expect(within(dialog).getByRole("button", { name: "Photo" })).toHaveAttribute("aria-pressed", "true");
    expect(within(dialog).queryByRole("link", { name: "Download" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Tag person" })).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByTestId("camera-playback-source")).toBe(inlinePlayer);

    fireEvent.click(screen.getByRole("button", { name: "Event details" }));
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByTestId("camera-playback-source")).toBe(inlinePlayer);
    expect(screen.getByRole("button", { name: /Play person clip,/ })).toHaveAttribute("aria-pressed", "true");
    expect(h.push).not.toHaveBeenCalled();
    expect(h.replace).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("camera-playback-source")).not.toBeInTheDocument();
    expect(h.replace).not.toHaveBeenCalled();
  });

  it("filters the activity list without changing the selected clip", () => {
    render(<CameraFullscreenPage />);
    fireEvent.click(screen.getByRole("button", { name: /Play motion clip,/ }));
    fireEvent.click(screen.getByRole("button", { name: "Detections" }));
    expect(screen.getByRole("button", { name: /Play person clip,/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Play motion clip,/ })).not.toBeInTheDocument();
    expect(screen.getByTestId("camera-playback-source")).toHaveAttribute("src", movement.playbackUrl);

    fireEvent.click(screen.getByRole("button", { name: "Motion" }));
    expect(screen.getByRole("button", { name: /Play motion clip,/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Play person clip,/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByRole("button", { name: /Play person clip,/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Play motion clip,/ })).toBeInTheDocument();
  });

  it("uses Escape to return playback to live before navigating away", () => {
    render(<CameraFullscreenPage />);
    fireEvent.click(screen.getByRole("button", { name: /Play person clip,/ }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("camera-playback-source")).not.toBeInTheDocument();
    expect(h.replace).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(h.replace).toHaveBeenCalledWith("/cameras");
  });

  it("also returns a recording opened from the live timeline to live before navigating away", () => {
    render(<CameraFullscreenPage />);
    const ruler = screen.getByTestId("timeline-ruler");
    Object.defineProperty(ruler, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 1000, height: 128, right: 1000, bottom: 128 }),
    });
    const clickX = 9.5 / 24 * 1000;
    for (const type of ["pointerdown", "pointerup"]) {
      const event = new MouseEvent(type, { bubbles: true, clientX: clickX, button: 0 });
      Object.defineProperty(event, "pointerId", { value: 1 });
      fireEvent(ruler, event);
    }
    expect(screen.getByTestId("camera-playback-source")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("camera-playback-source")).not.toBeInTheDocument();
    expect(h.replace).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(h.replace).toHaveBeenCalledWith("/cameras");
  });

  it("shows a loading state while recent activity is still being fetched", () => {
    h.events = [];
    h.motion.activity = [];
    h.eventsLoading = true;
    h.motionLoading = true;
    render(<CameraFullscreenPage />);
    expect(screen.getByText("Loading recent events…")).toBeInTheDocument();
    expect(screen.queryByText("No recent events recorded on this camera.")).not.toBeInTheDocument();
  });

  it("keeps available detections usable when motion cannot be loaded and provides a retry", () => {
    h.motion.activity = [];
    h.motionError = new Error("Camera service unavailable");
    render(<CameraFullscreenPage />);
    expect(screen.getByRole("button", { name: /Play person clip,/ })).toBeInTheDocument();
    expect(screen.getByText(/Some recent events could not be loaded/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(h.eventsRefresh).toHaveBeenCalledOnce();
    expect(h.motionRefresh).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Motion" }));
    expect(screen.getByText("Recent activity is unavailable.")).toBeInTheDocument();
    expect(screen.queryByText("No motion kept in the last 24 hours.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Detections" }));
    expect(screen.queryByText(/Some recent events could not be loaded/)).not.toBeInTheDocument();
  });

  it("puts event activity ahead of recording details and leaves the details collapsible", () => {
    render(<CameraFullscreenPage />);
    const details = screen.getByTestId("camera-recording-summary").closest("details");
    expect(details).not.toHaveAttribute("open");
    const eventRow = screen.getByRole("button", { name: /Play person clip,/ });
    expect(eventRow.compareDocumentPosition(details!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    fireEvent.click(details!.querySelector("summary")!);
    expect(within(details!).getByRole("link", { name: "Notifications" })).toHaveAttribute("href", "/cameras/notifications");
  });
});
