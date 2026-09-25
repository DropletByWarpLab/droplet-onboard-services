/**
 * WARP-2981 (ADR-059 P6, D6) — what /security/wall shows an account it does
 * not run on (Stefan: "Member wall, own cameras"): why, what to do — sign in
 * here with a Staff account that has the cameras to show — and a way to sign
 * out straight into that sign-in, first. An owner or admin also gets Users,
 * where such an account is made and given cameras. A guest can't see Security
 * at all, so it is told that and gets no Users link and no way into Security.
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
  it.each(["owner", "admin", undefined])("a %s: says why and what to do, in the household's words for the tier, and links to Users", (role) => {
    render(<WallRefused role={role} />);
    expect(screen.getByRole("heading", { level: 1, name: WALL_COPY.refusedTitle })).toBeInTheDocument();
    expect(screen.getByText(WALL_COPY.refusedWhy)).toBeInTheDocument();
    // `family` is shown as "Staff" everywhere (lib/access tierLabel); never the enum value.
    const what = screen.getByText(/Sign in here with a/);
    expect(what.textContent).toContain(`with a ${tierLabel("family")} account`);
    expect(what.textContent).not.toMatch(/\{|family/);
    expect(screen.getByRole("link", { name: WALL_COPY.refusedManageLink })).toHaveAttribute("href", "/users");
    expect(screen.getByRole("link", { name: WALL_COPY.leave })).toHaveAttribute("href", "/security");
    // Nothing is asked: the refusal is drawn from the session alone.
    expect(h.authFetch).not.toHaveBeenCalled();
  });

  it("signing out is the one primary action, and first; Users is a plain button", () => {
    render(<WallRefused role="owner" />);
    const signOut = screen.getByRole("button", { name: WALL_COPY.refusedSignOut });
    const users = screen.getByRole("link", { name: WALL_COPY.refusedManageLink });
    expect(signOut).toHaveClass("btn", "primary");
    expect(users).toHaveClass("btn");
    expect(users).not.toHaveClass("primary");
    expect(document.querySelectorAll(".sec-wall-notice-actions .primary")).toHaveLength(1);
    expect(document.querySelector(".sec-wall-notice-actions > :first-child")).toBe(signOut);
  });

  it("a guest: told the account can't see Security, sent to a Staff sign-in — no Users link, no way into Security", () => {
    render(<WallRefused role="guest" />);
    expect(screen.getByRole("heading", { level: 1, name: WALL_COPY.refusedGuestTitle })).toBeInTheDocument();
    expect(screen.getByText(WALL_COPY.refusedGuestWhy)).toBeInTheDocument();
    expect(screen.queryByText(WALL_COPY.refusedTitle)).toBeNull();
    expect(screen.queryByText(WALL_COPY.refusedWhy)).toBeNull();
    expect(screen.getByText(/Sign in here with a/).textContent).toContain(`with a ${tierLabel("family")} account`);
    expect(screen.queryByText(WALL_COPY.refusedManage)).toBeNull();
    expect(screen.queryByRole("link", { name: WALL_COPY.refusedManageLink })).toBeNull();
    // /security's own reads would be refused for a guest too: the way out is the Overview.
    expect(screen.queryByRole("link", { name: WALL_COPY.leave })).toBeNull();
    expect(screen.getByRole("link", { name: WALL_COPY.refusedGuestLeave })).toHaveAttribute("href", "/");
    expect(screen.getByRole("button", { name: WALL_COPY.refusedSignOut })).toHaveClass("btn", "primary");
    expect(h.authFetch).not.toHaveBeenCalled();
  });

  it.each(["owner", "guest"])("a %s: 'Sign out on this screen' signs out, then opens the sign-in that comes back to the wall", async (role) => {
    render(<WallRefused role={role} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: WALL_COPY.refusedSignOut }));
    });
    expect(h.logout).toHaveBeenCalledTimes(1);
    expect(h.push).toHaveBeenCalledWith("/login?next=%2Fsecurity%2Fwall");
    expect(h.logout.mock.invocationCallOrder[0]!).toBeLessThan(h.push.mock.invocationCallOrder[0]!);
  });
});
