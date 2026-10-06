/**
 * WARP-3511 — the per-camera settings page.
 *
 *  - Its sliders are drawn from the same limits the service validates against
 *    (detection FPS 1–30, every retention window 0–90 days). The sliders used
 *    to stop at 15 FPS while the service accepted 30, and the service accepted
 *    365 days while the sliders stopped at 90.
 *  - It opens with the camera's Recording status, above the controls.
 *  - The budget card shows what the camera is using and whether every budget
 *    together fits on the drive.
 *  - Saving restarts the camera service for EVERY camera, and the page says so
 *    — it used to say "the camera".
 *  - While the service restarts (or is down) the page shows a calm state and
 *    waits, instead of a red error that never clears.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { CameraBudget, CameraInfo, CameraRecordingState, CameraSettings } from "@/lib/types";

const h = vi.hoisted(() => ({
  role: "owner",
  camera: undefined as unknown as CameraInfo,
  fetchSettings: vi.fn(),
  patchSettings: vi.fn(),
  fetchBudget: vi.fn(),
  refreshCameras: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ name: "front_door" }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/cameras/front_door/settings",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
  useAuth: () => ({ user: { role: h.role } }),
}));

vi.mock("@/lib/hooks/useCameras", () => ({
  useCameras: () => ({ cameras: h.camera ? [h.camera] : [], refresh: h.refreshCameras }),
}));

vi.mock("@/lib/hooks/useRecordings", () => ({
  useRecordingsSummary: () => ({ days: [], isLoading: false, error: undefined, refresh: vi.fn() }),
}));

vi.mock("@/lib/hooks/useRecordingStorage", () => ({
  useRecordingStorage: () => ({ state: "not_supported", recording: null, stale: false, refresh: vi.fn() }),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchCameraSettings: (...a: unknown[]) => h.fetchSettings(...a),
    patchCameraSettings: (...a: unknown[]) => h.patchSettings(...a),
    fetchCameraBudget: (...a: unknown[]) => h.fetchBudget(...a),
    setCameraBudget: vi.fn(),
    renameCamera: vi.fn(),
    fetchRetentionBackfillPlan: vi.fn(),
    runRetentionBackfill: vi.fn(),
  };
});

vi.mock("@/components/Toast", () => ({
  useToast: () => ({ toast: vi.fn(), dismissAll: vi.fn() }),
}));

// The polygon editors are canvas widgets with their own suites.
vi.mock("@/components/settings/ZoneEditor", () => ({ ZoneEditor: () => null }));
vi.mock("@/components/settings/MotionMaskEditor", () => ({ MotionMaskEditor: () => null }));

// The shell chrome is not what is under test; keep the page's own header.
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

import CameraSettingsPage from "@/app/cameras/[name]/settings/page";
import { CamerasUnavailableError } from "@/lib/files-unavailable";

const SETTINGS: CameraSettings = {
  detectEnabled: true,
  detectFps: 5,
  trackedLabels: ["person"],
  objectFilters: { person: { threshold: 0.7, minScore: 0.5 } },
  recordEnabled: true,
  continuousRetainDays: 11,
  motionRetainDays: 17,
  alertsRetainDays: 23,
  detectionsRetainDays: 29,
  snapshotsEnabled: true,
  snapshotRetainDays: 7,
  zones: [],
  motionMasks: [],
};

const BUDGET: CameraBudget = {
  retentionMode: "MANUAL",
  budgetBytes: null,
  retentionCeiling: null,
  overAllocation: null,
};

const TIB = 1024 ** 4;

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

function renderPage() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <CameraSettingsPage />
    </SWRConfig>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.role = "owner";
  h.camera = cam();
  h.fetchSettings.mockResolvedValue(structuredClone(SETTINGS));
  h.fetchBudget.mockResolvedValue(structuredClone(BUDGET));
  h.patchSettings.mockImplementation(async (_name: string, patch: Partial<CameraSettings>) => ({
    ...structuredClone(SETTINGS),
    ...patch,
  }));
});
afterEach(cleanup);

describe("slider limits match what the service accepts", () => {
  it("detection FPS runs 1–30, and the five retention sliders 0–90", async () => {
    renderPage();
    const sliders = (await screen.findAllByRole("slider")) as HTMLInputElement[];

    expect([sliders[0].min, sliders[0].max]).toEqual(["1", "30"]);
    // 24/7, motion, alert clips, other detections, snapshot retention
    for (const s of sliders.slice(1, 6)) expect([s.min, s.max]).toEqual(["0", "90"]);
  });
});

describe("the Recording status block", () => {
  it("opens the page, with the camera's own reading", async () => {
    renderPage();
    expect(await screen.findByRole("heading", { name: "Recording status" })).toBeTruthy();
    expect(screen.getByTestId("recording-mode").textContent).toBe("24/7");
    expect(screen.getByTestId("recording-retention").textContent).toContain("Other detections: 29 days");
  });

  it("offers the repair on a camera that is not saving", async () => {
    h.camera = cam({ status: "live", recording: rec({ mode: "off", lastSegmentAt: null }) });
    renderPage();
    expect(await screen.findByRole("button", { name: /^Fix:/ })).toBeTruthy();
  });

  it("links to the camera's recordings, notifications and system pages — not to itself", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "Recording status" });
    const links = screen.getByTestId("camera-related-links");
    expect(links.textContent).toContain("Recordings");
    expect(links.textContent).toContain("Notifications");
    expect(links.textContent).toContain("System");
    expect(links.textContent).not.toContain("Settings");
  });
});

describe("the storage budget card", () => {
  it("says what the camera is using now, in the same units as the Camera system page", async () => {
    renderPage();
    expect((await screen.findByTestId("budget-usage")).textContent).toBe("Using 46.0 GiB now.");
  });

  it("says so when there is nothing stored yet, rather than 0", async () => {
    h.camera = cam({ recording: rec({ usedBytes: null }) });
    renderPage();
    expect((await screen.findByTestId("budget-usage")).textContent).toBe("Nothing stored for this camera yet.");
  });

  it("names its unit honestly — the field is multiplied by 1024³, so it is GiB", async () => {
    renderPage();
    expect(await screen.findByLabelText("Storage budget in gibibytes")).toBeTruthy();
  });

  it("warns when every camera's budget together is more than the drive holds", async () => {
    h.fetchBudget.mockResolvedValue({
      ...BUDGET,
      overAllocation: { allocatedBytes: 3 * TIB, capacityBytes: 2 * TIB, overAllocated: true },
    });
    renderPage();
    const note = await screen.findByTestId("budget-over-allocation");
    expect(note.textContent).toContain("3.00 TiB");
    expect(note.textContent).toContain("2.00 TiB");
    expect(note.textContent).toMatch(/oldest footage is deleted first/);
    expect(note.className).toContain("text-system-orange");
  });

  it("states the total calmly when it fits", async () => {
    h.fetchBudget.mockResolvedValue({
      ...BUDGET,
      overAllocation: { allocatedBytes: 1 * TIB, capacityBytes: 2 * TIB, overAllocated: false },
    });
    renderPage();
    const note = await screen.findByTestId("budget-over-allocation");
    expect(note.textContent).toBe("All camera budgets together: 1.00 TiB of the 2.00 TiB recordings drive.");
    expect(note.className).not.toContain("text-system-orange");
  });

  it("says nothing when the box could not read the drive's capacity", async () => {
    renderPage();
    await screen.findByTestId("budget-usage");
    expect(screen.queryByTestId("budget-over-allocation")).toBeNull();
  });
});

describe("saving restarts the camera service — for every camera", () => {
  it("the header says so", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "Recording status" });
    const sub = screen.getByTestId("page-sub").textContent ?? "";
    expect(sub).toContain("restarts the camera service");
    expect(sub).toContain("every camera drops for a few seconds");
  });

  it("the unsaved-changes bar says so", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("switch", { name: "Detection enabled" }));
    expect(screen.getByText("Unsaved changes. Saving restarts the camera service.")).toBeTruthy();
  });

  it("after a save the page says the SERVICE is restarting", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("switch", { name: "Detection enabled" }));
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => expect(h.patchSettings).toHaveBeenCalledWith("front_door", { detectEnabled: false }));
    expect(await screen.findByText("Saved. Camera service restarting…")).toBeTruthy();
  });
});

describe("a failed settings read is retried a bounded number of times", () => {
  // It used to be retried forever: SWR's default, against a camera service that
  // might be down for hours or a request that can never succeed.
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const settle = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };

  it("an ordinary failure: the read plus two quick retries, then it stops and shows the error", async () => {
    h.fetchSettings.mockRejectedValue(new Error("boom"));
    renderPage();
    await settle(60_000);
    expect(h.fetchSettings).toHaveBeenCalledTimes(3);
    expect(screen.getByText(/Couldn't load settings: boom/)).toBeTruthy();
  });

  it("a restarting service: keeps asking for about a minute, then stops", async () => {
    h.fetchSettings.mockRejectedValue(new CamerasUnavailableError());
    renderPage();
    await settle(300_000);
    // the read plus twelve retries, five seconds apart
    expect(h.fetchSettings).toHaveBeenCalledTimes(13);
  });

  it("and recovers by itself when the service comes back", async () => {
    h.fetchSettings
      .mockRejectedValueOnce(new CamerasUnavailableError())
      .mockRejectedValueOnce(new CamerasUnavailableError())
      .mockResolvedValue(structuredClone(SETTINGS));
    renderPage();
    await settle(15_000);
    expect(h.fetchSettings).toHaveBeenCalledTimes(3);
    expect(screen.getAllByRole("slider").length).toBeGreaterThan(0);
  });
});

describe("when the camera service is restarting or down", () => {
  it("shows a calm state, not a red error, when the settings read is refused as unavailable", async () => {
    h.fetchSettings.mockRejectedValue(new CamerasUnavailableError());
    renderPage();
    expect(await screen.findByTestId("camera-service-notice")).toBeTruthy();
    expect(screen.queryByText(/Couldn't load settings/)).toBeNull();
  });

  it("shows the same state when the camera list says the service is degraded", async () => {
    h.camera = cam({
      status: "offline",
      recording: rec({ degraded: true, mode: null, retentionDays: null, lastSegmentAt: null, usedBytes: null, bytesPerDay: null }),
    });
    renderPage();
    expect((await screen.findAllByTestId("camera-service-notice")).length).toBeGreaterThan(0);
  });

  it("a real error is still an error, in the danger token and with the message", async () => {
    h.fetchSettings.mockRejectedValue(new Error("boom"));
    renderPage();
    const error = await screen.findByText(/Couldn't load settings: boom/);
    expect(error.closest(".card")?.getAttribute("style")).toContain("var(--danger-ink)");
    expect(screen.queryByTestId("camera-service-notice")).toBeNull();
  });
});

describe("who can change settings", () => {
  it("a member gets the refusal and none of the editor — or the repair", () => {
    h.role = "family";
    renderPage();
    expect(screen.getByText("Only owners and admins can change camera settings.")).toBeTruthy();
    expect(screen.queryByTestId("camera-recording-summary")).toBeNull();
    expect(screen.queryByRole("slider")).toBeNull();
  });
});
