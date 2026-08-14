/**
 * WARP-1992 — `/reports` shell render pins.
 *
 * This story ships the grid, not the tile contents, so what is worth holding
 * is the frame the sibling stories build into: every tile present, in the
 * brief's reading order, at its declared span, with a labelled heading. Get
 * those wrong and four downstream tickets inherit a broken layout.
 *
 * ShellPage is mocked to a passthrough (same as admin-audit.page.test) — its
 * SWR health chip would only add noise.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import React from "react";

vi.mock("@/components/shell/ShellPage", () => ({
  ShellPage: ({ title, sub, actions, children }: any) => (
    <div className="droplet-shell">
      {title ? <h1>{title}</h1> : null}
      {sub ? <p>{sub}</p> : null}
      {actions ? <div data-testid="phead-actions">{actions}</div> : null}
      {children}
    </div>
  ),
}));

import ReportsPage from "@/app/reports/page";

/** Brief §4 — this order IS the reading order, and mobile preserves it. */
const EXPECTED_ORDER = ["a1", "a2", "b1", "b2", "b3", "b4", "c1", "c2", "d1", "d2"];

const EXPECTED_SPANS: Record<string, string> = {
  a1: "8x2", a2: "4x2",
  b1: "3x1", b2: "3x1", b3: "3x1", b4: "3x1",
  c1: "6x2", c2: "6x2",
  d1: "8x2", d2: "4x2",
};

function tiles(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-tile]"));
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 7, 14, 9, 41, 0));
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("/reports shell (WARP-1992)", () => {
  it("renders every tile from the brief, in reading order", () => {
    const { container } = render(<ReportsPage />);
    expect(tiles(container).map((t) => t.dataset.tile)).toEqual(EXPECTED_ORDER);
  });

  it("gives each tile its declared span — the grid is the contract with the sibling stories", () => {
    const { container } = render(<ReportsPage />);
    for (const t of tiles(container)) {
      expect(t.dataset.span).toBe(EXPECTED_SPANS[t.dataset.tile!]);
    }
  });

  it("labels every tile — each section points at a real heading", () => {
    const { container } = render(<ReportsPage />);
    for (const t of tiles(container)) {
      const id = t.getAttribute("aria-labelledby");
      expect(id).toBeTruthy();
      expect(container.querySelector(`#${id}`)?.textContent?.trim()).toBeTruthy();
    }
  });

  it("carries the provenance strip with a real timestamp", () => {
    render(<ReportsPage />);
    expect(
      screen.getByText(/Computed on this box · nothing left your network/),
    ).toBeTruthy();
    // A <time> with a machine-readable stamp, not just rendered text.
    const t = document.querySelector("time");
    expect(t?.getAttribute("dateTime") ?? t?.getAttribute("datetime")).toBeTruthy();
  });

  it("offers the four date scopes with Today pressed by default", () => {
    render(<ReportsPage />);
    const group = screen.getByRole("group", { name: "Date range" });
    const chips = within(group).getAllByRole("button");
    expect(chips.map((c) => c.textContent)).toEqual([
      "Today",
      "Yesterday",
      "Last 7 days",
      "Custom",
    ]);
    expect(chips[0].getAttribute("aria-pressed")).toBe("true");
  });

  it("moves the pressed state when a different scope is chosen — exactly one at a time", () => {
    render(<ReportsPage />);
    const group = screen.getByRole("group", { name: "Date range" });
    fireEvent.click(within(group).getByText("Yesterday"));

    const pressed = within(group)
      .getAllByRole("button")
      .filter((c) => c.getAttribute("aria-pressed") === "true");
    expect(pressed).toHaveLength(1);
    expect(pressed[0].textContent).toBe("Yesterday");
  });

  it("threads the resolved range onto the tiles so sibling stories can read it", () => {
    const { container } = render(<ReportsPage />);
    const a1 = container.querySelector<HTMLElement>('[data-tile="a1"]')!;
    // Today, resolved half-open: 14 Aug 00:00 → 15 Aug 00:00 local.
    expect(a1.dataset.rangeFrom).toBe(new Date(2026, 7, 14).toISOString());
    expect(a1.dataset.rangeTo).toBe(new Date(2026, 7, 15).toISOString());
  });

  it("re-resolves the range when the scope changes", () => {
    const { container } = render(<ReportsPage />);
    fireEvent.click(screen.getByText("Yesterday"));
    const a1 = container.querySelector<HTMLElement>('[data-tile="a1"]')!;
    expect(a1.dataset.rangeFrom).toBe(new Date(2026, 7, 13).toISOString());
    expect(a1.dataset.rangeTo).toBe(new Date(2026, 7, 14).toISOString());
  });

  it("leaves the range UNSET under Custom rather than falling back to today", () => {
    // The failure this pins: showing today's data under a label the user
    // deliberately changed. Absent beats wrong.
    const { container } = render(<ReportsPage />);
    fireEvent.click(screen.getByText("Custom"));
    const a1 = container.querySelector<HTMLElement>('[data-tile="a1"]')!;
    expect(a1.dataset.rangeFrom).toBeUndefined();
    expect(a1.dataset.rangeTo).toBeUndefined();
  });

  it("says in the provenance strip that counts are not range-scoped (WARP-1999)", () => {
    const { container } = render(<ReportsPage />);
    // The caveat belongs to the page, not to a tile: on four number tiles it
    // would be noise, on one it would read as applying only to that tile.
    // Omitting it entirely would imply a scope /api/home cannot apply.
    const strip = container.querySelector(".rp-provenance")!;
    expect(strip.textContent).toMatch(/counts are as of now/i);

    // And nowhere else — one statement, one place.
    const tiles = Array.from(container.querySelectorAll("[data-tile]"));
    for (const t of tiles) {
      expect(t.textContent ?? "").not.toMatch(/as of now/i);
    }
  });

  it("gives the refresh control an accessible name — it is icon-only", () => {
    render(<ReportsPage />);
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
  });
});
