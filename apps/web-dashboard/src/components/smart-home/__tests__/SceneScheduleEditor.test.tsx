/**
 * SceneScheduleEditor — schedule a routine on a recurring cadence.
 *
 * Pins the load-bearing behaviour:
 *   - lists existing schedules (with their local-time summary)
 *   - the empty state invites adding the first schedule
 *   - creating sends a wall-clock RRULE + the browser's IANA timezone
 *     (KAN-6), built from the chosen day chips + local time
 *   - the UI names the timezone WITHOUT the old DST caveat (KAN-6 fixed it)
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
    id: string; sceneId: string; rrule: string; timezone: string;
    nextFireAt: string;
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
    timezone: "America/Los_Angeles",
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

  it("names the local timezone WITHOUT the old daylight-saving caveat (KAN-6)", () => {
    render(
      <SceneScheduleEditor sceneId="scene-1" sceneName="Good night" onClose={() => {}} />,
    );
    // The confident copy frames it as the owner's local time…
    expect(screen.getByText(/your local time/i)).toBeTruthy();
    // …and the stopgap UTC/DST caveat is GONE — the per-row zone fixed it.
    expect(screen.queryByText(/saved in utc/i)).toBeNull();
    expect(screen.queryByText(/daylight-saving/i)).toBeNull();
    expect(screen.queryByText(/shift by an hour/i)).toBeNull();
  });

  it("creates a schedule with a wall-clock RRULE + the browser timezone (KAN-6)", async () => {
    render(
      <SceneScheduleEditor sceneId="scene-1" sceneName="Good night" onClose={() => {}} />,
    );
    // Pick 07:00 local; leave the default (every day) selection.
    fireEvent.change(screen.getByLabelText(/time/i), { target: { value: "07:00" } });
    fireEvent.click(screen.getByRole("button", { name: /add schedule/i }));
    await waitFor(() => expect(hookState.create).toHaveBeenCalledTimes(1));
    const [rrule, timezone] = hookState.create.mock.calls[0] as [string, string];
    // Wall-clock: the chosen 07:00 is stored verbatim (NOT UTC-shifted).
    expect(rrule).toBe("FREQ=DAILY;BYHOUR=7;BYMINUTE=0");
    // The browser's IANA zone is passed alongside so the server stores it.
    expect(typeof timezone).toBe("string");
    expect(timezone.length).toBeGreaterThan(0);
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
