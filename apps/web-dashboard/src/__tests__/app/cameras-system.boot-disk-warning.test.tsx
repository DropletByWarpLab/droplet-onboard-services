/**
 * WARP-2099 — the "recordings are on the boot disk" warning must be reachable.
 *
 * The orchestrator has detected this condition since WARP-1963
 * (recordingsOnBootDisk, camera-system.service.ts), but the dashboard rendered
 * the warning INSIDE the else-branch of a zero-cameras ternary — so the one
 * box that most needs it, a freshly reset box with nothing adopted yet, could
 * never display it. `data-testid="boot-disk-warning"` had zero test references
 * repo-wide, which is why the gap survived.
 *
 * The damage lands the moment a camera is adopted after a factory reset:
 * Frigate writes 24/7 into a boot-disk volume while a dedicated array sits
 * idle. The owner's only clue is this warning.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { CameraStorageSummary, CameraSystemStatus } from "@/lib/types";

const fetchCameraSystemStatus = vi.fn();
const fetchCameraStorage = vi.fn();

// Spread the real module: the page renders inside ShellPage, which pulls
// further api exports. Only the two fetchers under test are replaced.
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchCameraSystemStatus: (...a: unknown[]) => fetchCameraSystemStatus(...a),
  fetchCameraStorage: (...a: unknown[]) => fetchCameraStorage(...a),
  restartFrigate: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

import CameraSystemPage from "@/app/cameras/system/page";

/** SWR's cache is module-global and keyed by URL, so without a fresh provider
 *  the second test reuses the first test's storage payload and never refetches. */
function renderPage() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <CameraSystemPage />
    </SWRConfig>,
  );
}

const SYSTEM_OK: CameraSystemStatus = {
  version: "0.14.1",
  uptimeSec: 3600,
  cameraCount: 0,
  camerasLive: 0,
  cameraFps: [],
  detectors: [],
  gpus: [],
  storage: [],
  cpuPct: 4.2,
};

function storageSummary(over: Partial<CameraStorageSummary> = {}): CameraStorageSummary {
  return {
    volume: {
      path: "/media/frigate",
      totalBytes: 250_000_000_000,
      usedBytes: 200_000_000_000,
      freeBytes: 50_000_000_000,
      usedPercent: 80,
    },
    cameras: [],
    nearFull: false,
    recordingsOnBootDisk: true,
    totalBytesPerHour: null,
    ...over,
  };
}

describe("cameras/system — boot-disk warning reachability (WARP-2099)", () => {
  beforeEach(() => {
    fetchCameraSystemStatus.mockReset().mockResolvedValue(SYSTEM_OK);
    fetchCameraStorage.mockReset();
  });
  afterEach(() => cleanup());

  it("warns about boot-disk recordings even with NO cameras adopted", async () => {
    // The regression guard. Before the fix this rendered "No cameras are
    // recording yet." and nothing else — the warning was structurally
    // unreachable on exactly the box that has just been reset.
    fetchCameraStorage.mockResolvedValue(storageSummary({ cameras: [] }));
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("boot-disk-warning")).toBeInTheDocument(),
    );
  });

  it("still warns once cameras ARE recording", async () => {
    fetchCameraStorage.mockResolvedValue(
      storageSummary({
        cameras: [
          {
            camera: "front_door",
            usedBytes: 1_000_000_000,
            sharePercent: 0.4,
            bytesPerHour: null,
            daysAtCurrentRate: null,
          },
        ] as CameraStorageSummary["cameras"],
      }),
    );
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("boot-disk-warning")).toBeInTheDocument(),
    );
  });

  it("stays silent when recordings are on the dedicated drive", async () => {
    fetchCameraStorage.mockResolvedValue(
      storageSummary({ recordingsOnBootDisk: false }),
    );
    renderPage();
    await waitFor(() => expect(fetchCameraStorage).toHaveBeenCalled());
    expect(screen.queryByTestId("boot-disk-warning")).toBeNull();
  });

  it("stays silent when the box cannot tell (null), never guessing", async () => {
    // null is "can't tell" — crying wolf here would train the owner to ignore
    // the one warning that matters.
    fetchCameraStorage.mockResolvedValue(
      storageSummary({ recordingsOnBootDisk: null }),
    );
    renderPage();
    await waitFor(() => expect(fetchCameraStorage).toHaveBeenCalled());
    expect(screen.queryByTestId("boot-disk-warning")).toBeNull();
  });
});
