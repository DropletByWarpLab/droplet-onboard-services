/**
 * WARP-2981 (ADR-059 P6, D6) — what /security/wall shows an owner or admin
 * instead of the wall (Stefan: "Member wall, own cameras"): why, what to do —
 * sign in on the TV with a Staff account that has the cameras to show — where
 * such an account is made and given cameras (Users), and a way to sign out of
 * the TV straight into that sign-in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({ logout: vi.fn(), push: vi.fn(), authFetch: vi.fn() }));
vi.mock("@/lib/auth", () => ({ authFetch: h.authFetch, useAuth: () => ({ user: { id: "u1", role: "owner" }, logout: h.logout }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push, replace: vi.fn() }) }));

import { WallRefused } from "./WallNotice";
import { WALL_COPY } from "./wall-status";
import { tierLabel } from "@/lib/access";

beforeEach(() => {
  h.logout.mockReset().mockResolvedValue(undefined);
  h.push.mockReset();
  h.authFetch.mockReset();
});
afterEach(cleanup);

describe("WallRefused (D6)", () => {
  it("says why and what to do, in the household's words for the tier, and links to Users", () => {
    render(<WallRefused />);
    expect(screen.getByRole("heading", { level: 1, name: WALL_COPY.refusedTitle })).toBeInTheDocument();
    expect(screen.getByText(WALL_COPY.refusedWhy)).toBeInTheDocument();
    // `family` is shown as "Staff" everywhere (lib/access tierLabel); never the enum value.
    const what = screen.getByText(/Sign in on this TV with a/);
    expect(what.textContent).toContain(`with a ${tierLabel("family")} account`);
    expect(what.textContent).not.toMatch(/\{|family/);
    expect(screen.getByRole("link", { name: WALL_COPY.refusedManageLink })).toHaveAttribute("href", "/users");
    expect(screen.getByRole("link", { name: WALL_COPY.leave })).toHaveAttribute("href", "/security");
    // Nothing is asked: the refusal is drawn from the session alone.
    expect(h.authFetch).not.toHaveBeenCalled();
  });

  it("'Sign out of this TV' signs out, then opens the sign-in that comes back to the wall", async () => {
    render(<WallRefused />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: WALL_COPY.refusedSignOut }));
    });
    expect(h.logout).toHaveBeenCalledTimes(1);
    expect(h.push).toHaveBeenCalledWith("/login?next=%2Fsecurity%2Fwall");
    expect(h.logout.mock.invocationCallOrder[0]!).toBeLessThan(h.push.mock.invocationCallOrder[0]!);
  });
});
