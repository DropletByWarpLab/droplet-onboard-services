/**
 * WARP-2980 (ADR-059 P5 §8) — /security/patterns, "Patterns", read-only.
 *
 * Pins the page's states, each with its own words (never an empty screen
 * that reads as "nothing happens here"):
 *   · loading; an outage (translateError copy + Retry — never the server's
 *     message);
 *   · no timezone → a pointer to Opening hours;
 *   · no camera reporting yet;
 *   · learning but not worked out yet (the list shows; the grid waits);
 *   · ready — the status line from the `patterns` health row, the learning
 *     list and the grid.
 * The trial sentence shows while any flag is in trial, unless the health row
 * already says so.
 */
import type { ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { CameraInfo, SecurityHealthRow, SecurityPatternsOverview } from "@/lib/types";

const h = vi.hoisted(() => ({
  overview: null as unknown,
  overviewError: undefined as Error | undefined,
  mutate: vi.fn(),
  health: null as unknown,
  cameras: [] as unknown[],
}));

vi.mock("@/lib/hooks/useSecurity", () => ({
  useSecurityPatterns: () => ({ overview: h.overview, error: h.overviewError, isLoading: h.overview === null && !h.overviewError, mutate: h.mutate }),
  useSecurityHealth: () => ({ sources: h.health, error: undefined, isLoading: false, refresh: vi.fn() }),
  useSecurityCameras: () => ({ cameras: h.cameras, error: undefined }),
  useSecurityPatternCells: () => ({ cells: null, error: undefined, isLoading: true }),
}));

vi.mock("@/components/shell/ShellPage", () => ({
  ShellPage: ({ title, sub, children }: { title?: string; sub?: string; children?: ReactNode }) => (
    <div className="droplet-shell">
      <h1>{title}</h1>
      <p data-testid="page-sub">{sub}</p>
      {children}
    </div>
  ),
}));

import SecurityPatternsPage from "@/app/security/patterns/page";
import { COPY } from "@/components/security/patterns-copy";

const RELEASE = { out_of_place: "trial", unusual_volume: "trial", long_dwell: "trial" } as const;
function overview(over: Partial<SecurityPatternsOverview> = {}): SecurityPatternsOverview {
  return {
    state: "ready",
    reason: null,
    timezone: "America/New_York",
    window: { from: "2026-08-26", to: "2026-09-22", builtAt: "2026-09-23T04:11:00.000Z" },
    release: { ...RELEASE },
    sources: [
      { camera: "front", label: "Front camera", state: "learning", daysObserved: 9, daysNeeded: 14, lastSeenAt: "2026-09-23T15:00:00.000Z", detectionsPerDay: null },
    ],
    keys: [{ zoneKey: "camera:front", kind: "camera", zoneId: null, name: "Front camera", cameras: ["front"], labels: ["person"], learning: true }],
    waitingProposals: 0,
    ...over,
  };
}
const row = (over: Partial<SecurityHealthRow>): SecurityHealthRow => ({ id: "patterns", state: "quiet", detail: "Learning what normal looks like — 9 of 14 days", lastSeenAt: null, ...over });

beforeEach(() => {
  h.overview = overview();
  h.overviewError = undefined;
  h.mutate.mockReset();
  h.health = [row({})];
  h.cameras = [{ name: "front", displayName: "Front camera" } as CameraInfo];
});

describe("/security/patterns", () => {
  it("title and sub are the spec's words", () => {
    render(<SecurityPatternsPage />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Patterns");
    expect(screen.getByTestId("page-sub").textContent).toBe(COPY.sub);
  });

  it("ready: the status line, the trial sentence, the learning list and the grid", () => {
    render(<SecurityPatternsPage />);
    expect(screen.getByTestId("patterns-status").textContent).toContain("Learning what normal looks like — 9 of 14 days");
    expect(screen.getByText(COPY.trial)).toBeTruthy();
    expect(screen.getByRole("heading", { name: COPY.learningTitle })).toBeTruthy();
    expect(screen.getByRole("heading", { name: COPY.usualTitle })).toBeTruthy();
    expect(screen.getByLabelText(COPY.keyLabel)).toBeTruthy();
  });

  it("the trial sentence is not repeated when the health row already carries it", () => {
    h.health = [row({ state: "ok", detail: "Knows what normal looks like for 1 camera · Trial: pattern flags aren't raised yet" })];
    render(<SecurityPatternsPage />);
    expect(screen.queryByText(COPY.trial)).toBeNull();
  });

  it("no trial sentence once every flag is live", () => {
    h.overview = overview({ release: { out_of_place: "live", unusual_volume: "live", long_dwell: "live" } });
    render(<SecurityPatternsPage />);
    expect(screen.queryByText(COPY.trial)).toBeNull();
  });

  it("no timezone → says so and points to Opening hours", () => {
    h.overview = overview({ state: "not_configured", reason: "no_timezone", timezone: null, window: null, sources: [], keys: [] });
    render(<SecurityPatternsPage />);
    expect(screen.getByText(COPY.noTimezone)).toBeTruthy();
    expect(screen.getByRole("link", { name: COPY.setHours }).getAttribute("href")).toBe("/security/settings");
    expect(screen.queryByLabelText(COPY.keyLabel)).toBeNull();
  });

  it("no camera reporting yet → its own empty state", () => {
    h.overview = overview({ state: "not_configured", reason: "no_cameras", sources: [], keys: [] });
    h.cameras = [];
    render(<SecurityPatternsPage />);
    expect(screen.getByText(COPY.noCamerasTitle)).toBeTruthy();
    expect(screen.getByText(COPY.noCameras)).toBeTruthy();
  });

  it("learning but not worked out yet → the list shows, the grid waits with its reason", () => {
    h.overview = overview({ state: "not_built", window: null, keys: [] });
    render(<SecurityPatternsPage />);
    // The camera's own row, with its 14-step bar (the status line may say the same words).
    expect(screen.getByRole("progressbar", { name: "Front camera" }).getAttribute("aria-valuenow")).toBe("9");
    expect(screen.getByText(COPY.notBuilt)).toBeTruthy();
    expect(screen.queryByLabelText(COPY.keyLabel)).toBeNull();
  });

  it("loading shows a busy card, not an empty page", () => {
    h.overview = null;
    render(<SecurityPatternsPage />);
    expect(screen.getByTestId("patterns-loading").getAttribute("aria-busy")).toBe("true");
  });

  it("an outage: the Security domain's words, never the server's, and Retry re-reads", () => {
    h.overview = null;
    h.overviewError = Object.assign(new Error("ECONNREFUSED 10.0.0.1"), { code: "PATTERNS_UNAVAILABLE", status: 503 });
    render(<SecurityPatternsPage />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Droplet couldn't load what's usual right now");
    expect(alert.textContent).not.toContain("ECONNREFUSED");
    fireEvent.click(screen.getByRole("button", { name: COPY.retry }));
    expect(h.mutate).toHaveBeenCalled();
  });
});
