/**
 * WARP-3515 — /cameras/[name]/settings, the "Storage budget" card.
 *
 * Two additions, both of which must be invisible when there is nothing to say:
 *
 *   1. a note naming the recording drive and THIS camera's GB a day / need for
 *      the retention window, linking to the Recording storage card;
 *   2. the budget route's `overAllocation` advisory, which the type never carried
 *      and nothing rendered: budgets that add up to more than the volume holds.
 *
 * The real ShellPage renders around mocked data (the cameras.page-rhythm harness):
 * `swr` is answered per key, the zone/mask editors are stubbed (canvas), and the
 * recording-storage hook is driven directly.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import type { CameraBudget, CameraInfo, CameraSettings } from "@/lib/types";

const auth = vi.hoisted(() => ({ role: "owner" }));
vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
  useAuth: () => ({ user: { role: auth.role } }),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ name: "front_door" }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/cameras/front_door/settings",
  useSearchParams: () => new URLSearchParams(),
}));

const swr = vi.hoisted(() => ({
  byKey: {} as Record<string, { data?: unknown; error?: unknown }>,
}));
vi.mock("swr", () => ({
  default: (key: unknown) => ({
    data: undefined,
    error: undefined,
    isLoading: false,
    isValidating: false,
    mutate: vi.fn(),
    ...(swr.byKey[String(key)] ?? {}),
  }),
}));

vi.mock("@/lib/hooks/useCameras", () => ({
  useCameras: () => ({
    cameras: [
      {
        name: "front_door",
        displayName: "Front door",
        manufacturer: null,
        model: null,
        ipAddress: "10.10.0.5",
        macAddress: null,
        enabled: true,
        autoDiscovered: false,
        status: "live",
        lastSeen: "2026-10-03T10:00:00Z",
        lastDetection: null,
        recording: {
          degraded: false,
          mode: "continuous",
          retentionDays: { continuous: 7, motion: 7, alerts: 7, detections: 7 },
          lastSegmentAt: "2026-10-03T10:00:00Z",
          usedBytes: 20 * 1024 ** 3,
          bytesPerDay: 36 * 1_000_000_000,
        },
      } satisfies CameraInfo,
    ],
    refresh: vi.fn(),
  }),
}));

vi.mock("@/lib/hooks/useRecordings", () => ({
  useRecordingsSummary: () => ({ days: [], isLoading: false, error: undefined, refresh: vi.fn() }),
}));

vi.mock("@/components/settings/ZoneEditor", () => ({ ZoneEditor: () => null }));
vi.mock("@/components/settings/MotionMaskEditor", () => ({ MotionMaskEditor: () => null }));

const recordings = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock("@/lib/hooks/useRecordingStorage", () => ({
  useRecordingStorage: () => recordings.value,
}));

import CameraSettingsPage from "@/app/cameras/[name]/settings/page";

const GIB = 1024 ** 3;

const settings: CameraSettings = {
  detectEnabled: true,
  detectFps: 5,
  trackedLabels: ["person"],
  objectFilters: { person: { threshold: 0.7, minScore: 0.5 } },
  recordEnabled: true,
  continuousRetainDays: 7,
  motionRetainDays: 7,
  alertsRetainDays: 7,
  detectionsRetainDays: 7,
  snapshotsEnabled: true,
  snapshotRetainDays: 7,
  zones: [],
  motionMasks: [],
};

function budget(overrides: Partial<CameraBudget> = {}): CameraBudget {
  return {
    retentionMode: "BUDGET",
    budgetBytes: 100 * GIB,
    retentionCeiling: null,
    ...overrides,
  };
}

function ready() {
  recordings.value = {
    state: "ready",
    refresh: vi.fn(),
    recording: {
      status: "active",
      mode: "auto_reserved",
      drive: { fsUuid: "fs-1", label: "Bay 2", model: "", sizeBytes: 4000 * GIB, encrypted: true, mountPath: "" },
      reservedBytes: 120 * GIB,
      usedBytes: 40 * GIB,
      freeBytes: 80 * GIB,
      needBytes: 96 * GIB,
      retentionDays: 7,
      daysStored: 3,
      cameras: [
        { name: "front_door", displayName: "Front door", mbPerHour: 1500, gbPerDay: 36, needBytes: 75 * GIB, usedBytes: 20 * GIB },
      ],
      migration: { state: "idle", progressPct: 0, bytesCopied: 0, bytesTotal: 0, startedAt: null, error: null },
      oldFootage: { present: false, bytes: 0, location: "system_disk" },
      warnings: [],
      eligibleDrives: [],
    },
  };
}

function mountPage(b: CameraBudget | undefined = budget()) {
  swr.byKey = {
    "camera-settings,front_door": { data: settings },
    "camera-budget,front_door": { data: b },
  };
  return render(<CameraSettingsPage />);
}

function budgetCard(): HTMLElement {
  const heading = screen.getByRole("heading", { name: /storage budget/i });
  return heading.closest(".card") as HTMLElement;
}

afterEach(() => {
  cleanup();
  auth.role = "owner";
});

describe("/cameras/[name]/settings — where this camera records", () => {
  it("keeps current recording status and usage alongside the recording-drive allocation", () => {
    ready();
    mountPage();
    expect(screen.getByRole("heading", { name: "Recording status" })).toBeInTheDocument();
    expect(within(budgetCard()).getByTestId("budget-usage")).toHaveTextContent("Using 20.0 GiB now.");
    expect(within(budgetCard()).getByRole("group", { name: /where this camera records/i })).toHaveTextContent("Recording drive: Bay 2");
  });

  it("puts the recording drive and this camera's numbers in the Storage budget card", () => {
    ready();
    mountPage();
    const note = within(budgetCard()).getByRole("group", { name: /where this camera records/i });
    expect(note).toHaveTextContent("Recording drive: Bay 2");
    expect(note).toHaveTextContent(/about 36 GB a day/i);
    expect(note).toHaveTextContent(/needs about 75\.0 GiB for its retention window/i);
  });

  it("links to the Recording storage card on the camera system page", () => {
    ready();
    mountPage();
    expect(within(budgetCard()).getByRole("link", { name: /recording storage/i })).toHaveAttribute(
      "href",
      "/cameras/system#recording-storage",
    );
  });

  it("leaves the budget card exactly as it was when recording storage is not there yet", () => {
    recordings.value = { state: "not_supported", recording: null, refresh: vi.fn() };
    mountPage();
    const card = budgetCard();
    expect(within(card).queryByRole("group")).not.toBeInTheDocument();
    expect(within(card).getByRole("button", { name: /use this budget/i })).toBeInTheDocument();
    expect(within(card).getByLabelText(/storage budget in gibibytes/i)).toBeInTheDocument();
  });

  it("says nothing extra while recording storage is still loading or failed", () => {
    recordings.value = { state: "error", recording: null, refresh: vi.fn() };
    mountPage();
    expect(within(budgetCard()).queryByRole("group")).not.toBeInTheDocument();
  });
});

describe("/cameras/[name]/settings — budgets that outgrow the drive (overAllocation)", () => {
  it("warns when the budgets add up to more than the volume holds", () => {
    ready();
    mountPage(
      budget({
        overAllocation: { allocatedBytes: 3000 * GIB, capacityBytes: 2000 * GIB, overAllocated: true },
      }),
    );
    const warning = within(budgetCard()).getByTestId("over-allocation-warning");
    expect(warning).toHaveTextContent(/add up to 2\.93 TiB/i);
    expect(warning).toHaveTextContent(/drive holds 1\.95 TiB/i);
    expect(within(budgetCard()).getAllByTestId("over-allocation-warning")).toHaveLength(1);
  });

  it.each([
    ["within the drive", { allocatedBytes: 500 * GIB, capacityBytes: 2000 * GIB, overAllocated: false }],
    ["unknown (null)", null],
    ["absent", undefined],
  ])("is silent when the budgets are %s", (_label, overAllocation) => {
    ready();
    mountPage(budget({ overAllocation }));
    expect(screen.queryByTestId("over-allocation-warning")).not.toBeInTheDocument();
  });

  it("shows the warning even when recording storage itself is unavailable (it is the budget route's own advisory)", () => {
    recordings.value = { state: "not_supported", recording: null, refresh: vi.fn() };
    mountPage(
      budget({
        overAllocation: { allocatedBytes: 3000 * GIB, capacityBytes: 2000 * GIB, overAllocated: true },
      }),
    );
    expect(screen.getByTestId("over-allocation-warning")).toBeInTheDocument();
  });
});
