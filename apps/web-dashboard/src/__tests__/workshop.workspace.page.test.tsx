/**
 * WARP-2896 (ADR-056 §6.2) — `/workshop/<id>` and the workspace half of `/workshop`.
 *
 *   1. The workspace page reads detail, history, changes and the last output
 *      from `/api/workspace/:id{,/log,/diff,/output}` and shows them: the
 *      branch and head, the proposal tag once there is one, the runs that
 *      worked here, the commits, the diff, the last command's verdict.
 *   2. One of the three reads failing blanks that section alone.
 *   3. A 404 is "No workspace with that id"; a bad id never fetches.
 *   4. On /workshop, choosing a workspace under "Work in" makes the start
 *      POST carry `workspaceId`; the plain form still sends `{ goal }` alone
 *      (workshop.page.test.tsx pins that side).
 *   5. "New workspace" POSTs name + template and preselects the result.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import React from "react";

const authFetchMock = vi.fn();
let mockRole = "owner";
let mockAuthLoading = false;
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "u1", username: "alice", role: mockRole }, isLoading: mockAuthLoading }),
  authFetch: (...args: unknown[]) => authFetchMock(...args),
}));

let mockParams: Record<string, string> = { workspaceId: "ws-a" };
let mockSearchParamsString = "";
vi.mock("next/navigation", () => ({
  useParams: () => mockParams,
  useSearchParams: () => new URLSearchParams(mockSearchParamsString),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/workshop/ws-a",
}));

vi.mock("@/components/shell/ShellPage", () => ({
  ShellPage: ({ title, children }: { title?: string; children: React.ReactNode }) => (
    <div className="droplet-shell">
      {title ? <h1>{title}</h1> : null}
      {children}
    </div>
  ),
}));

import WorkspacePage from "@/app/workshop/[workspaceId]/page";
import WorkshopPage from "@/app/workshop/page";

function okJson(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

const DETAIL = {
  id: "ws-a",
  name: "Word counter",
  template: "python-tool",
  status: "proposed",
  proposedTag: "proposal/0.1.0",
  proposedAt: "2026-09-20T10:00:00.000Z",
  createdAt: "2026-09-20T09:00:00.000Z",
  updatedAt: "2026-09-20T10:00:00.000Z",
  userId: "u1",
  git: { id: "ws-a", branch: "work", head: "0123456789abcdef0123", dirty: true, tags: ["proposal/0.1.0"] },
  runs: [
    { id: "run-1", status: "succeeded", goal: "build a word counter", stopReason: "proposed", createdAt: "2026-09-20T09:30:00.000Z", endedAt: "2026-09-20T10:00:00.000Z" },
  ],
};

function calls(prefix: string) {
  return authFetchMock.mock.calls.filter((c) => typeof c[0] === "string" && (c[0] as string).startsWith(prefix));
}

let created: Array<Record<string, unknown>> = [];

beforeEach(() => {
  mockRole = "owner";
  mockAuthLoading = false;
  mockParams = { workspaceId: "ws-a" };
  mockSearchParamsString = "";
  created = [];
  authFetchMock.mockReset();
  authFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/api/workspace/ws-a") return okJson(DETAIL);
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
    if (url === "/api/workspace/templates") return okJson({ templates: ["python-tool", "typescript-tool"] });
    if (url === "/api/workspace" && init?.method === "POST") {
      created.push({ ...DETAIL, id: "new-ws-abc123", name: "New one", template: "typescript-tool", status: "active", proposedTag: null, lastRun: null });
      return okJson({ id: "new-ws-abc123", name: "New one", status: "active" }, 201);
    }
    if (url === "/api/workspace") return okJson({ workspaces: [{ ...DETAIL, status: "active", proposedTag: null, lastRun: null }, ...created] });
    if (url === "/api/agent-runs" && init?.method === "POST") return okJson({ id: "run-new", status: "queued", workspaceId: "ws-a" }, 201);
    if (url.startsWith("/api/agent-runs/schedules")) return okJson({ items: [] });
    if (url.startsWith("/api/agent-runs/")) return okJson({ id: "run-new", goal: "g", model: "m", status: "queued", iteration: 0, maxIter: 5, attempts: 0, createdAt: "2026-09-20T10:00:00.000Z", startedAt: null, endedAt: null, deadlineAt: null, result: null, stopReason: null, error: null, pending: null, trace: [] });
    if (url.startsWith("/api/agent-runs")) return okJson({ items: [], nextCursor: null });
    return okJson({});
  });
});

afterEach(() => cleanup());

describe("/workshop/<id> (WARP-2896)", () => {
  it("shows the branch, the proposal, the runs, the history, the diff and the last command", async () => {
    render(<WorkspacePage />);
    expect(await screen.findByRole("heading", { level: 2, name: "Word counter" })).toBeInTheDocument();
    expect(screen.getByTestId("workspace-status")).toHaveTextContent("Proposed");
    expect(screen.getByText("proposal/0.1.0", { selector: "dd code" })).toBeInTheDocument();
    expect(screen.getByText("0123456789ab")).toBeInTheDocument();
    expect(screen.getByText(/uncommitted changes/)).toBeInTheDocument();
    expect(screen.getByTestId("clone-url")).toHaveTextContent("/git/ws-a.git");

    const runs = screen.getByRole("list", { name: "Runs in this workspace" });
    expect(within(runs).getByText("build a word counter")).toHaveAttribute("href", "/workshop?run=run-1");
    expect(within(runs).getByText("proposed")).toBeInTheDocument();

    const commits = await screen.findByRole("list", { name: "Commits" });
    expect(within(commits).getAllByRole("listitem")).toHaveLength(2);
    expect(within(commits).getByText("propose Word counter 0.1.0")).toBeInTheDocument();
    expect(within(commits).getByText("proposal")).toBeInTheDocument();

    expect(await screen.findByTestId("workspace-diff")).toHaveTextContent("+print(1)");
    expect(await screen.findByTestId("last-run-verdict")).toHaveTextContent("passed");
    expect(screen.getByTestId("last-run-output")).toHaveTextContent("2 passed");
    // A proposed workspace offers no "start a run" door.
    expect(screen.queryByRole("link", { name: /start a run here/i })).toBeNull();
  });

  it("an active, idle workspace offers to start a run here, preselected", async () => {
    authFetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/workspace/ws-a") return okJson({ ...DETAIL, status: "active", proposedTag: null, runs: [] });
      if (url.startsWith("/api/workspace/ws-a/output")) return okJson({ lastRun: null });
      if (url.startsWith("/api/workspace/ws-a/diff")) return okJson({ base: "HEAD", diff: "", truncated: false });
      return okJson({ entries: [] });
    });
    render(<WorkspacePage />);
    const door = await screen.findByRole("link", { name: /start a run here/i });
    expect(door).toHaveAttribute("href", "/workshop?workspace=ws-a");
    expect(screen.getByText("No command has run here yet.")).toBeInTheDocument();
    expect(screen.getByText(/Nothing uncommitted/)).toBeInTheDocument();
  });

  it("one failing read blanks its own section only", async () => {
    authFetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/workspace/ws-a") return okJson(DETAIL);
      if (url.startsWith("/api/workspace/ws-a/log")) return okJson({ error: "the sandbox could not be reached" }, 502);
      if (url.startsWith("/api/workspace/ws-a/diff")) return okJson({ base: "HEAD", diff: "+x\n", truncated: true });
      if (url.startsWith("/api/workspace/ws-a/output")) return okJson({ lastRun: null });
      return okJson({});
    });
    render(<WorkspacePage />);
    expect(await screen.findByText("No commits yet.")).toBeInTheDocument();
    expect(await screen.findByTestId("workspace-diff")).toHaveTextContent("(truncated)");
  });

  it("a 404 says so; a malformed id never fetches", async () => {
    authFetchMock.mockImplementation(async () => okJson({ error: "No such workspace" }, 404));
    render(<WorkspacePage />);
    expect(await screen.findByText("No workspace with that id.")).toBeInTheDocument();
    cleanup();
    authFetchMock.mockClear();
    mockParams = { workspaceId: "../etc" };
    render(<WorkspacePage />);
    expect(screen.getByText("That is not a workspace id.")).toBeInTheDocument();
    expect(authFetchMock).not.toHaveBeenCalled();
  });

  it("a family member gets the honest copy and no fetch", () => {
    mockRole = "family";
    render(<WorkspacePage />);
    expect(screen.getByRole("status")).toHaveTextContent(/owner and admins/i);
    expect(authFetchMock).not.toHaveBeenCalled();
  });
});

describe("/workshop — the workspace half (WARP-2896)", () => {
  it("lists workspaces, and choosing one under 'Work in' makes the start POST a workshop run", async () => {
    render(<WorkshopPage />);
    const list = await screen.findByRole("list", { name: "Workspaces" });
    expect(within(list).getByText("Word counter")).toHaveAttribute("href", "/workshop/ws-a");

    const select = (await screen.findByTestId("workspace-select")) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(2));
    fireEvent.change(select, { target: { value: "ws-a" } });
    expect(screen.getByText(/A workshop run:/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("What should your Droplet do?"), { target: { value: "count words" } });
    fireEvent.click(screen.getByRole("button", { name: /start run/i }));
    await waitFor(() => expect(calls("/api/agent-runs").some((c) => (c[1] as RequestInit | undefined)?.method === "POST")).toBe(true));
    const post = calls("/api/agent-runs").find((c) => (c[1] as RequestInit | undefined)?.method === "POST")!;
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({ goal: "count words", workspaceId: "ws-a" });
    expect(await screen.findByText(/Workshop run queued/)).toBeInTheDocument();
  });

  it("?workspace=<id> preselects it", async () => {
    mockSearchParamsString = "workspace=ws-a";
    render(<WorkshopPage />);
    const select = (await screen.findByTestId("workspace-select")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("ws-a"));
  });

  it("'New workspace' POSTs name + template and preselects the result", async () => {
    render(<WorkshopPage />);
    const form = await screen.findByRole("form", { name: "New workspace" });
    const template = (await screen.findByTestId("template-select")) as HTMLSelectElement;
    await waitFor(() => expect(template.value).toBe("python-tool"));
    fireEvent.change(template, { target: { value: "typescript-tool" } });
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "  New one  " } });
    fireEvent.click(within(form).getByRole("button", { name: /new workspace/i }));
    await waitFor(() => expect(calls("/api/workspace").some((c) => (c[1] as RequestInit | undefined)?.method === "POST")).toBe(true));
    const post = calls("/api/workspace").find((c) => (c[1] as RequestInit | undefined)?.method === "POST")!;
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({ name: "New one", template: "typescript-tool" });
    expect(await screen.findByText(/is ready/)).toBeInTheDocument();
    const select = screen.getByTestId("workspace-select") as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("new-ws-abc123"));
  });
});
