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
  afterEach(() => { vi.unstubAllGlobals(); });

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
    // Craft a window that spans the current hour: start an hour earlier,
    // end an hour later, for today's day-of-week.
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
    // Pick a day-of-week mask that definitely excludes today.
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
});
