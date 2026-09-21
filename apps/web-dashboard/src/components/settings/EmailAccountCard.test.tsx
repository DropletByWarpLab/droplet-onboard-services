/**
 * WARP-2957 — "Connected" on the mailbox card is a fact, not a default.
 *
 * The row's `imapStatus` used to be written once by the connect probe and
 * never again, so this card said "Connected" forever. It now renders the
 * health columns the indexer reports through the orchestrator, says
 * "Checking…" until the first cycle has completed, and polls while it waits.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";

const authFetch = vi.fn();
vi.mock("@/lib/auth", () => ({
  authFetch: (...a: unknown[]) => authFetch(...a),
}));
vi.mock("@/components/ConfirmDialog", () => ({
  ConfirmDialog: () => null,
}));

import { EmailAccountCard } from "./EmailAccountCard";

function account(overrides: Record<string, unknown> = {}) {
  return {
    id: "acct-1",
    address: "desk@northgate.example",
    displayName: "Front desk",
    imapStatus: "idle",
    lastIdleAt: null,
    lastErrorAt: null,
    lastError: null,
    ...overrides,
  };
}

function listResponse(accounts: unknown[]) {
  return { ok: true, json: async () => ({ accounts }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("EmailAccountCard — mailbox state", () => {
  it("says Connected with the last check time once a cycle has completed", async () => {
    authFetch.mockResolvedValue(
      listResponse([account({ lastIdleAt: new Date(Date.now() - 2 * 3_600_000).toISOString() })]),
    );
    render(<EmailAccountCard />);
    expect(await screen.findByRole("status")).toHaveTextContent(/connected · checked 2 hours ago/i);
  });

  it("says Checking… — not Connected — before the first cycle has reported", async () => {
    authFetch.mockResolvedValue(listResponse([account()]));
    render(<EmailAccountCard />);
    expect(await screen.findByRole("status")).toHaveTextContent(/checking/i);
    expect(screen.queryByText(/^connected/i)).not.toBeInTheDocument();
  });

  it("renders the closed-set failure sentence for an errored mailbox", async () => {
    authFetch.mockResolvedValue(
      listResponse([
        account({
          imapStatus: "error",
          lastErrorAt: new Date().toISOString(),
          lastError: "The mail server rejected the username or password.",
        }),
      ]),
    );
    render(<EmailAccountCard />);
    expect(await screen.findByRole("status")).toHaveTextContent(/rejected the username or password/i);
  });

  it("polls the list while a mailbox awaits its first cycle, and stops once it has one", async () => {
    vi.useFakeTimers();
    authFetch
      .mockResolvedValueOnce(listResponse([account()]))
      .mockResolvedValueOnce(listResponse([account()]))
      .mockResolvedValue(listResponse([account({ lastIdleAt: new Date().toISOString() })]));

    render(<EmailAccountCard />);
    // Initial load.
    await act(async () => {
      await Promise.resolve();
    });
    expect(authFetch).toHaveBeenCalledTimes(1);

    // Two polls while pending…
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(authFetch).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(authFetch).toHaveBeenCalledTimes(3);

    // …the third answer carries lastIdleAt, so polling stops.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(authFetch).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/connected/i));
  });
});
