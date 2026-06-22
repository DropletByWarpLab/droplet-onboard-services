/**
 * RoutinesSection — empty state + run-outcome toast copy.
 *
 * Pins the three user-facing branches the component owns: the "No routines yet"
 * empty card, the full-success vs partial-success run toast wording, and the
 * thrown-error failure toast. Running is confirm-gated, so each run clicks
 * through the ConfirmDialog.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("framer-motion", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("framer-motion");
  return { ...actual, useReducedMotion: () => true };
});

vi.mock("@/lib/api", () => ({
  runScene: vi.fn(),
  deleteScene: vi.fn(),
}));

// Stub the editor so author-mode tests don't pull in useSmartHome / the Dialog.
vi.mock("../SceneEditorModal", () => ({
  SceneEditorModal: ({ mode }: { mode: string }) => (
    <div data-testid="scene-editor">{mode}</div>
  ),
}));

import { runScene, deleteScene, type Scene } from "@/lib/api";
import { RoutinesSection } from "../RoutinesSection";

function scene(over: Partial<Scene> = {}): Scene {
  return {
    id: "s1",
    name: "Good night",
    icon: null,
    createdBy: null,
    createdAt: "",
    updatedAt: "",
    actionCount: 3,
    ...over,
  };
}

async function clickRunThenConfirm(label: RegExp) {
  fireEvent.click(screen.getByRole("button", { name: label }));
  fireEvent.click(await screen.findByRole("button", { name: "Run" }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("RoutinesSection", () => {
  it("renders the empty state with no routines", () => {
    render(<RoutinesSection scenes={[]} />);
    expect(screen.getByText("No routines yet")).toBeTruthy();
  });

  it("lists routines with a run button", () => {
    render(<RoutinesSection scenes={[scene({ name: "Good night" })]} />);
    expect(screen.getByText("Good night")).toBeTruthy();
    expect(screen.getByRole("button", { name: /run good night/i })).toBeTruthy();
  });

  it("full-success run shows the 'ran' toast", async () => {
    (runScene as ReturnType<typeof vi.fn>).mockResolvedValue({
      sceneId: "s1", successCount: 3, actionCount: 3, results: [],
    });
    render(<RoutinesSection scenes={[scene({ name: "Good night", actionCount: 3 })]} />);
    await clickRunThenConfirm(/run good night/i);
    await waitFor(() => expect(screen.getByText(/ran[\s\S]*3 actions/i)).toBeTruthy());
  });

  it("partial-success run shows the 'ran with issues' toast", async () => {
    (runScene as ReturnType<typeof vi.fn>).mockResolvedValue({
      sceneId: "s1", successCount: 1, actionCount: 3, results: [],
    });
    render(<RoutinesSection scenes={[scene({ name: "Movie", actionCount: 3 })]} />);
    await clickRunThenConfirm(/run movie/i);
    await waitFor(() =>
      expect(screen.getByText(/ran with issues[\s\S]*1 of 3 succeeded/i)).toBeTruthy(),
    );
  });

  it("a thrown error shows the failure toast", async () => {
    (runScene as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    render(<RoutinesSection scenes={[scene({ name: "Movie" })]} />);
    await clickRunThenConfirm(/run movie/i);
    await waitFor(() => expect(screen.getByText("boom")).toBeTruthy());
  });
});

describe("RoutinesSection — author mode (owner/admin)", () => {
  it("hides author affordances when canAuthor is false (default)", () => {
    render(<RoutinesSection scenes={[scene()]} />);
    expect(screen.queryByRole("button", { name: /new routine/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /edit good night/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /delete good night/i })).toBeNull();
  });

  it("shows New / Edit / Delete when canAuthor", () => {
    render(<RoutinesSection scenes={[scene()]} canAuthor />);
    expect(screen.getByRole("button", { name: /new routine/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /edit good night/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /delete good night/i })).toBeTruthy();
  });

  it("opens the editor in create mode from the empty state", () => {
    render(<RoutinesSection scenes={[]} canAuthor />);
    fireEvent.click(screen.getByRole("button", { name: /create your first routine/i }));
    expect(screen.getByTestId("scene-editor").textContent).toBe("create");
  });

  it("deletes a routine after confirm and notifies the parent", async () => {
    (deleteScene as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const onChanged = vi.fn();
    render(<RoutinesSection scenes={[scene({ name: "Movie" })]} canAuthor onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: /delete movie/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteScene).toHaveBeenCalledWith("s1"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });
});
