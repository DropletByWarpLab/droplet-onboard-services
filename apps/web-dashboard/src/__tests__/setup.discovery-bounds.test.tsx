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
  useAuth: () => ({ completeSetup: vi.fn() }),
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
  setupAdmin: vi.fn(async () => undefined),
  loginUser: vi.fn(async () => undefined),
  fetchDuckDnsStatus: vi.fn(async () => ({ configured: false })),
  setDuckDnsConfig: vi.fn(async () => ({ configured: false })),
  fetchMatterDevices: () => fetchDevicesMock(),
}));

import SetupPage from "@/app/setup/page";

async function advanceToDiscovery() {
  // Click "Get Started" then fill account form.
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
    // Flush in-flight promises from setupAdmin/loginUser.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  // Account → Internet. The Internet step (WARP-174) sits between account
  // and discovery — skip it so the polling-bounds tests can land on the
  // discovery surface they exercise. Flush once for InternetStep's
  // fetchDuckDnsStatus effect, then click the always-rendered skip link.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
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
