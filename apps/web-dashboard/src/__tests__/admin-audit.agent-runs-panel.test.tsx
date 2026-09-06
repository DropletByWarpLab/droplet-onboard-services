/**
 * WARP-2180 — the Background runs panel on the Activity surface.
 *
 *   1. A parked run shows the confirm prompt WITH PROVENANCE — which run
 *      asked (its goal), which tool, and the PHI-free argument summary —
 *      and Approve posts the decision to the confirm route.
 *   2. A finished run shows its result and trace, and no approve buttons.
 *   3. Deny posts `denied`; Cancel posts to the cancel route.
 *   4. A detail response that arrives after the person selected another run
 *      is dropped — a stale run's approval prompt never overwrites the
 *      selected run's panel.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import React from "react";

const authFetchMock = vi.fn();
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "u1", username: "romain", role: "owner" }, isLoading: false }),
  authFetch: (...args: unknown[]) => authFetchMock(...args),
}));

import { AgentRunsPanel } from "@/components/audit/AgentRunsPanel";
import type { AgentRunSummary } from "@/components/audit/agent-runs/api";

function okJson(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
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
    summary: { tool: "delete_file", fields: [{ key: "path", kind: "string", detail: "/Documents/old.txt" }], truncatedFields: 0 },
    parkedAt: "2026-09-04T03:05:00.000Z",
    decision: null,
    decidedAt: null,
  },
};

const finished: AgentRunSummary = {
  ...parked,
  id: "run-2",
  goal: "sweep last night's clips",
  status: "succeeded",
  iteration: 3,
  endedAt: "2026-09-04T03:20:00.000Z",
  result: "Reviewed 12 clips; nothing unusual.",
  pending: null,
};

function wire(runs: AgentRunSummary[], traces: Record<string, unknown[]> = {}) {
  authFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") return okJson({ ok: true });
    const m = /^\/api\/agent-runs\/([^/?]+)$/.exec(url);
    if (m) {
      const run = runs.find((r) => r.id === decodeURIComponent(m[1]!));
      if (!run) return { ok: false, status: 404, json: async () => ({ error: "Run not found" }) };
      return okJson({ ...run, trace: traces[run.id] ?? [] });
    }
    if (url.startsWith("/api/agent-runs")) return okJson({ items: runs, nextCursor: null });
    throw new Error(`unexpected ${url}`);
  });
}

beforeEach(() => {
  authFetchMock.mockReset();
});
afterEach(cleanup);

describe("Background runs panel (WARP-2180)", () => {
  it("shows a parked run's confirm prompt with provenance, and Approve posts the decision", async () => {
    wire([parked], { "run-1": [{ tool_call_id: "c1", tool: "list_files", args: { path: "/Documents" }, iteration: 0, dispatchedAt: "2026-09-04T03:00:02.000Z", text: "[]" }] });
    render(<AgentRunsPanel initialRunId="run-1" />);

    await screen.findByText("This run is waiting for your approval");
    // Provenance: the run's goal, the tool, the argument summary.
    const prompt = screen.getByRole("group", { name: /waiting for your approval/i });
    expect(prompt.textContent).toContain("tidy up the old files in Documents");
    expect(prompt.textContent).toContain("delete_file");
    expect(prompt.textContent).toContain("/Documents/old.txt");
    expect(prompt.textContent).toContain("Nothing has been done yet");
    // The trace so far is visible too.
    expect(screen.getByRole("list", { name: "Tool calls" }).textContent).toContain("list_files");

    fireEvent.click(screen.getByRole("button", { name: /approve and continue/i }));
    await waitFor(() => {
      const post = authFetchMock.mock.calls.find(
        (c) => c[0] === "/api/agent-runs/run-1/confirm" && (c[1] as RequestInit)?.method === "POST",
      );
      expect(post).toBeTruthy();
      expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({ decision: "approved" });
    });
  });

  it("a finished run shows its result and trace, with no approve or cancel buttons", async () => {
    wire([finished], { "run-2": [{ tool_call_id: "c1", tool: "search_camera_events", args: { since: "last night" }, iteration: 0, dispatchedAt: "x", text: "{}" }] });
    render(<AgentRunsPanel initialRunId="run-2" />);
    await screen.findByText("Reviewed 12 clips; nothing unusual.");
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /cancel run/i })).toBeNull();
    expect(screen.getByRole("list", { name: "Tool calls" }).textContent).toContain("search_camera_events");
  });

  it("Deny posts denied; Cancel posts to the cancel route", async () => {
    wire([parked]);
    render(<AgentRunsPanel initialRunId="run-1" />);
    await screen.findByText("This run is waiting for your approval");
    fireEvent.click(screen.getByRole("button", { name: /^deny$/i }));
    await waitFor(() => {
      const post = authFetchMock.mock.calls.find((c) => c[0] === "/api/agent-runs/run-1/confirm");
      expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({ decision: "denied" });
    });
    fireEvent.click(screen.getByRole("button", { name: /cancel run/i }));
    await waitFor(() => {
      expect(authFetchMock.mock.calls.some((c) => c[0] === "/api/agent-runs/run-1/cancel")).toBe(true);
    });
  });

  it("lists runs with their state and lets one be selected", async () => {
    wire([parked, finished]);
    render(<AgentRunsPanel />);
    const list = await screen.findByRole("list", { name: "Background runs" });
    expect(list.textContent).toContain("Needs approval");
    expect(list.textContent).toContain("Finished");
    fireEvent.click(screen.getByRole("button", { name: /sweep last night's clips/i }));
    await screen.findByText("Reviewed 12 clips; nothing unusual.");
  });

  it("drops a late detail response for a run that is no longer selected", async () => {
    const pending: Record<string, (v: unknown) => void> = {};
    authFetchMock.mockImplementation(async (url: string) => {
      const m = /^\/api\/agent-runs\/([^/?]+)$/.exec(url);
      if (m) {
        const id = decodeURIComponent(m[1]!);
        const run = [parked, finished].find((r) => r.id === id)!;
        // Each detail fetch resolves only when the test says so.
        await new Promise((resolve) => {
          pending[id] = resolve;
        });
        return okJson({ ...run, trace: [] });
      }
      if (url.startsWith("/api/agent-runs")) return okJson({ items: [parked, finished], nextCursor: null });
      throw new Error(`unexpected ${url}`);
    });
    render(<AgentRunsPanel />);
    await screen.findByRole("list", { name: "Background runs" });
    // Select the parked run (slow), then the finished one (fast).
    fireEvent.click(screen.getByRole("button", { name: /tidy up the old files/i }));
    await waitFor(() => expect(pending["run-1"]).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /sweep last night's clips/i }));
    await waitFor(() => expect(pending["run-2"]).toBeTruthy());
    pending["run-2"]!(undefined);
    await screen.findByText("Reviewed 12 clips; nothing unusual.");
    // The slow response lands last — and must not take over the panel.
    pending["run-1"]!(undefined);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText("Reviewed 12 clips; nothing unusual.")).toBeTruthy();
    expect(screen.queryByText("This run is waiting for your approval")).toBeNull();
  });
});
