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
});
