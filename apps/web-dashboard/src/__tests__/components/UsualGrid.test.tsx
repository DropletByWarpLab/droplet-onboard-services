/**
 * WARP-2980 (ADR-059 P5 §8 "What's usual") — the hour grid.
 *
 * Pins:
 *   - the select lists exactly the keys the server returned (it has already
 *     dropped any area or camera the viewer may not fully see), areas first;
 *   - label pills from the key's kept labels (Person / Car / Dog / Cat first);
 *   - two blocks, Weekdays and Weekends, each 24 cell BUTTONS in two halves
 *     of 12 — one row on desktop, 2 × 12 at ≤ 480 px (the stylesheet's media
 *     rule, pinned below), so 375 px never scrolls sideways;
 *   - four fill steps and a hatched "not enough yet"; every cell's
 *     aria-label; the detail line; arrow-key movement between cells.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { packagePath } from "@/__tests__/helpers/test-paths";
import type { SecurityPatternCellView, SecurityPatternCells, SecurityPatternsOverview } from "@/lib/types";

const h = vi.hoisted(() => ({
  calls: [] as Array<[string | null, string | null]>,
  cells: null as unknown,
  error: undefined as Error | undefined,
}));

vi.mock("@/lib/hooks/useSecurity", () => ({
  useSecurityPatternCells: (key: string | null, label: string | null) => {
    h.calls.push([key, label]);
    return { cells: h.cells, error: h.error, isLoading: h.cells === null && !h.error };
  },
}));

import { UsualGrid, cellAriaLabel, detailLine } from "@/components/security/UsualGrid";
import { COPY, fillStep, formatRate, hourRange } from "@/components/security/patterns-copy";

type Key = SecurityPatternsOverview["keys"][number];
const KEYS: Key[] = [
  { zoneKey: "area:a1", kind: "area", zoneId: "a1", name: "Car park", cameras: ["front"], labels: ["person", "car"], learning: false },
  { zoneKey: "area:a2", kind: "area", zoneId: "a2", name: "Stock room", cameras: ["back"], labels: ["person"], learning: true },
  { zoneKey: "camera:front", kind: "camera", zoneId: null, name: "Front camera", cameras: ["front"], labels: ["person", "car", "bicycle"], learning: false },
];

function cell(dayType: "weekday" | "weekend", hour: number, over: Partial<SecurityPatternCellView> = {}): SecurityPatternCellView {
  const n = dayType === "weekday" ? 20 : 8;
  return { dayType, hour, daysObserved: n, daysWithEvent: 0, ready: true, rare: true, typicalPerHour: 0.0167, longestUsualVisitSec: null, ...over };
}

function cellsView(over: (c: SecurityPatternCellView) => Partial<SecurityPatternCellView> = () => ({})): SecurityPatternCells {
  const cells: SecurityPatternCellView[] = [];
  for (const dt of ["weekday", "weekend"] as const) for (let h2 = 0; h2 < 24; h2 += 1) {
    const c = cell(dt, h2);
    cells.push({ ...c, ...over(c) });
  }
  return { key: "area:a1", label: "person", window: { from: "2026-08-26", to: "2026-09-22", builtAt: "2026-09-23T04:11:00.000Z" }, cells };
}

beforeEach(() => {
  h.calls = [];
  h.cells = cellsView((c) =>
    c.dayType === "weekday" && c.hour === 14
      ? { daysWithEvent: 18, rare: false, typicalPerHour: 8.02, longestUsualVisitSec: 95 }
      : c.dayType === "weekend"
        ? { ready: false, rare: false, typicalPerHour: null }
        : {},
  );
  h.error = undefined;
});

describe("copy helpers", () => {
  it.each([
    [0, "12–1 AM", "12 to 1 AM"],
    [2, "2–3 AM", "2 to 3 AM"],
    [11, "11 AM–12 PM", "11 AM to 12 PM"],
    [12, "12–1 PM", "12 to 1 PM"],
    [23, "11 PM–12 AM", "11 PM to 12 AM"],
  ])("hourRange(%i)", (hour, dash, words) => {
    expect(hourRange(hour, "–")).toBe(dash);
    expect(hourRange(hour, " to ")).toBe(words);
  });

  it("four fill steps from daysWithEvent / daysObserved", () => {
    expect(fillStep(0, 20)).toBe("never");
    expect(fillStep(1, 20)).toBe("some");
    expect(fillStep(5, 20)).toBe("often");
    expect(fillStep(11, 20)).toBe("often");
    expect(fillStep(12, 20)).toBe("most");
    expect(fillStep(0, 0)).toBe("never");
  });

  it("rates read as people say them", () => {
    expect(formatRate(0.0167)).toBe("0");
    expect(formatRate(0.4)).toBe("0.4");
    expect(formatRate(8.02)).toBe("8");
    expect(formatRate(14.6)).toBe("15");
  });

  it("the aria-label and the detail line", () => {
    expect(cellAriaLabel(cell("weekday", 2))).toBe("Weekdays, 2 to 3 AM: seen on 0 of 20 days");
    expect(cellAriaLabel(cell("weekend", 23, { ready: false }))).toBe("Weekends, 11 PM to 12 AM: not enough yet");
    expect(detailLine(cell("weekday", 2), "person")).toBe(
      "Weekdays 2–3 AM · seen on 0 of 20 days · usually 0 an hour · longest usual visit: not enough visits yet",
    );
    expect(detailLine(cell("weekday", 14, { daysWithEvent: 18, typicalPerHour: 8.02, longestUsualVisitSec: 95 }), "person")).toBe(
      "Weekdays 2–3 PM · seen on 18 of 20 days · usually 8 an hour · longest usual visit: 95 s",
    );
    expect(detailLine(cell("weekday", 14, { longestUsualVisitSec: 400 }), "person")).toContain("longest usual visit: 7 min");
    // Visits are timed for people only.
    expect(detailLine(cell("weekday", 2), "car")).toBe("Weekdays 2–3 AM · seen on 0 of 20 days · usually 0 an hour");
    expect(detailLine(cell("weekend", 2, { ready: false, typicalPerHour: null }), "person")).toBe(
      "Weekends 2–3 AM · not enough yet — seen on 0 of 8 days so far",
    );
  });
});

describe("UsualGrid", () => {
  it("the select holds exactly the server's keys, areas first, then cameras", () => {
    render(<UsualGrid keys={KEYS} />);
    const select = screen.getByLabelText(COPY.keyLabel) as HTMLSelectElement;
    const groups = within(select).getAllByRole("group");
    expect(groups.map((g) => g.getAttribute("label"))).toEqual([COPY.areasGroup, COPY.camerasGroup]);
    expect([...select.options].map((o) => o.value)).toEqual(["area:a1", "area:a2", "camera:front"]);
    expect([...select.options].map((o) => o.textContent)).toEqual(["Car park", "Stock room", "Front camera"]);
  });

  it("asks for the first key's person cells, then follows the pills and the select", () => {
    render(<UsualGrid keys={KEYS} />);
    expect(h.calls.at(-1)).toEqual(["area:a1", "person"]);
    const pills = screen.getByRole("group", { name: COPY.labelGroup });
    expect(within(pills).getAllByRole("button").map((b) => b.textContent)).toEqual(["Person", "Car"]);
    fireEvent.click(within(pills).getByRole("button", { name: "Car" }));
    expect(h.calls.at(-1)).toEqual(["area:a1", "car"]);
    expect(within(pills).getByRole("button", { name: "Car" }).getAttribute("aria-pressed")).toBe("true");
    // A key without the chosen label goes back to person.
    fireEvent.change(screen.getByLabelText(COPY.keyLabel), { target: { value: "area:a2" } });
    expect(h.calls.at(-1)).toEqual(["area:a2", "person"]);
    fireEvent.change(screen.getByLabelText(COPY.keyLabel), { target: { value: "camera:front" } });
    expect(within(screen.getByRole("group", { name: COPY.labelGroup })).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Person",
      "Car",
      "Bicycle",
    ]);
  });

  it("two blocks of 24 buttons, each two halves of 12; not-ready cells hatched; fill steps as data", () => {
    render(<UsualGrid keys={KEYS} />);
    for (const name of [COPY.weekdays, COPY.weekends]) {
      const block = screen.getByRole("group", { name });
      const halves = block.querySelectorAll("[data-half]");
      expect(halves).toHaveLength(2);
      halves.forEach((half) => expect(half.querySelectorAll("button")).toHaveLength(12));
    }
    const weekday2 = screen.getByRole("button", { name: "Weekdays, 2 to 3 AM: seen on 0 of 20 days" });
    expect(weekday2.getAttribute("data-fill")).toBe("never");
    expect(weekday2.getAttribute("data-ready")).toBe("true");
    const busy = screen.getByRole("button", { name: "Weekdays, 2 to 3 PM: seen on 18 of 20 days" });
    expect(busy.getAttribute("data-fill")).toBe("most");
    const weekend = screen.getByRole("button", { name: "Weekends, 2 to 3 AM: not enough yet" });
    expect(weekend.getAttribute("data-ready")).toBe("false");
    expect(weekend.className).toContain("usual-cell");
  });

  it("choosing a cell shows its detail line; before that, a prompt", () => {
    render(<UsualGrid keys={KEYS} />);
    expect(screen.getByTestId("usual-detail").textContent).toBe(COPY.pick);
    fireEvent.click(screen.getByRole("button", { name: "Weekdays, 2 to 3 PM: seen on 18 of 20 days" }));
    expect(screen.getByTestId("usual-detail").textContent).toBe(
      "Weekdays 2–3 PM · seen on 18 of 20 days · usually 8 an hour · longest usual visit: 95 s",
    );
    expect(screen.getByRole("button", { name: "Weekdays, 2 to 3 PM: seen on 18 of 20 days" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("one tab stop; arrows move across hours and between weekdays and weekends", () => {
    render(<UsualGrid keys={KEYS} />);
    const buttons = screen.getAllByRole("button").filter((b) => b.classList.contains("usual-cell"));
    expect(buttons.filter((b) => b.tabIndex === 0)).toHaveLength(1);
    const first = buttons.find((b) => b.tabIndex === 0)!;
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Weekdays, 1 to 2 AM: seen on 0 of 20 days");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Weekends, 1 to 2 AM: not enough yet");
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Weekends, 11 PM to 12 AM: not enough yet");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Weekends, 11 PM to 12 AM: not enough yet");
  });

  it("a legend: the four steps and 'not enough yet'", () => {
    render(<UsualGrid keys={KEYS} />);
    const legend = screen.getByTestId("usual-legend");
    for (const t of [COPY.legendNever, COPY.legendSome, COPY.legendOften, COPY.legendMost, COPY.legendNotReady]) {
      expect(within(legend).getByText(t)).toBeTruthy();
    }
  });

  it("loading, and an error in the Security domain's words (never the server's message)", () => {
    h.cells = null;
    const { rerender } = render(<UsualGrid keys={KEYS} />);
    expect(screen.getByTestId("usual-loading")).toBeTruthy();
    h.error = Object.assign(new Error("prisma exploded"), { code: "PATTERN_NOT_FOUND", status: 404 });
    rerender(<UsualGrid keys={KEYS} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("There's nothing to show for that area or camera");
    expect(alert.textContent).not.toContain("prisma");
  });

  it("no keys → nothing to choose from; the page says why", () => {
    const { container } = render(<UsualGrid keys={[]} />);
    expect(container.textContent).toBe(COPY.noKeys);
    expect(h.calls.at(-1)).toEqual([null, null]);
  });
});

describe("the stylesheet — 2 × 12 at ≤ 480 px, tokens only", () => {
  const css = readFileSync(packagePath("src/components/security/patterns.css"), "utf8");

  it("the halves sit side by side and stack at ≤ 480 px", () => {
    expect(css).toMatch(/\.droplet-shell \.usual-halves \{[^}]*display: flex;/);
    expect(css).toMatch(/@media \(max-width: 480px\) \{[^@]*\.droplet-shell \.usual-halves \{[^}]*flex-direction: column;/);
  });

  it("no hard-coded colours: every colour is a token", () => {
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(withoutComments).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(withoutComments).not.toMatch(/\brgba?\(/);
  });
});
