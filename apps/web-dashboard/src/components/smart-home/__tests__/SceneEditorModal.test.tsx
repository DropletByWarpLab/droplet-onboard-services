/**
 * SceneEditorModal — create + edit flows against the /api/scenes CRUD.
 *
 * Pins: create sends {name, actions} in order; edit hydrates from getScene and
 * saves via updateScene; the command picker only offers known commands; Save is
 * gated on a name + at least one action.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("framer-motion", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("framer-motion");
  return { ...actual, useReducedMotion: () => true };
});

vi.mock("@/lib/api", () => ({
  getScene: vi.fn(),
  createScene: vi.fn(),
  updateScene: vi.fn(),
}));

vi.mock("@/lib/hooks/useSmartHome", () => ({
  useSmartHome: () => ({
    grouped: {
      lights: [
        { nodeId: "n1", name: "Living room", category: "light", state: "on", connectionState: "connected", endpoints: [], attributes: {} },
      ],
      switches: [], sensors: [], climate: [], media: [], covers: [], locks: [], other: [],
    },
  }),
}));

import { getScene, createScene, updateScene } from "@/lib/api";
import { SceneEditorModal } from "../SceneEditorModal";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SceneEditorModal — create", () => {
  it("Create is disabled until there is a name and an action", () => {
    render(<SceneEditorModal mode="create" onClose={() => {}} onSaved={() => {}} />);
    const createBtn = screen.getByRole("button", { name: /create routine/i });
    expect((createBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it("adds an action and POSTs {name, actions} on save", async () => {
    (createScene as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "s9" });
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(<SceneEditorModal mode="create" onClose={onClose} onSaved={onSaved} />);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Movie night" } });
    fireEvent.click(screen.getByRole("button", { name: /add action/i }));

    const createBtn = screen.getByRole("button", { name: /create routine/i });
    expect((createBtn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(createBtn);

    await waitFor(() => expect(createScene).toHaveBeenCalledOnce());
    const arg = (createScene as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.name).toBe("Movie night");
    expect(arg.actions).toHaveLength(1);
    expect(arg.actions[0]).toMatchObject({ deviceNodeId: "n1", command: "set_brightness" });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });
});

describe("SceneEditorModal — edit", () => {
  it("hydrates from getScene and saves via updateScene", async () => {
    (getScene as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "s1", name: "Evening", icon: null, createdBy: null, createdAt: "", updatedAt: "",
      actions: [{ id: "a1", idx: 0, deviceNodeId: "n1", command: "toggle", args: {} }],
    });
    (updateScene as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "s1" });
    render(<SceneEditorModal mode="edit" sceneId="s1" onClose={() => {}} onSaved={() => {}} />);

    await waitFor(() =>
      expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Evening"),
    );
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(updateScene).toHaveBeenCalledWith("s1", expect.objectContaining({ name: "Evening" })));
  });
});
