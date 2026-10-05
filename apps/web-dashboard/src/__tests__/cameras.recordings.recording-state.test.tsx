/**
 * WARP-3511 — the per-camera Recordings page.
 *
 *  - Its subtitle says how far back THIS camera keeps footage, from its own
 *    retention. It used to say "the past 7 days" for every camera, whatever it
 *    kept, and that figure changes by release.
 *  - The empty state's "Settings" is a link for someone who can open it, and
 *    a sentence about who to ask for everyone else.
 *  - The page links onward to the camera's other pages.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import type { CameraInfo, CameraRecordingState, RecordingDay } from "@/lib/types";

const h = vi.hoisted(() => ({
  role: "owner",
  camera: undefined as unknown as CameraInfo,
  days: [] as RecordingDay[],
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ name: "front_door" }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/cameras/front_door/recordings",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
  useAuth: () => ({ user: { role: h.role } }),
}));

vi.mock("@/lib/hooks/useCameras", () => ({
  useCameras: () => ({ cameras: h.camera ? [h.camera] : [] }),
}));

vi.mock("@/lib/hooks/useRecordings", () => ({
  useRecordingsSummary: () => ({ days: h.days, isLoading: false, error: undefined, refresh: vi.fn() }),
  useRecordingsRange: () => ({
    segments: [],
    timeline: [],
    isLoading: false,
    error: undefined,
    refresh: vi.fn(),
  }),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, getRecordingHlsUrl: () => "/hls.m3u8" };
});

vi.mock("@/components/recordings/HlsPlayer", () => ({ HlsPlayer: () => null }));
vi.mock("@/components/recordings/RecordingsTimeline", () => ({
  RecordingsTimeline: () => null,
  fmtSecOfDay: (n: number) => String(n),
}));

vi.mock("@/components/shell/ShellPage", () => ({
  ShellPage: ({
    title,
    sub,
    actions,
    children,
  }: {
    title: string;
    sub?: string;
    actions?: React.ReactNode;
    children: React.ReactNode;
  }) => (
    <div>
      <h1>{title}</h1>
      <p data-testid="page-sub">{sub}</p>
      <div>{actions}</div>
      {children}
    </div>
  ),
}));

import RecordingsPage from "@/app/cameras/[name]/recordings/page";

function rec(over: Partial<CameraRecordingState> = {}): CameraRecordingState {
  return {
    degraded: false,
    mode: "continuous",
    // Unlike any shipped default, so a hard-coded figure cannot hide.
    retentionDays: { continuous: 11, motion: 41, alerts: 23, detections: 29 },
    lastSegmentAt: null,
    usedBytes: null,
    bytesPerDay: null,
    ...over,
  };
}

function cam(over: Partial<CameraInfo> = {}): CameraInfo {
  return {
    name: "front_door",
    displayName: "Front door",
    manufacturer: null,
    model: null,
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

/** Today's footage at hour 0, so the page selects an hour that is in the past. */
function todayWithFootage(): RecordingDay[] {
  const now = new Date();
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return [
    {
      day,
      events: 0,
      duration: 3600,
      hours: [{ hour: 0, events: 0, duration: 3600, motion: 0, objects: 0 }],
    },
  ];
}

beforeEach(() => {
  h.role = "owner";
  h.camera = cam();
  h.days = [];
});
afterEach(cleanup);

describe("the subtitle", () => {
  it("states how far back this camera keeps footage, from its own windows", () => {
    render(<RecordingsPage />);
    const sub = screen.getByTestId("page-sub").textContent ?? "";
    expect(sub).toContain("Footage is kept for up to 41 days.");
    expect(sub).toContain("Click an hour on the timeline to jump in.");
  });

  it("never says the old fixed '7 days'", () => {
    h.camera = cam({ recording: rec({ retentionDays: { continuous: 3, motion: 0, alerts: 0, detections: 0 } }) });
    render(<RecordingsPage />);
    const sub = screen.getByTestId("page-sub").textContent ?? "";
    expect(sub).toContain("up to 3 days");
    expect(sub).not.toContain("past 7 days");
  });

  it("is honest for a camera that is not saving", () => {
    h.camera = cam({ status: "live", recording: rec({ mode: "off" }) });
    render(<RecordingsPage />);
    expect(screen.getByTestId("page-sub").textContent).toContain("This camera isn't saving footage");
  });

  it("claims no figure while the camera service cannot be read", () => {
    h.camera = cam({
      status: "offline",
      recording: rec({ degraded: true, mode: null, retentionDays: null }),
    });
    render(<RecordingsPage />);
    const sub = screen.getByTestId("page-sub").textContent ?? "";
    expect(sub).toContain("Browse your recordings.");
    expect(sub).not.toMatch(/\d+ days?/);
  });

  it("falls back when the box sends no recording block", () => {
    h.camera = cam({ recording: undefined });
    render(<RecordingsPage />);
    expect(screen.getByTestId("page-sub").textContent).toContain("Browse your recordings.");
  });
});

describe("the empty state", () => {
  beforeEach(() => {
    // An hour is selected, but the (mocked) range has no segments.
    h.days = todayWithFootage();
  });

  it("links to the camera's Settings for an owner or admin", () => {
    render(<RecordingsPage />);
    const empty = screen.getByText(/No footage kept for this hour/).parentElement as HTMLElement;
    const link = within(empty).getByRole("link", { name: "Settings" });
    expect(link.getAttribute("href")).toBe("/cameras/front_door/settings");
  });

  it("tells a member who to ask, and offers no link they would be refused at", () => {
    h.role = "family";
    render(<RecordingsPage />);
    const empty = screen.getByText(/No footage kept for this hour/).parentElement as HTMLElement;
    expect(within(empty).queryByRole("link")).toBeNull();
    expect(empty.textContent).toMatch(/Ask an owner or admin to keep footage for longer/);
  });
});

describe("links to the camera's other pages", () => {
  it("an owner gets Settings, Notifications and System — not Recordings, the page it is on", () => {
    render(<RecordingsPage />);
    const nav = within(screen.getByTestId("camera-related-links"));
    expect(nav.getByRole("link", { name: "Settings" }).getAttribute("href")).toBe("/cameras/front_door/settings");
    expect(nav.getByRole("link", { name: "Notifications" }).getAttribute("href")).toBe("/cameras/notifications");
    expect(nav.getByRole("link", { name: "System" }).getAttribute("href")).toBe("/cameras/system");
    expect(nav.queryByRole("link", { name: "Recordings" })).toBeNull();
  });

  it("a member does not get Settings", () => {
    h.role = "family";
    render(<RecordingsPage />);
    expect(within(screen.getByTestId("camera-related-links")).queryByRole("link", { name: "Settings" })).toBeNull();
  });
});
