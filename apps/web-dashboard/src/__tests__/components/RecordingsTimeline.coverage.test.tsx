/**
 * WARP-1959 — the scrubber shows COVERAGE, not just motion.
 *
 * The defect this pins: the old build coloured each hour by Frigate's
 * `motion` score alone and discarded `duration`, so an hour holding a full
 * 3600s of continuous recording over a quiet scene was pixel-identical to
 * an hour with nothing on disk. On the production box, hours 05:00–12:00
 * held 3586s each with `motion: 0` and rendered as empty grey — which is
 * how "the cams aren't recording" got reported about a camera that was
 * recording perfectly.
 *
 * The fixture below is the real shape from that day.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  RecordingsTimeline,
  fmtSecOfDay,
} from "@/components/recordings/RecordingsTimeline";
import type { RecordingDay } from "@/lib/types";

const DAY = "2026-08-13";

function hour(h: number, duration: number, motion = 0, events = 0) {
  return { hour: h, duration, motion, events, objects: 0 };
}

/** Quiet-but-fully-recorded hours next to busy ones, as measured. */
const SUMMARY: RecordingDay[] = [
  {
    day: DAY,
    events: 3,
    duration: 3586 * 6,
    hours: [
      hour(4, 3586, 774, 3),
      hour(9, 3586, 0), // fully recorded, zero motion
      hour(10, 3586, 0),
      hour(11, 3586, 0),
      hour(13, 3586, 954),
      hour(15, 1800, 11), // half an hour
      // 0-3, 5-8, 12, 14, 16-23 absent entirely = nothing kept
    ],
  },
];

function renderTimeline(overrides: Partial<React.ComponentProps<typeof RecordingsTimeline>> = {}) {
  const props = {
    day: DAY,
    summary: SUMMARY,
    timeline: [],
    selectedHour: null as number | null,
    onSelectHour: vi.fn(),
    onSelectionChange: vi.fn(),
    onScrubTo: vi.fn(),
    nowSecOfDay: null as number | null,
    ...overrides,
  };
  const utils = render(<RecordingsTimeline {...props} />);
  return { ...utils, props };
}

const cell = (h: number) => screen.getByTestId(`hour-cell-${h}`);

// Braces matter: an arrow with an implicit return hands the hook
// VitestUtils instead of a cleanup function, which tsc rejects.
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("a recorded hour is distinguishable from an empty one", () => {
  it("marks a fully-recorded, motionless hour as having footage", () => {
    renderTimeline();
    // THE regression. motion === 0, duration === 3586.
    expect(cell(9).getAttribute("data-has-footage")).toBe("true");
    expect(Number(cell(9).getAttribute("data-coverage"))).toBeGreaterThan(0.99);
  });

  it("marks an hour with nothing on disk as having no footage", () => {
    renderTimeline();
    expect(cell(0).getAttribute("data-has-footage")).toBe("false");
    expect(Number(cell(0).getAttribute("data-coverage"))).toBe(0);
  });

  it("renders a coverage fill for the recorded hour and none for the empty one", () => {
    renderTimeline();
    // The old build rendered the SAME thing for both.
    expect(screen.getByTestId("coverage-fill-9")).toBeTruthy();
    expect(screen.queryByTestId("coverage-fill-0")).toBeNull();
  });

  it("scales the fill to how much of the hour was actually kept", () => {
    renderTimeline();
    const full = screen.getByTestId("coverage-fill-9").getAttribute("style") ?? "";
    const half = screen.getByTestId("coverage-fill-15").getAttribute("style") ?? "";
    const pct = (s: string) => Number(/height:\s*([\d.]+)%/.exec(s)?.[1] ?? "0");

    expect(pct(full)).toBeGreaterThan(95);
    expect(pct(half)).toBeGreaterThan(45);
    expect(pct(half)).toBeLessThan(55);
  });

  it("says so in the accessible name, not only in colour", () => {
    renderTimeline();
    expect(cell(9).getAttribute("aria-label")).toMatch(/full hour/i);
    expect(cell(0).getAttribute("aria-label")).toMatch(/no footage/i);
    // The old label was "Hour 9: 0 events" for an hour holding 60 minutes.
    expect(cell(9).getAttribute("aria-label")).not.toMatch(/0 events/);
  });

  it("distinguishes the two by surface, not just by hue", () => {
    renderTimeline();
    // A colour-blind reader, or a bad monitor, still gets the answer.
    expect(cell(9).getAttribute("style")).toMatch(/solid/);
    expect(cell(0).getAttribute("style")).toMatch(/dashed/);
  });
});

describe("motion rides on top of coverage instead of replacing it", () => {
  it("renders motion for a busy hour without removing its coverage", () => {
    renderTimeline();
    expect(screen.getByTestId("coverage-fill-13")).toBeTruthy();
    expect(screen.getByTestId("motion-band-13")).toBeTruthy();
  });

  it("keeps busy hours distinguishable from each other", () => {
    renderTimeline();
    const h = (id: string) =>
      Number(/height:\s*([\d.]+)%/.exec(screen.getByTestId(id).getAttribute("style") ?? "")?.[1] ?? "0");

    // 954 vs 774 vs 11. The old 0-100 clamp made the first two identical.
    expect(h("motion-band-13")).toBeGreaterThan(h("motion-band-4"));
    expect(h("motion-band-4")).toBeGreaterThan(h("motion-band-15"));
  });

  it("draws no motion layer for a motionless hour", () => {
    renderTimeline();
    expect(screen.queryByTestId("motion-band-9")).toBeNull();
  });
});

describe("the axis is a real 24-column grid", () => {
  it("lays the hour labels out in 24 columns", () => {
    const { container } = renderTimeline();
    const grids = Array.from(container.querySelectorAll<HTMLElement>("[style*='grid-template-columns']"));

    // `grid-cols-24` is not a Tailwind 3 class and nothing defined it, so
    // the label row collapsed to ONE column and the labels never sat over
    // their hours. Both rows must carry the inline 24-column template.
    expect(grids.length).toBeGreaterThanOrEqual(2);
    for (const g of grids) {
      expect(g.style.gridTemplateColumns).toContain("repeat(24");
    }
  });

  it("renders one cell per hour of the day", () => {
    renderTimeline();
    for (let h = 0; h < 24; h++) expect(cell(h)).toBeTruthy();
  });
});

describe("the future is visibly out of range", () => {
  it("marks hours after now and shows a now marker", () => {
    renderTimeline({ nowSecOfDay: 15 * 3600 + 30 * 60 }); // 15:30
    expect(cell(16).getAttribute("data-future")).toBe("true");
    expect(cell(23).getAttribute("data-future")).toBe("true");
    expect(cell(14).getAttribute("data-future")).toBe("false");
    expect(screen.getByTestId("now-marker")).toBeTruthy();
  });

  it("does not grey out a past day", () => {
    renderTimeline({ nowSecOfDay: null });
    expect(cell(23).getAttribute("data-future")).toBe("false");
    expect(screen.queryByTestId("now-marker")).toBeNull();
  });

  it("says 'not yet' rather than 'no footage' for a future hour", () => {
    renderTimeline({ nowSecOfDay: 10 * 3600 });
    expect(cell(20).getAttribute("aria-label")).toMatch(/not yet/i);
  });
});

describe("scrubbing moves playback", () => {
  it("steps an hour with the arrow keys and seeks there", () => {
    const { props } = renderTimeline({ selectedHour: 9 });
    fireEvent.keyDown(screen.getByRole("slider"), { key: "ArrowRight" });

    expect(props.onSelectHour).toHaveBeenCalledWith(10);
    // The old build had no keyboard support at all, and drag fed only the
    // export button — the gesture never moved the video.
    expect(props.onScrubTo).toHaveBeenCalledWith(10 * 3600);
  });

  it("jumps six hours with shift-arrow", () => {
    const { props } = renderTimeline({ selectedHour: 12 });
    fireEvent.keyDown(screen.getByRole("slider"), { key: "ArrowLeft", shiftKey: true });
    expect(props.onSelectHour).toHaveBeenCalledWith(6);
  });

  it("Home and End go to the ends of the available day", () => {
    const { props } = renderTimeline({ selectedHour: 12, nowSecOfDay: 15 * 3600 + 1800 });
    const slider = screen.getByRole("slider");

    fireEvent.keyDown(slider, { key: "Home" });
    expect(props.onSelectHour).toHaveBeenLastCalledWith(0);

    fireEvent.keyDown(slider, { key: "End" });
    // End stops at NOW, not at 23 — there is nothing after it to play.
    expect(props.onSelectHour).toHaveBeenLastCalledWith(15);
  });

  it("never steps past now", () => {
    const { props } = renderTimeline({ selectedHour: 15, nowSecOfDay: 15 * 3600 + 1800 });
    fireEvent.keyDown(screen.getByRole("slider"), { key: "ArrowRight" });
    expect(props.onSelectHour).toHaveBeenLastCalledWith(15);
  });

  it("is one focusable widget, not 24 tab stops", () => {
    renderTimeline();
    const slider = screen.getByRole("slider");
    expect(slider.getAttribute("tabindex")).toBe("0");
    // The cells themselves must not be separately tabbable.
    expect(cell(9).getAttribute("tabindex")).toBeNull();
  });
});

describe("the empty day explains itself", () => {
  it("distinguishes 'nothing kept' from 'outside retention'", () => {
    const empty: RecordingDay[] = [{ day: DAY, events: 0, duration: 0, hours: [] }];

    const { unmount } = render(
      <RecordingsTimeline
        day={DAY}
        summary={empty}
        timeline={[]}
        selectedHour={null}
        onSelectHour={vi.fn()}
      />,
    );
    expect(screen.getByText(/no footage kept on this day/i)).toBeTruthy();
    unmount();

    render(
      <RecordingsTimeline
        day={DAY}
        summary={empty}
        timeline={[]}
        selectedHour={null}
        onSelectHour={vi.fn()}
        retentionOldestDay="2026-08-20"
      />,
    );
    expect(screen.getByText(/outside this camera's retention/i)).toBeTruthy();
  });

  it("summarises how much footage the day actually holds", () => {
    renderTimeline();
    expect(screen.getByText(/min of footage across 6 hours/i)).toBeTruthy();
  });
});

describe("fmtSecOfDay", () => {
  it("formats seconds-since-midnight as HH:MM", () => {
    expect(fmtSecOfDay(0)).toBe("00:00");
    expect(fmtSecOfDay(9 * 3600 + 5 * 60)).toBe("09:05");
    expect(fmtSecOfDay(23 * 3600 + 59 * 60)).toBe("23:59");
  });
});
