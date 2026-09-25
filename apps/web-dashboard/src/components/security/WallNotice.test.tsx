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
import { ACCESS_FEATURES, tierLabel } from "@/lib/access";
import { ACCESS_COPY } from "@/components/access/copy";
import { fill } from "./ModeCard";

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
    // Round 3 (rjouffret non-blocking 1): an account just for the screen, whose role sets Security to View.
    expect(screen.getByText(/an account just for this screen/).textContent).toBe(fill(WALL_COPY.refusedManage, { tier: tierLabel("family") }));
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
    expect(screen.queryByText(/an account just for this screen/)).toBeNull();
    expect(screen.queryByRole("link", { name: WALL_COPY.refusedManageLink })).toBeNull();
    // /security's own reads would be refused for a guest too: the way out is the Overview.
    expect(screen.queryByRole("link", { name: WALL_COPY.leave })).toBeNull();
    expect(screen.getByRole("link", { name: WALL_COPY.refusedGuestLeave })).toHaveAttribute("href", "/");
    expect(screen.getByRole("button", { name: WALL_COPY.refusedSignOut })).toHaveClass("btn", "primary");
    expect(h.authFetch).not.toHaveBeenCalled();
  });

  it("the dedicated-account advice uses the role builder's own words, and View is a level a Staff role can hold below Respond", () => {
    // A Staff account holds Security at Respond by default (setting the mode, acknowledging). A role based on
    // Staff with Security at View has the server refuse those (requireFeatureAccess("security", "act")).
    const security = ACCESS_FEATURES.find((f) => f.moduleId === "security")!;
    const cameras = ACCESS_FEATURES.find((f) => f.moduleId === "cameras")!;
    const [view, respond] = security.levels;
    expect([view!.value, respond!.value]).toEqual(["view", "act"]);
    expect(view!.minTier).toBe("family");
    const advice = fill(WALL_COPY.refusedManage, { tier: tierLabel("family") });
    expect(advice).toContain(`in ${ACCESS_COPY.tab},`);
    expect(advice).toContain(`a role based on ${tierLabel("family")} with`);
    expect(advice).toContain(`with ${cameras.label} on and ${security.label} set to ${view!.label},`);
    expect(advice).not.toMatch(/\{|family/);
    // What View takes away, in the words the person meets: the strip's "Site mode", and Respond's own "acknowledge".
    expect(advice).toContain(`can't change the ${WALL_COPY.modeLabel.toLowerCase()} or acknowledge alerts.`);
    expect(respond!.grants).toMatch(/\backnowledge\b/);
    expect(advice).toMatch(/^It's best to make an account just for this screen\./);
  });

  it("the sign-out button says 'here', as the card's 'Sign in here' does", () => {
    expect(WALL_COPY.refusedSignOut).toBe("Sign out here");
    expect(WALL_COPY.refusedWhat.startsWith(WALL_COPY.refusedSignOut.replace("out", "in"))).toBe(true);
  });

  it.each(["owner", "guest"])("a %s: 'Sign out here' signs out, then opens the sign-in that comes back to the wall", async (role) => {
    render(<WallRefused role={role} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: WALL_COPY.refusedSignOut }));
    });
    expect(h.logout).toHaveBeenCalledTimes(1);
    expect(h.push).toHaveBeenCalledWith("/login?next=%2Fsecurity%2Fwall");
    expect(h.logout.mock.invocationCallOrder[0]!).toBeLessThan(h.push.mock.invocationCallOrder[0]!);
  });
});
