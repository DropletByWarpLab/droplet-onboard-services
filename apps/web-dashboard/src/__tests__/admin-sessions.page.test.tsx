/**
 * WARP-2820 (review round 2) — /admin/sessions was the one page under /admin
 * that never asked who was looking at it.
 *
 * Two symptoms, one bug. A `family` account reached the page, fired the fetch
 * unconditionally, took the 403 the orchestrator correctly returns, and landed
 * in the GENERIC failure branch — the one that says "The box did not answer".
 * A permissions refusal was being reported to the operator as an outage, on
 * the single page whose entire premise is that it never overstates what it
 * knows. The client gate is what /admin/audit and /admin/files already carry
 * (real enforcement stays in the orchestrator's requireRole middleware).
 *
 * The distinction this page is built around must survive the fix:
 * `sessions: null` ("could not read") and `sessions: []` ("signed out") are
 * different answers and are asserted separately below.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import React from "react";

const fetchSessionsMock = vi.fn();
const revokeUserSessionsMock = vi.fn();

vi.mock("@/lib/api", () => ({
  fetchSessions: (...a: unknown[]) => fetchSessionsMock(...a),
  revokeUserSessions: (...a: unknown[]) => revokeUserSessionsMock(...a),
}));

let mockRole: string | undefined = "owner";
let mockAuthLoading = false;
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: mockRole
      ? { id: "u1", username: "alice", displayName: "Alice", role: mockRole }
      : null,
    isLoading: mockAuthLoading,
  }),
}));

// ShellPage drags in the SWR health chip and the device hook; both have their
// own suites. Passthrough keeps this file about the gate.
vi.mock("@/components/shell/ShellPage", () => ({
  ShellPage: ({ title, sub, children }: any) => (
    <div className="droplet-shell">
      {title ? <h1>{title}</h1> : null}
      {sub ? <p>{sub}</p> : null}
      {children}
    </div>
  ),
}));

import AdminSessionsPage from "@/app/admin/sessions/page";

/** Epoch SECONDS — the session store's own unit, which is what the page reads. */
const now = () => Math.floor(Date.now() / 1000);

function live() {
  const t = now();
  return {
    role: "owner",
    createdAt: t - 3600,
    lastSeenAt: t - 60,
    idleDeadline: t + 1800,
    absoluteDeadline: t + 7200,
  };
}

/** A 403 as `fetchSessions` throws it: the status rides on the error. */
function refusal(status: number) {
  const err = new Error(`Failed to fetch sessions: ${status}`) as Error & {
    status?: number;
  };
  err.status = status;
  return err;
}

const OUTAGE = /box did not answer/i;

beforeEach(() => {
  cleanup();
  fetchSessionsMock.mockReset();
  revokeUserSessionsMock.mockReset();
  mockRole = "owner";
  mockAuthLoading = false;
});

describe("/admin/sessions — client role gate (WARP-2820)", () => {
  it("shows the not-authorized state to a family account and never asks the box", async () => {
    mockRole = "family";
    fetchSessionsMock.mockResolvedValue({
      users: [
        { username: "alice", displayName: "Alice", role: "owner", sessions: [live()] },
      ],
    });

    render(<AdminSessionsPage />);

    expect(await screen.findByText(/admin access required/i)).toBeInTheDocument();
    // The refusal must NOT borrow the outage copy, and must not offer a retry
    // that can only ever fail again.
    expect(screen.queryByText(OUTAGE)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /try again/i })).not.toBeInTheDocument();
    // And it must not leak the roster it was never allowed to read.
    expect(screen.queryByText("Alice")).not.toBeInTheDocument();
    expect(fetchSessionsMock).not.toHaveBeenCalled();
  });

  it("renders neutral chrome while the auth probe is in flight, and fetches nothing", async () => {
    mockAuthLoading = true;
    mockRole = "owner";
    fetchSessionsMock.mockResolvedValue({ users: [] });

    render(<AdminSessionsPage />);

    expect(await screen.findByText(/loading/i)).toBeInTheDocument();
    expect(screen.queryByText(/admin access required/i)).not.toBeInTheDocument();
    expect(screen.queryByText(OUTAGE)).not.toBeInTheDocument();
    expect(fetchSessionsMock).not.toHaveBeenCalled();
  });
});

describe("/admin/sessions — a refusal is not an outage (WARP-2820)", () => {
  it("renders a 403 from the box as a permissions message, not the outage copy", async () => {
    // Role says admin, the box says no — a downgraded-since-issue token, or a
    // server-side tightening. Either way it is not a Redis problem.
    mockRole = "admin";
    fetchSessionsMock.mockRejectedValue(refusal(403));

    render(<AdminSessionsPage />);

    expect(await screen.findByText(/refused this request/i)).toBeInTheDocument();
    expect(screen.getByText(/admin access required/i)).toBeInTheDocument();
    expect(screen.queryByText(OUTAGE)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /try again/i })).not.toBeInTheDocument();
  });

  it("still reports a non-403 failure as an outage, with a retry", async () => {
    mockRole = "owner";
    fetchSessionsMock.mockRejectedValue(refusal(503));

    render(<AdminSessionsPage />);

    expect(await screen.findByText(OUTAGE)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
    expect(screen.queryByText(/admin access required/i)).not.toBeInTheDocument();
  });
});

describe("/admin/sessions — null is still not [] (WARP-2820)", () => {
  it("keeps 'could not read' and 'signed out' apart, and offers no Sign out on Unknown", async () => {
    mockRole = "owner";
    fetchSessionsMock.mockResolvedValue({
      users: [
        { username: "blind", displayName: "Blind Row", role: "admin", sessions: null },
        { username: "gone", displayName: "Gone Row", role: "family", sessions: [] },
        { username: "here", displayName: "Here Row", role: "owner", sessions: [live()] },
      ],
    });

    render(<AdminSessionsPage />);

    await waitFor(() => {
      expect(screen.getByText("Blind Row")).toBeInTheDocument();
    });
    expect(screen.getByText("Unknown")).toBeInTheDocument();
    expect(screen.getByText("Signed out")).toBeInTheDocument();
    expect(screen.getByText("1 session")).toBeInTheDocument();
    expect(
      screen.getByText(/could not read this person's sessions/i),
    ).toBeInTheDocument();
    // Exactly one Sign out button: the person the box could actually see.
    expect(screen.getAllByRole("button", { name: /^sign out$/i })).toHaveLength(1);
    expect(screen.queryByText(OUTAGE)).not.toBeInTheDocument();
  });
});

/**
 * WARP-2820 (review round 3) — the page sends back the identifier the box
 * listed, and nothing else.
 *
 * The revoke route resolves the row this `username` names; the cross-boundary
 * proof lives in the orchestrator suite (admin-sessions.routes.test.ts), which
 * drives GET /auth/sessions and feeds its own payload into the POST. What this
 * side can pin is that the value leaving the page is the payload's `username`
 * — not the display name, and not some field a later refactor invents. Sending
 * anything else re-opens the mismatch from the other end.
 */
describe("/admin/sessions — revoke sends the listed identifier (WARP-2820)", () => {
  it("POSTs the row's `username`, not its display name", async () => {
    mockRole = "owner";
    // Display name deliberately unlike the username: a page that reached for
    // the wrong field would still render correctly and still 404 the box.
    fetchSessionsMock.mockResolvedValue({
      users: [
        {
          username: "dana.chen",
          displayName: "Dana Chen",
          role: "family",
          sessions: [live()],
        },
      ],
    });
    revokeUserSessionsMock.mockResolvedValue({ status: "ok", revoked: 2 });

    render(<AdminSessionsPage />);

    fireEvent.click(await screen.findByRole("button", { name: /^sign out$/i }));
    fireEvent.click(
      await screen.findByRole("button", { name: /^sign out everywhere$/i }),
    );

    await waitFor(() => {
      expect(revokeUserSessionsMock).toHaveBeenCalledWith("dana.chen");
    });
    expect(revokeUserSessionsMock).not.toHaveBeenCalledWith("Dana Chen");
    // A successful revoke re-reads the roster rather than guessing the new
    // state — the initial load plus one refresh.
    await waitFor(() => {
      expect(fetchSessionsMock).toHaveBeenCalledTimes(2);
    });
  });
});
