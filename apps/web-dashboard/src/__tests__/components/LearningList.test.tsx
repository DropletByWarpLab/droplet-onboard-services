/**
 * WARP-2980 (ADR-059 P5 §8 "Learning") — one row per camera the viewer may
 * see, in four states:
 *   · learning  — "Learning what normal looks like — 9 of 14 days", with a
 *                 14-step bar;
 *   · active    — "Knows what normal looks like · about 140 detections a day";
 *   · stale     — "Hasn't been watching since Tue 2:14 AM" (site zone);
 *   · no source — "Not reporting to Droplet yet", for a camera Droplet has
 *                 never heard from.
 * The server has already dropped cameras outside the viewer's grant; the
 * camera list (/api/cameras) is filtered the same way.
 */
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { LearningList, learningLine } from "@/components/security/LearningList";
import { COPY, formatPerDay } from "@/components/security/patterns-copy";
import type { CameraInfo, SecurityPatternsOverview } from "@/lib/types";

const TZ = "America/New_York";
const NOW = new Date("2026-09-23T16:00:00.000Z"); // Wed 12:00 PM in New York

type Source = SecurityPatternsOverview["sources"][number];
const src = (over: Partial<Source>): Source => ({
  camera: "front",
  label: "Front camera",
  state: "learning",
  daysObserved: 9,
  daysNeeded: 14,
  lastSeenAt: NOW.toISOString(),
  detectionsPerDay: null,
  ...over,
});
const cam = (name: string, displayName: string): CameraInfo => ({ name, displayName }) as CameraInfo;

describe("learningLine — the row copy", () => {
  it("learning", () => {
    expect(learningLine(src({}), TZ, NOW)).toBe("Learning what normal looks like — 9 of 14 days");
  });
  it("active, with and without a rate", () => {
    expect(learningLine(src({ state: "active", daysObserved: 20, detectionsPerDay: 140.4 }), TZ, NOW)).toBe(
      "Knows what normal looks like · about 140 detections a day",
    );
    expect(learningLine(src({ state: "active", daysObserved: 20, detectionsPerDay: null }), TZ, NOW)).toBe("Knows what normal looks like");
  });
  it("stale, in the site's zone and the dashboard's day-aware style", () => {
    // 2026-09-22T06:14Z = Tue 2:14 AM in New York.
    expect(learningLine(src({ state: "stale", lastSeenAt: "2026-09-22T06:14:00.000Z" }), TZ, NOW)).toBe(
      "Hasn't been watching since Tue 2:14 AM",
    );
  });
  it("detections a day read naturally", () => {
    expect(formatPerDay(0.4)).toBe("fewer than one detection a day");
    expect(formatPerDay(1.2)).toBe("about 1 detection a day");
    expect(formatPerDay(7.6)).toBe("about 8 detections a day");
    expect(formatPerDay(1234.5)).toBe("about 1,235 detections a day");
  });
});

describe("LearningList", () => {
  const sources = [
    src({ camera: "back", label: "Back camera", state: "active", daysObserved: 20, detectionsPerDay: 140 }),
    src({ camera: "front", label: "Front camera" }),
    src({ camera: "yard", label: "Yard", state: "stale", lastSeenAt: "2026-09-22T06:14:00.000Z" }),
  ];
  const cameras = [cam("back", "Back camera"), cam("front", "Front camera"), cam("yard", "Yard"), cam("porch", "Porch")];

  it("one row per camera, in the server's order, then the ones never heard from", () => {
    render(<LearningList sources={sources} cameras={cameras} timezone={TZ} now={NOW} />);
    const rows = screen.getAllByRole("listitem");
    expect(rows.map((r) => within(r).getByTestId("learning-name").textContent)).toEqual(["Back camera", "Front camera", "Yard", "Porch"]);
    expect(rows[3]!.textContent).toContain(COPY.notReporting);
  });

  it("a learning camera carries a 14-step bar with its days", () => {
    render(<LearningList sources={sources} cameras={cameras} timezone={TZ} now={NOW} />);
    const bar = screen.getByRole("progressbar", { name: "Front camera" });
    expect(bar.getAttribute("aria-valuenow")).toBe("9");
    expect(bar.getAttribute("aria-valuemax")).toBe("14");
    expect(bar.getAttribute("aria-valuetext")).toBe("9 of 14 days");
    expect(bar.querySelectorAll("[data-step]")).toHaveLength(14);
    expect(bar.querySelectorAll('[data-step="on"]')).toHaveLength(9);
    // Only learning rows have a bar.
    expect(screen.getAllByRole("progressbar")).toHaveLength(1);
  });

  it("the three states' lines", () => {
    render(<LearningList sources={sources} cameras={cameras} timezone={TZ} now={NOW} />);
    expect(screen.getByText("Knows what normal looks like · about 140 detections a day")).toBeTruthy();
    expect(screen.getByText("Learning what normal looks like — 9 of 14 days")).toBeTruthy();
    expect(screen.getByText("Hasn't been watching since Tue 2:14 AM")).toBeTruthy();
  });

  it("no timezone yet: times fall back to the device's zone, never UTC-by-default copy", () => {
    render(<LearningList sources={[sources[2]!]} cameras={[]} timezone={null} now={NOW} />);
    expect(screen.getByText(/^Hasn't been watching since /)).toBeTruthy();
  });

  it("nothing at all → nothing rendered (the page owns the empty state)", () => {
    const { container } = render(<LearningList sources={[]} cameras={[]} timezone={TZ} now={NOW} />);
    expect(container.textContent).toBe("");
  });
});
