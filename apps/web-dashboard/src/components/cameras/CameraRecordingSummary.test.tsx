/**
 * WARP-3511 — the Recording block on the camera rail and the settings page.
 *
 * It answers "is this camera keeping footage, and how much?" from the camera's
 * own reading. What it must not do: invent a figure (every number here is the
 * camera's, so these tests use odd values that no default would produce), show
 * a zero where the box gave nothing, or describe a camera at all while the
 * camera service cannot be read.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import type { CameraInfo, CameraRecordingState, RecordingDay } from "@/lib/types";

const h = vi.hoisted(() => ({
  days: [] as RecordingDay[],
  loading: false,
  summaryArg: undefined as string | null | undefined,
}));

vi.mock("@/lib/hooks/useRecordings", () => ({
  useRecordingsSummary: (name: string | null) => {
    h.summaryArg = name;
    return { days: h.days, isLoading: h.loading, error: undefined, refresh: vi.fn() };
  },
}));

vi.mock("@/lib/api", () => ({
  fetchRetentionBackfillPlan: vi.fn(),
  runRetentionBackfill: vi.fn(),
}));

import { CameraRecordingSummary } from "./CameraRecordingSummary";

function rec(over: Partial<CameraRecordingState> = {}): CameraRecordingState {
  return {
    degraded: false,
    mode: "continuous",
    // Deliberately unlike any shipped default: if a number shows up that is
    // not one of these, it was written into the component.
    retentionDays: { continuous: 11, motion: 17, alerts: 23, detections: 29 },
    lastSegmentAt: new Date(Date.now() - 12_000).toISOString(),
    usedBytes: 46 * 1024 ** 3,
    bytesPerDay: 24 * 1024 ** 3,
    ...over,
  };
}

function cam(over: Partial<CameraInfo> = {}): CameraInfo {
  return {
    name: "front_door",
    displayName: "Front door",
    manufacturer: null,
    model: null,
    ipAddress: "192.168.20.10",
    macAddress: null,
    enabled: true,
    autoDiscovered: false,
    status: "recording",
    lastSeen: new Date().toISOString(),
    lastDetection: null,
    recording: rec(),
    ...over,
  };
}

function renderSummary(camera: CameraInfo, props: Partial<React.ComponentProps<typeof CameraRecordingSummary>> = {}) {
  return render(
    <CameraRecordingSummary
      camera={camera}
      appearance="card"
      current="settings"
      canManage
      cameras={[camera]}
      {...props}
    />,
  );
}

const row = (label: string): string => {
  const dt = screen.getByText(label, { selector: "dt" });
  return dt.nextElementSibling?.textContent ?? "";
};

beforeEach(() => {
  h.days = [];
  h.loading = false;
  h.summaryArg = undefined;
});
afterEach(cleanup);

describe("a camera that is keeping footage", () => {
  it("shows the mode, in words and as the chip", () => {
    renderSummary(cam());
    expect(screen.getByTestId("recording-mode").textContent).toBe("24/7");
    expect(row("Mode")).toContain("Saves everything, around the clock.");
  });

  it("lists each open window with the camera's OWN days", () => {
    renderSummary(cam());
    const keeps = screen.getByTestId("recording-retention").textContent ?? "";
    expect(keeps).toContain("24/7 footage: 11 days");
    expect(keeps).toContain("Motion footage: 17 days");
    expect(keeps).toContain("Alert clips: 23 days");
    expect(keeps).toContain("Other detections: 29 days");
  });

  it("leaves a closed window out rather than listing it as 0", () => {
    renderSummary(cam({ recording: rec({ retentionDays: { continuous: 0, motion: 17, alerts: 0, detections: 0 } }) }));
    const keeps = screen.getByTestId("recording-retention").textContent ?? "";
    expect(keeps).toContain("Motion footage: 17 days");
    expect(keeps).not.toContain("24/7 footage");
    expect(keeps).not.toMatch(/\b0 days?\b/);
  });

  it("says when it last saved, how much is stored and how fast it grows", () => {
    renderSummary(cam());
    expect(row("Last saved")).toBe("12s ago");
    expect(row("Used")).toBe("46.0 GiB");
    expect(row("Writing")).toBe("≈ 24.0 GiB/day");
  });

  it("says how far back there is real footage, from the recordings summary", () => {
    const now = new Date();
    const twoDaysAgo = new Date(now.getTime() - 2 * 86_400_000);
    const y = twoDaysAgo.getFullYear();
    const m = String(twoDaysAgo.getMonth() + 1).padStart(2, "0");
    const d = String(twoDaysAgo.getDate()).padStart(2, "0");
    h.days = [
      {
        day: `${y}-${m}-${d}`,
        events: 0,
        duration: 3600,
        hours: [{ hour: 0, events: 0, duration: 3600, motion: 0, objects: 0 }],
      },
    ];
    renderSummary(cam());
    expect(row("Stored")).toMatch(/^\d+(\.\d)? days · since /);
  });

  it("shows a dash — not a zero — for anything the box did not give", () => {
    renderSummary(cam({ recording: rec({ usedBytes: null, bytesPerDay: null, lastSegmentAt: null }) }));
    expect(row("Used")).toBe("—");
    expect(row("Writing")).toBe("—");
    expect(row("Stored")).toBe("—");
    expect(screen.getByTestId("camera-recording-summary").textContent).not.toMatch(/\b0 B\b/);
  });

  it("warns, calmly, about a 24/7 camera whose newest write is old", () => {
    renderSummary(cam({ recording: rec({ lastSegmentAt: new Date(Date.now() - 30 * 60_000).toISOString() }) }));
    const saved = screen.getByText("30 min ago");
    expect(saved.className).toContain("text-system-orange");
  });

  it("asks for the recordings summary only for a camera that has a reading", () => {
    renderSummary(cam());
    expect(h.summaryArg).toBe("front_door");
  });

  it("no hard-coded day count appears that the camera did not report", () => {
    renderSummary(cam());
    const text = screen.getByTestId("camera-recording-summary").textContent ?? "";
    const counts = [...text.matchAll(/(\d+(?:\.\d+)?)\s+days?/g)].map((m) => Number(m[1]));
    for (const n of counts) expect([11, 17, 23, 29]).toContain(n);
  });
});

describe("a camera that is not saving", () => {
  const off = () => cam({ status: "live", recording: rec({ mode: "off", lastSegmentAt: null }) });

  it("says nothing is kept, and offers the repair to an owner or admin", () => {
    renderSummary(off());
    expect(screen.getByTestId("recording-mode").textContent).toBe("Off");
    expect(row("Keeps")).toBe("Nothing");
    const block = screen.getByTestId("recording-not-saving");
    expect(within(block).getByRole("button", { name: /^Fix:/ })).toBeTruthy();
  });

  it("offers no repair — and no dead end — to someone who cannot use it", () => {
    renderSummary(off(), { canManage: false });
    const block = screen.getByTestId("recording-not-saving");
    expect(within(block).queryByRole("button", { name: /^Fix:/ })).toBeNull();
    expect(block.textContent).toMatch(/Ask an owner or admin/);
  });
});

describe("while the camera service cannot be read", () => {
  const down = () =>
    cam({
      status: "offline",
      recording: rec({ degraded: true, mode: null, retentionDays: null, lastSegmentAt: null, usedBytes: null, bytesPerDay: null }),
    });

  it("says so, and describes no camera", () => {
    renderSummary(down());
    expect(screen.getByTestId("camera-service-notice").textContent).toContain("Camera service restarting…");
    expect(screen.queryByTestId("recording-mode")).toBeNull();
    expect(screen.queryByText("Mode", { selector: "dt" })).toBeNull();
  });

  it("makes no recordings request and offers no repair for a camera it knows nothing about", () => {
    renderSummary(down());
    expect(h.summaryArg).toBeNull();
    expect(screen.queryByRole("button", { name: /^Fix:/ })).toBeNull();
  });

  it("still links onward", () => {
    renderSummary(down());
    expect(screen.getByRole("link", { name: "Recordings" })).toBeTruthy();
  });
});

describe("a box that reports no recording block", () => {
  it("says so plainly instead of rendering empty rows", () => {
    renderSummary(cam({ recording: undefined }));
    expect(screen.getByTestId("camera-recording-summary").textContent).toContain("doesn't report recording details");
    expect(screen.queryByText("Mode", { selector: "dt" })).toBeNull();
  });
});

describe("the links between the camera's pages", () => {
  const hrefs = () =>
    within(screen.getByTestId("camera-related-links"))
      .getAllByRole("link")
      .map((a) => [a.textContent, a.getAttribute("href")]);

  it("from the settings page: Recordings, Notifications, System — not itself", () => {
    renderSummary(cam(), { current: "settings" });
    expect(hrefs()).toEqual([
      ["Recordings", "/cameras/front_door/recordings"],
      ["Notifications", "/cameras/notifications"],
      ["System", "/cameras/system"],
    ]);
  });

  it("from the camera screen: Recordings, Settings, Notifications, System", () => {
    renderSummary(cam(), { current: "detail" });
    expect(hrefs()).toEqual([
      ["Recordings", "/cameras/front_door/recordings"],
      ["Settings", "/cameras/front_door/settings"],
      ["Notifications", "/cameras/notifications"],
      ["System", "/cameras/system"],
    ]);
  });

  it("does not offer Settings to someone the settings page would refuse", () => {
    renderSummary(cam(), { current: "detail", canManage: false });
    expect(hrefs().map(([label]) => label)).toEqual(["Recordings", "Notifications", "System"]);
  });

  it("encodes a camera name that needs it", () => {
    renderSummary(cam({ name: "back yard/1" }), { current: "detail" });
    expect(hrefs()[0][1]).toBe("/cameras/back%20yard%2F1/recordings");
  });
});

describe("appearance", () => {
  it("the rail variant is a heading, the card variant is a card with its own icon", () => {
    const { container } = renderSummary(cam(), { appearance: "rail" });
    expect(container.querySelector(".card")).toBeNull();
    cleanup();
    const card = renderSummary(cam(), { appearance: "card", title: "Recording status" });
    expect(card.container.querySelector(".card")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Recording status" })).toBeTruthy();
  });
});
