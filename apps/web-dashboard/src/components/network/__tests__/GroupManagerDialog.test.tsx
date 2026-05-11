import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { GroupManagerDialog } from "../GroupManagerDialog";
import type { DeviceGroupWithCount } from "@/lib/types";

type FetchMock = ReturnType<typeof vi.fn>;

function makeGroup(overrides: Partial<DeviceGroupWithCount> = {}): DeviceGroupWithCount {
  return {
    id: "g1",
    name: "Office",
    color: null,
    icon: null,
    _count: { devices: 3 },
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

function renderDialog(onClose = () => {}) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <GroupManagerDialog open={true} onClose={onClose} />
    </SWRConfig>,
  );
}

describe("GroupManagerDialog", () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // WARP-289: full modal ARIA via the shared <Dialog> primitive.
  it("renders as a role=dialog with aria-modal and aria-labelledby", async () => {
    mockFetchOnceJson(fetchMock, { groups: [] });
    renderDialog();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const labelledBy = dialog.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    const heading = document.getElementById(labelledBy!);
    expect(heading).not.toBeNull();
    expect(heading!.textContent).toMatch(/Manage groups/);
  });

  it("renders the list of groups with member count", async () => {
    mockFetchOnceJson(fetchMock, {
      groups: [
        makeGroup({ id: "g1", name: "Office", _count: { devices: 3 } }),
        makeGroup({ id: "g2", name: "Kids", _count: { devices: 1 } }),
      ],
    });
    renderDialog();

    await screen.findByLabelText("Rename Office");
    expect(screen.getByLabelText("Rename Kids")).toBeInTheDocument();
    expect(screen.getByText("3 devices")).toBeInTheDocument();
    expect(screen.getByText("1 device")).toBeInTheDocument();
  });

  it("creates a group: typing name + Enter POSTs /api/network/groups", async () => {
    mockFetchOnceJson(fetchMock, { groups: [] });
    renderDialog();

    const input = (await screen.findByLabelText("New group name")) as HTMLInputElement;

    // POST create → returns the created group, then SWR revalidates the list.
    mockFetchOnceJson(fetchMock, { id: "new-1", name: "Cameras" });
    mockFetchOnceJson(fetchMock, { groups: [] });

    fireEvent.change(input, { target: { value: "Cameras" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      const postCalls = fetchMock.mock.calls.filter(
        (c) => c[0] === "/api/network/groups" && c[1]?.method === "POST",
      );
      expect(postCalls).toHaveLength(1);
      expect(JSON.parse(postCalls[0][1].body)).toEqual({ name: "Cameras" });
    });
  });

  it("renames a group: blur on name input PATCHes /api/network/groups/:id", async () => {
    mockFetchOnceJson(fetchMock, {
      groups: [makeGroup({ id: "g1", name: "Office" })],
    });
    renderDialog();

    const input = (await screen.findByLabelText("Rename Office")) as HTMLInputElement;

    mockFetchOnceJson(fetchMock, {});

    fireEvent.change(input, { target: { value: "Home Office" } });
    fireEvent.blur(input);

    await waitFor(() => {
      const patchCalls = fetchMock.mock.calls.filter((c) => c[1]?.method === "PATCH");
      expect(patchCalls).toHaveLength(1);
      expect(patchCalls[0][0]).toBe("/api/network/groups/g1");
      expect(JSON.parse(patchCalls[0][1].body)).toEqual({ name: "Home Office" });
    });
  });

  it("deletes with inline confirm: Delete → Yes → DELETE /api/network/groups/:id", async () => {
    mockFetchOnceJson(fetchMock, {
      groups: [makeGroup({ id: "g1", name: "Office", _count: { devices: 2 } })],
    });
    renderDialog();

    await screen.findByLabelText("Rename Office");
    fireEvent.click(screen.getByRole("button", { name: "Delete Office" }));

    const yes = await screen.findByRole("button", { name: "Yes" });
    expect(screen.getByText("2 ungrouped. Delete?")).toBeInTheDocument();

    mockFetchOnceJson(fetchMock, {});
    fireEvent.click(yes);

    await waitFor(() => {
      const deleteCalls = fetchMock.mock.calls.filter((c) => c[1]?.method === "DELETE");
      expect(deleteCalls).toHaveLength(1);
      expect(deleteCalls[0][0]).toBe("/api/network/groups/g1");
    });
  });

  it("shows friendly toast and stays open on DUPLICATE_GROUP_NAME", async () => {
    mockFetchOnceJson(fetchMock, { groups: [] });
    const onClose = vi.fn();
    renderDialog(onClose);

    const input = (await screen.findByLabelText("New group name")) as HTMLInputElement;

    mockFetchOnceJson(
      fetchMock,
      { error: { code: "DUPLICATE_GROUP_NAME", message: "duplicate" } },
      false,
      409,
    );

    fireEvent.change(input, { target: { value: "Office" } });
    fireEvent.keyDown(input, { key: "Enter" });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("A group with that name already exists");
    expect(onClose).not.toHaveBeenCalled();
    // Dialog is still in the DOM.
    expect(screen.getByRole("dialog", { name: "Manage groups" })).toBeInTheDocument();
  });
});
