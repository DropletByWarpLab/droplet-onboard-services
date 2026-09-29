/**
 * Deleting a custom tool from the Workshop.
 *
 * `DELETE /api/workspace/:id` shipped with WARP-2896 (owner only; refused
 * while a run works in the workspace or, since this change, while it is the
 * source of an installed extension), and `deleteWorkspace` has been in the
 * dashboard's client since then, but nothing rendered it. The contract:
 *   1. The context pane offers `Delete` to the box's owner only — the route
 *      is `requireRole("owner")`, so an admin is never shown a button that
 *      can only fail.
 *   2. No `Delete` while a run is working in the tool: the pane offers the
 *      run instead, as it does for `Start a run here`.
 *   3. `Delete` asks first, naming the tool; Cancel sends nothing.
 *   4. Confirming sends one DELETE and hands the deleted tool back.
 *   5. A refusal keeps the dialog open with the route's reason (a 409 is
 *      something the owner can act on); any other failure is the calm line,
 *      with the cause in the title.
 *   6. In the space: the tool leaves the rail, its pane closes, the composer
 *      stops pointing at it, the URL drops `?workspace=`, and an open run
 *      that worked in it is re-read so its chip no longer links to it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import React from "react";

const authFetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<unknown>>();
let mockRole: "owner" | "admin" | "family" | "guest" = "owner";
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "u1", username: "alice", role: mockRole }, isLoading: false }),
  authFetch: (url: string, init?: RequestInit) => authFetchMock(url, init),
}));

let mockSearchParamsString = "";
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(mockSearchParamsString),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/workshop",
}));

import { WorkspaceContext } from "@/components/workshop/WorkspaceContext";
import { WorkshopSpace } from "@/components/workshop/WorkshopSpace";
import type { AgentRunSummary } from "@/components/workshop/agent-runs/api";

function okJson(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

const SUMMARY = {
  id: "ws-a",
  name: "Word counter",
  template: "typescript-tool",
  status: "proposed",
  proposedTag: "proposal/0.1.0",
  proposedAt: "2026-09-20T10:00:00.000Z",
  createdAt: "2026-09-20T09:00:00.000Z",
  updatedAt: "2026-09-20T10:00:00.000Z",
  userId: "u1",
  lastRun: { id: "run-9", status: "succeeded", createdAt: "2026-09-20T09:30:00.000Z" },
};

const FINISHED_RUN = { id: "run-9", status: "succeeded", goal: "build a word counter", stopReason: "proposed", createdAt: "2026-09-20T09:30:00.000Z", endedAt: "2026-09-20T10:00:00.000Z" };
const LIVE_RUN = { ...FINISHED_RUN, id: "run-10", status: "running", stopReason: null, endedAt: null };

function detail(runs: unknown[] = [FINISHED_RUN]) {
  return {
    ...SUMMARY,
    git: { id: "ws-a", branch: "work", head: "0123456789abcdef0123", dirty: false, tags: ["proposal/0.1.0"] },
    connectorDraft: null,
    runs,
  };
}

const RUN: AgentRunSummary = {
  id: "run-9",
  goal: "build a word counter",
  model: "m",
  workspaceId: "ws-a",
  status: "succeeded",
  iteration: 4,
  maxIter: 30,
  attempts: 0,
  createdAt: "2026-09-20T09:30:00.000Z",
  startedAt: "2026-09-20T09:30:01.000Z",
  endedAt: "2026-09-20T10:00:00.000Z",
  deadlineAt: null,
  result: "Proposed Word counter 0.1.0.",
  stopReason: "proposed",
  error: null,
  pending: null,
};

interface WireOpts {
  runs?: unknown[];
  /** What the DELETE answers. */
  del?: () => unknown;
}

let deleted = false;

function wire({ runs, del = () => okJson({ id: "ws-a", deleted: true }) }: WireOpts = {}) {
  authFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/api/workspace/ws-a" && init?.method === "DELETE") {
      const res = del() as { ok: boolean };
      if (res.ok) deleted = true;
      return res;
    }
    if (url === "/api/workspace") return okJson({ workspaces: deleted ? [] : [SUMMARY] });
    if (url === "/api/workspace/ws-a") return deleted ? okJson({ error: "No such workspace" }, 404) : okJson(detail(runs));
    if (url.startsWith("/api/workspace/ws-a/log")) return okJson({ entries: [] });
    if (url.startsWith("/api/workspace/ws-a/diff")) return okJson({ base: "HEAD", diff: "", truncated: false });
    if (url.startsWith("/api/workspace/ws-a/output")) return okJson({ lastRun: null });
    if (url.startsWith("/api/agent-runs/schedules")) return okJson({ schedules: [] });
    // The FK is ON DELETE SET NULL: once the workspace is gone, its runs no longer name it.
    if (url === "/api/agent-runs/run-9") return okJson({ ...RUN, workspaceId: deleted ? null : "ws-a", trace: [] });
    if (url.startsWith("/api/agent-runs")) return okJson({ items: [{ ...RUN, workspaceId: deleted ? null : "ws-a" }], nextCursor: null });
    throw new Error(`unexpected ${url} ${String(init?.method)}`);
  });
}

function deleteCalls() {
  return authFetchMock.mock.calls.filter((c) => c[0] === "/api/workspace/ws-a" && c[1]?.method === "DELETE");
}

beforeEach(() => {
  mockRole = "owner";
  mockSearchParamsString = "";
  deleted = false;
  authFetchMock.mockReset();
});
afterEach(cleanup);

async function renderPane(onDeleted = vi.fn()) {
  render(<WorkspaceContext workspaceId="ws-a" live={false} onDeleted={onDeleted} onOpenRun={vi.fn()} />);
  const pane = await screen.findByTestId("workspace-context");
  await waitFor(() => expect(pane.textContent).toContain("proposal/0.1.0"));
  return { pane, onDeleted };
}

describe("Workshop — deleting a custom tool (the pane)", () => {
  it("offers Delete to the owner", async () => {
    wire();
    const { pane } = await renderPane();
    expect(within(pane).getByRole("button", { name: "Delete this custom tool" })).toBeInTheDocument();
  });

  it.each(["admin", "family", "guest"] as const)("does not offer Delete to %s (the route is owner-only)", async (role) => {
    mockRole = role;
    wire();
    const { pane } = await renderPane();
    expect(within(pane).queryByRole("button", { name: "Delete this custom tool" })).toBeNull();
  });

  it("does not offer Delete while a run is working in the tool, and offers the run instead", async () => {
    wire({ runs: [LIVE_RUN] });
    const { pane } = await renderPane();
    expect(within(pane).getByRole("button", { name: /a run is working here/i })).toBeInTheDocument();
    expect(within(pane).queryByRole("button", { name: "Delete this custom tool" })).toBeNull();
  });

  it("asks first, naming the tool; Cancel sends nothing", async () => {
    wire();
    const { pane, onDeleted } = await renderPane();
    fireEvent.click(within(pane).getByRole("button", { name: "Delete this custom tool" }));
    const dialog = await screen.findByRole("dialog", { name: 'Delete "Word counter"?' });
    expect(dialog.textContent).toMatch(/can't be undone/);
    expect(dialog.textContent).toMatch(/runs that worked on it stay/i);
    expect(dialog.textContent).toContain("ws-a");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(deleteCalls()).toHaveLength(0);
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it("confirming sends one DELETE and hands the deleted tool back", async () => {
    wire();
    const { pane, onDeleted } = await renderPane();
    fireEvent.click(within(pane).getByRole("button", { name: "Delete this custom tool" }));
    const dialog = await screen.findByRole("dialog", { name: 'Delete "Word counter"?' });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith({ id: "ws-a", name: "Word counter" }));
    expect(deleteCalls()).toHaveLength(1);
  });

  it("a refusal keeps the dialog open with the route's reason", async () => {
    const reason = 'This workspace is the source of the extension "Word counter"; uninstall the extension first';
    wire({ del: () => okJson({ error: reason }, 409) });
    const { pane, onDeleted } = await renderPane();
    fireEvent.click(within(pane).getByRole("button", { name: "Delete this custom tool" }));
    const dialog = await screen.findByRole("dialog", { name: 'Delete "Word counter"?' });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toBe(`Not deleted: ${reason}.`);
    expect(screen.getByRole("dialog", { name: 'Delete "Word counter"?' })).toBeInTheDocument();
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it("any other failure is the calm line, with the cause in the title", async () => {
    wire({ del: () => okJson({ error: "sandbox unreachable" }, 502) });
    const { pane, onDeleted } = await renderPane();
    fireEvent.click(within(pane).getByRole("button", { name: "Delete this custom tool" }));
    const dialog = await screen.findByRole("dialog", { name: 'Delete "Word counter"?' });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toBe("Couldn't delete it. Something went wrong on the box. Try again in a moment.");
    expect(alert.getAttribute("title")).toContain("sandbox unreachable");
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it("switching to another tool clears a refusal left on the dialog", async () => {
    wire({ del: () => okJson({ error: "A run is still working in this workspace; cancel it first" }, 409) });
    const onDeleted = vi.fn();
    const { rerender } = render(<WorkspaceContext workspaceId="ws-a" live={false} onDeleted={onDeleted} />);
    const pane = await screen.findByTestId("workspace-context");
    await waitFor(() => expect(pane.textContent).toContain("proposal/0.1.0"));
    fireEvent.click(within(pane).getByRole("button", { name: "Delete this custom tool" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await within(dialog).findByRole("alert");
    rerender(<WorkspaceContext workspaceId="ws-b" live={false} onDeleted={onDeleted} />);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});

describe("Workshop — deleting a custom tool (the space)", () => {
  it("the tool leaves the rail, its pane closes, the composer and the URL stop pointing at it, and the open run is re-read", async () => {
    mockSearchParamsString = "run=run-9&workspace=ws-a";
    wire();
    const replaceState = vi.spyOn(window.history, "replaceState");
    render(<WorkshopSpace />);

    const pane = await screen.findByTestId("workspace-context");
    await waitFor(() => expect(pane.textContent).toContain("proposal/0.1.0"));
    expect(screen.getByRole("list", { name: "Custom tools" }).textContent).toContain("Word counter");
    await waitFor(() => expect(screen.getByTestId("workspace-picker")).toHaveAccessibleName("Work in: Word counter"));
    const runReadsBefore = authFetchMock.mock.calls.filter((c) => c[0] === "/api/agent-runs/run-9").length;

    fireEvent.click(within(pane).getByRole("button", { name: "Delete this custom tool" }));
    const dialog = await screen.findByRole("dialog", { name: 'Delete "Word counter"?' });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.queryByTestId("workspace-context")).toBeNull());
    await waitFor(() => expect(screen.queryByRole("list", { name: "Custom tools" })).toBeNull());
    expect(screen.getByText("No custom tools yet. Create one and give it a goal.")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-picker")).not.toHaveAccessibleName("Work in: Word counter");
    expect(screen.getByText('Deleted "Word counter".')).toBeInTheDocument();
    expect(String(replaceState.mock.calls.at(-1)?.[2])).not.toContain("workspace=");
    await waitFor(() =>
      expect(authFetchMock.mock.calls.filter((c) => c[0] === "/api/agent-runs/run-9").length).toBeGreaterThan(runReadsBefore),
    );
    expect(deleteCalls()).toHaveLength(1);
    replaceState.mockRestore();
  });
});
