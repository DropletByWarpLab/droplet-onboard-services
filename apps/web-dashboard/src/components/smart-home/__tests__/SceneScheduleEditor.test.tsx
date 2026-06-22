/**
 * SceneScheduleEditor — schedule a routine on a recurring cadence.
 *
 * Pins the load-bearing behaviour:
 *   - lists existing schedules (with their local-time summary)
 *   - the empty state invites adding the first schedule
 *   - creating sends a UTC RRULE built from the chosen day chips + local time
 *   - the UI states it converts to UTC (rrule.ts is UTC-only)
 *   - toggling enabled + deleting call through
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

vi.mock("framer-motion", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("framer-motion");
  return { ...actual, useReducedMotion: () => true };
});

const hookState = {
  schedules: [] as Array<{
    id: string; sceneId: string; rrule: string; nextFireAt: string;
    enabled: boolean; createdBy: string | null; lastFiredAt: string | null;
    createdAt: string; updatedAt: string;
  }>,
  isLoading: false,
  error: undefined as unknown,
  create: vi.fn().mockResolvedValue({ id: "new" }),
  toggle: vi.fn().mockResolvedValue({ id: "s1" }),
  remove: vi.fn().mockResolvedValue(undefined),
  refresh: vi.fn(),
};

vi.mock("@/lib/hooks/useSceneSchedules", () => ({
  useSceneSchedules: () => hookState,
}));

import { SceneScheduleEditor } from "../SceneScheduleEditor";

function sched(over: Partial<(typeof hookState)["schedules"][number]> = {}) {
  return {
    id: "s1", sceneId: "scene-1", rrule: "FREQ=DAILY;BYHOUR=7;BYMINUTE=0",
    nextFireAt: "2026-06-20T07:00:00.000Z", enabled: true,
    createdBy: "stefan", lastFiredAt: null,
    createdAt: "2026-06-19T00:00:00.000Z", updatedAt: "2026-06-19T00:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  hookState.schedules = [];
  hookState.isLoading = false;
  hookState.error = undefined;
  vi.clearAllMocks();
});

describe("SceneScheduleEditor", () => {
  it("shows an empty state when the routine has no schedules", () => {
    render(
      <SceneScheduleEditor sceneId="scene-1" sceneName="Good night" onClose={() => {}} />,
    );
    expect(screen.getByText(/no schedules yet/i)).toBeTruthy();
  });

  it("lists an existing schedule with an enable toggle and a delete control", () => {
    hookState.schedules = [sched()];
    render(
      <SceneScheduleEditor sceneId="scene-1" sceneName="Good night" onClose={() => {}} />,
    );
    expect(screen.getByRole("switch")).toBeTruthy();
    expect(screen.getByRole("button", { name: /remove schedule/i })).toBeTruthy();
  });

  it("states that the chosen time is converted to UTC (the UTC-only trap)", () => {
    render(
      <SceneScheduleEditor sceneId="scene-1" sceneName="Good night" onClose={() => {}} />,
    );
    // Match the honesty copy specifically — a plain /utc/i is ambiguous when the
    // runner's own timezone label is literally "UTC" (CI), which renders a second
    // "UTC" in the "shown in <tz>" line.
    expect(screen.getByText(/saved in utc/i)).toBeTruthy();
  });

  it("creates a schedule with a UTC RRULE built from the time field", async () => {
    render(
      <SceneScheduleEditor sceneId="scene-1" sceneName="Good night" onClose={() => {}} />,
    );
    // Pick 07:00 local; leave the default (every day) selection.
    fireEvent.change(screen.getByLabelText(/time/i), { target: { value: "07:00" } });
    fireEvent.click(screen.getByRole("button", { name: /add schedule/i }));
    await waitFor(() => expect(hookState.create).toHaveBeenCalledTimes(1));
    const rrule = hookState.create.mock.calls[0][0] as string;
    // UTC-converted: contains BYHOUR/BYMINUTE and a supported FREQ.
    expect(rrule).toMatch(/^FREQ=(DAILY|WEEKLY);/);
    expect(rrule).toMatch(/BYHOUR=\d+/);
    expect(rrule).toMatch(/BYMINUTE=0/);
  });

  it("builds a WEEKLY rrule when specific day chips are selected", async () => {
    render(
      <SceneScheduleEditor sceneId="scene-1" sceneName="Good night" onClose={() => {}} />,
    );
    fireEvent.change(screen.getByLabelText(/time/i), { target: { value: "08:00" } });
    // Deselect "every day", then pick Monday only.
    fireEvent.click(screen.getByRole("button", { name: /^mon$/i }));
    fireEvent.click(screen.getByRole("button", { name: /add schedule/i }));
    await waitFor(() => expect(hookState.create).toHaveBeenCalled());
    const rrule = hookState.create.mock.calls[0][0] as string;
    expect(rrule.startsWith("FREQ=WEEKLY;")).toBe(true);
    expect(rrule).toMatch(/BYDAY=/);
  });

  it("toggling a schedule's switch calls toggle()", async () => {
    hookState.schedules = [sched({ enabled: true })];
    render(
      <SceneScheduleEditor sceneId="scene-1" sceneName="Good night" onClose={() => {}} />,
    );
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(hookState.toggle).toHaveBeenCalledWith("s1", false));
  });

  it("removing a schedule calls remove()", async () => {
    hookState.schedules = [sched()];
    render(
      <SceneScheduleEditor sceneId="scene-1" sceneName="Good night" onClose={() => {}} />,
    );
    const row = screen.getByRole("button", { name: /remove schedule/i });
    fireEvent.click(row);
    await waitFor(() => expect(hookState.remove).toHaveBeenCalledWith("s1"));
  });
});
