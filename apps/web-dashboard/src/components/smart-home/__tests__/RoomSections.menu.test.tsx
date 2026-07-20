/**
 * WARP-1396 — the room options menu.
 *
 * Pins that "Rename room" and "Choose icon" open DIFFERENT faces of the room
 * dialog. Both entries once shared the same `onRename` handler, so picking an
 * icon dropped the user into the rename dialog instead.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RoomSections } from "../RoomSections";
import type { RoomLayout } from "../rooms-model";

const room = { id: "r1", name: "Kitchen", icon: "chef-hat", sortOrder: 1, deviceCount: 0 };
const layout: RoomLayout = { rooms: [{ room, devices: [] }], unassigned: [] };

const actions = {
  create: vi.fn().mockResolvedValue({}),
  rename: vi.fn().mockResolvedValue({}),
  remove: vi.fn().mockResolvedValue({}),
};

function renderSections() {
  return render(
    <RoomSections
      layout={layout}
      showNudge={false}
      onCommand={vi.fn()}
      onDeviceClick={vi.fn()}
      onBulkLights={vi.fn()}
      actions={actions}
    />,
  );
}

/** Open the room's "..." menu and click one of its entries. */
function openMenuItem(label: string) {
  fireEvent.click(screen.getByRole("button", { name: "Kitchen options" }));
  fireEvent.click(screen.getByRole("menuitem", { name: label }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("room options menu (WARP-1396)", () => {
  it("'Rename room' opens the rename dialog with the name field", () => {
    renderSections();
    openMenuItem("Rename room");
    expect(screen.getByRole("heading", { name: "Rename room" })).toBeInTheDocument();
    expect(screen.getByLabelText("Room name")).toHaveValue("Kitchen");
  });

  it("'Choose icon' opens the icon picker, NOT the rename dialog", () => {
    renderSections();
    openMenuItem("Choose icon");
    expect(screen.getByRole("heading", { name: "Choose icon" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Rename room" })).not.toBeInTheDocument();
    // Icon-only mode drops the name field entirely.
    expect(screen.queryByLabelText("Room name")).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Room icon" })).toBeInTheDocument();
  });

  it("saving from the icon picker keeps the room's existing name", async () => {
    renderSections();
    openMenuItem("Choose icon");
    fireEvent.click(screen.getByRole("button", { name: "Bedroom" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() =>
      expect(actions.rename).toHaveBeenCalledWith("r1", { name: "Kitchen", icon: "bed" }),
    );
  });
});
