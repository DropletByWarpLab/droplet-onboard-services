/**
 * WARP-1847 — "Available on your network".
 *
 * The surface this replaces (CameraDiscoveryBanner) rendered nothing unless a
 * camera had already been auto-added AND written to the DB as `enabled: false`,
 * a combination nothing produced — so an operator pressing "Scan network" saw a
 * spinner and then no change, forever. These tests pin the three states that
 * have to be distinguishable, because the operator's next action differs in
 * each: found something, swept and found nothing, nothing is scanning.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import { NetworkCameraList } from "./NetworkCameraList";
import type { DiscoveredCamera } from "@/lib/types";

function camera(over: Partial<DiscoveredCamera> = {}): DiscoveredCamera {
  return {
    id: "mac:E4:30:22:50:2A:FD",
    name: "XNV_C8083R",
    displayName: "XNV C8083R",
    ip: "192.168.9.219",
    mac: "E4:30:22:50:2A:FD",
    manufacturer: "Hanwha",
    model: "XNV-C8083R",
    status: "ready",
    hasCredentials: true,
    rtspUrl: "rtsp://192.168.9.219:554/profile2/media.smp",
    detectionMethod: "rtsp_default_credentials",
    discoveredAt: "2026-08-10T00:00:00.000Z",
    source: "live",
    ...over,
  };
}

function renderList(props: Partial<React.ComponentProps<typeof NetworkCameraList>> = {}) {
  const handlers = {
    onScan: vi.fn(),
    onAccept: vi.fn(),
    onReject: vi.fn(),
    onEnterCredentials: vi.fn(),
  };
  render(
    <NetworkCameraList
      cameras={[camera()]}
      discoveryOnline
      scanning={false}
      lastScan={null}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

describe("NetworkCameraList — found cameras", () => {
  it("lists each camera with its address and vendor", () => {
    renderList();
    expect(screen.getByText("XNV C8083R")).toBeTruthy();
    expect(screen.getByText(/192\.168\.9\.219/)).toBeTruthy();
    expect(screen.getByText(/Hanwha/)).toBeTruthy();
    expect(screen.getByText("1 found")).toBeTruthy();
  });

  it("offers Add for a reachable stream and calls back with the camera", async () => {
    const { onAccept } = renderList();
    fireEvent.click(screen.getByRole("button", { name: /^Add$/ }));
    await waitFor(() => expect(onAccept).toHaveBeenCalledTimes(1));
    expect(onAccept.mock.calls[0][0].id).toBe("mac:E4:30:22:50:2A:FD");
  });

  it("shows a sign-in status and routes to setup instead of Add when the stream needs credentials", () => {
    const { onEnterCredentials, onAccept } = renderList({
      cameras: [camera({ status: "needs_credentials", hasCredentials: false })],
    });
    expect(screen.getByText("Needs sign-in")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Add$/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Set up/ }));
    expect(onEnterCredentials).toHaveBeenCalledTimes(1);
    expect(onAccept).not.toHaveBeenCalled();
  });

  it("labels a port-open guess as not confirmed", () => {
    renderList({ cameras: [camera({ status: "unverified", rtspUrl: null })] });
    expect(screen.getByText("Not confirmed")).toBeTruthy();
  });

  it("treats a payload with no status as not confirmed rather than crashing", () => {
    const { status: _dropped, ...noStatus } = camera();
    renderList({ cameras: [noStatus as DiscoveredCamera] });
    expect(screen.getByText("Not confirmed")).toBeTruthy();
  });

  it("ignores a device through onReject", async () => {
    const { onReject } = renderList();
    fireEvent.click(screen.getByRole("button", { name: /Ignore XNV C8083R/ }));
    await waitFor(() => expect(onReject).toHaveBeenCalledTimes(1));
  });

  it("re-scans from the list header", () => {
    const { onScan } = renderList();
    fireEvent.click(screen.getByRole("button", { name: /Scan again/ }));
    expect(onScan).toHaveBeenCalledTimes(1);
  });
});

describe("NetworkCameraList — the three empty states", () => {
  it("before any scan, invites one", () => {
    renderList({ cameras: [] });
    expect(screen.getByText("Nothing found yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Scan network/ })).toBeTruthy();
  });

  it("after a scan that found nothing, says so and suggests what to check", () => {
    renderList({ cameras: [], lastScan: { at: 1, found: 0 } });
    expect(screen.getByText("No cameras found on your network")).toBeTruthy();
    expect(screen.getByText(/has power and is plugged into/)).toBeTruthy();
  });

  it("distinguishes a dead discovery service from an empty network", () => {
    renderList({ cameras: [], discoveryOnline: false, lastScan: { at: 1, found: 0 } });
    expect(screen.getByText("Camera discovery isn't running")).toBeTruthy();
    // Offering "scan again" would be a lie — nothing is there to run the sweep.
    expect(screen.queryByRole("button", { name: /Scan network/ })).toBeNull();
  });

  it("shows progress while a sweep is running", () => {
    renderList({ cameras: [], scanning: true });
    expect(screen.getByText("Looking for cameras…")).toBeTruthy();
  });
});
