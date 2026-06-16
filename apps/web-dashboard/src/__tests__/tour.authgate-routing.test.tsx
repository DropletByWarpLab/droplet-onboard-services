/**
 * Onboarding Tour — AuthGate "ready + tour pending → tour" routing (stacks
 * on PR #372).
 *
 * #372 plumbed `userTourCompleted` through the auth context and the
 * `/api/setup/state` machine but left the AuthGate branch UNWIRED (a NOTE
 * documenting where it slots in) and shipped no `/tour` route. This PR wires
 * it: a claimed-but-tour-pending owner is routed to `/tour`; once the tour is
 * marked complete they pass through to the dashboard.
 *
 * Drives the REAL client seam — real AuthProvider.init() reading
 * `/api/setup/state`, real AuthGate routing decision — against an in-memory
 * store faithful to the orchestrator's snake_case `/api/setup/state` contract
 * (the route + markTourCompleted are unit-covered in
 * apps/orchestrator/src/routes/setup.test.ts).
 *
 * Proven RED first: with the branch unwired, a ready + tour-pending owner on
 * "/" is let straight through to the dashboard, so the "routes to /tour"
 * assertion fails (replace never called with "/tour").
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import React from "react";

const replaceMock = vi.fn();
let pathnameValue = "/";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn(), back: vi.fn() }),
  usePathname: () => pathnameValue,
}));

// Sidebar drags in a wide provider tree; stub it so AuthGate's authenticated
// branch renders in isolation.
vi.mock("@/components/Sidebar", () => ({ Sidebar: () => null }));

// ── In-memory server implementing the /api/setup/state contract ──
// Mirrors apps/orchestrator/src/routes/setup.ts: snake_case wire; the
// caller seeds the starting row (a ready appliance whose tour may or may
// not be complete).
function createSetupStateServer(seed: {
  state: "unclaimed" | "ready";
  setup_step: string;
  user_tour_completed: boolean;
}) {
  const row = { ...seed };
  const json = (status: number, body: unknown): Response =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as Response;

  return {
    peek: () => ({ ...row }),
    fetch: async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/auth/me")) {
        return json(200, {
          id: "u1",
          username: "owner",
          displayName: "Robin",
          role: "owner",
        });
      }
      if (!url.includes("/api/setup/state")) {
        return json(200, {});
      }
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "PATCH") {
        const body = init?.body ? JSON.parse(init.body as string) : {};
        if (body.appliance === "ready") {
          row.state = "ready";
          row.setup_step = "done";
        }
        if (typeof body.setup_step === "string") row.setup_step = body.setup_step;
        if (body.user_tour_completed === true) row.user_tour_completed = true;
      }
      return json(200, {
        appliance: row.state,
        setup_step: row.setup_step,
        user_tour_completed: row.user_tour_completed,
      });
    },
  };
}

import { AuthProvider } from "@/lib/auth";
import { AuthGate } from "@/components/AuthGate";

function seedAuthedOwner() {
  localStorage.setItem(
    "droplet-auth-user",
    JSON.stringify({
      id: "u1",
      username: "owner",
      displayName: "Robin",
      role: "owner",
    }),
  );
}

beforeEach(() => {
  replaceMock.mockReset();
  pathnameValue = "/";
  seedAuthedOwner();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  localStorage.clear();
});

describe("AuthGate tour routing (ready + tour pending → /tour)", () => {
  it("routes a claimed-but-tour-pending owner from / to /tour", async () => {
    const server = createSetupStateServer({
      state: "ready",
      setup_step: "done",
      user_tour_completed: false,
    });
    vi.stubGlobal("fetch", server.fetch);
    pathnameValue = "/";

    await act(async () => {
      render(
        <AuthProvider>
          <AuthGate>
            <div>dashboard-home</div>
          </AuthGate>
        </AuthProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith("/tour");
    });
  });

  it("does NOT route to /tour once the tour is complete — dashboard renders", async () => {
    const server = createSetupStateServer({
      state: "ready",
      setup_step: "done",
      user_tour_completed: true,
    });
    vi.stubGlobal("fetch", server.fetch);
    pathnameValue = "/";

    await act(async () => {
      render(
        <AuthProvider>
          <AuthGate>
            <div>dashboard-home</div>
          </AuthGate>
        </AuthProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByText("dashboard-home")).toBeInTheDocument();
    });
    expect(replaceMock).not.toHaveBeenCalledWith("/tour");
  });

  it("does NOT bounce away from /tour while the tour is pending", async () => {
    const server = createSetupStateServer({
      state: "ready",
      setup_step: "done",
      user_tour_completed: false,
    });
    vi.stubGlobal("fetch", server.fetch);
    pathnameValue = "/tour";

    await act(async () => {
      render(
        <AuthProvider>
          <AuthGate>
            <div>tour-screen</div>
          </AuthGate>
        </AuthProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    // The user is allowed to sit on /tour — no redirect back to / or to /tour
    // (already there). The tour content renders.
    await waitFor(() => {
      expect(screen.getByText("tour-screen")).toBeInTheDocument();
    });
    expect(replaceMock).not.toHaveBeenCalledWith("/");
  });
});
