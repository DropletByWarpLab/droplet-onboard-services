/**
 * WARP-174 — Storage step.
 *
 * Validates:
 *   1. Auto-skip when the bridge returns 0 drives — the customer never
 *      sees an empty form.
 *   2. Renders one card per detected drive with the FS label as a
 *      secondary hint, pre-filling existing displayName values.
 *   3. Save → PATCH /api/storage/drives/:uuid per named drive →
 *      advance to discovery.
 *   4. Skip advances without PATCHing anything.
 *   5. Duplicate names → inline error, no save.
 *
 * Same Vitest + JSDOM + assert-on-DOM-strings pattern the rest of the
 * setup tests use.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import React from "react";

vi.mock("framer-motion", async () => {
  const actual =
    await vi.importActual<typeof import("framer-motion")>("framer-motion");
  return { ...actual, useReducedMotion: () => true };
});

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ completeSetup: vi.fn() }),
}));

const fetchDrivesMock = vi.fn();
const updateDriveLabelMock = vi.fn();

vi.mock("@/lib/api", () => ({
  setupAdmin: vi.fn(async () => undefined),
  loginUser: vi.fn(async () => undefined),
  fetchDuckDnsStatus: vi.fn(async () => ({ configured: false })),
  setDuckDnsConfig: vi.fn(async () => ({ configured: false })),
  fetchDrives: () => fetchDrivesMock(),
  updateDriveLabel: (uuid: string, patch: unknown) =>
    updateDriveLabelMock(uuid, patch),
  fetchDiscoveredCameras: vi.fn(async () => []),
  acceptDiscoveredCamera: vi.fn(),
  fetchVpnStatus: vi.fn(async () => ({
    configured: false,
    endpointConfigured: false,
  })),
  createVpnPeer: vi.fn(),
  fetchMatterDevices: vi.fn(async () => ({
    lights: [],
    switches: [],
    climate: [],
    sensors: [],
    media: [],
    covers: [],
    locks: [],
    other: [],
  })),
}));

import SetupPage from "@/app/setup/page";

async function advanceToStorage() {
  fireEvent.click(screen.getByRole("button", { name: /get started/i }));
  fireEvent.change(screen.getByPlaceholderText(/your-username/i), {
    target: { value: "owner" },
  });
  fireEvent.change(screen.getByPlaceholderText(/your name/i), {
    target: { value: "Robin" },
  });
  fireEvent.change(screen.getByPlaceholderText(/min\. 8 characters/i), {
    target: { value: "longenoughpw" },
  });
  fireEvent.change(screen.getByPlaceholderText(/repeat password/i), {
    target: { value: "longenoughpw" },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /create account/i }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  // Internet step → skip to Storage.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
  });
  // Let StorageStep's fetchDrives effect resolve.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const FIXTURE_DRIVES = {
  drives: [
    {
      device: "/dev/sda1",
      mount: "/mnt/droplet/data",
      label: "TOSHIBA EXT",
      uuid: "UUID-MAIN",
      size_bytes: 2_000_000_000_000,
      used_bytes: 100_000_000_000,
      free_bytes: 1_900_000_000_000,
      mounted: true,
      displayName: null,
      icon: null,
      notes: null,
    },
    {
      device: "/dev/sda2",
      mount: "/mnt/droplet/nvr",
      label: "WD ELEMENTS",
      uuid: "UUID-NVR",
      size_bytes: 1_000_000_000_000,
      used_bytes: 0,
      free_bytes: 1_000_000_000_000,
      mounted: true,
      displayName: null,
      icon: null,
      notes: null,
    },
  ],
  count: 2,
};

describe("setup Storage step (WARP-174)", () => {
  beforeEach(() => {
    fetchDrivesMock.mockReset();
    updateDriveLabelMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("auto-skips when bridge returns 0 drives", async () => {
    fetchDrivesMock.mockResolvedValue({ drives: [], count: 0 });
    render(<SetupPage />);
    await advanceToStorage();
    // Landed on Discovery — no Storage UI ever rendered.
    expect(screen.getByText(/discovering your devices/i)).toBeInTheDocument();
    expect(updateDriveLabelMock).not.toHaveBeenCalled();
  });

  it("renders one card per detected drive with the FS label as a hint", async () => {
    fetchDrivesMock.mockResolvedValue(FIXTURE_DRIVES);
    render(<SetupPage />);
    await advanceToStorage();

    expect(screen.getByText(/name your storage/i)).toBeInTheDocument();
    expect(screen.getByText(/TOSHIBA EXT/)).toBeInTheDocument();
    expect(screen.getByText(/WD ELEMENTS/)).toBeInTheDocument();
    // Two name inputs (one per drive).
    const inputs = screen.getAllByPlaceholderText(/e\.g\. wedding photos/i);
    expect(inputs).toHaveLength(2);
  });

  it("pre-fills existing displayName values", async () => {
    fetchDrivesMock.mockResolvedValue({
      drives: [
        {
          ...FIXTURE_DRIVES.drives[0],
          displayName: "Wedding Photos",
        },
      ],
      count: 1,
    });
    render(<SetupPage />);
    await advanceToStorage();

    const input = screen.getByPlaceholderText(
      /e\.g\. wedding photos/i,
    ) as HTMLInputElement;
    expect(input.value).toBe("Wedding Photos");
  });

  it("Save and continue PATCHes each named drive then advances", async () => {
    fetchDrivesMock.mockResolvedValue(FIXTURE_DRIVES);
    updateDriveLabelMock.mockResolvedValue({
      uuid: "UUID-MAIN",
      displayName: "Wedding Photos",
      icon: null,
      notes: null,
      createdAt: "now",
      updatedAt: "now",
    });
    render(<SetupPage />);
    await advanceToStorage();

    const inputs = screen.getAllByPlaceholderText(/e\.g\. wedding photos/i);
    fireEvent.change(inputs[0], { target: { value: "Wedding Photos" } });
    fireEvent.change(inputs[1], { target: { value: "Camera Footage" } });

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /save and continue/i }),
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(updateDriveLabelMock).toHaveBeenCalledWith("UUID-MAIN", {
      displayName: "Wedding Photos",
    });
    expect(updateDriveLabelMock).toHaveBeenCalledWith("UUID-NVR", {
      displayName: "Camera Footage",
    });
    expect(screen.getByText(/discovering your devices/i)).toBeInTheDocument();
  });

  it("Skip for now advances without calling updateDriveLabel", async () => {
    fetchDrivesMock.mockResolvedValue(FIXTURE_DRIVES);
    render(<SetupPage />);
    await advanceToStorage();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
    });

    expect(updateDriveLabelMock).not.toHaveBeenCalled();
    expect(screen.getByText(/discovering your devices/i)).toBeInTheDocument();
  });

  it("blocks save when two drives share a name", async () => {
    fetchDrivesMock.mockResolvedValue(FIXTURE_DRIVES);
    render(<SetupPage />);
    await advanceToStorage();

    const inputs = screen.getAllByPlaceholderText(/e\.g\. wedding photos/i);
    fireEvent.change(inputs[0], { target: { value: "Drive" } });
    fireEvent.change(inputs[1], { target: { value: "Drive" } });

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /save and continue/i }),
      );
      await Promise.resolve();
    });

    expect(screen.getByText(/can't share the name/i)).toBeInTheDocument();
    expect(updateDriveLabelMock).not.toHaveBeenCalled();
  });
});
