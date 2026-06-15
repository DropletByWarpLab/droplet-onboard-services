/**
 * WARP-298 — setup discovery polling has an upper bound.
 *
 * Asserts the two new lifecycle transitions:
 *   1. 60s of no new devices → downshift hint appears, polling slows.
 *   2. 5min total → polling stops, "Stopped automatic scanning" message
 *      appears.
 *
 * Behavioural drive: advance fake timers and read text from the DOM.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import React from "react";

vi.mock("framer-motion", async () => {
  const actual = await vi.importActual<typeof import("framer-motion")>(
    "framer-motion",
  );
  return { ...actual, useReducedMotion: () => true };
});

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ completeSetup: vi.fn(), setupState: { appliance: "unclaimed", setupStep: "welcome", userTourCompleted: false } }),
}));

const fetchDevicesMock = vi.fn(async () => ({
  lights: [],
  switches: [],
  climate: [],
  sensors: [],
  media: [],
  covers: [],
  locks: [],
  other: [],
}));

vi.mock("@/lib/api", () => ({
  // WARP-867 — AccountStep probes setup status on mount to pick its mode;
  // "required" keeps these walks on the normal create form.
  checkSetupRequired: vi.fn(async () => "required"),
  setupAdmin: vi.fn(async () => undefined),
  patchSetupStep: vi.fn(async () => undefined),
  loginUser: vi.fn(async () => undefined),
  // PR #373 — claim slots before account; the Claim step calls these.
  fetchApplianceContract: vi.fn(async () => ({
    appliance_id: "droplet-appliance-test",
    compute: { label: "Compute", value: "Local AI compute", online: true },
    storage: { label: "Storage", value: "Encrypted at rest", online: true },
    network: { label: "Network", value: "Local network", online: true },
    display: { label: "Display", value: "Front-panel display", online: true },
    supply_chain: { taa_compliant: true, ndaa_889_clear: true, summary: "Verified" },
  })),
  postClaim: vi.fn(async () => ({ claimed: true, next_step: "account" })),
  // PR #380 — org slots after account; the Org step calls postOrg.
  postOrg: vi.fn(async () => ({
    ok: true,
    slug: "acme",
    reserved_host: "droplet.local/acme",
    next_step: "internet",
  })),
  fetchDuckDnsStatus: vi.fn(async () => ({ configured: false })),
  setDuckDnsConfig: vi.fn(async () => ({ configured: false })),
  // Storage step auto-skips on empty drive list — let it pass straight
  // through so the polling-bounds tests land on discovery as they
  // expect.
  fetchDrives: vi.fn(async () => ({ drives: [], count: 0 })),
  updateDriveLabel: vi.fn(),
  // Cameras step is downstream of discovery — never reached by these
  // tests but mocked so the import resolves.
  fetchDiscoveredCameras: vi.fn(async () => []),
  acceptDiscoveredCamera: vi.fn(),
  // VPN step is downstream of discovery; never reached in these tests
  // but mocked for the import side-effect.
  fetchVpnStatus: vi.fn(async () => ({
    configured: false,
    endpointConfigured: false,
  })),
  createVpnPeer: vi.fn(),
  fetchModels: vi.fn(async () => ({ models: [] })),
  sendChat: vi.fn(),
  fetchMatterDevices: () => fetchDevicesMock(),
}));

import SetupPage from "@/app/setup/page";
import { passClaimStep } from "./helpers/claim-step";
import { passOrgStep } from "./helpers/org-step";

async function advanceToDiscovery() {
  // Click "Get Started", pass the Claim step, then fill account form.
  fireEvent.click(screen.getByRole("button", { name: /get started/i }));
  await passClaimStep();
  fireEvent.change(screen.getByPlaceholderText(/you@company\.com/i), {
    target: { value: "owner@warp.test" },
  });
  fireEvent.change(screen.getByPlaceholderText(/your name/i), {
    target: { value: "Robin" },
  });
  fireEvent.change(screen.getByPlaceholderText(/create a password/i), {
    target: { value: "Abcdefghijk1" },
  });
  fireEvent.change(screen.getByPlaceholderText(/repeat password/i), {
    target: { value: "Abcdefghijk1" },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /create account/i }));
    // Flush in-flight promises from setupAdmin/loginUser.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  // PR #380 — pass through the org step (account → org → …).
  await passOrgStep();
  // PR #375 — TwoFactor step → skip (org → twofactor → wifi).
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
  });
  // Onboarding-Flow redesign — the single Internet step is now two (Wi-Fi then
  // Address) between account and discovery. Skip both so the polling-bounds
  // tests land on the discovery surface they exercise. Wi-Fi has no async mount
  // load; the Address step's fetchDuckDnsStatus effect resolves before its skip.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    fireEvent.click(
      screen.getByRole("button", { name: /skip — i'll do this later/i }),
    );
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    fireEvent.click(
      screen.getByRole("button", { name: /skip — no remote access/i }),
    );
  });
}

describe("setup discovery polling bounds (WARP-298)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchDevicesMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("shows the downshift hint after 60s with no new devices", async () => {
    render(<SetupPage />);
    await advanceToDiscovery();

    // Tick 60s of scanSeconds (timer fires every 1000ms). The phase-watching
    // effect needs both the timer tick AND a flush to React state — so we
    // tick by 1000 in a loop, letting each scanSeconds++ flush, and the
    // hint should appear once idleFor >= 60.
    for (let i = 0; i < 65; i++) {
      await act(async () => {
        vi.advanceTimersByTime(1000);
        await Promise.resolve();
      });
    }

    expect(screen.getByTestId("discovery-downshift-hint")).toBeInTheDocument();
  });

  it("stops scanning entirely after 5 minutes total", async () => {
    render(<SetupPage />);
    await advanceToDiscovery();

    // Tick 5 minutes (300s) + a couple of seconds slack. Use a slightly
    // coarser step (5s) to keep the test fast; the phase effect only
    // depends on scanSeconds, not on intermediate timer fires.
    for (let i = 0; i < 305; i++) {
      await act(async () => {
        vi.advanceTimersByTime(1000);
        await Promise.resolve();
      });
    }

    expect(screen.getByTestId("discovery-stopped")).toBeInTheDocument();
    // The fetchDevices poll has stopped — capture call count, advance more
    // time, count should stay flat.
    const beforeStopCount = fetchDevicesMock.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(30000);
      await Promise.resolve();
    });
    expect(fetchDevicesMock.mock.calls.length).toBe(beforeStopCount);
  });

  // ── WARP-302 ─────────────────────────────────────────────────────────
  // The stopped state previously left the user with no way back to
  // active scanning short of refreshing the setup flow. Surface a
  // "Scan again" button that re-arms startDiscovery() so a late-arriving
  // device still has a path to discovery without a full reload.
  it("renders a 'Scan again' button in the stopped state (WARP-302)", async () => {
    render(<SetupPage />);
    await advanceToDiscovery();

    for (let i = 0; i < 305; i++) {
      await act(async () => {
        vi.advanceTimersByTime(1000);
        await Promise.resolve();
      });
    }

    expect(screen.getByTestId("discovery-stopped")).toBeInTheDocument();
    const scanAgain = screen.getByRole("button", { name: /scan again/i });
    expect(scanAgain).toBeInTheDocument();
    // UX: the button must be reachable as a real tap target — assert
    // it carries the secondary button token so styling stays consistent
    // with the rest of the setup flow.
    expect(scanAgain.className).toMatch(/dp-btn-secondary/);
  });

  // WARP-302 fix-up: scanSeconds ticker was leaking across "Scan again".
  // Original bug: timerRef.current was never cleared at the stop transition
  // and startDiscovery overwrote it with a new setInterval without clearing
  // the old one — scanSeconds advanced at 2 Hz post-click, halving the
  // recovery window before the next auto-stop. Regression test: after
  // clicking "Scan again", advance fake timers N seconds and assert
  // scanSeconds equals N, not 2N.
  it("'Scan again' resets the 1Hz scanSeconds ticker without leaking the prior interval (WARP-302)", async () => {
    render(<SetupPage />);
    await advanceToDiscovery();

    // Drive to the stopped state.
    for (let i = 0; i < 305; i++) {
      await act(async () => {
        vi.advanceTimersByTime(1000);
        await Promise.resolve();
      });
    }
    expect(screen.getByTestId("discovery-stopped")).toBeInTheDocument();

    // Click "Scan again" — startDiscovery should clear the old timer
    // (which had been left running on the buggy version) and arm a
    // fresh 1Hz ticker.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /scan again/i }));
      await Promise.resolve();
    });

    // Advance exactly 5 seconds and assert the visible counter shows 5,
    // not 10. The "Scanning... Ns" caption is the user-facing tell — if
    // the ticker were doubled it would read "Scanning... 10s" here.
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        vi.advanceTimersByTime(1000);
        await Promise.resolve();
      });
    }
    expect(screen.getByText(/Scanning\.\.\. 5s/)).toBeInTheDocument();
    expect(screen.queryByText(/Scanning\.\.\. 10s/)).not.toBeInTheDocument();

    // Belt + braces: click "Scan again" once more after driving back to
    // the stopped state, and verify the ticker still advances at 1 Hz —
    // the original bug compounded with each click.
    for (let i = 0; i < 305; i++) {
      await act(async () => {
        vi.advanceTimersByTime(1000);
        await Promise.resolve();
      });
    }
    expect(screen.getByTestId("discovery-stopped")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /scan again/i }));
      await Promise.resolve();
    });
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        vi.advanceTimersByTime(1000);
        await Promise.resolve();
      });
    }
    expect(screen.getByText(/Scanning\.\.\. 3s/)).toBeInTheDocument();
  });

  it("'Scan again' returns to the active scan phase and resumes polling (WARP-302)", async () => {
    render(<SetupPage />);
    await advanceToDiscovery();

    for (let i = 0; i < 305; i++) {
      await act(async () => {
        vi.advanceTimersByTime(1000);
        await Promise.resolve();
      });
    }

    expect(screen.getByTestId("discovery-stopped")).toBeInTheDocument();
    const callsBefore = fetchDevicesMock.mock.calls.length;

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /scan again/i }));
      await Promise.resolve();
    });

    // After the click the stopped banner must disappear (phase is active
    // again).
    expect(screen.queryByTestId("discovery-stopped")).not.toBeInTheDocument();

    // Advance a few seconds and verify fetchMatterDevices was called
    // again — i.e. polling actually restarted.
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        vi.advanceTimersByTime(1000);
        await Promise.resolve();
      });
    }
    expect(fetchDevicesMock.mock.calls.length).toBeGreaterThan(callsBefore);
  });
});
