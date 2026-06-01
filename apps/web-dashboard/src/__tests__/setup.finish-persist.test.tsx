/**
 * PR #372 regression — the wizard-FINISH → server-PERSIST → REFRESH seam.
 *
 * The reviewer caught that the wizard never marked the appliance `ready`
 * SERVER-side: `DoneStep` only rendered the flourish + redirected, and the
 * only writers of `appliance:"ready"` were the in-memory optimistic setters
 * in `lib/auth.tsx`. So `ApplianceSetup.state` stayed `"unclaimed"` forever →
 * the next hard refresh read `unclaimed` and re-trapped the owner in the
 * first-run wizard (`AuthGate` → `/setup`), with no path back to `ready`.
 *
 * This test drives the REAL client seam end-to-end — NOT a seeded mock:
 *   real DoneStep  →  real AuthProvider.completeSetup()  →
 *   real lib/api.patchSetupReady()  →  PATCH /api/setup/state over the wire
 * The server side is an in-memory store that implements the SAME
 * `/api/setup/state` contract the orchestrator route enforces (the real
 * route + markApplianceReady are covered, including the finish-persist +
 * idempotence assertions, in apps/orchestrator/src/routes/setup.test.ts).
 * The store starts `unclaimed`; the ONLY thing that can flip it to `ready`
 * is the client code under test actually firing the finish PATCH.
 *
 * Two assertions, mirroring the reviewer's uncovered seam:
 *   1. finishing the wizard PERSISTS `state === "ready"` server-side; and
 *   2. a fresh AuthProvider.init() reads that `ready` state and AuthGate
 *      routes to `/` (dashboard) — NOT back into `/setup`.
 *
 * Proven RED first: with DoneStep firing no PATCH and completeSetup doing
 * only the in-memory flip, the store never leaves `unclaimed`, so (1) fails
 * (store still `unclaimed`) and (2) fails (AuthGate redirects to `/setup`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import React from "react";

// Force WelcomeFlourish's reduced-motion path so DoneStep renders
// synchronously (no fake timers needed to reach the asserted state).
vi.mock("framer-motion", async () => {
  const actual =
    await vi.importActual<typeof import("framer-motion")>("framer-motion");
  return { ...actual, useReducedMotion: () => true };
});

// next/navigation: capture replace() so we can assert AuthGate's routing
// decision, and keep pathname controllable across the refresh re-mount.
const replaceMock = vi.fn();
let pathnameValue = "/";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn(), back: vi.fn() }),
  usePathname: () => pathnameValue,
}));

// Sidebar drags in a wide provider tree; stub to a marker so AuthGate's
// authenticated branch renders in isolation.
vi.mock("@/components/Sidebar", () => ({ Sidebar: () => null }));

// ── In-memory server implementing the /api/setup/state contract ──
// Faithful to apps/orchestrator/src/routes/setup.ts: snake_case wire,
// PATCH { appliance: "ready" } flips the explicit state column to "ready"
// and lands setup_step on "done"; GET returns the persisted state. Starts
// at the documented unclaimed/welcome baseline.
function createSetupStateServer() {
  const row = {
    state: "unclaimed" as "unclaimed" | "ready",
    setup_step: "welcome",
    user_tour_completed: false,
  };
  const json = (status: number, body: unknown): Response =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as Response;

  return {
    peek: () => ({ ...row }),
    fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/auth/me")) {
        // Post-finish refresh: the owner auto-logged-in at the account step,
        // so the session cookie is valid and /api/auth/me returns the user.
        return json(200, {
          id: "u1",
          username: "owner",
          displayName: "Robin",
          role: "owner",
        });
      }
      if (!url.includes("/api/setup/state")) {
        // Any other probe on init — benign empty 200.
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

import { AuthProvider, useAuth } from "@/lib/auth";
import { AuthGate } from "@/components/AuthGate";
import { DoneStep } from "@/components/setup/steps/DoneStep";

let server: ReturnType<typeof createSetupStateServer>;

beforeEach(() => {
  replaceMock.mockReset();
  pathnameValue = "/setup";
  server = createSetupStateServer();
  vi.stubGlobal("fetch", server.fetch);
  // A signed-in owner is already present by the time the wizard reaches
  // `done` (the account step auto-logs-in). Pre-seed the cached profile so
  // the refreshed AuthProvider hydrates a user without a live session.
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

describe("wizard finish → persist `ready` server-side → refresh routes to dashboard (PR #372)", () => {
  it("persists state === \"ready\" on the server when the wizard reaches done", async () => {
    // Render the terminal DoneStep inside the real AuthProvider so its real
    // completeSetup() runs. No seeded `ready` — the store starts unclaimed.
    render(
      <AuthProvider>
        <DoneStep displayName="Robin" discoveredCount={0} />
      </AuthProvider>,
    );

    // The finish transition must reach the SERVER. Today nothing fires the
    // PATCH, so the store stays unclaimed and this fails RED.
    await waitFor(() => {
      expect(server.peek().state).toBe("ready");
    });
    expect(server.peek().setup_step).toBe("done");
  });

  it("a fresh AuthProvider reads the persisted `ready` and AuthGate routes to / (not /setup)", async () => {
    // 1. Finish the wizard (drives the real persist).
    const finish = render(
      <AuthProvider>
        <DoneStep displayName="Robin" discoveredCount={0} />
      </AuthProvider>,
    );
    await waitFor(() => expect(server.peek().state).toBe("ready"));
    finish.unmount();

    // 2. Hard refresh: a brand-new AuthProvider.init() hits GET
    // /api/setup/state and must observe the persisted `ready` state. The
    // owner is on "/" post-redirect; AuthGate must NOT bounce to /setup.
    pathnameValue = "/";
    await act(async () => {
      render(
        <AuthProvider>
          <AuthGate>
            <div>dashboard-home</div>
          </AuthGate>
        </AuthProvider>,
      );
      // flush init()'s /api/setup/state + /api/auth/me probes
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByText("dashboard-home")).toBeInTheDocument();
    });
    // The regression symptom: re-trapped in the wizard. Must NOT happen.
    expect(replaceMock).not.toHaveBeenCalledWith("/setup");
  });
});
