/**
 * WARP-2961 — page rhythm on /cameras.
 *
 * The shell had no page-level spacing rule at all: every direct child of
 * `.page-inner` had to opt into its own outer margin, so the chip sub-nav sat
 * flush against the subnet card, the two empty-state cards carried nothing,
 * and the "Pinned" heading — wrapped in a `div.mb-6` — became a `:first-child`
 * and silently lost the 34px that "All cameras" kept.
 *
 * Two halves, and both are needed. The CSS half pins the rule itself (a
 * grep-level contract: jsdom has no layout engine and never applies these
 * sheets, so `getComputedStyle` cannot see it). The DOM half pins the thing
 * the rule depends on and that a future edit will break first — that the
 * page's sections are REAL direct children of `.page-inner` rather than
 * wrapped in spacing divs, and that the fixed toaster renders last.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CameraInfo, DetectionEvent } from "@/lib/types";

/* ── The rule, as authored ──────────────────────────────── */

const shellCss = readFileSync(
  resolve(__dirname, "..", "components", "shell", "droplet-shell.css"),
  "utf8",
);

describe("droplet-shell.css — the page-rhythm rule", () => {
  it("gives every direct child of an opted-in .page-inner one 24px gap", () => {
    expect(shellCss).toContain(
      ".droplet-shell .page-inner.rhythm > * + *     { margin-top: 24px; }",
    );
  });

  it("promotes a section heading to 34px and closes the gap under it", () => {
    expect(shellCss).toContain(
      ".droplet-shell .page-inner.rhythm > .sect + * { margin-top: 0; }",
    );
    // `* + .sect`, never a bare `.sect`: a bare selector would out-specify
    // `.droplet-shell .sect:first-child { margin-top: 0 }` and put 34px above
    // a heading that opens the page.
    expect(shellCss).toContain(
      ".droplet-shell .page-inner.rhythm > * + .sect { margin-top: 34px; }",
    );
    expect(shellCss).not.toMatch(
      /\.droplet-shell \.page-inner\.rhythm > \.sect\s+\{/,
    );
  });

  it("keeps out-of-flow children out of the rhythm", () => {
    // A margin on a `position: fixed` box offsets the pinned box instead of
    // spacing anything — the toaster and the two non-portalled camera modals
    // are all `fixed inset-0` direct children of `.page-inner`.
    expect(shellCss).toContain(".droplet-shell .page-inner.rhythm > .fixed,");
    expect(shellCss).toContain(".droplet-shell .page-inner.rhythm > .absolute,");
    expect(shellCss).toContain(
      ".droplet-shell .page-inner.rhythm > [data-overlay] { margin-top: 0; }",
    );
  });
});

/* ── The markup the rule needs ──────────────────────────── */

function camera(name: string): CameraInfo {
  return {
    name,
    displayName: name.replace(/_/g, " "),
    manufacturer: null,
    model: null,
    ipAddress: "10.10.0.5",
    macAddress: null,
    enabled: true,
    autoDiscovered: false,
    status: "live",
    lastSeen: new Date().toISOString(),
    lastDetection: null,
  };
}

const detection: DetectionEvent = {
  id: "evt-1",
  camera: "front_door",
  label: "person",
  score: 0.92,
  startTime: Math.floor(Date.now() / 1000) - 30,
  endTime: null,
  thumbnail: "/api/cameras/events/evt-1/thumbnail.jpg",
  hasClip: true,
  hasSnapshot: true,
};

vi.mock("swr", () => ({
  default: () => ({ data: undefined, mutate: vi.fn(), isValidating: false }),
}));

vi.mock("@/lib/hooks/useCameras", () => ({
  useCameras: () => ({
    cameras: [camera("front_door"), camera("garage")],
    discovered: [],
    discoveryOnline: true,
    recentEvents: [detection],
    totalCameras: 2,
    isLoading: false,
    isRefreshing: false,
    error: undefined,
    refresh: vi.fn(),
    setDiscovered: vi.fn(),
    acceptCamera: vi.fn(),
    rejectCamera: vi.fn(),
  }),
}));

vi.mock("@/lib/hooks/useCameraEvents", () => ({
  useCameraEvents: () => ({
    // A live toast, so the fixed element is actually in the DOM.
    notifications: [
      { type: "detection", camera: "front_door", label: "person", score: 0.9, timestamp: 1 },
    ],
    dismissNotification: vi.fn(),
  }),
}));

vi.mock("@/lib/hooks/useCameraGroups", () => ({
  useCameraGroups: () => ({
    groups: [],
    create: vi.fn(),
    rename: vi.fn(),
    setIcon: vi.fn(),
    addMembers: vi.fn(),
    removeMember: vi.fn(),
    remove: vi.fn(),
  }),
}));

vi.mock("@/lib/hooks/useCameraPins", () => ({
  useCameraPins: () => ({
    pins: [{ cameraName: "front_door", sortOrder: 0 }],
    pinnedSet: new Set(["front_door"]),
    toggle: vi.fn(),
  }),
}));

import CamerasPage from "@/app/cameras/page";

function renderPage(): HTMLElement {
  const { container } = render(<CamerasPage />);
  const inner = container.querySelector<HTMLElement>(".page-inner");
  expect(inner).not.toBeNull();
  return inner as HTMLElement;
}

describe("/cameras — the page's own children", () => {
  afterEach(cleanup);

  it("opts into the rhythm rule", () => {
    expect(renderPage().classList.contains("rhythm")).toBe(true);
  });

  it("renders every section heading as a direct child, not inside a spacer", () => {
    const inner = renderPage();
    const headings = Array.from(
      inner.querySelectorAll(":scope > .sect h2"),
      (h) => h.textContent,
    );
    // Pinned + All cameras were wrapped in `div.mb-6`; Recent detections was a
    // `type-headline` h2 inside a `div.mt-8` wrapping a `space-y-3` component.
    expect(headings).toEqual(["Pinned", "All cameras", "Recent detections"]);
    // …and nothing is left wrapping one.
    expect(inner.querySelectorAll(".sect")).toHaveLength(headings.length);
  });

  it("renders the fixed toaster last, so it takes no rhythm slot mid-column", () => {
    const last = renderPage().lastElementChild as HTMLElement;
    expect(last.classList.contains("fixed")).toBe(true);
    expect(last.textContent).toContain("person detected");
  });

  it("leaves outer spacing entirely to the page — no child carries a margin", () => {
    const offenders = Array.from(renderPage().children)
      .map((el) => el.className)
      .filter((cls) => typeof cls === "string" && / m[btxy]?-\d/.test(" " + cls));
    expect(offenders).toEqual([]);
  });
});
