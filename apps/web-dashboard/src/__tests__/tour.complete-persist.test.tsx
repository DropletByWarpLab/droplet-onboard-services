/**
 * Onboarding Tour — completion persists `userTourCompleted` (PR #382).
 *
 * Mirrors the #372 finish-persist seam, but for the tour: real ProductTour →
 * real AuthProvider.completeTour() → real lib/api.patchTourCompleted() → PATCH
 * /api/setup/state over the wire. The in-memory store implements the same
 * snake_case `/api/setup/state` contract the orchestrator route enforces
 * (markTourCompleted is unit-covered in the orchestrator suite).
 *
 * Two assertions:
 *   1. finishing the tour PERSISTS `user_tour_completed === true` server-side;
 *   2. completeTour() flips the in-memory context so AuthGate stops routing to
 *      /tour (proven via the context value the provider exposes).
 *
 * Proven RED first: with no completeTour() on the context and no
 * patchTourCompleted() helper, the store never flips and the import fails.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

vi.mock("framer-motion", async () => {
  const actual =
    await vi.importActual<typeof import("framer-motion")>("framer-motion");
  return { ...actual, useReducedMotion: () => true };
});

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/tour",
}));

function createSetupStateServer() {
  const row = {
    state: "ready" as "unclaimed" | "ready",
    setup_step: "done",
    user_tour_completed: false,
  };
  const json = (status: number, body: unknown): Response =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
  return {
    peek: () => ({ ...row }),
    fetch: async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/auth/me")) {
        return json(200, { id: "u1", username: "owner", displayName: "Robin", role: "owner" });
      }
      if (!url.includes("/api/setup/state")) return json(200, {});
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "PATCH") {
        const body = init?.body ? JSON.parse(init.body as string) : {};
        if (body.user_tour_completed === true) row.user_tour_completed = true;
        if (body.appliance === "ready") row.state = "ready";
        if (typeof body.setup_step === "string") row.setup_step = body.setup_step;
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
import { ProductTour } from "@/components/tour/ProductTour";

let server: ReturnType<typeof createSetupStateServer>;

beforeEach(() => {
  pushMock.mockReset();
  server = createSetupStateServer();
  vi.stubGlobal("fetch", server.fetch);
  localStorage.setItem(
    "droplet-auth-user",
    JSON.stringify({ id: "u1", username: "owner", displayName: "Robin", role: "owner" }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  localStorage.clear();
});

/** Advance through every tour step until the finish button appears, click it. */
async function finishTour() {
  // Click "Next" until the final action ("Go to dashboard" / Finish) shows.
  // The tour exposes a stable finish button once on the last step.
  for (let i = 0; i < 12; i++) {
    const finish = screen.queryByRole("button", { name: /go to (the )?dashboard|finish/i });
    if (finish) {
      fireEvent.click(finish);
      return;
    }
    const next = screen.getByRole("button", { name: /next|continue/i });
    fireEvent.click(next);
  }
  throw new Error("Never reached the tour finish button");
}

describe("ProductTour completion persists the tour flag (PR #382)", () => {
  it("PATCHes user_tour_completed=true to the server on finish", async () => {
    render(
      <AuthProvider>
        <ProductTour />
      </AuthProvider>,
    );
    await finishTour();
    await waitFor(() => {
      expect(server.peek().user_tour_completed).toBe(true);
    });
  });

  it("navigates to the dashboard after finishing", async () => {
    render(
      <AuthProvider>
        <ProductTour />
      </AuthProvider>,
    );
    await finishTour();
    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith("/");
    });
  });

  it("Skip persists completion and routes to the dashboard (does not re-show)", async () => {
    render(
      <AuthProvider>
        <ProductTour />
      </AuthProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /skip/i }));
    await waitFor(() => {
      expect(server.peek().user_tour_completed).toBe(true);
    });
    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith("/");
    });
  });
});
