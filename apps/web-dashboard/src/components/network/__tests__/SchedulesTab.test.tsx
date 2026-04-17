import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { SchedulesTab } from "../SchedulesTab";
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

function renderTab() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <SchedulesTab />
    </SWRConfig>,
  );
}

describe("SchedulesTab", () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  function mockAllEndpoints(schedules: Schedule[] = []) {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/network/schedules"))
        return { ok: true, status: 200, json: async () => ({ schedules }) };
      if (url.startsWith("/api/network/schedule-events"))
        return { ok: true, status: 200, json: async () => ({ events: [] }) };
      if (url.startsWith("/api/network/devices"))
        return { ok: true, status: 200, json: async () => ({ devices: [] }) };
      if (url.startsWith("/api/network/groups"))
        return {
          ok: true,
          status: 200,
          json: async () => ({
            groups: [{ id: "kids", name: "Kids", _count: { devices: 0 } }],
          }),
        };
      return { ok: true, status: 200, json: async () => ({}) };
    });
  }

  it("renders the presets placeholder and empty state when no schedules", async () => {
    mockAllEndpoints([]);
    renderTab();
    expect(
      screen.getByText(/Presets coming soon \(WARP-99/),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("No schedules yet")).toBeInTheDocument();
    });
    expect(
      screen.getByText(
        "Pick a preset above, or create a custom schedule.",
      ),
    ).toBeInTheDocument();
  });

  it("renders one ScheduleRow per schedule when populated", async () => {
    mockAllEndpoints([
      makeSchedule({ id: "s1", name: "Bedtime" }),
      makeSchedule({ id: "s2", name: "School hours" }),
    ]);
    renderTab();
    await waitFor(() => {
      expect(screen.getByText("Bedtime")).toBeInTheDocument();
      expect(screen.getByText("School hours")).toBeInTheDocument();
    });
  });

  it("opens the editor stub when '+ New schedule' is clicked", async () => {
    mockAllEndpoints([]);
    renderTab();
    await waitFor(() =>
      expect(screen.getByText("No schedules yet")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /new schedule/i }));
    expect(
      screen.getByText(/Schedule editor coming soon \(WARP-96\)/),
    ).toBeInTheDocument();
    // Close the stub
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(
      screen.queryByText(/Schedule editor coming soon \(WARP-96\)/),
    ).not.toBeInTheDocument();
  });
});
