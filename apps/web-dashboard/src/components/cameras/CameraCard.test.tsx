/**
 * WARP-3511 — the camera tile says, at a glance, whether footage is being
 * kept: a mode chip, when something last landed on disk, and how much there is.
 *
 * What the tile must NOT do is as load-bearing as what it does:
 *   - claim recording or "not saving" while the camera service cannot be read;
 *   - paint "Detecting" (healthy, objects tracked) and "Live · not saving" (a
 *     warning) in the same colour, as it used to;
 *   - hard-code a retention figure (the numbers are the camera's own, and they
 *     change by box and release).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CameraInfo, CameraRecordingState } from "@/lib/types";

vi.mock("@/lib/api", () => ({
  getCameraSnapshotUrl: (name: string) => `/api/cameras/${name}/snapshot`,
  getCameraLiveUrl: (name: string) => `/api/cameras/${name}/live`,
}));

import { CameraCard } from "./CameraCard";

function rec(over: Partial<CameraRecordingState> = {}): CameraRecordingState {
  return {
    degraded: false,
    mode: "continuous",
    retentionDays: { continuous: 7, motion: 21, alerts: 10, detections: 5 },
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
    manufacturer: "Hanwha",
    model: "XNV-C8083R",
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

function renderCard(camera: CameraInfo, props: Partial<React.ComponentProps<typeof CameraCard>> = {}) {
  const onClick = vi.fn();
  render(<CameraCard camera={camera} onClick={onClick} {...props} />);
  return { onClick };
}

afterEach(cleanup);

describe("the mode chip", () => {
  it.each([
    ["continuous", "24/7"],
    ["motion", "Motion"],
    ["events", "Events"],
    ["off", "Off"],
  ] as const)("shows %s as %s", (mode, label) => {
    renderCard(cam({ recording: rec({ mode }) }));
    expect(screen.getByTestId("recording-mode-chip").textContent).toBe(label);
  });

  it("explains itself on hover with the camera's own retention, not a built-in number", () => {
    renderCard(cam({ recording: rec({ retentionDays: { continuous: 7, motion: 21, alerts: 10, detections: 5 } }) }));
    const title = screen.getByTestId("recording-mode-chip").getAttribute("title") ?? "";
    expect(title).toContain("7 days");
    expect(title).toContain("21 days");
    expect(title).toContain("10 days");
    expect(title).toContain("5 days");
  });

  it("an off camera's chip is a warning, the others are not", () => {
    renderCard(cam({ status: "live", recording: rec({ mode: "off" }) }));
    expect(screen.getByTestId("recording-mode-chip").className).toContain("text-system-orange");
    cleanup();
    renderCard(cam({ recording: rec({ mode: "motion" }) }));
    expect(screen.getByTestId("recording-mode-chip").className).not.toContain("text-system-orange");
  });
});

describe("when something last landed on disk, and how much there is", () => {
  it("says how long ago and how much is stored", () => {
    renderCard(cam());
    const meta = screen.getByTestId("recording-meta");
    expect(meta.textContent).toContain("Saved 12s ago");
    expect(meta.textContent).toContain("46.0 GiB");
  });

  it("flags a 24/7 camera that has stopped writing", () => {
    renderCard(cam({ recording: rec({ lastSegmentAt: new Date(Date.now() - 600_000).toISOString() }) }));
    const saved = screen.getByText(/Saved 10 min ago/);
    expect(saved.className).toContain("text-system-orange");
  });

  it("leaves usage out when the box has no figure — it does not say 0", () => {
    renderCard(cam({ recording: rec({ usedBytes: null }) }));
    expect(screen.getByTestId("recording-meta").textContent).not.toMatch(/GiB|MiB|KiB|0 B/);
  });

  it("says nothing about the last write for a camera that is not saving", () => {
    renderCard(cam({ status: "live", recording: rec({ mode: "off", lastSegmentAt: null }) }));
    expect(screen.getByTestId("recording-meta").textContent).not.toContain("Saved");
  });
});

describe("status badge colours", () => {
  const dotColor = (camera: CameraInfo): string => {
    renderCard(camera);
    const badge = screen.getByTestId("status-badge");
    const dot = badge.querySelector("svg") as SVGElement;
    const color = dot.style.color;
    cleanup();
    return color;
  };

  it("Detecting and 'Live · not saving' are different colours, both from tokens", () => {
    const detecting = dotColor(cam({ status: "detecting" }));
    const notSaving = dotColor(cam({ status: "live", recording: rec({ mode: "off" }) }));
    expect(detecting).not.toBe(notSaving);
    for (const c of [detecting, notSaving]) {
      expect(c).toMatch(/^var\(--[a-z-]+\)$/);
    }
  });

  it("the badge words are unchanged for each state", () => {
    const words: Array<[CameraInfo["status"], string]> = [
      ["recording", "Recording"],
      ["detecting", "Detecting"],
      ["live", "Live · not saving"],
      ["idle", "Idle"],
      ["offline", "Offline"],
    ];
    for (const [status, text] of words) {
      renderCard(cam({ status, recording: rec({ mode: status === "live" ? "off" : "continuous" }) }));
      expect(screen.getByTestId("status-badge").textContent).toBe(text);
      cleanup();
    }
  });
});

describe("when the camera service cannot be read", () => {
  const degraded = () => cam({ status: "offline", recording: rec({ degraded: true, mode: null, retentionDays: null, lastSegmentAt: null, usedBytes: null, bytesPerDay: null }) });

  it("the badge says status unavailable — not Offline", () => {
    renderCard(degraded());
    expect(screen.getByTestId("status-badge").textContent).toBe("Status unavailable");
    expect(screen.queryByText("Offline")).toBeNull();
  });

  it("shows no mode chip, no 'saved' line and no usage", () => {
    renderCard(degraded());
    expect(screen.queryByTestId("recording-mode-chip")).toBeNull();
    expect(screen.queryByTestId("recording-meta")).toBeNull();
  });
});

describe("a box that sends no recording block", () => {
  it("renders the tile as before", () => {
    renderCard(cam({ recording: undefined }));
    expect(screen.getByText("Front door")).toBeTruthy();
    expect(screen.queryByTestId("recording-meta")).toBeNull();
    expect(screen.getByTestId("status-badge").textContent).toBe("Recording");
  });
});

describe("the settings gear", () => {
  it("is absent unless the page offers it — members never see it", () => {
    renderCard(cam());
    expect(screen.queryByRole("button", { name: /settings for front door/i })).toBeNull();
  });

  it("opens that camera's settings and does NOT open the detail view", () => {
    const onOpenSettings = vi.fn();
    const { onClick } = renderCard(cam(), { onOpenSettings });
    fireEvent.click(screen.getByRole("button", { name: /settings for front door/i }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(onOpenSettings.mock.calls[0][0].name).toBe("front_door");
    expect(onClick).not.toHaveBeenCalled();
  });

  it("pressing Enter on it does not also activate the card", () => {
    const onOpenSettings = vi.fn();
    const { onClick } = renderCard(cam(), { onOpenSettings });
    fireEvent.keyDown(screen.getByRole("button", { name: /settings for front door/i }), { key: "Enter" });
    expect(onClick).not.toHaveBeenCalled();
  });

  it("is still shown while the camera service is unreadable — settings are reachable", () => {
    renderCard(cam({ status: "offline", recording: rec({ degraded: true, mode: null }) }), {
      onOpenSettings: vi.fn(),
    });
    expect(screen.getByRole("button", { name: /settings for front door/i })).toBeTruthy();
  });
});

describe("the Recordings link on the recording row", () => {
  it("goes to that camera's recordings", () => {
    renderCard(cam({ name: "front_door" }));
    const link = within(screen.getByTestId("recording-meta")).getByRole("link", {
      name: /recordings for front door/i,
    });
    expect(link.getAttribute("href")).toBe("/cameras/front_door/recordings");
    expect(link.textContent).toContain("Recordings");
  });

  it("keeps the mode chip, last-saved and size beside it", () => {
    renderCard(cam());
    const meta = screen.getByTestId("recording-meta");
    expect(within(meta).getByTestId("recording-mode-chip")).toBeTruthy();
    expect(meta.textContent).toContain("Saved 12s ago");
    expect(meta.textContent).toContain("46.0 GiB");
  });

  it("does NOT also open the detail view when clicked or activated from the keyboard", () => {
    const { onClick } = renderCard(cam());
    const link = screen.getByTestId("recordings-link");
    link.addEventListener("click", (e) => e.preventDefault()); // jsdom: no navigation
    fireEvent.click(link);
    fireEvent.keyDown(link, { key: "Enter" });
    expect(onClick).not.toHaveBeenCalled();
  });

  it("is not drawn while the camera service is unreadable (the row is not either)", () => {
    renderCard(cam({ status: "offline", recording: rec({ degraded: true, mode: null }) }));
    expect(screen.queryByTestId("recordings-link")).toBeNull();
  });
});

describe("the card itself", () => {
  it("still opens the detail view on click", () => {
    const { onClick } = renderCard(cam());
    fireEvent.click(screen.getByRole("button", { name: /front door/i }));
    expect(onClick).toHaveBeenCalled();
  });

  it("the pin toggle still does not open the detail view", () => {
    const onTogglePin = vi.fn();
    const { onClick } = renderCard(cam(), { onTogglePin });
    fireEvent.click(within(document.body).getByRole("button", { name: /pin camera/i }));
    expect(onTogglePin).toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("the tile's source", () => {
  it("draws every colour from a token — no hex literal (it had the amber hard-coded, twice)", () => {
    const src = readFileSync(resolve(__dirname, "CameraCard.tsx"), "utf8")
      // Comments may quote a colour; only code is held to the rule.
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
