/**
 * WARP-1306 — the Projects "module off" state offers the enable path.
 *
 * With /api/capabilities now mirroring the module-toggles effective state
 * (projects ships defaultEnabled:false), this screen is what a customer sees
 * instead of a New-project dialog whose POST dies on `module_disabled`.
 * The orchestrator already exposes the enable path — PATCH
 * /api/admin/modules/projects, owner/admin only — so the screen must not
 * dead-end an owner on "An owner or admin can turn it on". Validates:
 *
 *   1. owner/admin → a working "Turn on Projects" button that PATCHes the
 *      module on and flips the /api/capabilities SWR cache so the workspace
 *      appears without waiting out the 30 s HTTP cache.
 *   2. non-admin roles → the honest "an owner or admin can turn it on" copy
 *      and NO enable button (the server would 403 it anyway).
 *   3. a failed enable → calm inline error, no crash, button usable again.
 *   4. WARP-2578 — that flip MERGES. It used to write `{ projects: true }`
 *      over the whole cache entry, blanking `crm`/`contacts` for every
 *      other reader of the key until the 10-minute probe came round.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import React from "react";
import type { AppCapabilities } from "@/lib/api";

const setAppModuleEnabledMock = vi.fn();
const mutateMock = vi.fn();

const authState: { role: string } = { role: "owner" };
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { id: "u1", username: "ada", displayName: "Ada", role: authState.role },
    isLoading: false,
  }),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    setAppModuleEnabled: (...a: unknown[]) => setAppModuleEnabledMock(...a),
  };
});

vi.mock("swr", async () => {
  const actual = await vi.importActual<typeof import("swr")>("swr");
  return {
    ...actual,
    mutate: (...a: unknown[]) => mutateMock(...a),
  };
});

vi.mock("@/components/shell/ShellPage", () => ({
  ShellPage: ({ title, children }: any) => (
    <div>
      {title ? <h1>{title}</h1> : null}
      {children}
    </div>
  ),
}));

import { ProjectsDisabled } from "./ProjectsDisabled";

describe("ProjectsDisabled — enable path (WARP-1306)", () => {
  beforeEach(() => {
    cleanup();
    setAppModuleEnabledMock.mockReset();
    mutateMock.mockReset();
    authState.role = "owner";
  });

  it.each(["owner", "admin"])(
    "offers a working 'Turn on Projects' button to %s",
    async (role) => {
      authState.role = role;
      setAppModuleEnabledMock.mockResolvedValue(undefined);
      render(<ProjectsDisabled />);

      expect(
        screen.getByText(/projects isn't enabled on this droplet/i),
      ).toBeInTheDocument();
      const btn = screen.getByRole("button", { name: /turn on projects/i });
      await act(async () => {
        fireEvent.click(btn);
        await Promise.resolve();
      });

      expect(setAppModuleEnabledMock).toHaveBeenCalledWith("projects", true);
      // The capabilities cache flips through an UPDATER, not a replacement
      // value — see the merged-result assertions below.
      expect(mutateMock).toHaveBeenCalledWith(
        "/api/capabilities",
        expect.any(Function),
        { revalidate: false },
      );

      // With nothing cached yet, the write lands on the hook's documented
      // per-flag defaults — NOT `undefined` for the flags it doesn't own.
      const update = mutateMock.mock.calls[0][1] as
        (prev: AppCapabilities | undefined) => AppCapabilities;
      expect(update(undefined)).toEqual({
        projects: true,
        crm: false,
        contacts: false,
      });
    },
  );

  // WARP-2578 — the regression this closes. A whole-object replace here
  // switched the CRM off for the rest of the probe window; once /customers
  // is a nav-visible route gated on `crm` (ADR-044/WARP-2558), that shows up
  // as the Customers entry vanishing from the sidebar.
  it("preserves the other capability flags already in the cache", async () => {
    setAppModuleEnabledMock.mockResolvedValue(undefined);
    render(<ProjectsDisabled />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /turn on projects/i }));
      await Promise.resolve();
    });

    const update = mutateMock.mock.calls[0][1] as
      (prev: AppCapabilities | undefined) => AppCapabilities;

    expect(
      update({ projects: false, crm: true, contacts: true }),
    ).toEqual({ projects: true, crm: true, contacts: true });
  });

  it.each(["family", "guest"])(
    "shows the owner/admin copy and no enable button to %s",
    (role) => {
      authState.role = role;
      render(<ProjectsDisabled />);

      expect(
        screen.getByText(/an owner or admin can turn it on/i),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /turn on projects/i }),
      ).not.toBeInTheDocument();
      expect(setAppModuleEnabledMock).not.toHaveBeenCalled();
    },
  );

  it("surfaces a calm inline error when enabling fails, and stays usable", async () => {
    setAppModuleEnabledMock.mockRejectedValue(new Error("boom"));
    render(<ProjectsDisabled />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /turn on projects/i }));
      await Promise.resolve();
    });

    expect(screen.getByText(/couldn't turn on projects/i)).toBeInTheDocument();
    expect(mutateMock).not.toHaveBeenCalled();
    // Recoverable — the button is still there and re-clickable.
    const btn = screen.getByRole("button", { name: /turn on projects/i });
    expect(btn).toBeEnabled();

    setAppModuleEnabledMock.mockResolvedValue(undefined);
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
    });
    expect(mutateMock).toHaveBeenCalled();
  });
});
