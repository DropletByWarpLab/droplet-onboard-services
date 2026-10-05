/**
 * WARP-3515 — /cameras/system, the page the Recording storage card lives on.
 *
 * Two things change on the page itself:
 *
 *   1. The card is mounted, and it does not depend on the camera service: the
 *      allocation comes from the orchestrator, so it must still render when the
 *      engine's own status could not be loaded (a missing drive is exactly when
 *      the engine is likely to be unhappy too).
 *
 *   2. The "recordings are being written to the system disk" banner (WARP-1963)
 *      used to sit inside the "cameras are present" branch of the per-camera
 *      card — so on a box with ZERO cameras, the very state where footage lands
 *      on the boot disk by default and nobody is watching, the warning vanished.
 *      It is lifted out so it shows with no cameras at all.
 *
 * `swr` is mocked per key and the real ShellPage renders around it (the same
 * harness cameras.page-rhythm.test.tsx uses).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import type { CameraStorageSummary, CameraSystemStatus } from "@/lib/types";

const auth = vi.hoisted(() => ({ role: "owner" }));
vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
  useAuth: () => ({ user: { role: auth.role } }),
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

const recordings = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock("@/lib/hooks/useRecordingStorage", () => ({
  useRecordingStorage: () => recordings.value,
}));

import CameraSystemPage from "@/app/cameras/system/page";

const GIB = 1024 ** 3;

const status: CameraSystemStatus = {
  version: "0.17.1",
  uptimeSec: 7200,
  cameraCount: 2,
  camerasLive: 2,
  cameraFps: [{ name: "front_door", cameraFps: 5, detectionFps: 5, skippedFps: 0 }],
  detectors: [],
  gpus: [],
  storage: [],
  cpuPct: 12,
};

function storage(overrides: Partial<CameraStorageSummary> = {}): CameraStorageSummary {
  return {
    volume: {
      path: "/media/recordings",
      totalBytes: 1000 * GIB,
      usedBytes: 100 * GIB,
      freeBytes: 900 * GIB,
      usedPercent: 10,
    },
    cameras: [
      { camera: "front_door", usedBytes: 50 * GIB, bytesPerHour: 1e9, sharePercent: 50, daysAtCurrentRate: 3 },
    ],
    nearFull: false,
    recordingsOnBootDisk: false,
    totalBytesPerHour: 1e9,
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
      cameras: [],
      migration: { state: "idle", progressPct: 0, bytesCopied: 0, bytesTotal: 0, startedAt: null, error: null },
      oldFootage: { present: false, bytes: 0, location: "system_disk" },
      warnings: [],
      eligibleDrives: [],
    },
  };
}

function mountPage({
  sys = status as CameraSystemStatus | undefined,
  sysError,
  stor,
  storError,
}: {
  sys?: CameraSystemStatus | undefined;
  sysError?: Error;
  stor?: CameraStorageSummary;
  storError?: Error;
} = {}) {
  swr.byKey = {
    "/api/cameras/system": { data: sys, error: sysError },
    "/api/cameras/storage": { data: stor, error: storError },
  };
  return render(<CameraSystemPage />);
}

afterEach(() => {
  cleanup();
  auth.role = "owner";
});

describe("/cameras/system — the Recording storage card", () => {
  it("is on the page, with the section anchor the other surfaces link to", () => {
    ready();
    mountPage({ stor: storage() });
    const card = screen.getByTestId("recording-storage-card");
    expect(card).toHaveAttribute("id", "recording-storage");
    expect(within(card).getByRole("heading", { name: /recording storage/i })).toBeInTheDocument();
  });

  it("sits with the other storage cards: after throughput, before the volumes list", () => {
    ready();
    mountPage({
      sys: { ...status, storage: [{ path: "/media/recordings", totalBytes: 1, usedBytes: 0, freeBytes: 1, mountType: "ext4", role: "recordings", duplicateOf: null }] },
      stor: storage(),
    });
    const order = Array.from(document.querySelectorAll(".card, .kpi, [data-testid='recording-storage-card']"))
      .map((el) => el.getAttribute("data-testid") ?? el.querySelector(".ct")?.textContent ?? "");
    const throughput = order.indexOf("Per-camera throughput");
    const recording = order.indexOf("recording-storage-card");
    const volumes = order.indexOf("Storage");
    expect(throughput).toBeGreaterThanOrEqual(0);
    expect(recording).toBeGreaterThan(throughput);
    expect(volumes).toBeGreaterThan(recording);
  });

  it("still renders when the camera engine's own status could not be loaded", () => {
    ready();
    mountPage({ sys: undefined, sysError: new Error("503"), stor: undefined });
    expect(screen.getByText(/couldn't reach the camera service/i)).toBeInTheDocument();
    expect(screen.getByTestId("recording-storage-card")).toBeInTheDocument();
  });

  it("says 'not available on this Droplet yet' — and leaves the rest of the page intact — on an older orchestrator", () => {
    recordings.value = { state: "not_supported", recording: null, refresh: vi.fn() };
    mountPage({ stor: storage() });
    expect(screen.getByText(/isn't available on this droplet yet/i)).toBeInTheDocument();
    expect(screen.getByText("Per-camera throughput")).toBeInTheDocument();
    expect(screen.getByText("Storage by camera")).toBeInTheDocument();
  });

  it("is absent for a role that may not read it", () => {
    recordings.value = { state: "forbidden", recording: null, refresh: vi.fn() };
    mountPage({ stor: storage() });
    expect(screen.queryByTestId("recording-storage-card")).not.toBeInTheDocument();
    expect(screen.getByText("Per-camera throughput")).toBeInTheDocument();
  });
});

describe("/cameras/system — the boot-disk banner is not hostage to having cameras (WARP-1963)", () => {
  it("shows with ZERO cameras", () => {
    ready();
    mountPage({ stor: storage({ cameras: [], recordingsOnBootDisk: true }) });
    const banner = screen.getByTestId("boot-disk-warning");
    expect(banner).toHaveTextContent(/recordings are being written to the system disk/i);
    // The empty-state line is still there beneath it.
    expect(screen.getByText(/no cameras are recording yet/i)).toBeInTheDocument();
  });

  it("still shows with cameras present (no regression)", () => {
    ready();
    mountPage({ stor: storage({ recordingsOnBootDisk: true }) });
    expect(screen.getByTestId("boot-disk-warning")).toBeInTheDocument();
  });

  it.each([false, null])("is absent when recordingsOnBootDisk is %s", (value) => {
    ready();
    mountPage({ stor: storage({ cameras: [], recordingsOnBootDisk: value }) });
    expect(screen.queryByTestId("boot-disk-warning")).not.toBeInTheDocument();
  });

  it("is absent while storage usage is unavailable — an outage must not be read as a finding", () => {
    ready();
    mountPage({ stor: undefined, storError: new Error("503") });
    expect(screen.queryByTestId("boot-disk-warning")).not.toBeInTheDocument();
    expect(screen.getByText(/storage usage is unavailable right now/i)).toBeInTheDocument();
  });

  it("is announced to assistive tech and paints its text with the danger-ink token", () => {
    ready();
    mountPage({ stor: storage({ cameras: [], recordingsOnBootDisk: true }) });
    const banner = screen.getByTestId("boot-disk-warning");
    expect(banner).toHaveAttribute("role", "alert");
    // Error TEXT is --danger-ink (AA in both themes), not a raw hex or the --danger fill.
    expect(banner.getAttribute("style")).toContain("var(--danger-ink)");
    expect(banner.getAttribute("style")).not.toMatch(/#ef4444/i);
  });
});
