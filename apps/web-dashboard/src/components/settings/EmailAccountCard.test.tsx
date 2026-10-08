/**
 * WARP-2957 — "Connected" on the mailbox card is a fact, not a default.
 *
 * The row's `imapStatus` used to be written once by the connect probe and
 * never again, so this card said "Connected" forever. It now renders the
 * health columns the indexer reports through the orchestrator, says
 * "Checking…" until the first cycle has completed, and polls while it waits.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";

const authFetch = vi.fn();
const session = { role: "owner" };
vi.mock("@/lib/auth", () => ({
  authFetch: (...a: unknown[]) => authFetch(...a),
  useAuth: () => ({ user: { role: session.role } }),
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
  session.role = "owner";
});

afterEach(() => {
  vi.useRealTimers();
});

describe("EmailAccountCard — mailbox state", () => {
  it("reports a new connection only after a successful save, without credential arguments", async () => {
    const onConnected = vi.fn();
    authFetch.mockResolvedValue(listResponse([account({ lastIdleAt: new Date().toISOString() })]));
    render(<EmailAccountCard onConnected={onConnected} />);
    await screen.findByRole("status");
    expect(onConnected).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Connect a mailbox" }));
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "private-mailbox-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
    expect(onConnected.mock.calls).toEqual([[]]);
    expect(authFetch).toHaveBeenCalledWith("/api/email/accounts", expect.objectContaining({ method: "POST" }));
  });

  it("does not report rejected mailbox credentials as connected", async () => {
    const onConnected = vi.fn();
    authFetch.mockImplementation((_url: string, options?: RequestInit) => Promise.resolve(options?.method === "POST" ? { ok: false, status: 400, json: async () => ({ error: "connect_failed" }) } : listResponse([])));
    render(<EmailAccountCard onConnected={onConnected} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect a mailbox" }));
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "private-mailbox-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByRole("alert");
    expect(onConnected).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Password")).toHaveValue("");
  });
  it("labels a native Outlook account as a read-only import and uses its imported timestamp", async () => {
    authFetch.mockResolvedValue(listResponse([account({ authMode: "M365_GRAPH", canSend: false, lastIdleAt: new Date(Date.now() - 2 * 3_600_000).toISOString() })]));
    render(<EmailAccountCard />);
    expect(await screen.findByRole("status")).toHaveTextContent(/imported · checked 2 hours ago/i);
    expect(screen.getByText(/read-only outlook import.*sending unavailable/i)).toBeInTheDocument();
  });
  it("shows family a provider import management link rather than an administrator mailbox removal action", async () => {
    session.role = "family";
    authFetch.mockResolvedValue(listResponse([account({ authMode: "M365_GRAPH", canSend: false })]));
    render(<EmailAccountCard />);
    expect(await screen.findByRole("link", { name: "Manage import" })).toHaveAttribute("href", "/settings#connected-accounts");
    expect(screen.queryByRole("button", { name: "Disconnect" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Waiting for first email import");
  });
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
