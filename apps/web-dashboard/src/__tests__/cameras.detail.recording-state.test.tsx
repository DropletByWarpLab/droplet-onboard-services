/**
 * WARP-3511 — the camera screen at /cameras/[name].
 *
 *  - Enable / Disable is a settings write that restarts the camera service
 *    for every camera, so it is confirmed first, and a failure is SAID. It used
 *    to fire on click, with the promise dropped on the floor: when Frigate
 *    refused, nothing happened and nothing told you.
 *  - "Settings" keeps its label on a phone (it is where "not saving" is fixed).
 *  - The "not saving" banner links to Settings for real, and offers the repair.
 *  - Recording information remains available in the camera details.
 *  - While the camera service cannot be read, the screen says so instead of
 *    "Camera offline", and the PTZ probe is never retried forever.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import type { ReactNode } from "react";
import type { CameraInfo, CameraRecordingState, DetectionEvent } from "@/lib/types";

const h = vi.hoisted(() => ({
  role: "owner",
  camera: undefined as unknown as CameraInfo,
  events: [] as DetectionEvent[],
  push: vi.fn(),
  replace: vi.fn(),
  enableCam: vi.fn(),
  disableCam: vi.fn(),
  removeCam: vi.fn(),
  refresh: vi.fn(),
  toast: vi.fn(),
  swrCalls: [] as Array<{ key: unknown; options: Record<string, unknown> }>,
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ name: "front_door" }),
  useRouter: () => ({ push: h.push, replace: h.replace, back: vi.fn() }),
  usePathname: () => "/cameras/front_door",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
  useAuth: () => ({ user: { role: h.role } }),
}));

vi.mock("@/lib/hooks/useCameras", () => ({
  useCameras: () => ({
    cameras: h.camera ? [h.camera] : [],
    isLoading: false,
    refresh: h.refresh,
    enableCam: h.enableCam,
    disableCam: h.disableCam,
    removeCam: h.removeCam,
  }),
}));

vi.mock("@/lib/hooks/useCameraPins", () => ({
  useCameraPins: () => ({ pinnedSet: new Set<string>(), toggle: vi.fn() }),
}));

vi.mock("@/lib/hooks/useRecordings", () => ({
  useRecordingsSummary: () => ({ days: [], isLoading: false, error: undefined, refresh: vi.fn() }),
}));

// This suite owns camera management and recording status. Playback behavior is
// exercised with the real panel in cameras.detail.playback.test.tsx.
vi.mock("@/components/cameras/CameraPlaybackPanel", () => ({
  CameraPlaybackPanel: ({ children, selection, onReturnToLive }: {
    children: ReactNode;
    selection: { kind: "event"; event: DetectionEvent } | { kind: "motion"; activity: { id: string } } | null;
    onReturnToLive: () => void;
  }) => selection ? (
    <div>
      <p data-testid="selected-camera-clip">
        {selection.kind === "event" ? selection.event.id : selection.activity.id}
      </p>
      <button onClick={onReturnToLive}>Return to live</button>
    </div>
  ) : children,
}));

vi.mock("@/lib/api", () => ({
  fetchPtzCapabilities: vi.fn(),
  fetchMotionActivity: vi.fn(),
  getCameraLiveUrl: (n: string) => `/api/cameras/${n}/live`,
  getCameraSnapshotUrl: (n: string) => `/api/cameras/${n}/snapshot`,
  fetchRetentionBackfillPlan: vi.fn(),
  runRetentionBackfill: vi.fn(),
}));

vi.mock("@/components/ptz/PtzOverlay", () => ({ PtzOverlay: () => null }));

vi.mock("@/components/Toast", () => ({
  useToast: () => ({ toast: h.toast, dismissAll: vi.fn() }),
}));

// Capture how the page configures its SWR calls (the PTZ probe's retry policy).
vi.mock("swr", () => ({
  default: (key: unknown, _fetcher: unknown, options: Record<string, unknown> = {}) => {
    h.swrCalls.push({ key, options });
    return { data: typeof key === "string" && key.includes("/events?") ? h.events : undefined, error: undefined, isLoading: false, mutate: vi.fn() };
  },
}));

import CameraFullscreenPage from "@/app/cameras/[name]/page";
import { CamerasUnavailableError } from "@/lib/files-unavailable";

function rec(over: Partial<CameraRecordingState> = {}): CameraRecordingState {
  return {
    degraded: false,
    mode: "continuous",
    retentionDays: { continuous: 11, motion: 17, alerts: 23, detections: 29 },
    lastSegmentAt: new Date(Date.now() - 12_000).toISOString(),
    usedBytes: 46 * 1024 ** 3,
    bytesPerDay: 24 * 1024 ** 3,
    ...over,
  };
}

function cam(over: Partial<CameraInfo> = {}): CameraInfo {
  return {
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
    recording: rec(),
    ...over,
  };
}

const DEGRADED = (): Partial<CameraInfo> => ({
  status: "offline",
  recording: rec({ degraded: true, mode: null, retentionDays: null, lastSegmentAt: null, usedBytes: null, bytesPerDay: null }),
});

beforeEach(() => {
  vi.clearAllMocks();
  h.role = "owner";
  h.camera = cam();
  h.events = [];
  h.swrCalls = [];
  h.enableCam.mockResolvedValue(undefined);
  h.disableCam.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("Disable / Enable", () => {
  it("Disable asks first, in words about what happens, and does nothing until confirmed", () => {
    render(<CameraFullscreenPage />);
    fireEvent.click(screen.getByRole("button", { name: "Disable" }));

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain('Disable "Front door"?');
    expect(dialog.textContent).toMatch(/restarts to apply this, so every camera drops for a few seconds/);
    expect(dialog.textContent).toContain("Write · confirm to apply");
    expect(h.disableCam).not.toHaveBeenCalled();
  });

  it("confirming disables that camera and tells the household", async () => {
    render(<CameraFullscreenPage />);
    fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Disable" }));

    await waitFor(() => expect(h.disableCam).toHaveBeenCalledWith("front_door"));
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith("Front door is disabled.", "success"));
  });

  it("a refusal is shown as an error and the dialog stays so it can be tried again", async () => {
    h.disableCam.mockRejectedValue(new Error("Too many camera changes. Wait a minute."));
    render(<CameraFullscreenPage />);
    fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Disable" }));

    await waitFor(() =>
      expect(h.toast).toHaveBeenCalledWith("Too many camera changes. Wait a minute.", "error"),
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("an unreachable camera service is said in plain words", async () => {
    h.disableCam.mockRejectedValue(new CamerasUnavailableError());
    render(<CameraFullscreenPage />);
    fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Disable" }));

    await waitFor(() =>
      expect(h.toast).toHaveBeenCalledWith("The camera service isn't responding. Try again in a moment.", "error"),
    );
  });

  it("Cancel leaves the camera alone", async () => {
    render(<CameraFullscreenPage />);
    fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(h.disableCam).not.toHaveBeenCalled();
  });

  it("Enable is confirmed the same way", async () => {
    h.camera = cam({ enabled: false });
    render(<CameraFullscreenPage />);
    fireEvent.click(screen.getByRole("button", { name: "Enable" }));

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain('Enable "Front door"?');
    expect(h.enableCam).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Enable" }));
    await waitFor(() => expect(h.enableCam).toHaveBeenCalledWith("front_door"));
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith("Front door is enabled.", "success"));
  });

  it("a member is offered neither", () => {
    h.role = "family";
    render(<CameraFullscreenPage />);
    expect(screen.queryByRole("button", { name: "Disable" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Enable" })).toBeNull();
  });
});

describe("the Settings button", () => {
  it("keeps its label on a phone — it is never the icon-only, sm-and-up kind", () => {
    render(<CameraFullscreenPage />);
    const button = screen.getByRole("button", { name: /Settings/ });
    const label = within(button).getByText("Settings");
    expect(label.className).not.toContain("hidden");
  });

  it("goes to that camera's settings", () => {
    render(<CameraFullscreenPage />);
    fireEvent.click(screen.getByRole("button", { name: /Settings/ }));
    expect(h.push).toHaveBeenCalledWith("/cameras/front_door/settings");
  });

  it("the other toolbar labels still collapse on a phone (only Settings was promoted)", () => {
    render(<CameraFullscreenPage />);
    const label = within(screen.getByRole("button", { name: /Recordings/ })).getByText("Recordings");
    expect(label.className).toContain("hidden");
  });
});

describe("the 'not saving' banner", () => {
  const notSaving = () => cam({ status: "live", recording: rec({ mode: "off", lastSegmentAt: null }) });

  it("links to Settings for real — it used to be the plain word", () => {
    h.camera = notSaving();
    render(<CameraFullscreenPage />);
    const banner = screen.getByTestId("status-help");
    const link = within(banner).getByRole("link", { name: "Settings" });
    expect(link.getAttribute("href")).toBe("/cameras/front_door/settings");
  });

  it("offers the repair to an owner or admin", () => {
    h.camera = notSaving();
    render(<CameraFullscreenPage />);
    expect(within(screen.getByTestId("status-help")).getByRole("button", { name: /^Fix:/ })).toBeTruthy();
  });

  it("tells a member who to ask, with no link to a page that would refuse them and no repair", () => {
    h.role = "family";
    h.camera = notSaving();
    render(<CameraFullscreenPage />);
    const banner = screen.getByTestId("status-help");
    expect(within(banner).queryByRole("link")).toBeNull();
    expect(within(banner).queryByRole("button", { name: /^Fix:/ })).toBeNull();
    expect(banner.textContent).toMatch(/Ask an owner or admin/);
  });

  it("is absent for a camera that is saving", () => {
    render(<CameraFullscreenPage />);
    expect(screen.queryByTestId("status-help")).toBeNull();
  });
});

describe("the rail", () => {
  it("keeps the Recording block available with the camera's own reading", () => {
    render(<CameraFullscreenPage />);
    const block = screen.getByTestId("camera-recording-summary");
    expect(within(block).getByTestId("recording-mode").textContent).toBe("24/7");
    expect(block.textContent).toContain("Alert clips: 23 days");
  });

  it("links on to the camera's other pages", () => {
    render(<CameraFullscreenPage />);
    const details = screen.getByTestId("camera-related-links").closest("details");
    if (details) fireEvent.click(details.querySelector("summary")!);
    const links = within(screen.getByTestId("camera-related-links"));
    expect(links.getByRole("link", { name: "Notifications" }).getAttribute("href")).toBe("/cameras/notifications");
    expect(links.getByRole("link", { name: "System" }).getAttribute("href")).toBe("/cameras/system");
  });
});

describe("while the camera service cannot be read", () => {
  beforeEach(() => {
    h.camera = cam(DEGRADED());
  });

  it("says so, and never says Camera offline", () => {
    render(<CameraFullscreenPage />);
    expect(screen.getAllByTestId("camera-service-notice").length).toBeGreaterThan(0);
    expect(screen.queryByText("Camera offline")).toBeNull();
    expect(screen.getByText("Waiting for the camera service")).toBeTruthy();
  });

  it("the status line is 'Status unavailable', not a recording claim", () => {
    render(<CameraFullscreenPage />);
    expect(screen.getByText("Status unavailable")).toBeTruthy();
    expect(screen.queryByTestId("status-help")).toBeNull();
  });

  it("does not show the LIVE pip over a feed it is not showing", () => {
    render(<CameraFullscreenPage />);
    expect(screen.queryByText("LIVE")).toBeNull();
  });
});

describe("a camera that is simply offline", () => {
  it("still says Camera offline when the service itself is fine", () => {
    h.camera = cam({ status: "offline" });
    render(<CameraFullscreenPage />);
    expect(screen.getByText("Camera offline")).toBeTruthy();
    expect(screen.queryByTestId("camera-service-notice")).toBeNull();
  });
});

describe("the PTZ probe", () => {
  const ptzOptions = () => {
    render(<CameraFullscreenPage />);
    const call = h.swrCalls.find((c) => String(c.key).endsWith("/ptz"));
    expect(call).toBeDefined();
    return call!.options;
  };

  it("is never retried on error — a camera with no PTZ is the normal case", () => {
    expect(ptzOptions().shouldRetryOnError).toBe(false);
  });

  it("is asked again only while the answer was 'unknown' (the service was down)", () => {
    const refreshInterval = ptzOptions().refreshInterval as (latest: { degraded?: boolean } | undefined) => number;
    expect(refreshInterval({ degraded: true })).toBe(10_000);
    expect(refreshInterval({ degraded: false })).toBe(0);
    expect(refreshInterval(undefined)).toBe(0);
  });
});

describe("what was already here", () => {
  it("selects the recent person's clip inline and Escape returns to live before leaving the camera", () => {
    h.events = [{ id: "evt-1", camera: "front_door", label: "person", score: 0.92, startTime: 1_800_000_000, endTime: 1_800_000_010, thumbnail: "/api/cameras/events/evt-1/thumbnail", hasSnapshot: true, hasClip: true }];
    render(<CameraFullscreenPage />);
    fireEvent.click(screen.getByRole("button", { name: /Play person clip/ }));
    expect(screen.getByTestId("selected-camera-clip")).toHaveTextContent("evt-1");
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("selected-camera-clip")).toBeNull();
    expect(h.replace).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(h.replace).toHaveBeenCalledWith("/cameras");
  });

  it("the fullscreen toggle keeps its accessible name", () => {
    render(<CameraFullscreenPage />);
    expect(screen.getByRole("button", { name: "Toggle fullscreen" })).toBeTruthy();
  });
});
