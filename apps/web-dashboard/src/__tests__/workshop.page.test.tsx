/**
 * WARP-2925 (ADR-056) — `/workshop`.
 *
 *   1. Start a run: the goal is POSTed to /api/agent-runs as `{ goal }`, the
 *      field clears, and the panel opens the run the route answered with
 *      (its detail is fetched by id).
 *   2. A refused start (403 — the person's role may not start runs) renders
 *      the calm error with the cause in the title, and nothing crashes.
 *   3. `?run=<id>` opens that run on arrival — the deep link /admin/audit
 *      now forwards here.
 *   4. A family member reaching the page by URL gets honest copy and no form.
 *   5. The Start button stays disabled until there is a goal to send.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import React from "react";

const authFetchMock = vi.fn();
let mockRole: string = "owner";
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "u1", username: "alice", role: mockRole }, isLoading: false }),
  authFetch: (...args: unknown[]) => authFetchMock(...args),
}));

let mockSearchParamsString = "";
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(mockSearchParamsString),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/workshop",
}));

// ShellPage passthrough — the real shell pulls device/health SWR wiring this
// test doesn't exercise.
vi.mock("@/components/shell/ShellPage", () => ({
  ShellPage: ({ title, sub, children }: { title?: string; sub?: string; children: React.ReactNode }) => (
    <div className="droplet-shell">
      {title ? <h1>{title}</h1> : null}
      {sub ? <p>{sub}</p> : null}
      {children}
    </div>
  ),
}));

import WorkshopPage from "@/app/workshop/page";
import type { AgentRunDetail } from "@/components/workshop/agent-runs/api";

function okJson(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

function detail(id: string, goal: string): AgentRunDetail {
  return {
    id,
    goal,
    model: "m",
    status: "queued",
    iteration: 0,
    maxIter: 30,
    attempts: 0,
    createdAt: "2026-09-19T10:00:00.000Z",
    startedAt: null,
    endedAt: null,
    deadlineAt: null,
    result: null,
    stopReason: null,
    error: null,
    pending: null,
    trace: [],
  };
}

function calls(prefix: string) {
  return authFetchMock.mock.calls.filter((c) => typeof c[0] === "string" && (c[0] as string).startsWith(prefix));
}

beforeEach(() => {
  mockRole = "owner";
  mockSearchParamsString = "";
  authFetchMock.mockReset();
  authFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/api/agent-runs" && init?.method === "POST") return okJson({ id: "run-new", status: "queued" }, 201);
    if (url.startsWith("/api/agent-runs/schedules")) return okJson({ items: [] });
    if (url.startsWith("/api/agent-runs/")) {
      const id = decodeURIComponent(url.slice("/api/agent-runs/".length));
      return okJson(detail(id, `goal of ${id}`));
    }
    if (url.startsWith("/api/agent-runs")) return okJson({ items: [], nextCursor: null });
    return okJson({});
  });
});

afterEach(() => cleanup());

describe("/workshop (WARP-2925)", () => {
  it("starts a run: POSTs the goal, clears the field and opens the new run", async () => {
    render(<WorkshopPage />);
    const field = screen.getByLabelText("What should your Droplet do?") as HTMLTextAreaElement;
    const start = screen.getByRole("button", { name: /start run/i });
    expect(start).toBeDisabled();

    fireEvent.change(field, { target: { value: "  sort last week's scans  " } });
    expect(start).toBeEnabled();
    fireEvent.click(start);

    await waitFor(() => {
      expect(calls("/api/agent-runs").some((c) => (c[1] as RequestInit | undefined)?.method === "POST")).toBe(true);
    });
    const post = calls("/api/agent-runs").find((c) => (c[1] as RequestInit | undefined)?.method === "POST")!;
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({ goal: "sort last week's scans" });

    await waitFor(() => expect(field.value).toBe(""));
    expect(await screen.findByText(/run queued/i)).toBeInTheDocument();
    // The panel opened the run the route answered with.
    await waitFor(() => expect(calls("/api/agent-runs/run-new").length).toBeGreaterThan(0));
    expect(await screen.findByTestId("agent-run-detail")).toHaveTextContent("goal of run-new");
  });

  it("renders the calm error, with the cause in the title, when the start is refused", async () => {
    authFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/agent-runs" && init?.method === "POST")
        return okJson({ error: "Forbidden: role not permitted to use background runs" }, 403);
      if (url.startsWith("/api/agent-runs/schedules")) return okJson({ items: [] });
      return okJson({ items: [], nextCursor: null });
    });
    render(<WorkshopPage />);
    fireEvent.change(screen.getByLabelText("What should your Droplet do?"), { target: { value: "do a thing" } });
    fireEvent.click(screen.getByRole("button", { name: /start run/i }));

    const status = await screen.findByText("Something went wrong on the box. Try again in a moment.");
    expect(status).toHaveAttribute("title", expect.stringContaining("Forbidden"));
    // No run was opened — nothing to open.
    expect(calls("/api/agent-runs/run-").length).toBe(0);
    // The goal is kept so the person can try again, not silently discarded.
    expect((screen.getByLabelText("What should your Droplet do?") as HTMLTextAreaElement).value).toBe("do a thing");
  });

  it("?run=<id> opens that run on arrival", async () => {
    mockSearchParamsString = "run=run-7";
    render(<WorkshopPage />);
    await waitFor(() => expect(calls("/api/agent-runs/run-7").length).toBeGreaterThan(0));
    expect(await screen.findByTestId("agent-run-detail")).toHaveTextContent("goal of run-7");
  });

  it("tells a family member the page is for owners and admins, and offers no form", () => {
    mockRole = "family";
    render(<WorkshopPage />);
    expect(screen.getByRole("status")).toHaveTextContent(/owner and admins/i);
    expect(screen.queryByLabelText("What should your Droplet do?")).toBeNull();
    expect(calls("/api/agent-runs").length).toBe(0);
  });
});
