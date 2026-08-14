/**
 * WARP-1906 — Settings → "Locations" card (premade buildings + conference
 * rooms that feed the event-form Location suggestions).
 *
 * The states this pins:
 *   - loads GET /api/workspace-locations and renders one row per room with
 *     the canonical label;
 *   - Add: two inputs (Building, Room) → createWorkspaceLocation, the new
 *     row appears, inputs clear, toast;
 *   - a failed add shows the error line and KEEPS the typed values
 *     (never-lose-edits, §7.9);
 *   - Edit: inline rename → updateWorkspaceLocation, row re-renders;
 *   - Remove: deleteWorkspaceLocation, row disappears, toast;
 *   - lesser roles render nothing — Settings is an admin surface (§6.3).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const fetchWorkspaceLocations = vi.fn();
const createWorkspaceLocation = vi.fn();
const updateWorkspaceLocation = vi.fn();
const deleteWorkspaceLocation = vi.fn();
vi.mock("@/lib/api", () => ({
  fetchWorkspaceLocations: (...a: unknown[]) => fetchWorkspaceLocations(...a),
  createWorkspaceLocation: (...a: unknown[]) => createWorkspaceLocation(...a),
  updateWorkspaceLocation: (...a: unknown[]) => updateWorkspaceLocation(...a),
  deleteWorkspaceLocation: (...a: unknown[]) => deleteWorkspaceLocation(...a),
}));

let mockRole: string | undefined = "owner";
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { id: "u1", username: "stefan@warp-lab.ai", role: mockRole },
  }),
}));

const toast = vi.fn();
vi.mock("@/components/Toast", () => ({
  useToast: () => ({ toast }),
}));

import { LocationsCard } from "./LocationsCard";

function loc(over: Record<string, unknown> = {}) {
  return {
    id: "loc-1",
    building: "HQ",
    room: "Room Aurora",
    label: "HQ - Room Aurora",
    createdAt: "2026-08-12T00:00:00Z",
    updatedAt: "2026-08-12T00:00:00Z",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRole = "owner";
  fetchWorkspaceLocations.mockResolvedValue([
    loc(),
    loc({ id: "loc-2", room: "Fishbowl", label: "HQ - Fishbowl" }),
  ]);
});

describe("LocationsCard (WARP-1906)", () => {
  it("loads and renders one row per room with the canonical label", async () => {
    render(<LocationsCard />);
    await screen.findByText("HQ - Room Aurora");
    expect(screen.getByText("HQ - Fishbowl")).toBeInTheDocument();
  });

  it("shows the empty state when no locations exist yet", async () => {
    fetchWorkspaceLocations.mockResolvedValue([]);
    render(<LocationsCard />);
    await screen.findByText(
      "No locations yet. Add a building and a room to suggest them when someone schedules an event.",
    );
  });

  it("adds a room — calls the API, appends the row, clears the inputs, toasts", async () => {
    createWorkspaceLocation.mockResolvedValue(
      loc({ id: "loc-3", building: "2nd Floor", room: "Boardroom", label: "2nd Floor - Boardroom" }),
    );
    render(<LocationsCard />);
    await screen.findByText("HQ - Room Aurora");

    const building = screen.getByLabelText("Building");
    const room = screen.getByLabelText("Room");
    fireEvent.change(building, { target: { value: "2nd Floor" } });
    fireEvent.change(room, { target: { value: "Boardroom" } });
    fireEvent.click(screen.getByRole("button", { name: "Add location" }));

    await waitFor(() =>
      expect(createWorkspaceLocation).toHaveBeenCalledWith({
        building: "2nd Floor",
        room: "Boardroom",
      }),
    );
    expect(await screen.findByText("2nd Floor - Boardroom")).toBeInTheDocument();
    expect((building as HTMLInputElement).value).toBe("");
    expect((room as HTMLInputElement).value).toBe("");
    expect(toast).toHaveBeenCalledWith("Location added", "success");
  });

  it("keeps the typed values and shows the error line when the add fails", async () => {
    createWorkspaceLocation.mockRejectedValueOnce(new Error("dup"));
    render(<LocationsCard />);
    await screen.findByText("HQ - Room Aurora");

    const building = screen.getByLabelText("Building");
    const room = screen.getByLabelText("Room");
    fireEvent.change(building, { target: { value: "HQ" } });
    fireEvent.change(room, { target: { value: "Room Aurora" } });
    fireEvent.click(screen.getByRole("button", { name: "Add location" }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect((building as HTMLInputElement).value).toBe("HQ");
    expect((room as HTMLInputElement).value).toBe("Room Aurora");
    expect(toast).not.toHaveBeenCalled();
  });

  it("renames a room inline via updateWorkspaceLocation", async () => {
    updateWorkspaceLocation.mockResolvedValue(
      loc({ room: "War Room", label: "HQ - War Room" }),
    );
    render(<LocationsCard />);
    await screen.findByText("HQ - Room Aurora");

    fireEvent.click(
      screen.getByRole("button", { name: "Edit HQ - Room Aurora" }),
    );
    const roomInput = screen.getByLabelText("Edit room");
    fireEvent.change(roomInput, { target: { value: "War Room" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(updateWorkspaceLocation).toHaveBeenCalledWith("loc-1", {
        building: "HQ",
        room: "War Room",
      }),
    );
    expect(await screen.findByText("HQ - War Room")).toBeInTheDocument();
    expect(toast).toHaveBeenCalledWith("Location updated", "success");
  });

  it("removes a room and drops the row", async () => {
    deleteWorkspaceLocation.mockResolvedValue(undefined);
    render(<LocationsCard />);
    await screen.findByText("HQ - Room Aurora");

    fireEvent.click(
      screen.getByRole("button", { name: "Remove HQ - Room Aurora" }),
    );
    await waitFor(() =>
      expect(deleteWorkspaceLocation).toHaveBeenCalledWith("loc-1"),
    );
    await waitFor(() =>
      expect(screen.queryByText("HQ - Room Aurora")).not.toBeInTheDocument(),
    );
    expect(toast).toHaveBeenCalledWith("Location removed", "success");
  });

  it("renders nothing for family/guest", () => {
    mockRole = "family";
    const { container } = render(<LocationsCard />);
    expect(container).toBeEmptyDOMElement();
    expect(fetchWorkspaceLocations).not.toHaveBeenCalled();
  });
});
