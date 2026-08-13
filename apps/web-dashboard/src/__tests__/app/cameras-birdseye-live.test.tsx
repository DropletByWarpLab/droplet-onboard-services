/**
 * Birdseye multi-camera live view — probe contract (WARP-1918).
 *
 * QA hit the "Birdseye view isn't set up on this Droplet" empty state on
 * every box because the platform-managed Frigate config never enabled
 * birdseye (fixed in docker/frigate/config.yml + camera-discovery's
 * ensure_birdseye convergence). These tests pin the dashboard half of the
 * contract so the fix stays honest end-to-end:
 *
 *  - the page probes the proxied route (HEAD /api/cameras/birdseye/live —
 *    the orchestrator answers 404 only when Frigate reports birdseye
 *    disabled);
 *  - the composite grid `<img>` renders when the probe says enabled;
 *  - the empty state renders ONLY when the probe says disabled.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";

import BirdseyePage from "@/app/cameras/birdseye/page";

const BIRDSEYE_LIVE_URL = "/api/cameras/birdseye/live";

/** Flush the probe's .then(setAvailable) through React's commit. */
async function flushProbe() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("Birdseye live view (WARP-1918)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("probes the proxied birdseye route with a HEAD request", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    render(<BirdseyePage />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      BIRDSEYE_LIVE_URL,
      expect.objectContaining({ method: "HEAD" }),
    );
  });

  it("renders the composite stream, not the empty state, when the probe says enabled", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    render(<BirdseyePage />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await flushProbe();

    const img = screen.getByAltText("Birdseye live composite");
    expect(img).toHaveAttribute("src", BIRDSEYE_LIVE_URL);
    expect(screen.queryByText("Birdseye not enabled")).not.toBeInTheDocument();
  });

  it("renders the not-enabled empty state only when the probe says disabled", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    render(<BirdseyePage />);

    await screen.findByText("Birdseye not enabled");
    expect(
      screen.getByText(/isn't set up on this Droplet/),
    ).toBeInTheDocument();
    expect(
      screen.queryByAltText("Birdseye live composite"),
    ).not.toBeInTheDocument();
  });

  it("treats a probe transport failure as disabled rather than a black feed", async () => {
    fetchMock.mockRejectedValue(new TypeError("network down"));
    render(<BirdseyePage />);

    await screen.findByText("Birdseye not enabled");
    expect(
      screen.queryByAltText("Birdseye live composite"),
    ).not.toBeInTheDocument();
  });

  it("does not flash the empty state while the probe is still in flight", () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<BirdseyePage />);

    expect(screen.queryByText("Birdseye not enabled")).not.toBeInTheDocument();
    expect(screen.getByAltText("Birdseye live composite")).toBeInTheDocument();
  });
});
