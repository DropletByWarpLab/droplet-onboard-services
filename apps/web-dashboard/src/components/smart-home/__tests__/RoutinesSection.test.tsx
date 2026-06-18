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
}));

import { runScene, type Scene } from "@/lib/api";
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
