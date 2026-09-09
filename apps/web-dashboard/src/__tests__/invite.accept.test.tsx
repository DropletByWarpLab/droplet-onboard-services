/**
 * Tests for the public /invite/[token] acceptance page.
 *
 * The page has three meaningful render states:
 *   1. Loading        — initial getInvite() in flight.
 *   2. Form           — invite is valid; render password + confirm fields.
 *   3. Success        — acceptInvite resolved; render <WelcomeFlourish />.
 *   4. Invalid        — getInvite threw 404/410; show friendly screen.
 *
 * We mock the api module so the test never hits the network. WelcomeFlourish
 * is real but we mock framer-motion's useReducedMotion (per WelcomeFlourish
 * research note §5.2) so the post-accept screen renders deterministically.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

const useReducedMotionMock = vi.fn(() => true);
vi.mock("framer-motion", async () => {
  const actual = await vi.importActual<typeof import("framer-motion")>(
    "framer-motion",
  );
  return {
    ...actual,
    useReducedMotion: () => useReducedMotionMock(),
  };
});

const getInviteMock = vi.fn();
const acceptInviteMock = vi.fn();
vi.mock("@/lib/api", () => ({
  getInvite: (...args: any[]) => getInviteMock(...args),
  acceptInvite: (...args: any[]) => acceptInviteMock(...args),
}));

// next/navigation is already mocked in setup.ts; import the page after.
import InviteAcceptPage from "@/app/invite/[token]/page";

// Next 15 hands the page its `params` as a Promise, which the page reads with
// React's `use` and so suspends on mount. That first suspension has to happen
// inside an awaited act(): React 19 parks the retry in the act queue that
// RTL's synchronous render() opens, and a queue that is never awaited never
// flushes — the page would show its Suspense fallback forever.
async function renderPage(token: string) {
  await act(async () => {
    render(<InviteAcceptPage params={Promise.resolve({ token })} />);
  });
}

describe("InviteAcceptPage", () => {
  beforeEach(() => {
    getInviteMock.mockReset();
    acceptInviteMock.mockReset();
    useReducedMotionMock.mockReturnValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows the friendly invalid screen when getInvite returns 404", async () => {
    const err = Object.assign(new Error("Invite not found"), { status: 404 });
    getInviteMock.mockRejectedValueOnce(err);

    await renderPage("deadbeef");

    await waitFor(() => {
      expect(
        screen.getByText(/this invite is no longer valid|invite (was|isn|is) ?n('t| not) ?valid/i),
      ).toBeInTheDocument();
    });
    // Link back to /login
    expect(screen.getByText(/sign ?in|go to sign in|back to sign in/i)).toBeInTheDocument();
  });

  it("shows specific copy when getInvite returns 410 USED", async () => {
    const err = Object.assign(new Error("Already used"), { status: 410, code: "USED" });
    getInviteMock.mockRejectedValueOnce(err);

    await renderPage("abc");

    await waitFor(() => {
      expect(screen.getByText(/already (been )?used/i)).toBeInTheDocument();
    });
  });

  it("renders the form once getInvite resolves", async () => {
    getInviteMock.mockResolvedValueOnce({
      username: "alice",
      displayName: "Alice Smith",
      role: "user",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    await renderPage("valid");

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /accept|join|set password/i }),
      ).toBeInTheDocument(),
    );
    // Username + display name should appear as readonly input values.
    expect(screen.getByDisplayValue("alice")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Alice Smith")).toBeInTheDocument();
    // Confirm + new password fields are present.
    expect(document.querySelectorAll('input[type="password"]').length).toBeGreaterThanOrEqual(2);
  });

  it("rejects passwords that don't meet policy without calling acceptInvite", async () => {
    getInviteMock.mockResolvedValueOnce({
      username: "alice",
      displayName: "Alice",
      role: "user",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    await renderPage("valid");

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /accept|join|set password/i })).toBeEnabled(),
    );

    const inputs = document.querySelectorAll('input[type="password"]');
    fireEvent.change(inputs[0], { target: { value: "short" } });
    fireEvent.change(inputs[1], { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: /accept|join|set password/i }));

    await waitFor(() => {
      expect(screen.getByText(/doesn't meet the requirements/i)).toBeInTheDocument();
    });
    expect(acceptInviteMock).not.toHaveBeenCalled();
  });

  it("rejects mismatched confirm password", async () => {
    getInviteMock.mockResolvedValueOnce({
      username: "alice",
      displayName: "Alice",
      role: "user",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    await renderPage("valid");

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /accept|join|set password/i })).toBeEnabled(),
    );

    const inputs = document.querySelectorAll('input[type="password"]');
    fireEvent.change(inputs[0], { target: { value: "Abcdefghijk1" } });
    fireEvent.change(inputs[1], { target: { value: "Abcdefghijk2" } });
    fireEvent.click(screen.getByRole("button", { name: /accept|join|set password/i }));

    await waitFor(() => {
      expect(screen.getByText(/do not match|don't match/i)).toBeInTheDocument();
    });
    expect(acceptInviteMock).not.toHaveBeenCalled();
  });

  it("renders <WelcomeFlourish /> after acceptInvite resolves", async () => {
    getInviteMock.mockResolvedValueOnce({
      username: "alice",
      displayName: "Alice",
      role: "user",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    acceptInviteMock.mockResolvedValueOnce({
      user: { id: "alice", username: "alice", displayName: "Alice", role: "family" },
    });

    await renderPage("valid");

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /accept|join|set password/i })).toBeEnabled(),
    );

    const inputs = document.querySelectorAll('input[type="password"]');
    fireEvent.change(inputs[0], { target: { value: "Abcdefghijk1" } });
    fireEvent.change(inputs[1], { target: { value: "Abcdefghijk1" } });
    fireEvent.click(screen.getByRole("button", { name: /accept|join|set password/i }));

    await waitFor(() => {
      expect(screen.getByTestId("welcome-flourish")).toBeInTheDocument();
    });
    expect(acceptInviteMock).toHaveBeenCalledWith("valid", "Abcdefghijk1");
  });

  it("translates err.code=USED into friendly copy and never surfaces the raw message", async () => {
    getInviteMock.mockResolvedValueOnce({
      username: "alice",
      displayName: "Alice",
      role: "user",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    // Server-shaped: short raw message + structured code.
    const err = Object.assign(new Error("USED"), { status: 410, code: "USED" });
    acceptInviteMock.mockRejectedValueOnce(err);

    await renderPage("valid");

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /accept|join|set password/i })).toBeEnabled(),
    );

    const inputs = document.querySelectorAll('input[type="password"]');
    fireEvent.change(inputs[0], { target: { value: "Abcdefghijk1" } });
    fireEvent.change(inputs[1], { target: { value: "Abcdefghijk1" } });
    fireEvent.click(screen.getByRole("button", { name: /accept|join|set password/i }));

    await waitFor(() => {
      expect(screen.getByText(/already been used/i)).toBeInTheDocument();
    });
    // The terse raw message must NOT appear verbatim.
    // Match the message as a stand-alone token (case-sensitive) — the
    // friendly copy contains lowercase "used" but never uppercase "USED".
    const matches = screen.queryAllByText((_, node) =>
      !!node && /\bUSED\b/.test(node.textContent ?? ""),
    );
    expect(matches.length).toBe(0);
  });

  it("Enter on the Password field submits (parity with /login)", async () => {
    getInviteMock.mockResolvedValueOnce({
      username: "alice",
      displayName: "Alice",
      role: "user",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    acceptInviteMock.mockResolvedValueOnce({
      user: { id: "alice", username: "alice", displayName: "Alice", role: "family" },
    });

    await renderPage("valid");

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /accept|join|set password/i })).toBeEnabled(),
    );

    const inputs = document.querySelectorAll('input[type="password"]');
    fireEvent.change(inputs[0], { target: { value: "Abcdefghijk1" } });
    fireEvent.change(inputs[1], { target: { value: "Abcdefghijk1" } });

    // Press Enter on the Password (first) field — should submit the form.
    fireEvent.keyDown(inputs[0], { key: "Enter" });

    await waitFor(() => {
      expect(acceptInviteMock).toHaveBeenCalledWith("valid", "Abcdefghijk1");
    });
  });

  it("surfaces a friendly error when acceptInvite fails (no raw codes)", async () => {
    getInviteMock.mockResolvedValueOnce({
      username: "alice",
      displayName: "Alice",
      role: "user",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    acceptInviteMock.mockRejectedValueOnce(new Error("Could not create your account."));

    await renderPage("valid");

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /accept|join|set password/i })).toBeEnabled(),
    );

    const inputs = document.querySelectorAll('input[type="password"]');
    fireEvent.change(inputs[0], { target: { value: "Abcdefghijk1" } });
    fireEvent.change(inputs[1], { target: { value: "Abcdefghijk1" } });
    fireEvent.click(screen.getByRole("button", { name: /accept|join|set password/i }));

    await waitFor(() => {
      // Generic-fallback friendly copy — we now ignore err.message entirely
      // and surface a fixed string when no err.code is recognized.
      expect(screen.getByText(/couldn't accept that invite|ask the admin/i)).toBeInTheDocument();
    });
    // No raw error codes / numbers leaked.
    expect(screen.queryByText(/\b500\b|\b404\b|undefined/)).not.toBeInTheDocument();
  });
});
