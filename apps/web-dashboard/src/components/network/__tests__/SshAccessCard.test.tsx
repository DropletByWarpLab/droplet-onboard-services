/**
 * WARP-2887 — SshAccessCard: the login the SSH door uses.
 *
 * Pins the contract that matters on the security axis: the card renders what
 * the HOST reports (never what was typed), the password is sent once through
 * the Tier-3 two-step and cleared, and client-side validation refuses the
 * shapes the orchestrator would 400 anyway so a bad name never mints a token.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render as rtlRender, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";

import { SshAccessCard } from "../SshAccessCard";

/** SWR caches by key across tests in one module; give each render its own cache. */
function render(ui: React.ReactElement) {
  return rtlRender(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{ui}</SWRConfig>,
  );
}
import { fetchSshAccess, setSshAccess, setSshLogin, confirmNetworkCommand } from "@/lib/api";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    fetchSshAccess: vi.fn(),
    setSshAccess: vi.fn(),
    setSshLogin: vi.fn(),
    confirmNetworkCommand: vi.fn(),
  };
});

const fetchMock = vi.mocked(fetchSshAccess);
const setLoginMock = vi.mocked(setSshLogin);
const confirmMock = vi.mocked(confirmNetworkCommand);

function status(overrides: Record<string, unknown> = {}) {
  return {
    enabled: false,
    status: "applied" as const,
    changedAt: "2026-09-17T00:00:00Z",
    login: { username: null, status: "none" as const },
    ...overrides,
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  setLoginMock.mockReset();
  confirmMock.mockReset();
  vi.mocked(setSshAccess).mockReset();
  setLoginMock.mockResolvedValue({
    status: "confirmation_required",
    operation: "set_ssh_login",
    confirmationToken: "tok-1",
  } as never);
  confirmMock.mockResolvedValue({ operationId: null });
});
afterEach(() => {
  vi.clearAllMocks();
});

async function openForm() {
  await act(async () => {
    fireEvent.click(await screen.findByRole("button", { name: /set login|change login/i }));
  });
}

describe("SshAccessCard — login (WARP-2887)", () => {
  it("shows the login the host reports, not a typed one", async () => {
    fetchMock.mockResolvedValue(status({ login: { username: "support", status: "set" } }));
    render(<SshAccessCard />);
    expect(await screen.findByText("Login: support")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /change login/i })).toBeInTheDocument();
  });

  it("says plainly when no login exists, because the door is otherwise unusable", async () => {
    fetchMock.mockResolvedValue(status());
    render(<SshAccessCard />);
    expect(await screen.findByText(/no login set yet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /set login/i })).toBeInTheDocument();
  });

  it("renders a refused login honestly and keeps the previous one visible", async () => {
    fetchMock.mockResolvedValue(status({ login: { username: "support", status: "refused" } }));
    render(<SshAccessCard />);
    expect(await screen.findByText(/refused the new login.*“support” still works/i)).toBeInTheDocument();
  });

  it("does not offer the login section when the host units are absent", async () => {
    fetchMock.mockResolvedValue({ enabled: false, status: "unknown", changedAt: null, login: { username: null, status: "unknown" } });
    render(<SshAccessCard />);
    await screen.findByText(/not available on this droplet/i);
    expect(screen.queryByRole("button", { name: /set login/i })).not.toBeInTheDocument();
  });

  it("sends username + password through the Tier-3 two-step and clears the password", async () => {
    fetchMock.mockResolvedValue(status());
    render(<SshAccessCard />);
    await openForm();
    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "support" } });
    fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: "correct horse battery" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save login/i }));
    });
    await waitFor(() => expect(setLoginMock).toHaveBeenCalledWith("support", "correct horse battery"));
    expect(confirmMock).toHaveBeenCalledWith("tok-1", "set_ssh_login");
    // The form closes and the password field is gone with it.
    expect(screen.queryByLabelText(/^password/i)).not.toBeInTheDocument();
  });

  it.each([
    ["an uppercase username", "Support", "correct horse battery"],
    ["a username starting with a digit", "1support", "correct horse battery"],
    ["a short password", "support", "short"],
  ])("refuses %s client-side without minting a token", async (_label, u, p) => {
    fetchMock.mockResolvedValue(status());
    render(<SshAccessCard />);
    await openForm();
    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: u } });
    fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: p } });
    expect(screen.getByRole("button", { name: /save login/i })).toBeDisabled();
    expect(setLoginMock).not.toHaveBeenCalled();
  });
});
