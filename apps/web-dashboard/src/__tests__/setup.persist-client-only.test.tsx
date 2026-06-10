/**
 * Setup-wizard audit — the persisted resume pointer must never be sent a
 * CLIENT-ONLY step.
 *
 * `twofactor` (PR #375) exists only in the wizard's client state machine — it
 * has no `SetupStep` Prisma-enum value / orchestrator `SETUP_STEPS` entry, so
 * `PATCH /api/setup/state {setup_step:"twofactor"}` is rejected 400
 * INVALID_SETUP_STEP. Because the persist is fire-and-forget
 * (`void patchSetupStep(next)` in `app/setup/page.tsx`), that 400 was SILENT:
 * the wizard advanced normally while the stored pointer stayed one step stale
 * ("org") — and nothing ever surfaced the rejection.
 *
 * Fix under test: the page maps every persisted step through `persistedStep`
 * (app/setup/page.tsx) — `twofactor` maps to null (nothing sent) and the
 * pointer catches up on the next persisted step (`wifi` persists as
 * "internet").
 *
 * Proven RED first: with the unguarded `void patchSetupStep(next)`, completing
 * org fires `patchSetupStep("twofactor")` and the first assertion fails.
 *
 * Same Vitest + JSDOM harness as setup.org.test.tsx / the PR #518 monotonic
 * test: drive the real chrome (forms + buttons), assert on the spied
 * `patchSetupStep`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import React from "react";

import { claimApiMocks, passClaimStep } from "./helpers/claim-step";

vi.mock("framer-motion", async () => {
  const actual =
    await vi.importActual<typeof import("framer-motion")>("framer-motion");
  return { ...actual, useReducedMotion: () => true };
});

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ setupState: undefined }),
}));

const patchSetupStepMock = vi.fn(async (_setupStep: string) => undefined);

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    setupAdmin: vi.fn(async () => undefined),
    loginUser: vi.fn(async () => undefined),
    patchSetupStep: (setupStep: string) => patchSetupStepMock(setupStep),
    ...claimApiMocks(),
    postOrg: vi.fn(async () => ({
      ok: true,
      slug: "acme",
      reserved_host: "droplet.local/acme",
      next_step: "internet",
    })),
    // Address step (post-redesign, after wifi) renders on an unconfigured
    // DuckDNS; wifi itself fetches nothing on mount.
    fetchDuckDnsStatus: vi.fn(async () => ({ configured: false })),
    setDuckDnsConfig: vi.fn(async () => ({ configured: false })),
    fetchDrives: vi.fn(async () => ({ drives: [], count: 0 })),
    fetchDiscoveredCameras: vi.fn(async () => []),
    fetchVpnStatus: vi.fn(async () => ({
      configured: false,
      endpointConfigured: false,
    })),
    fetchModels: vi.fn(async () => ({ models: [] })),
  };
});

import SetupPage from "@/app/setup/page";

/** Walk welcome → claim → account → org → submit org (lands on twofactor). */
async function advanceThroughOrg() {
  fireEvent.click(screen.getByRole("button", { name: /get started/i }));
  await passClaimStep();
  fireEvent.change(screen.getByPlaceholderText(/you@company\.com/i), {
    target: { value: "owner@warp.test" },
  });
  fireEvent.change(screen.getByPlaceholderText(/your name/i), {
    target: { value: "Robin" },
  });
  fireEvent.change(screen.getByPlaceholderText(/create a password/i), {
    target: { value: "Abcdefghijk1" },
  });
  fireEvent.change(screen.getByPlaceholderText(/repeat password/i), {
    target: { value: "Abcdefghijk1" },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /create account/i }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  fireEvent.change(screen.getByLabelText(/workspace name/i), {
    target: { value: "Acme HQ" },
  });
  fireEvent.change(screen.getByLabelText(/workspace url/i), {
    target: { value: "acme" },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("setup wizard — client-only steps are never persisted", () => {
  beforeEach(() => {
    patchSetupStepMock.mockReset();
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("never sends 'twofactor' to PATCH /api/setup/state, and catches up on 'internet'", async () => {
    render(<SetupPage />);
    await advanceThroughOrg();

    // We're on the client-only twofactor step — org's heading is gone.
    expect(
      screen.queryByText(/create your workspace/i),
    ).not.toBeInTheDocument();

    // The silent-400 step value must never be persisted.
    expect(patchSetupStepMock).not.toHaveBeenCalledWith("twofactor");

    // Skip 2FA → internet. The pointer catches up with a step the server
    // actually accepts.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
      await Promise.resolve();
    });
    expect(patchSetupStepMock).toHaveBeenCalledWith("internet");
    expect(patchSetupStepMock).not.toHaveBeenCalledWith("twofactor");
  });
});
