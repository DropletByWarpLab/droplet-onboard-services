/**
 * WARP-1282 — Cameras step: full recovery after a backend outage during load.
 *
 * A transient orchestrator outage while this step loads used to leave the
 * customer stuck: the 10 s discovery poll (WARP-933) cleared the error and
 * refreshed the *discovered* list once the backend came back, but never
 * re-ran the full `load()` — so `existing` ("Already set up from a previous
 * run", WARP-861) stayed empty for the rest of the step and the
 * remove-stale-cameras affordance silently vanished. The error copy also
 * promised "Try again in a moment" with no explicit Try-again control.
 *
 * Validates the three recovery contracts:
 *   1. Failed initial load → error banner gains a "Try again" button
 *      (dp-btn-secondary → 44 px tap target); clicking it re-runs the FULL
 *      load so BOTH the discovered and existing lists repopulate.
 *   2. Failed initial load → a later successful 10 s poll tick re-runs the
 *      FULL load (not just the discovered-only refresh), including `existing`.
 *   3. The WARP-933 save guard still wins: a poll tick during an in-flight
 *      accept-all triggers NO fetch at all — neither the light refresh nor
 *      the full-load recovery — and doesn't clobber the rendered cards.
 *
 * Renders <CamerasStep> in isolation, same as setup.ai.first-ask.test.tsx —
 * StepShell explicitly supports being mounted outside the wizard nav
 * provider, which keeps the fake-timer choreography tractable. The
 * full-wizard flow is covered by setup.cameras.test.tsx.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  render,
  screen,
  act,
  fireEvent,
  cleanup,
} from "@testing-library/react";
import React from "react";

const fetchCamerasMock = vi.fn();
const fetchDiscoveredCamerasMock = vi.fn();
const acceptDiscoveredCameraMock = vi.fn();
const removeCameraMock = vi.fn();

vi.mock("@/lib/api", () => ({
  fetchCameras: () => fetchCamerasMock(),
  fetchDiscoveredCameras: () => fetchDiscoveredCamerasMock(),
  acceptDiscoveredCamera: (id: string) => acceptDiscoveredCameraMock(id),
  removeCamera: (name: string) => removeCameraMock(name),
}));

import { CamerasStep } from "@/components/setup/steps/CamerasStep";

const DISCOVERED_TWO = [
  {
    id: "cam-1",
    name: "hikvision-45",
    ip: "192.168.100.45",
    mac: "aa:bb:cc:dd:ee:01",
    manufacturer: "Hikvision",
    model: "DS-2CD2143G2",
    discoveredAt: "2026-05-14T12:00:00Z",
  },
  {
    id: "cam-2",
    name: "reolink-62",
    ip: "192.168.100.62",
    mac: "aa:bb:cc:dd:ee:02",
    manufacturer: "Reolink",
    model: "RLC-810A",
    discoveredAt: "2026-05-14T12:01:00Z",
  },
];

/** An enabled camera from a previous setup run — the WARP-861 "Already set
 *  up" section renders it with a per-camera Remove. */
const EXISTING_ENABLED = {
  name: "backyard",
  displayName: "Backyard",
  manufacturer: "Reolink",
  model: "RLC-810A",
  ipAddress: "192.168.100.71",
  macAddress: "aa:bb:cc:dd:ee:71",
  enabled: true,
  autoDiscovered: true,
  status: "idle" as const,
  lastSeen: "2026-07-11T09:00:00Z",
  lastDetection: null,
};

/** Flush the pending microtask queue inside act() so promise chains settle
 *  without advancing fake timers. */
async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("setup Cameras step — outage recovery (WARP-1282)", () => {
  beforeEach(() => {
    fetchCamerasMock.mockReset();
    fetchDiscoveredCamerasMock.mockReset();
    acceptDiscoveredCameraMock.mockReset();
    removeCameraMock.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("failed initial load → error banner with a Try again button that re-runs the FULL load", async () => {
    // First tick of each fetch fails (backend outage), then the backend is back.
    fetchCamerasMock.mockRejectedValueOnce(new Error("backend down"));
    fetchDiscoveredCamerasMock.mockRejectedValueOnce(new Error("backend down"));
    fetchCamerasMock.mockResolvedValue([EXISTING_ENABLED]);
    fetchDiscoveredCamerasMock.mockResolvedValue(DISCOVERED_TWO);

    render(<CamerasStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await flushMicrotasks();

    // The outage surfaced — announced to screen readers (role="alert", the
    // same convention the sibling step banners carry) — and the banner
    // carries an explicit control now.
    expect(screen.getByRole("alert")).toHaveTextContent(
      /couldn't check for cameras right now/i,
    );
    const tryAgain = screen.getByRole("button", { name: /try again/i });
    // A11y: the control must be a real ≥44px tap target — the secondary
    // button token carries min-h-[44px] (same convention as WARP-302's
    // "Scan again") — with an on-convention focus ring (the token ships
    // none; CoverageExtendersPanel precedent).
    expect(tryAgain.className).toMatch(/dp-btn-secondary/);
    expect(tryAgain.className).toMatch(/focus-visible:ring-2/);

    await act(async () => {
      fireEvent.click(tryAgain);
      await Promise.resolve();
    });
    await flushMicrotasks();

    // FULL load re-ran — not just the discovered-only refresh.
    expect(fetchCamerasMock).toHaveBeenCalledTimes(2);
    expect(fetchDiscoveredCamerasMock).toHaveBeenCalledTimes(2);

    // BOTH lists repopulated: discovered cards…
    expect(screen.getByText(/Hikvision DS-2CD2143G2/)).toBeInTheDocument();
    expect(screen.getByText(/Reolink RLC-810A/)).toBeInTheDocument();
    // …AND the WARP-861 "Already set up" section with its Remove affordance.
    expect(screen.getByText(/already set up/i)).toBeInTheDocument();
    expect(screen.getByText("Backyard")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /remove backyard/i }),
    ).toBeInTheDocument();

    // Recovered — the banner is gone.
    expect(
      screen.queryByText(/couldn't check for cameras right now/i),
    ).not.toBeInTheDocument();
  });

  it("failed initial load → a later successful poll tick re-runs the FULL load including `existing`", async () => {
    vi.useFakeTimers();
    fetchCamerasMock.mockRejectedValueOnce(new Error("backend down"));
    fetchDiscoveredCamerasMock.mockRejectedValueOnce(new Error("backend down"));
    fetchCamerasMock.mockResolvedValue([EXISTING_ENABLED]);
    fetchDiscoveredCamerasMock.mockResolvedValue(DISCOVERED_TWO);

    render(<CamerasStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await flushMicrotasks();

    expect(
      screen.getByText(/couldn't check for cameras right now/i),
    ).toBeInTheDocument();
    expect(fetchCamerasMock).toHaveBeenCalledTimes(1);
    expect(fetchDiscoveredCamerasMock).toHaveBeenCalledTimes(1);

    // One 10s poll tick — the backend is reachable again.
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await flushMicrotasks();

    // The tick ran the FULL load (fetchCameras too — the old code only
    // refreshed the discovered list here, stranding `existing` empty).
    expect(fetchCamerasMock).toHaveBeenCalledTimes(2);
    expect(fetchDiscoveredCamerasMock).toHaveBeenCalledTimes(2);

    expect(screen.getByText(/Hikvision DS-2CD2143G2/)).toBeInTheDocument();
    expect(screen.getByText(/already set up/i)).toBeInTheDocument();
    expect(screen.getByText("Backyard")).toBeInTheDocument();
    expect(
      screen.queryByText(/couldn't check for cameras right now/i),
    ).not.toBeInTheDocument();

    // One more tick: a successful full load DISARMS recovery — the poll is
    // back on the light discovered-only refresh (fetchDiscoveredCameras
    // advances, fetchCameras does NOT keep reloading every 10 s).
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchCamerasMock).toHaveBeenCalledTimes(2);
    expect(fetchDiscoveredCamerasMock).toHaveBeenCalledTimes(3);
  });

  it("a poll tick during an in-flight accept-all triggers no fetch and doesn't clobber the cards (WARP-933 guard)", async () => {
    vi.useFakeTimers();
    // Persistent partial outage: the existing-cameras read keeps failing, so
    // the recovery path stays armed — but discovery works and cards render.
    fetchCamerasMock.mockRejectedValue(new Error("backend flapping"));
    fetchDiscoveredCamerasMock.mockResolvedValue(DISCOVERED_TWO);

    // Accept-all stays in flight until we resolve it by hand.
    const acceptResolvers: Array<() => void> = [];
    acceptDiscoveredCameraMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          acceptResolvers.push(resolve);
        }),
    );

    const onComplete = vi.fn();
    render(<CamerasStep onComplete={onComplete} onSkip={vi.fn()} />);
    await flushMicrotasks();

    expect(screen.getByText(/Hikvision DS-2CD2143G2/)).toBeInTheDocument();
    expect(fetchCamerasMock).toHaveBeenCalledTimes(1);
    expect(fetchDiscoveredCamerasMock).toHaveBeenCalledTimes(1);

    // Kick off the save — it stays pending.
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /add these cameras/i }),
      );
      await Promise.resolve();
    });
    expect(acceptDiscoveredCameraMock).toHaveBeenCalledTimes(2);

    // Poll tick lands mid-save: the savingRef guard must win over BOTH the
    // light refresh and the WARP-1282 full-load recovery.
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchCamerasMock).toHaveBeenCalledTimes(1);
    expect(fetchDiscoveredCamerasMock).toHaveBeenCalledTimes(1);
    // Cards untouched under the save.
    expect(screen.getByText(/Hikvision DS-2CD2143G2/)).toBeInTheDocument();
    expect(screen.getByText(/Reolink RLC-810A/)).toBeInTheDocument();

    // Let the save finish — the step advances with both cameras accepted.
    await act(async () => {
      for (const resolve of acceptResolvers) resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onComplete).toHaveBeenCalledWith(2);
  });

  it("an accept-all failure shows its own error WITHOUT the load-recovery Try again button", async () => {
    // Partial outage keeps the load marked incomplete (recovery armed)…
    fetchCamerasMock.mockRejectedValue(new Error("backend flapping"));
    fetchDiscoveredCamerasMock.mockResolvedValue(DISCOVERED_TWO);
    // …and every accept fails, so the step stays put with an ACTION error.
    acceptDiscoveredCameraMock.mockRejectedValue(new Error("boom"));

    render(<CamerasStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await flushMicrotasks();
    expect(screen.getByText(/Hikvision DS-2CD2143G2/)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /add these cameras/i }),
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The action error is announced…
    expect(screen.getByRole("alert")).toHaveTextContent(
      /couldn't add the cameras just now/i,
    );
    // …but the load-recovery control must NOT ride beneath copy that points
    // at the Cameras page instead — the button only serves load failures.
    expect(
      screen.queryByRole("button", { name: /^try again$/i }),
    ).not.toBeInTheDocument();
  });
});
