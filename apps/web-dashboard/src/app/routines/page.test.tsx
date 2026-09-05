/**
 * WARP-2671 — `/routines`.
 *
 * The surface the ToolSpec engine never had. Three tabs backed by the status
 * enum the schema already models, a readback derived from the steps, and the
 * first reader the WARP-464 pattern miner has ever had.
 *
 * Data comes from mocked hooks so these stay deterministic; the readback
 * itself is unit-tested in lib/routine-readback.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Routine, RoutineSchedule, ToolCatalogEntry } from "@/lib/types";

const useRoutinesMock = vi.fn();
const useRoutineMock = vi.fn();
const useRoutineRunsMock = vi.fn();
const useRoutineSchedulesMock = vi.fn();
vi.mock("@/lib/hooks/useRoutines", () => ({
  useRoutines: () => useRoutinesMock(),
  useRoutine: (slug: string | null) => useRoutineMock(slug),
  useRoutineRuns: (slug: string | null) => useRoutineRunsMock(slug),
  useRoutineSchedules: (slug: string | null) => useRoutineSchedulesMock(slug),
}));

const useToolCatalogMock = vi.fn();
vi.mock("@/lib/hooks/useToolCatalog", () => ({
  useToolCatalog: () => useToolCatalogMock(),
}));

const setRoutineStatusMock = vi.fn();
const runRoutineMock = vi.fn();
const createScheduleMock = vi.fn();
const updateScheduleMock = vi.fn();
const deleteScheduleMock = vi.fn();
// PARTIAL mock — `@/lib/api` is a large shared module and ShellPage's status
// chip imports from it too. Replacing the whole module leaves those exports
// undefined and every test fails on the chrome rather than the page.
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  setRoutineStatus: (...a: unknown[]) => setRoutineStatusMock(...a),
  runRoutine: (...a: unknown[]) => runRoutineMock(...a),
  createRoutineSchedule: (...a: unknown[]) => createScheduleMock(...a),
  updateRoutineSchedule: (...a: unknown[]) => updateScheduleMock(...a),
  deleteRoutineSchedule: (...a: unknown[]) => deleteScheduleMock(...a),
}));

import RoutinesPage from "./page";

function routine(over: Partial<Routine> = {}): Routine {
  return {
    id: "spec-1",
    slug: "daily-report",
    name: "Daily report",
    category: null,
    description: null,
    version: 1,
    status: "live",
    ownerId: "u1",
    share: null,
    safety: 1,
    writes: false,
    reversible: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    steps: [
      { id: "s0", idx: 0, kind: "call", args: { tool: "get_system_health", args: {} } },
      { id: "s1", idx: 1, kind: "summarize", args: {} },
    ],
    ...over,
  };
}

const CATALOG: ToolCatalogEntry[] = [
  {
    name: "get_system_health",
    domain: "system",
    description: "[agent] health",
    homeDescription: "Check how the box is doing",
    requiresWrite: false,
    requiresConfirmation: false,
  },
];

function setRoutines(rows: Routine[]) {
  useRoutinesMock.mockReturnValue({
    routines: rows,
    live: rows.filter((r) => r.status === "live"),
    drafts: rows.filter((r) => r.status === "draft"),
    suggested: rows.filter((r) => r.status === "suggested"),
    isLoading: false,
    error: undefined,
    refresh: vi.fn(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useToolCatalogMock.mockReturnValue({ tools: CATALOG, domains: [], isLoading: false });
  useRoutineMock.mockImplementation((slug: string | null) => ({
    routine: slug ? routine({ slug }) : undefined,
    isLoading: false,
  }));
  useRoutineRunsMock.mockReturnValue({ runs: [], isLoading: false, refresh: vi.fn() });
  useRoutineSchedulesMock.mockReturnValue({
    schedules: [],
    isLoading: false,
    refresh: vi.fn(),
  });
});

describe("/routines — the three tabs", () => {
  it("shows the three tabs the status enum models, with counts", () => {
    setRoutines([
      routine({ slug: "a", status: "live" }),
      routine({ slug: "b", status: "draft" }),
      routine({ slug: "c", status: "suggested" }),
      routine({ slug: "d", status: "suggested" }),
    ]);
    render(<RoutinesPage />);
    expect(screen.getByRole("tab", { name: /Live/ })).toHaveTextContent("1");
    expect(screen.getByRole("tab", { name: /Drafts/ })).toHaveTextContent("1");
    expect(screen.getByRole("tab", { name: /Suggested/ })).toHaveTextContent("2");
  });

  it("gives the miner's suggestions a reader — the tab it never had", () => {
    setRoutines([routine({ slug: "mined", name: "Mined pattern", status: "suggested" })]);
    render(<RoutinesPage />);
    // Not on the default (Live) tab...
    expect(screen.queryByText("Mined pattern")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /Suggested/ }));
    expect(screen.getByText("Mined pattern")).toBeInTheDocument();
  });

  it("explains an empty tab instead of showing a blank panel", () => {
    setRoutines([]);
    render(<RoutinesPage />);
    expect(screen.getByText("Nothing is running yet")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /Suggested/ }));
    expect(screen.getByText("No suggestions yet")).toBeInTheDocument();
  });

  it("surfaces a load failure rather than rendering empty tabs", () => {
    useRoutinesMock.mockReturnValue({
      routines: [],
      live: [],
      drafts: [],
      suggested: [],
      isLoading: false,
      error: new Error("orchestrator unreachable"),
      refresh: vi.fn(),
    });
    render(<RoutinesPage />);
    expect(screen.getByText("orchestrator unreachable")).toBeInTheDocument();
  });
});

describe("/routines — impact is shown from the server's own flags", () => {
  it("labels a read-only routine", () => {
    setRoutines([routine({ writes: false })]);
    render(<RoutinesPage />);
    expect(screen.getByText("Reads only")).toBeInTheDocument();
  });

  it("labels a routine whose changes are hard to undo", () => {
    setRoutines([routine({ writes: true, reversible: false })]);
    render(<RoutinesPage />);
    expect(screen.getByText("Hard to undo")).toBeInTheDocument();
  });
});

describe("/routines — turning one on", () => {
  it("shows the DERIVED readback in the confirmation, not the spec's description", async () => {
    setRoutines([
      routine({
        status: "draft",
        // A description that flatly contradicts the steps. The confirmation
        // must not repeat it — this is the whole point of deriving.
        description: "Deletes all your files",
      }),
    ]);
    render(<RoutinesPage />);
    fireEvent.click(screen.getByRole("tab", { name: /Drafts/ }));
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    fireEvent.click(await screen.findByRole("button", { name: /Turn on/ }));

    const confirm = await screen.findByText(/Turn this on\?/);
    expect(confirm).toHaveTextContent("check how the box is doing");
    expect(confirm).toHaveTextContent("Reads only. Changes nothing.");
    expect(confirm).not.toHaveTextContent("Deletes all your files");
  });

  it("promotes to live on confirm", async () => {
    setRoutines([routine({ status: "draft" })]);
    setRoutineStatusMock.mockResolvedValue(routine({ status: "live" }));
    render(<RoutinesPage />);
    fireEvent.click(screen.getByRole("tab", { name: /Drafts/ }));
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    fireEvent.click(await screen.findByRole("button", { name: /Turn on/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Yes, turn it on/ }));
    await waitFor(() =>
      expect(setRoutineStatusMock).toHaveBeenCalledWith("daily-report", "live"),
    );
  });

  it("a live routine offers Run now, and a draft does not", async () => {
    setRoutines([routine({ status: "live" })]);
    render(<RoutinesPage />);
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(await screen.findByRole("button", { name: /Run now/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Turn on/ })).not.toBeInTheDocument();
  });

  it("surfaces the server's own words when run-now is refused with 409", async () => {
    setRoutines([routine({ status: "live", writes: true, reversible: false })]);
    runRoutineMock.mockResolvedValue({
      status: 409,
      body: {
        error: "confirmation_required",
        detail: "this spec writes and is not reversible — re-POST with ?confirm=true",
      },
    });
    render(<RoutinesPage />);
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    fireEvent.click(await screen.findByRole("button", { name: /Run now/ }));
    expect(
      await screen.findByText(/writes and is not reversible/),
    ).toBeInTheDocument();
  });

  it("a 409 is not a dead end — Run anyway re-POSTs with confirm=true", async () => {
    setRoutines([routine({ status: "live", writes: true, reversible: false })]);
    runRoutineMock
      .mockResolvedValueOnce({
        status: 409,
        body: { error: "confirmation_required", detail: "hard to undo" },
      })
      .mockResolvedValueOnce({ status: 201, body: { id: "run-1" } });
    render(<RoutinesPage />);
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    fireEvent.click(await screen.findByRole("button", { name: /Run now/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Run anyway/ }));
    await waitFor(() =>
      expect(runRoutineMock).toHaveBeenLastCalledWith("daily-report", true),
    );
    expect(await screen.findByText(/Run finished/)).toBeInTheDocument();
    // Confirmed once; the next press is a fresh Run now, not a standing yes.
    expect(screen.queryByRole("button", { name: /Run anyway/ })).not.toBeInTheDocument();
  });

  it("Cancel steps back from a 409 without running", async () => {
    setRoutines([routine({ status: "live", writes: true, reversible: false })]);
    runRoutineMock.mockResolvedValue({
      status: 409,
      body: { error: "confirmation_required", detail: "hard to undo" },
    });
    render(<RoutinesPage />);
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    fireEvent.click(await screen.findByRole("button", { name: /Run now/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("button", { name: /Run now/ })).toBeInTheDocument();
    expect(runRoutineMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces a failed promote instead of swallowing it", async () => {
    setRoutines([routine({ status: "draft" })]);
    setRoutineStatusMock.mockRejectedValue(new Error("Only an owner can turn this on"));
    render(<RoutinesPage />);
    fireEvent.click(screen.getByRole("tab", { name: /Drafts/ }));
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    fireEvent.click(await screen.findByRole("button", { name: /Turn on/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Yes, turn it on/ }));
    expect(await screen.findByText(/Only an owner can turn this on/)).toBeInTheDocument();
  });
});

describe("/routines — schedules", () => {
  const sched: RoutineSchedule = {
    id: "sch-1",
    specId: "spec-1",
    rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=8;BYMINUTE=0",
    timezone: "UTC",
    nextFireAt: new Date().toISOString(),
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it("renders the cadence in English", async () => {
    setRoutines([routine()]);
    useRoutineSchedulesMock.mockReturnValue({
      schedules: [sched],
      isLoading: false,
      refresh: vi.fn(),
    });
    render(<RoutinesPage />);
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(
      await screen.findByText("Every weekday at 8:00 UTC"),
    ).toBeInTheDocument();
  });

  it("says a routine is unscheduled rather than leaving the section blank", async () => {
    setRoutines([routine()]);
    render(<RoutinesPage />);
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(
      await screen.findByText(/runs only when you press Run/),
    ).toBeInTheDocument();
  });

  it("pauses a schedule without deleting it", async () => {
    setRoutines([routine()]);
    useRoutineSchedulesMock.mockReturnValue({
      schedules: [sched],
      isLoading: false,
      refresh: vi.fn(),
    });
    updateScheduleMock.mockResolvedValue({ ...sched, enabled: false });
    render(<RoutinesPage />);
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    await waitFor(() =>
      expect(updateScheduleMock).toHaveBeenCalledWith("daily-report", "sch-1", {
        enabled: false,
      }),
    );
  });

  it("surfaces a failed pause instead of failing silently", async () => {
    setRoutines([routine()]);
    useRoutineSchedulesMock.mockReturnValue({
      schedules: [sched],
      isLoading: false,
      refresh: vi.fn(),
    });
    updateScheduleMock.mockRejectedValue(new Error("The box did not answer"));
    render(<RoutinesPage />);
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    expect(await screen.findByText(/The box did not answer/)).toBeInTheDocument();
    // The button comes back — a failed request is not a stuck panel.
    expect(await screen.findByRole("button", { name: "Pause" })).toBeEnabled();
  });

  it("removes a schedule, and says so when that fails", async () => {
    setRoutines([routine()]);
    useRoutineSchedulesMock.mockReturnValue({
      schedules: [sched],
      isLoading: false,
      refresh: vi.fn(),
    });
    deleteScheduleMock
      .mockRejectedValueOnce(new Error("Schedule not found"))
      .mockResolvedValueOnce(undefined);
    render(<RoutinesPage />);
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    fireEvent.click(await screen.findByRole("button", { name: /Remove schedule/ }));
    expect(await screen.findByText(/Schedule not found/)).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: /Remove schedule/ }));
    await waitFor(() =>
      expect(deleteScheduleMock).toHaveBeenLastCalledWith("daily-report", "sch-1"),
    );
    expect(deleteScheduleMock).toHaveBeenCalledTimes(2);
  });

  it("adds a schedule as an rrule the orchestrator can actually fire", async () => {
    setRoutines([routine()]);
    createScheduleMock.mockResolvedValue(sched);
    render(<RoutinesPage />);
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    fireEvent.click(await screen.findByRole("button", { name: /Add a schedule/ }));
    fireEvent.change(screen.getByLabelText("At what time"), {
      target: { value: "07:30" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(createScheduleMock).toHaveBeenCalled());
    const [slug, body] = createScheduleMock.mock.calls[0];
    expect(slug).toBe("daily-report");
    expect(body.rrule).toBe("FREQ=DAILY;BYHOUR=7;BYMINUTE=30");
    // The zone is sent explicitly — never left to the server's UTC default,
    // which is what WARP-2665's column exists to avoid.
    expect(body.timezone).toBeTruthy();
  });
});
