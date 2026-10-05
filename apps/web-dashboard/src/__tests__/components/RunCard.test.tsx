/**
 * WARP-3303 — the chat card for a background run started from chat.
 *
 * Pins: every status's line (incl. queue position and "Waiting for chat"),
 * state read from the run and the live topic rather than the persisted tool
 * result, Stop, in-card approval without a chat turn, and the read-only
 * state a 403 leaves.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AgentRunDetail } from "@/components/workshop/agent-runs/api";
import type { ChatToolCall } from "@/lib/types";

const getAgentRun = vi.fn();
const cancelAgentRun = vi.fn();
const decideAgentRun = vi.fn();
vi.mock("@/components/workshop/agent-runs/api", async (orig) => ({
  ...(await orig<typeof import("@/components/workshop/agent-runs/api")>()),
  getAgentRun: (...a: unknown[]) => getAgentRun(...a),
  cancelAgentRun: (...a: unknown[]) => cancelAgentRun(...a),
  decideAgentRun: (...a: unknown[]) => decideAgentRun(...a),
}));

import { RunCard, RunResultCard, progressLine, runIdOf } from "@/components/chat/RunCard";
import { publishAgentRunFrame } from "@/lib/agent-run-events";

const call: ChatToolCall = {
  id: "c1",
  name: "start_agent_run",
  args: { title: "Supplier price check" },
  ok: true,
  // The persisted snapshot says queued; the card must not believe it.
  data: { runId: "run-7", status: "queued", queuePosition: 2 },
};

function run(over: Partial<AgentRunDetail> = {}): AgentRunDetail {
  return {
    id: "run-7",
    goal: "g",
    model: "m",
    status: "running",
    iteration: 3,
    maxIter: 30,
    attempts: 0,
    createdAt: "2026-09-28T00:00:00Z",
    startedAt: null,
    endedAt: null,
    deadlineAt: null,
    result: null,
    stopReason: null,
    error: null,
    pending: null,
    trace: [],
    title: "Supplier price check",
    queuePosition: null,
    waitingFor: "none",
    ...over,
  };
}

beforeEach(() => {
  getAgentRun.mockReset();
  cancelAgentRun.mockReset();
  decideAgentRun.mockReset();
});

describe("progressLine", () => {
  const base = { iteration: 5, maxIter: 30, queuePosition: null, waitingFor: "none" as const };
  it.each([
    [{ ...base, status: "queued" as const, queuePosition: 2 }, "Queued, 2nd"],
    [{ ...base, status: "queued" as const, queuePosition: 1 }, "Queued, 1st"],
    [{ ...base, status: "queued" as const, queuePosition: 11 }, "Queued, 11th"],
    [{ ...base, status: "queued" as const, waitingFor: "chat" as const, queuePosition: 1 }, "Waiting for chat"],
    [{ ...base, status: "running" as const, lastTool: "search_content" }, "Step 5 of 30 · search content"],
    [{ ...base, status: "awaiting_confirmation" as const }, "Waiting for your OK"],
    [{ ...base, status: "cancelled" as const }, "Stopped, kept 5 steps"],
    [{ ...base, status: "failed" as const }, "Didn't finish"],
    [{ ...base, status: "succeeded" as const, iteration: 1 }, "Finished in 1 step"],
  ])("%o → %s", (r, expected) => {
    expect(progressLine(r)).toBe(expected);
  });
});

describe("runIdOf", () => {
  it("reads the run id from a successful start_agent_run only", () => {
    expect(runIdOf(call)).toBe("run-7");
    expect(runIdOf({ ...call, data: { data: { runId: "run-8" } } })).toBe("run-8");
    expect(runIdOf({ ...call, ok: false })).toBeNull();
    expect(runIdOf({ ...call, status: "confirmation_required", ok: true, data: undefined })).toBeNull();
    expect(runIdOf({ ...call, name: "list_agent_runs" })).toBeNull();
  });
});

describe("RunCard", () => {
  it("shows the run's real state, not the persisted tool result", async () => {
    getAgentRun.mockResolvedValue(run({ status: "running", iteration: 4 }));
    render(<RunCard call={call} />);
    await waitFor(() => expect(screen.getByTestId("run-card-progress").textContent).toBe("Step 4 of 30"));
    expect(screen.getByTestId("run-card").getAttribute("data-status")).toBe("running");
  });

  it("follows live frames and re-reads the run when its status changes", async () => {
    getAgentRun.mockResolvedValueOnce(run({ status: "queued", queuePosition: 2 }));
    render(<RunCard call={call} />);
    await waitFor(() => expect(screen.getByTestId("run-card-progress").textContent).toBe("Queued, 2nd"));

    getAgentRun.mockResolvedValueOnce(run({ status: "running", iteration: 1 }));
    act(() =>
      publishAgentRunFrame("droplet/agent-runs/romain", {
        runId: "run-7", sessionId: "conv-1", status: "running", iteration: 1, maxIter: 30,
        lastTool: "read_file", queuePosition: null, waitingFor: "none", title: "Supplier price check",
      }),
    );
    await waitFor(() => expect(screen.getByTestId("run-card-progress").textContent).toBe("Step 1 of 30 · read file"));
    expect(getAgentRun).toHaveBeenCalledTimes(2);

    // Another run's frame changes nothing.
    act(() =>
      publishAgentRunFrame("droplet/agent-runs/romain", {
        runId: "run-other", sessionId: null, status: "failed", iteration: 9, maxIter: 30,
        lastTool: null, queuePosition: null, waitingFor: "none", title: null,
      }),
    );
    expect(screen.getByTestId("run-card-progress").textContent).toBe("Step 1 of 30 · read file");
  });

  it("stops a live run", async () => {
    getAgentRun.mockResolvedValueOnce(run({ status: "running", iteration: 5 }));
    getAgentRun.mockResolvedValueOnce(run({ status: "cancelled", iteration: 5 }));
    cancelAgentRun.mockResolvedValue(undefined);
    render(<RunCard call={call} />);
    fireEvent.click(await screen.findByTestId("run-card-stop"));
    await waitFor(() => expect(screen.getByTestId("run-card-progress").textContent).toBe("Stopped, kept 5 steps"));
    expect(cancelAgentRun).toHaveBeenCalledWith("run-7");
    expect(screen.queryByTestId("run-card-stop")).toBeNull();
  });

  it("approves a parked run from the card, naming the task", async () => {
    const pending = {
      tool: "create_email_draft",
      args: {},
      summary: {
        tool: "create_email_draft",
        fields: [{ key: "to", kind: "string", detail: "18 characters" }],
        truncatedFields: 0,
        shown: [{ key: "to", text: "buyer@brightline.example" }],
      },
      parkedAt: null,
      decision: null,
      decidedAt: null,
    };
    getAgentRun.mockResolvedValueOnce(run({ status: "awaiting_confirmation", pending }));
    getAgentRun.mockResolvedValueOnce(run({ status: "running", pending: null }));
    decideAgentRun.mockResolvedValue(undefined);
    render(<RunCard call={call} />);
    expect(await screen.findByText("Supplier price check wants to create email draft")).toBeTruthy();
    // WARP-3569 — the parked-run approval shows the same decisive value, once.
    const facts = screen.getByTestId("run-card-pending-summary").textContent ?? "";
    expect(facts).toContain("buyer@brightline.example");
    expect(facts).not.toContain("18 characters");
    fireEvent.click(screen.getByTestId("run-card-approve"));
    await waitFor(() => expect(decideAgentRun).toHaveBeenCalledWith("run-7", "approved"));
    await waitFor(() => expect(screen.queryByTestId("run-card-approve")).toBeNull());
  });

  it("renders read-only when the run is not visible to this account", async () => {
    getAgentRun.mockRejectedValue(new Error("Couldn't load this run (HTTP 403)"));
    render(<RunCard call={call} />);
    expect(await screen.findByTestId("run-card-hidden")).toBeTruthy();
    expect(screen.queryByText("View")).toBeNull();
  });
});

describe("RunResultCard", () => {
  it("shows the summary, the files and a link to the run", () => {
    render(
      <RunResultCard
        result={{
          runId: "run-7",
          status: "succeeded",
          title: "Supplier price check",
          summary: "Brightline is cheapest at $39.",
          artifacts: [{ kind: "file", ref: "/Docs/Ops/suppliers.md", title: "suppliers.md" }],
        }}
      />,
    );
    expect(screen.getByText("Brightline is cheapest at $39.")).toBeTruthy();
    expect(screen.getByRole("link", { name: /suppliers\.md/ }).getAttribute("href")).toBe("/files?path=%2FDocs%2FOps");
    expect(screen.getByRole("link", { name: "View full run" }).getAttribute("href")).toBe("/workshop?run=run-7");
  });
});
