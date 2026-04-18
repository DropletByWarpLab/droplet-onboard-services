import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { GroupRow } from "../GroupRow";
import type { DeviceGroupWithCount, Schedule } from "@/lib/types";

type FetchMock = ReturnType<typeof vi.fn>;

function makeGroup(overrides: Partial<DeviceGroupWithCount> = {}): DeviceGroupWithCount {
  return {
    id: "g1",
    name: "Kids",
    color: null,
    icon: null,
    _count: { devices: 3 },
    ...overrides,
  };
}

function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: "s1",
    name: "Bedtime",
    enabled: true,
    subjectType: "group",
    groupId: "g1",
    windows: [{ id: "w1", daysOfWeek: 127, startMin: 21 * 60, endMin: 7 * 60 }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function renderRow(
  group: DeviceGroupWithCount,
  onRename = vi.fn(),
  onDelete = vi.fn(),
) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ul>
        <GroupRow group={group} onRename={onRename} onDelete={onDelete} />
      </ul>
    </SWRConfig>,
  );
}

describe("GroupRow", () => {
  let fetchMock: FetchMock;
  let schedulesResponse: Schedule[];

  beforeEach(() => {
    schedulesResponse = [];
    fetchMock = vi.fn();
    fetchMock.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.startsWith("/api/network/schedules")) {
        return { ok: true, status: 200, json: async () => ({ schedules: schedulesResponse }) };
      }
      if (typeof url === "string" && url.startsWith("/api/network/devices")) {
        return { ok: true, status: 200, json: async () => ({ devices: [] }) };
      }
      if (typeof url === "string" && url.startsWith("/api/network/groups")) {
        return { ok: true, status: 200, json: async () => ({ groups: [] }) };
      }
      return { ok: false, status: 500, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the group name + device count", () => {
    renderRow(makeGroup({ name: "Office", _count: { devices: 5 } }));
    expect(screen.getByLabelText("Rename Office")).toBeInTheDocument();
    expect(screen.getByText("5 devices")).toBeInTheDocument();
  });

  it("calls onRename on blur when name changes", async () => {
    const onRename = vi.fn();
    renderRow(makeGroup({ id: "g1", name: "Kids" }), onRename);
    const input = screen.getByLabelText("Rename Kids") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Children" } });
    fireEvent.blur(input);
    await waitFor(() => {
      expect(onRename).toHaveBeenCalledWith("g1", { name: "Children" });
    });
  });

  it("renders inline delete-confirm flow", async () => {
    const onDelete = vi.fn();
    renderRow(makeGroup({ id: "g1", name: "Kids", _count: { devices: 2 } }), vi.fn(), onDelete);
    fireEvent.click(screen.getByRole("button", { name: "Delete Kids" }));
    expect(await screen.findByText("2 ungrouped. Delete?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith("g1"));
  });

  it("calls onRename when clicking a color swatch", async () => {
    const onRename = vi.fn();
    renderRow(makeGroup({ id: "g1", name: "Kids" }), onRename);
    fireEvent.click(screen.getByLabelText("Color #22c55e"));
    await waitFor(() => {
      expect(onRename).toHaveBeenCalledWith("g1", { color: "#22c55e" });
    });
  });

  it("renders '0 schedules' summary when no schedules apply to the group", async () => {
    renderRow(makeGroup({ id: "g1", name: "Kids" }));
    await waitFor(() => {
      expect(screen.getByText("0 schedules")).toBeInTheDocument();
    });
  });

  it("renders first schedule name + enabled state in the summary", async () => {
    schedulesResponse = [
      makeSchedule({ id: "s1", name: "Bedtime", enabled: true, groupId: "g1" }),
    ];
    renderRow(makeGroup({ id: "g1", name: "Kids" }));
    await waitFor(() => {
      expect(screen.getByText("Bedtime (enabled)")).toBeInTheDocument();
    });
  });

  it("renders '+N more' when the group has multiple schedules", async () => {
    schedulesResponse = [
      makeSchedule({ id: "s1", name: "Bedtime", groupId: "g1" }),
      makeSchedule({ id: "s2", name: "School hours", groupId: "g1" }),
      makeSchedule({ id: "s3", name: "Homework", groupId: "g1" }),
    ];
    renderRow(makeGroup({ id: "g1", name: "Kids" }));
    await waitFor(() => {
      expect(screen.getByText(/Bedtime \(enabled\) · \+2 more/)).toBeInTheDocument();
    });
  });

  it("renders a Quick Schedule button scoped to the group", () => {
    renderRow(makeGroup({ id: "g1", name: "Kids" }));
    expect(
      screen.getByRole("button", { name: "Quick schedule for Kids" }),
    ).toBeInTheDocument();
  });
});
