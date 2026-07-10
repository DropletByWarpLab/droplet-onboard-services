import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { ScheduleRow } from "../ScheduleRow";
import type { Schedule } from "@/lib/types";

type FetchMock = ReturnType<typeof vi.fn>;

function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: "s1",
    name: "Bedtime",
    enabled: true,
    subjectType: "group",
    groupId: "kids",
    windows: [{ id: "w1", daysOfWeek: 31, startMin: 21 * 60, endMin: 7 * 60 }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function renderRow(schedule: Schedule, onEdit = vi.fn()) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ScheduleRow schedule={schedule} onEdit={onEdit} />
    </SWRConfig>,
  );
}

function mockListEndpoints(fetchMock: FetchMock) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.startsWith("/api/network/devices"))
      return { ok: true, status: 200, json: async () => ({ devices: [] }) };
    if (url.startsWith("/api/network/groups"))
      return {
        ok: true,
        status: 200,
        json: async () => ({
          groups: [{ id: "kids", name: "Kids", _count: { devices: 2 } }],
        }),
      };
    return {
      ok: true,
      status: 200,
      json: async () => ({ schedule: { id: "s1", name: "Bedtime" } }),
    };
  });
}

describe("ScheduleRow", () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("exposes the enabled toggle with role=switch + aria-checked", () => {
    mockListEndpoints(fetchMock);
    renderRow(makeSchedule({ enabled: true }));
    const toggle = screen.getByRole("switch", { name: /toggle bedtime/i });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("toggle click fires PATCH with flipped enabled flag", async () => {
    mockListEndpoints(fetchMock);
    renderRow(makeSchedule({ enabled: true }));
    fireEvent.click(screen.getByRole("switch", { name: /toggle bedtime/i }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        (c) => c[0] === "/api/network/schedules/s1",
      );
      expect(call).toBeDefined();
      expect(call![1].method).toBe("PATCH");
      expect(JSON.parse(call![1].body)).toEqual({ enabled: false });
    });
  });

  it("'Active now' dot renders when current time is inside a window", () => {
    mockListEndpoints(fetchMock);
    // Pin the clock to a fixed, safe mid-day instant instead of reading the
    // real wall clock. The old version derived start/end from `new Date()`
    // and clamped them into [0, 1439] — near midnight (e.g. 23:59) the
    // clamp collapsed endMin down to nowMin, and since isWindowActive's
    // end bound is exclusive, the window went inactive right when the test
    // ran in that minute (a real, if rare, CI flake). Freezing time removes
    // the dependency on when CI happens to execute entirely.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 15, 12, 0, 0));
    const now = new Date();
    const dayBit = [1, 2, 4, 8, 16, 32, 64][now.getDay()];
    const startMin = now.getHours() * 60 + now.getMinutes() - 60;
    const endMin = now.getHours() * 60 + now.getMinutes() + 60;
    const schedule = makeSchedule({
      windows: [
        {
          id: "w1",
          daysOfWeek: dayBit,
          startMin: Math.max(0, startMin),
          endMin: Math.min(1439, endMin),
        },
      ],
    });
    renderRow(schedule);
    expect(screen.getByLabelText("Active now")).toBeInTheDocument();
  });

  it("'Active now' dot absent when no window is currently active", () => {
    mockListEndpoints(fetchMock);
    // Same fixed-clock rationale as the test above — deterministic instead
    // of wall-clock-derived, so "today" can never shift mid-run.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 15, 12, 0, 0));
    const today = new Date().getDay();
    const dayBit = [1, 2, 4, 8, 16, 32, 64];
    let mask = 0;
    for (let i = 0; i < 7; i++) if (i !== today) mask |= dayBit[i];
    // But also use a tight window so "yesterday-wrap" doesn't sneak in:
    // start at noon, end at 13:00 — no wrap.
    const schedule = makeSchedule({
      windows: [
        { id: "w1", daysOfWeek: mask & ~dayBit[(today + 6) % 7], startMin: 12 * 60, endMin: 13 * 60 },
      ],
    });
    renderRow(schedule);
    expect(screen.queryByLabelText("Active now")).not.toBeInTheDocument();
  });

  it("delete shows inline confirm before firing DELETE", async () => {
    mockListEndpoints(fetchMock);
    renderRow(makeSchedule());
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    expect(screen.getByText(/delete\?/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^yes$/i }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        (c) => c[0] === "/api/network/schedules/s1",
      );
      expect(call).toBeDefined();
      expect(call![1].method).toBe("DELETE");
    });
  });

  it("edit button invokes the onEdit callback", () => {
    mockListEndpoints(fetchMock);
    const onEdit = vi.fn();
    renderRow(makeSchedule(), onEdit);
    fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  // WARP-100: the row carries a stable `schedule-<id>` anchor so the
  // cross-tab jump from DeviceDetailPanel can scroll it into view.
  it("renders a `schedule-<id>` anchor id on the row", () => {
    mockListEndpoints(fetchMock);
    const { container } = renderRow(makeSchedule({ id: "s1" }));
    const row = container.querySelector("#schedule-s1");
    expect(row).not.toBeNull();
    expect(row?.tagName).toBe("LI");
  });
});
