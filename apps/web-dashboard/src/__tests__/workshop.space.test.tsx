/**
 * WARP-2974 (ADR-056) — the Workshop as a space.
 *
 * The WARP-2180 panel's contract, carried into the transcript:
 *   1. A parked run shows the decision card WITH PROVENANCE — the tool and
 *      the PHI-free argument summary — and `Approve and continue` posts the
 *      decision; `Decline` posts `denied`; `Cancel run` posts to cancel.
 *   2. A finished run shows its result as the run's closing message and its
 *      steps, with no decision card and no cancel.
 *   3. A detail response that arrives after the person moved to another run
 *      is dropped — a stale run's decision card never lands on the run they
 *      are reading.
 *   4. An action that fails after the person moved on writes neither its
 *      error nor its busy state into the run they moved to (WARP-2878).
 *   5. Runs in the rail are parked-first, then newest-first.
 *   6. Recurring runs: listed with the human rule, added from the dialog
 *      (preset RRULE + typed time zone), deleted from the row.
 * The composer:
 *   7. Starting a run POSTs `{ goal }`, clears the field, opens the run.
 *   8. A refused start renders the calm error with the cause, keeps the goal.
 *   9. Choosing a custom tool under `Work in` makes the POST a workshop run.
 * Custom tools:
 *  10. `New custom tool` POSTs name + template and points the composer at it.
 *  11. `?workspace=<id>` opens the context pane: branch, proposal, changes,
 *      last command, history, clone URL; one failing read blanks its own
 *      section only; a 404 says so.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import React from "react";

const authFetchMock = vi.fn();
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "u1", username: "alice", role: "owner" }, isLoading: false }),
  authFetch: (...args: unknown[]) => authFetchMock(...args),
}));

let mockSearchParamsString = "";
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(mockSearchParamsString),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/workshop",
}));

import { WorkshopSpace } from "@/components/workshop/WorkshopSpace";
import { orderRuns } from "@/components/workshop/WorkshopRail";
import type { AgentRunSchedule, AgentRunSummary, TraceEntry } from "@/components/workshop/agent-runs/api";

function okJson(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

function calls(prefix: string) {
  return authFetchMock.mock.calls.filter((c) => typeof c[0] === "string" && (c[0] as string).startsWith(prefix));
}

const parked: AgentRunSummary = {
  id: "run-1",
  goal: "tidy up the old files in Documents",
  model: "m",
  status: "awaiting_confirmation",
  iteration: 1,
  maxIter: 10,
  attempts: 0,
  createdAt: "2026-09-04T03:00:00.000Z",
  startedAt: "2026-09-04T03:00:01.000Z",
  endedAt: null,
  deadlineAt: null,
  result: null,
  stopReason: null,
  error: null,
  pending: {
    tool: "delete_file",
    args: { path: "/Documents/old.txt" },
    summary: { tool: "delete_file", fields: [{ key: "path", kind: "string", detail: "a path, 18 chars" }], truncatedFields: 0 },
    parkedAt: "2026-09-04T03:05:00.000Z",
    decision: null,
    decidedAt: null,
  },
};

const parked2: AgentRunSummary = { ...parked, id: "run-3", goal: "water the plants on the roof", createdAt: "2026-09-03T03:00:00.000Z" };

const finished: AgentRunSummary = {
  ...parked,
  id: "run-2",
  goal: "sweep last night's clips",
  status: "succeeded",
  iteration: 3,
  createdAt: "2026-09-05T03:00:00.000Z",
  endedAt: "2026-09-04T03:20:00.000Z",
  result: "Reviewed 12 clips; nothing unusual.",
  pending: null,
};

const trace: TraceEntry[] = [
  { tool_call_id: "c1", tool: "list_recent_files", args: { days: 7 }, iteration: 0, dispatchedAt: "2026-09-04T03:00:02.000Z", text: "3 files", completedAt: "2026-09-04T03:00:03.000Z" },
  { tool_call_id: "c2", tool: "delete_file", args: { path: "/Documents/old.txt" }, iteration: 1, dispatchedAt: "2026-09-04T03:05:00.000Z", confirmation: "parked" },
];

const WS = {
  id: "ws-a",
  name: "Word counter",
  template: "python-tool" as string | null,
  status: "active",
  proposedTag: null,
  proposedAt: null,
  createdAt: "2026-09-20T09:00:00.000Z",
  updatedAt: "2026-09-20T10:00:00.000Z",
  userId: "u1",
  lastRun: null,
};

const WS_DETAIL = {
  ...WS,
  status: "proposed",
  proposedTag: "proposal/0.1.0",
  proposedAt: "2026-09-20T10:00:00.000Z",
  git: { id: "ws-a", branch: "work", head: "0123456789abcdef0123", dirty: true, tags: ["proposal/0.1.0"] },
  runs: [{ id: "run-9", status: "succeeded", goal: "build a word counter", stopReason: "proposed", createdAt: "2026-09-20T09:30:00.000Z", endedAt: "2026-09-20T10:00:00.000Z" }],
};

interface WireOpts {
  runs?: AgentRunSummary[];
  traces?: Record<string, TraceEntry[]>;
  schedules?: AgentRunSchedule[];
  workspaces?: Array<typeof WS>;
  override?: (url: string, init?: RequestInit) => unknown | undefined;
}

let created: Array<typeof WS> = [];

function wire({ runs = [], traces = {}, schedules = [], workspaces = [], override }: WireOpts = {}) {
  authFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const o = override?.(url, init);
    if (o !== undefined) return o;
    if (url.startsWith("/api/agent-runs/schedules")) {
      if (init?.method === "POST") return okJson({ id: "sched-new", nextFireAt: "2026-09-06T13:00:00.000Z" }, 201);
      if (init?.method === "DELETE") return okJson({}, 204);
      return okJson({ schedules });
    }
    if (url === "/api/agent-runs" && init?.method === "POST") return okJson({ id: "run-new", status: "queued" }, 201);
    if (url.startsWith("/api/agent-runs/") && init?.method === "POST") return okJson({ ok: true });
    const m = /^\/api\/agent-runs\/([^/?]+)$/.exec(url);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      if (id === "run-new") return okJson({ ...finished, id, goal: "goal of run-new", status: "queued", result: null, endedAt: null, trace: [] });
      const run = runs.find((r) => r.id === id);
      if (!run) return okJson({ error: "Run not found" }, 404);
      return okJson({ ...run, trace: traces[run.id] ?? [] });
    }
    if (url.startsWith("/api/agent-runs")) return okJson({ items: runs, nextCursor: null });
    if (url === "/api/workspace/templates") return okJson({ templates: ["python-tool", "typescript-tool"] });
    if (url === "/api/workspace" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { name: string; template?: string };
      created.push({ ...WS, id: "new-ws-abc123", name: body.name, template: body.template ?? null });
      return okJson({ id: "new-ws-abc123", name: body.name, status: "active" }, 201);
    }
    if (url === "/api/workspace") return okJson({ workspaces: [...workspaces, ...created] });
    if (url === "/api/workspace/ws-a") return okJson(WS_DETAIL);
    if (url.startsWith("/api/workspace/ws-a/log")) {
      return okJson({
        entries: [
          { commit: "abcdef0123456789", author: "Alice", date: "2026-09-20T10:00:00.000Z", subject: "propose Word counter 0.1.0", refs: ["tag: proposal/0.1.0", "HEAD -> work"] },
          { commit: "1234567890abcdef", author: "Alice", date: "2026-09-20T09:40:00.000Z", subject: "count words", refs: [] },
        ],
      });
    }
    if (url.startsWith("/api/workspace/ws-a/diff")) return okJson({ base: "HEAD", diff: "diff --git a/tool.py b/tool.py\n+print(1)\n", truncated: false });
    if (url.startsWith("/api/workspace/ws-a/output")) {
      return okJson({ lastRun: { argv: ["pytest", "-q"], exitCode: 0, timedOut: false, durationMs: 1234, stdout: "2 passed", stderr: "", truncated: false, finishedAt: "2026-09-20T09:50:00.000Z" } });
    }
    if (url.startsWith("/api/workspace/")) return okJson({ error: "not found" }, 404);
    throw new Error(`unexpected ${url} ${String(init?.method)}`);
  });
}

beforeEach(() => {
  mockSearchParamsString = "";
  created = [];
  authFetchMock.mockReset();
});
afterEach(cleanup);

const goalField = () => screen.getByLabelText("What should your Droplet do?") as HTMLTextAreaElement;

describe("Workshop — the transcript (WARP-2974 carries WARP-2180)", () => {
  it("a parked run shows the decision card with provenance; Approve and continue posts the decision", async () => {
    mockSearchParamsString = "run=run-1";
    wire({ runs: [parked], traces: { "run-1": trace } });
    render(<WorkshopSpace />);

    const card = await screen.findByRole("group", { name: /waiting for your OK/i });
    expect(card.textContent).toContain("delete_file");
    expect(card.textContent).toContain("a path, 18 chars");
    // The value itself never reaches the card — only its shape.
    expect(within(card).queryByText("/Documents/old.txt")).toBeNull();
    // The steps read in order, the parked one marked as such.
    const steps = screen.getByRole("list", { name: "Tool calls" });
    expect(steps.textContent).toContain("list_recent_files");
    expect(steps.textContent).toContain("parked for your OK");

    fireEvent.click(screen.getByRole("button", { name: /approve and continue/i }));
    await waitFor(() => {
      const post = authFetchMock.mock.calls.find((c) => c[0] === "/api/agent-runs/run-1/confirm");
      expect(post).toBeTruthy();
      expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({ decision: "approved" });
    });
  });

  it("Decline posts denied; Cancel run posts to the cancel route", async () => {
    mockSearchParamsString = "run=run-1";
    wire({ runs: [parked] });
    render(<WorkshopSpace />);
    await screen.findByRole("group", { name: /waiting for your OK/i });

    fireEvent.click(screen.getByRole("button", { name: /^decline$/i }));
    await waitFor(() => {
      const post = authFetchMock.mock.calls.find((c) => c[0] === "/api/agent-runs/run-1/confirm");
      expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({ decision: "denied" });
    });
    fireEvent.click(screen.getByRole("button", { name: /cancel run/i }));
    await waitFor(() => expect(authFetchMock.mock.calls.some((c) => c[0] === "/api/agent-runs/run-1/cancel")).toBe(true));
  });

  it("a finished run shows its result as the closing message, with no decision card and no cancel", async () => {
    mockSearchParamsString = "run=run-2";
    wire({ runs: [finished], traces: { "run-2": [trace[0]!] } });
    render(<WorkshopSpace />);
    expect(await screen.findByText("Reviewed 12 clips; nothing unusual.")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Tool calls" }).textContent).toContain("list_recent_files");
    expect(screen.queryByRole("button", { name: /approve and continue/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /cancel run/i })).toBeNull();
    // The head names the run and its state.
    expect(screen.getByTitle("sweep last night's clips")).toBeInTheDocument();
  });

  it("drops a late detail response for a run that is no longer selected", async () => {
    const pending: Record<string, (v: unknown) => void> = {};
    wire({
      runs: [parked, finished],
      override: (url) => {
        const m = /^\/api\/agent-runs\/([^/?]+)$/.exec(url);
        if (!m) return undefined;
        const id = decodeURIComponent(m[1]!);
        const run = [parked, finished].find((r) => r.id === id)!;
        return new Promise((resolve) => {
          pending[id] = () => resolve(okJson({ ...run, trace: [] }));
        });
      },
    });
    render(<WorkshopSpace />);
    const runsList = await screen.findByRole("list", { name: "Runs" });
    fireEvent.click(await within(runsList).findByRole("button", { name: /tidy up the old files/i }));
    await waitFor(() => expect(pending["run-1"]).toBeTruthy());
    fireEvent.click(within(runsList).getByRole("button", { name: /sweep last night's clips/i }));
    await waitFor(() => expect(pending["run-2"]).toBeTruthy());
    pending["run-2"]!(undefined);
    await screen.findByText("Reviewed 12 clips; nothing unusual.");
    // The slow response lands last — and must not take over the transcript.
    pending["run-1"]!(undefined);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText("Reviewed 12 clips; nothing unusual.")).toBeTruthy();
    expect(screen.queryByRole("group", { name: /waiting for your OK/i })).toBeNull();
  });

  it("an action that fails after the person moved on leaves the new run alone (WARP-2878)", async () => {
    let rejectCancel!: (e: unknown) => void;
    mockSearchParamsString = "run=run-1";
    wire({
      runs: [parked, parked2],
      override: (url) =>
        url === "/api/agent-runs/run-1/cancel"
          ? new Promise((_resolve, reject) => {
              rejectCancel = reject;
            })
          : undefined,
    });
    render(<WorkshopSpace />);
    await screen.findByRole("group", { name: /waiting for your OK/i });
    fireEvent.click(screen.getByRole("button", { name: /cancel run/i }));
    await waitFor(() => expect(rejectCancel).toBeTruthy());

    const runsList = screen.getByRole("list", { name: "Runs" });
    fireEvent.click(within(runsList).getByRole("button", { name: /water the plants/i }));
    await waitFor(() => expect(screen.getByTitle("water the plants on the roof")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /approve and continue/i })).not.toBeDisabled();

    rejectCancel(new Error("box said no"));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(/Something went wrong on the box/i)).toBeNull();
    expect(screen.getByRole("button", { name: /approve and continue/i })).not.toBeDisabled();
  });

  it("the rail lists parked runs first, then newest first", () => {
    expect(orderRuns([finished, parked2, parked]).map((r) => r.id)).toEqual(["run-1", "run-3", "run-2"]);
  });

  it("lists recurring runs, adds one from the dialog with the typed time zone, deletes one from the row", async () => {
    const schedule: AgentRunSchedule = {
      id: "sched-1",
      goal: "sweep last night's clips every morning",
      model: "m",
      maxIter: 30,
      rrule: "FREQ=DAILY;BYHOUR=6;BYMINUTE=0",
      timezone: "America/Los_Angeles",
      nextFireAt: "2026-09-06T13:00:00.000Z",
      enabled: true,
      lastFiredAt: null,
      createdAt: "2026-09-04T03:00:00.000Z",
    };
    wire({ schedules: [schedule] });
    render(<WorkshopSpace />);
    const list = await screen.findByRole("list", { name: "Recurring runs" });
    await waitFor(() => expect(list.textContent).toContain("sweep last night's clips every morning"));
    expect(list.textContent).toContain("Every day at 06:00");
    expect(list.textContent).toContain("America/Los_Angeles");

    fireEvent.click(screen.getByRole("button", { name: /add a recurring run/i }));
    const form = await screen.findByRole("form", { name: "Add a recurring run" });
    fireEvent.change(within(form).getByLabelText("Goal"), { target: { value: "check the front door camera" } });
    fireEvent.change(within(form).getByLabelText("When"), { target: { value: "weekdays-9" } });
    fireEvent.change(within(form).getByLabelText("Time zone"), { target: { value: "Europe/Paris" } });
    fireEvent.click(within(form).getByRole("button", { name: /add recurring run/i }));
    await waitFor(() => {
      const post = authFetchMock.mock.calls.find((c) => c[0] === "/api/agent-runs/schedules" && (c[1] as RequestInit)?.method === "POST");
      expect(post).toBeTruthy();
      expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({
        goal: "check the front door camera",
        rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0",
        timezone: "Europe/Paris",
      });
    });

    fireEvent.click(screen.getByRole("button", { name: /delete recurring run: sweep last night's clips/i }));
    await waitFor(() => {
      expect(authFetchMock.mock.calls.some((c) => c[0] === "/api/agent-runs/schedules/sched-1" && (c[1] as RequestInit)?.method === "DELETE")).toBe(true);
    });
  });
});

describe("Workshop — the composer", () => {
  it("starts a run: POSTs the goal, clears the field and opens the new run", async () => {
    wire();
    render(<WorkshopSpace />);
    const start = screen.getByRole("button", { name: /start run/i });
    expect(start).toBeDisabled();
    fireEvent.change(goalField(), { target: { value: "  sort last week's scans  " } });
    expect(start).toBeEnabled();
    fireEvent.click(start);

    await waitFor(() => expect(calls("/api/agent-runs").some((c) => (c[1] as RequestInit | undefined)?.method === "POST")).toBe(true));
    const post = calls("/api/agent-runs").find((c) => (c[1] as RequestInit | undefined)?.method === "POST")!;
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({ goal: "sort last week's scans" });
    await waitFor(() => expect(goalField().value).toBe(""));
    expect(await screen.findByText(/^Queued\. It starts on the box/)).toBeInTheDocument();
    expect(await screen.findByTestId("agent-run-detail")).toHaveTextContent("goal of run-new");
  });

  it("Enter sends; Shift+Enter does not", async () => {
    wire();
    render(<WorkshopSpace />);
    fireEvent.change(goalField(), { target: { value: "a goal" } });
    fireEvent.keyDown(goalField(), { key: "Enter", shiftKey: true });
    expect(calls("/api/agent-runs").filter((c) => (c[1] as RequestInit | undefined)?.method === "POST").length).toBe(0);
    fireEvent.keyDown(goalField(), { key: "Enter" });
    await waitFor(() => expect(calls("/api/agent-runs").filter((c) => (c[1] as RequestInit | undefined)?.method === "POST").length).toBe(1));
  });

  it("renders the calm error, with the cause in the title, when the start is refused — and keeps the goal", async () => {
    wire({ override: (url, init) => (url === "/api/agent-runs" && init?.method === "POST" ? okJson({ error: "Forbidden: role not permitted to use background runs" }, 403) : undefined) });
    render(<WorkshopSpace />);
    fireEvent.change(goalField(), { target: { value: "do a thing" } });
    fireEvent.click(screen.getByRole("button", { name: /start run/i }));
    const status = await screen.findByText("Something went wrong on the box. Try again in a moment.");
    expect(status).toHaveAttribute("title", expect.stringContaining("Forbidden"));
    expect(calls("/api/agent-runs/run-").length).toBe(0);
    expect(goalField().value).toBe("do a thing");
  });

  it("choosing a custom tool under 'Work in' makes the start POST a workshop run, and the placeholder speaks to the tool", async () => {
    wire({ workspaces: [WS] });
    render(<WorkshopSpace />);
    const select = (await screen.findByTestId("workspace-select")) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(2));
    fireEvent.change(select, { target: { value: "ws-a" } });
    const field = screen.getByLabelText("What should Word counter do?") as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "count words in every scan" } });
    fireEvent.click(screen.getByRole("button", { name: /start run/i }));
    await waitFor(() => {
      const post = calls("/api/agent-runs").find((c) => (c[1] as RequestInit | undefined)?.method === "POST");
      expect(post).toBeTruthy();
      expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({ goal: "count words in every scan", workspaceId: "ws-a" });
    });
    // Picking the tool also opened its context pane.
    expect(await screen.findByTestId("workspace-context")).toBeInTheDocument();
  });
});

describe("Workshop — custom tools", () => {
  it("'New custom tool' POSTs name + template and points the composer at the new workspace", async () => {
    wire();
    render(<WorkshopSpace />);
    fireEvent.click(screen.getByTestId("new-tool"));
    const form = await screen.findByRole("form", { name: "New custom tool" });
    await within(form).findByTestId("template-typescript-tool");
    expect(form.textContent).toContain("TypeScript MCP server (Node 20)");
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Booking reminders" } });
    fireEvent.click(within(form).getByTestId("template-typescript-tool"));
    fireEvent.click(within(form).getByRole("button", { name: /^create$/i }));

    await waitFor(() => {
      const post = authFetchMock.mock.calls.find((c) => c[0] === "/api/workspace" && (c[1] as RequestInit)?.method === "POST");
      expect(post).toBeTruthy();
      expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({ name: "Booking reminders", template: "typescript-tool" });
    });
    await waitFor(() => expect((screen.getByTestId("workspace-select") as HTMLSelectElement).value).toBe("new-ws-abc123"));
    expect(screen.getByLabelText("What should Booking reminders do?")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Custom tools" }).textContent).toContain("Booking reminders");
  });

  it("?workspace=<id> opens the context pane: branch, proposal, changes, last command, history, clone", async () => {
    mockSearchParamsString = "workspace=ws-a";
    wire({ workspaces: [WS] });
    render(<WorkshopSpace />);
    const pane = await screen.findByTestId("workspace-context");
    await waitFor(() => expect(pane.textContent).toContain("work"));
    expect(pane.textContent).toContain("0123456789ab");
    expect(pane.textContent).toContain("uncommitted changes");
    expect(pane.textContent).toContain("proposal/0.1.0");
    expect(within(pane).getByTestId("workspace-diff").textContent).toContain("+print(1)");
    expect(within(pane).getByTestId("last-run-verdict").textContent).toBe("passed");
    expect(within(pane).getByTestId("last-run-output").textContent).toContain("2 passed");
    const commits = within(pane).getByRole("list", { name: "Commits" });
    expect(commits.textContent).toContain("propose Word counter 0.1.0");
    expect(commits.textContent).toContain("proposal");
    expect(within(pane).getByTestId("clone-url").textContent).toMatch(/\/git\/ws-a\.git$/);
    // The composer is pointed at it.
    expect((screen.getByTestId("workspace-select") as HTMLSelectElement).value).toBe("ws-a");
    // And a proposed workspace offers no "start a run here" — it is waiting for review.
    expect(within(pane).queryByRole("button", { name: /start a run here/i })).toBeNull();
  });

  it("one failing read blanks its own section only", async () => {
    mockSearchParamsString = "workspace=ws-a";
    wire({ workspaces: [WS], override: (url) => (url.startsWith("/api/workspace/ws-a/diff") ? okJson({ error: "sandbox down" }, 502) : undefined) });
    render(<WorkshopSpace />);
    const pane = await screen.findByTestId("workspace-context");
    await waitFor(() => expect(within(pane).getByTestId("last-run-verdict")).toBeInTheDocument());
    expect(within(pane).queryByTestId("workspace-diff")).toBeNull();
    expect(pane.textContent).toContain("Nothing uncommitted");
    expect(within(pane).getByRole("list", { name: "Commits" })).toBeInTheDocument();
  });

  it("a workspace the box does not know says so", async () => {
    mockSearchParamsString = "workspace=ws-gone";
    wire();
    render(<WorkshopSpace />);
    const pane = await screen.findByTestId("workspace-context");
    await waitFor(() => expect(pane.textContent).toContain("No workspace with that id."));
  });
});
