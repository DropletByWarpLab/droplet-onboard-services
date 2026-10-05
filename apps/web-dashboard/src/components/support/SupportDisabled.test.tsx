/**
 * WARP-3528 — Support's "module off" state offers the enable path to the people
 * who can use it, and an honest sentence to everyone else (the Projects pattern,
 * WARP-1306).
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
  return { ...actual, setAppModuleEnabled: (...a: unknown[]) => setAppModuleEnabledMock(...a) };
});

vi.mock("swr", async () => {
  const actual = await vi.importActual<typeof import("swr")>("swr");
  return { ...actual, mutate: (...a: unknown[]) => mutateMock(...a) };
});

vi.mock("@/components/shell/ShellPage", () => ({
  ShellPage: ({ title, children }: any) => (
    <div>
      <h1>{title}</h1>
      {children}
    </div>
  ),
}));

import { SupportDisabled } from "./SupportDisabled";

beforeEach(() => {
  cleanup();
  setAppModuleEnabledMock.mockReset().mockResolvedValue(undefined);
  mutateMock.mockReset().mockResolvedValue(undefined);
  authState.role = "owner";
});

describe("SupportDisabled", () => {
  it.each(["owner", "admin"])("offers %s a working 'Turn on Support' that flips the capability cache in place", async (role) => {
    authState.role = role;
    render(<SupportDisabled />);
    expect(screen.getByText("Support isn't enabled on this Droplet.")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /turn on support/i }));
    });
    expect(setAppModuleEnabledMock).toHaveBeenCalledWith("support", true);
    expect(mutateMock).toHaveBeenCalledWith("/api/capabilities", expect.any(Function), { revalidate: false });

    const update = mutateMock.mock.calls[0]![1] as (prev: AppCapabilities | undefined) => AppCapabilities;
    // With nothing cached, the other flags land on the hook's documented defaults…
    expect(update(undefined)).toEqual({ projects: true, crm: false, contacts: false, support: true });
    // …and with a cache, it MERGES rather than blanking the flags it does not own (WARP-2578).
    expect(update({ projects: false, crm: true, contacts: true, support: false })).toEqual({
      projects: false,
      crm: true,
      contacts: true,
      support: true,
    });
  });

  it.each(["family", "guest"])("tells %s who can turn it on and offers no dead button", (role) => {
    authState.role = role;
    render(<SupportDisabled />);
    expect(screen.getByText("An owner or admin can turn it on.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /turn on support/i })).toBeNull();
  });

  it("stays calm when turning it on fails, and lets the owner try again", async () => {
    setAppModuleEnabledMock.mockRejectedValue(new Error("boom"));
    render(<SupportDisabled />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /turn on support/i }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't turn on Support just now. Try again in a moment.");
    expect(screen.getByRole("button", { name: /turn on support/i })).toBeEnabled();
    expect(mutateMock).not.toHaveBeenCalled();
  });
});
