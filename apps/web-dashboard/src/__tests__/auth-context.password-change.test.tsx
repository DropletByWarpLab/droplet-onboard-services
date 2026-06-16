/**
 * WARP-824 — auth context surfaces user.mustChangePassword and exposes
 * markPasswordChanged() to flip it false (optimistic) after a successful
 * change, so AuthGate lets the user into the dashboard without a round-trip.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";

// api.ts is a module cycle with auth.tsx; stub the two patch helpers it pulls.
vi.mock("@/lib/api", () => ({
  patchSetupReady: vi.fn().mockResolvedValue(undefined),
  patchTourCompleted: vi.fn().mockResolvedValue(undefined),
}));

import { AuthProvider, useAuth } from "@/lib/auth";

// A tiny probe that renders the must-change flag and a button to clear it.
function Probe() {
  const { user, markPasswordChanged } = useAuth();
  return (
    <div>
      <span data-testid="must">{String(user?.mustChangePassword)}</span>
      <button onClick={() => markPasswordChanged()}>clear</button>
    </div>
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  // /api/auth/me returns a must-change user; /api/setup/state any ready shape.
  vi.spyOn(global, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/auth/me")) {
      return {
        ok: true,
        json: async () => ({
          id: "u1",
          username: "kid",
          displayName: "Kid",
          role: "family",
          mustChangePassword: true,
        }),
      } as Response;
    }
    if (url.includes("/api/setup/state")) {
      return {
        ok: true,
        json: async () => ({ appliance: "ready", setup_step: "done", user_tour_completed: true }),
      } as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  });
  // jsdom localStorage
  vi.stubGlobal("localStorage", {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  });
});

describe("auth context — mustChangePassword", () => {
  it("hydrates user.mustChangePassword from /api/auth/me", async () => {
    await act(async () => {
      render(
        <AuthProvider>
          <Probe />
        </AuthProvider>,
      );
    });
    expect(screen.getByTestId("must").textContent).toBe("true");
  });

  it("markPasswordChanged() flips the in-memory flag to false", async () => {
    await act(async () => {
      render(
        <AuthProvider>
          <Probe />
        </AuthProvider>,
      );
    });
    expect(screen.getByTestId("must").textContent).toBe("true");

    await act(async () => {
      screen.getByText("clear").click();
    });
    expect(screen.getByTestId("must").textContent).toBe("false");
  });
});
