/**
 * WARP-2925 → WARP-2974 (ADR-056) — `/workshop` and `/workshop/<id>`.
 *
 *   1. An owner gets the space (the composer is there; `?run=` opens a run).
 *   2. A family member reaching the page by URL gets honest copy, no
 *      composer, and no fetch.
 *   3. While auth is still loading, nobody gets the space — the loading card
 *      renders and the space's mount fetches (GET /api/agent-runs,
 *      /api/workspace, the schedules) never fire before the role is known.
 *   4. `/workshop/<id>` forwards to `/workshop?workspace=<id>`; a malformed
 *      id forwards to the bare Workshop.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import React from "react";

const authFetchMock = vi.fn();
let mockRole: string = "owner";
let mockAuthLoading = false;
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "u1", username: "alice", role: mockRole }, isLoading: mockAuthLoading }),
  authFetch: (...args: unknown[]) => authFetchMock(...args),
}));

let mockSearchParamsString = "";
let mockParams: Record<string, string> = { workspaceId: "ws-a" };
const replaceMock = vi.fn();
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(mockSearchParamsString),
  useParams: () => mockParams,
  useRouter: () => ({ push: vi.fn(), replace: replaceMock }),
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
import WorkspaceForward from "@/app/workshop/[workspaceId]/page";
import { forwardTarget } from "@/components/workshop/forward";

function okJson(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

function calls(prefix: string) {
  return authFetchMock.mock.calls.filter((c) => typeof c[0] === "string" && (c[0] as string).startsWith(prefix));
}

beforeEach(() => {
  mockRole = "owner";
  mockAuthLoading = false;
  mockSearchParamsString = "";
  mockParams = { workspaceId: "ws-a" };
  replaceMock.mockReset();
  authFetchMock.mockReset();
  authFetchMock.mockImplementation(async (url: string) => {
    if (url.startsWith("/api/agent-runs/schedules")) return okJson({ schedules: [] });
    if (url.startsWith("/api/agent-runs/")) {
      const id = decodeURIComponent(url.slice("/api/agent-runs/".length));
      return okJson({
        id,
        goal: `goal of ${id}`,
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
      });
    }
    if (url.startsWith("/api/agent-runs")) return okJson({ items: [], nextCursor: null });
    if (url === "/api/workspace") return okJson({ workspaces: [] });
    return okJson({});
  });
});

afterEach(() => cleanup());

describe("/workshop (WARP-2974)", () => {
  it("an owner gets the space, and ?run=<id> opens that run on arrival", async () => {
    mockSearchParamsString = "run=run-7";
    render(<WorkshopPage />);
    expect(screen.getByLabelText("What should your Droplet do?")).toBeInTheDocument();
    await waitFor(() => expect(calls("/api/agent-runs/run-7").length).toBeGreaterThan(0));
    expect(await screen.findByTestId("agent-run-detail")).toHaveTextContent("goal of run-7");
  });

  it("tells a family member the page is for owners and admins, and offers no composer", () => {
    mockRole = "family";
    render(<WorkshopPage />);
    expect(screen.getByRole("status")).toHaveTextContent(/owner and admins/i);
    expect(screen.queryByLabelText("What should your Droplet do?")).toBeNull();
    expect(calls("/api/").length).toBe(0);
  });

  it.each(["family", "guest", "owner"])("while auth is still loading, a %s visitor sees the loading card and nothing is fetched", (role) => {
    mockRole = role;
    mockAuthLoading = true;
    render(<WorkshopPage />);
    const loading = screen.getByText("Loading…");
    expect(loading).toHaveAttribute("aria-busy", "true");
    expect(loading).toHaveClass("card");
    expect(screen.queryByLabelText("What should your Droplet do?")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(calls("/api/").length).toBe(0);
  });
});

describe("/workshop/<id> forwards into the space (WARP-2974)", () => {
  it("replaces the route with ?workspace=<id>", async () => {
    render(<WorkspaceForward />);
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/workshop?workspace=ws-a"));
    expect(calls("/api/").length).toBe(0);
  });

  it("a malformed id forwards to the bare Workshop, never to a query it could not satisfy", () => {
    expect(forwardTarget("../etc")).toBe("/workshop");
    expect(forwardTarget("")).toBe("/workshop");
    expect(forwardTarget(undefined)).toBe("/workshop");
    expect(forwardTarget("ws-a")).toBe("/workshop?workspace=ws-a");
  });
});
