import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { ScheduleActivityFeed } from "../ScheduleActivityFeed";
import type { ScheduleEvent } from "@/lib/types";

type FetchMock = ReturnType<typeof vi.fn>;

function renderFeed() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ScheduleActivityFeed />
    </SWRConfig>,
  );
}

function makeEvent(overrides: Partial<ScheduleEvent> = {}): ScheduleEvent {
  return {
    id: "e1",
    scheduleId: "sched-1",
    subjectType: "group",
    groupId: "kids",
    transition: "blocked",
    reason: "window_start",
    occurredAt: new Date("2026-04-15T21:00:00").toISOString(),
    ...overrides,
  };
}

describe("ScheduleActivityFeed", () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  function mockEndpoints(events: ScheduleEvent[]) {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/network/schedule-events"))
        return { ok: true, status: 200, json: async () => ({ events }) };
      if (url.startsWith("/api/network/schedules"))
        return {
          ok: true,
          status: 200,
          json: async () => ({
            schedules: [
              {
                id: "sched-1",
                name: "Bedtime",
                enabled: true,
                subjectType: "group",
                groupId: "kids",
                windows: [],
                createdAt: "",
                updatedAt: "",
              },
            ],
          }),
        };
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

  it("is collapsed by default — toggling flips aria-expanded", async () => {
    mockEndpoints([]);
    renderFeed();
    const toggle = screen.getByRole("button", { expanded: false });
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { expanded: true })).toBeInTheDocument();
  });

  it("does not fetch events while collapsed (null SWR key)", async () => {
    mockEndpoints([makeEvent()]);
    renderFeed();
    await new Promise((r) => setTimeout(r, 20));
    const eventCalls = fetchMock.mock.calls.filter((c) =>
      typeof c[0] === "string" && c[0].startsWith("/api/network/schedule-events"),
    );
    expect(eventCalls).toHaveLength(0);
  });

  it("shows empty-state copy when expanded with no events", async () => {
    mockEndpoints([]);
    renderFeed();
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    await waitFor(() => {
      expect(
        screen.getByText("No activity in the last 7 days"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByText("Showing activity from the last 7 days"),
    ).toBeInTheDocument();
  });

  it("renders events newest-first when expanded", async () => {
    const older = makeEvent({
      id: "e-old",
      occurredAt: "2026-04-14T10:00:00",
      transition: "unblocked",
    });
    const newer = makeEvent({
      id: "e-new",
      occurredAt: "2026-04-15T21:00:00",
      transition: "blocked",
    });
    // Deliberately provide in reverse chronological order to prove sorting.
    mockEndpoints([older, newer]);
    renderFeed();
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    await waitFor(() => {
      expect(screen.getAllByRole("listitem").length).toBe(2);
    });
    const items = screen.getAllByRole("listitem").map((el) => el.textContent);
    expect(items[0]).toMatch(/blocked/);
    expect(items[1]).toMatch(/unblocked/);
  });
});
