import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { GroupTypeahead } from "../GroupTypeahead";
import type { DeviceGroupWithCount } from "@/lib/types";

type FetchMock = ReturnType<typeof vi.fn>;

const MAC = "aa:bb:cc:dd:ee:01";

function makeGroup(overrides: Partial<DeviceGroupWithCount> = {}): DeviceGroupWithCount {
  return {
    id: "g1",
    name: "Office",
    color: null,
    icon: null,
    _count: { devices: 0 },
    ...overrides,
  };
}

function mockFetchOnceJson(mock: FetchMock, body: unknown, ok = true, status = 200) {
  mock.mockImplementationOnce(async () => ({
    ok,
    status,
    json: async () => body,
  }));
}

function renderTypeahead(currentGroups: Array<{ id: string; name: string }> = []) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <GroupTypeahead mac={MAC} currentGroups={currentGroups} />
    </SWRConfig>,
  );
}

describe("GroupTypeahead", () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders no listbox when input is empty", async () => {
    mockFetchOnceJson(fetchMock, {
      groups: [makeGroup({ id: "g1", name: "Office" })],
    });
    renderTypeahead();

    await screen.findByLabelText("Add to group");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("shows matching groups when typing a known prefix", async () => {
    mockFetchOnceJson(fetchMock, {
      groups: [
        makeGroup({ id: "g1", name: "Office" }),
        makeGroup({ id: "g2", name: "Outdoor Cams" }),
        makeGroup({ id: "g3", name: "Kids" }),
      ],
    });
    renderTypeahead();

    const input = (await screen.findByLabelText("Add to group")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "O" } });

    const listbox = await screen.findByRole("listbox");
    expect(listbox).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Office" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Outdoor Cams" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Kids" })).not.toBeInTheDocument();
  });

  it("clicking an existing option POSTs /api/network/devices/:mac/groups with merged ids", async () => {
    mockFetchOnceJson(fetchMock, {
      groups: [
        makeGroup({ id: "g1", name: "Office" }),
        makeGroup({ id: "g2", name: "Cameras" }),
      ],
    });
    renderTypeahead([{ id: "g1", name: "Office" }]);

    const input = (await screen.findByLabelText("Add to group")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Cam" } });

    const option = await screen.findByRole("button", { name: "Cameras" });

    mockFetchOnceJson(fetchMock, {});
    fireEvent.click(option);

    await waitFor(() => {
      const postCalls = fetchMock.mock.calls.filter(
        (c) =>
          typeof c[0] === "string" &&
          c[0].includes("/api/network/devices/") &&
          c[0].endsWith("/groups") &&
          c[1]?.method === "POST",
      );
      expect(postCalls).toHaveLength(1);
      expect(JSON.parse(postCalls[0][1].body)).toEqual({ groupIds: ["g1", "g2"] });
    });
  });

  it("shows 'Create <name>' when the typed name does not match any group", async () => {
    mockFetchOnceJson(fetchMock, {
      groups: [makeGroup({ id: "g1", name: "Office" })],
    });
    renderTypeahead();

    const input = (await screen.findByLabelText("Add to group")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Garage" } });

    const createBtn = await screen.findByRole("button", { name: /Create .Garage./ });
    expect(createBtn).toBeInTheDocument();
  });

  it("ArrowDown + Enter picks the highlighted existing group", async () => {
    mockFetchOnceJson(fetchMock, {
      groups: [
        makeGroup({ id: "g1", name: "Living Room" }),
        makeGroup({ id: "g2", name: "Office" }),
      ],
    });
    renderTypeahead();

    const input = (await screen.findByLabelText("Add to group")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "r" } });

    // Both "Living Room" and "Office" (via "r" in... wait, "Office" has no r).
    // "r" only matches "Living Room". Wait for the listbox to render.
    await screen.findByRole("button", { name: "Living Room" });

    fireEvent.keyDown(input, { key: "ArrowDown" });

    await waitFor(() => {
      expect(input.getAttribute("aria-activedescendant")).toBe("gt-opt-0");
    });
    const firstOption = document.getElementById("gt-opt-0");
    expect(firstOption?.getAttribute("aria-selected")).toBe("true");

    mockFetchOnceJson(fetchMock, {});
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      const postCalls = fetchMock.mock.calls.filter(
        (c) =>
          typeof c[0] === "string" &&
          c[0].includes("/api/network/devices/") &&
          c[0].endsWith("/groups") &&
          c[1]?.method === "POST",
      );
      expect(postCalls).toHaveLength(1);
      expect(JSON.parse(postCalls[0][1].body)).toEqual({ groupIds: ["g1"] });
    });
  });

  it("Enter on highlighted Create option creates group then assigns", async () => {
    mockFetchOnceJson(fetchMock, { groups: [] });
    renderTypeahead();

    const input = (await screen.findByLabelText("Add to group")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Lab" } });

    // Wait for the Create option to render.
    await screen.findByRole("button", { name: /Create .Lab./ });

    fireEvent.keyDown(input, { key: "ArrowDown" });

    await waitFor(() => {
      expect(input.getAttribute("aria-activedescendant")).toBe("gt-opt-0");
    });

    mockFetchOnceJson(fetchMock, { id: "new-lab", name: "Lab" });
    mockFetchOnceJson(fetchMock, {});

    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      const createCall = fetchMock.mock.calls.find(
        (c) => c[0] === "/api/network/groups" && c[1]?.method === "POST",
      );
      expect(createCall).toBeTruthy();
      expect(JSON.parse(createCall![1].body)).toEqual({ name: "Lab" });

      const assignCall = fetchMock.mock.calls.find(
        (c) =>
          typeof c[0] === "string" &&
          c[0].includes("/api/network/devices/") &&
          c[0].endsWith("/groups") &&
          c[1]?.method === "POST",
      );
      expect(assignCall).toBeTruthy();
      expect(JSON.parse(assignCall![1].body)).toEqual({ groupIds: ["new-lab"] });
    });
  });

  it("clicking Create POSTs /api/network/groups then POSTs device/:mac/groups", async () => {
    mockFetchOnceJson(fetchMock, { groups: [] });
    renderTypeahead();

    const input = (await screen.findByLabelText("Add to group")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Lab" } });

    const createBtn = await screen.findByRole("button", { name: /Create .Lab./ });

    // 1) POST create-group → returns the new group.
    mockFetchOnceJson(fetchMock, { id: "new-lab", name: "Lab" });
    // 2) POST assign device to the new group.
    mockFetchOnceJson(fetchMock, {});

    fireEvent.click(createBtn);

    await waitFor(() => {
      const createCall = fetchMock.mock.calls.find(
        (c) => c[0] === "/api/network/groups" && c[1]?.method === "POST",
      );
      expect(createCall).toBeTruthy();
      expect(JSON.parse(createCall![1].body)).toEqual({ name: "Lab" });

      const assignCall = fetchMock.mock.calls.find(
        (c) =>
          typeof c[0] === "string" &&
          c[0].includes("/api/network/devices/") &&
          c[0].endsWith("/groups") &&
          c[1]?.method === "POST",
      );
      expect(assignCall).toBeTruthy();
      expect(JSON.parse(assignCall![1].body)).toEqual({ groupIds: ["new-lab"] });
    });
  });
});
