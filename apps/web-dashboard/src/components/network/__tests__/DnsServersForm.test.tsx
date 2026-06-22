/**
 * WARP-871 — DnsServersForm: set upstream/custom DNS resolvers from the
 * Network → System tab. Client-side IP validation; Tier-1 write polls the op.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

import { DnsServersForm } from "../DnsServersForm";
import {
  setDnsServers,
  fetchNetworkOperation,
  RouterStatusError,
} from "@/lib/api";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    setDnsServers: vi.fn(),
    fetchNetworkOperation: vi.fn(),
  };
});

const dnsMock = vi.mocked(setDnsServers);
const opMock = vi.mocked(fetchNetworkOperation);

beforeEach(() => {
  dnsMock.mockReset();
  opMock.mockReset();
  dnsMock.mockResolvedValue({ status: "ok", operationId: "op-dns" } as never);
  opMock.mockResolvedValue({
    id: "op-dns",
    state: "applied",
    startedAt: 0,
    finishedAt: 1,
    reason: null,
  } as never);
});
afterEach(() => {
  vi.clearAllMocks();
});

function fill({ primary = "1.1.1.1", secondary = "" } = {}) {
  fireEvent.change(screen.getByPlaceholderText("1.1.1.1"), {
    target: { value: primary },
  });
  fireEvent.change(screen.getByPlaceholderText("1.0.0.1"), {
    target: { value: secondary },
  });
}
async function save() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /save dns servers/i }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("DnsServersForm (WARP-871)", () => {
  it("rejects an empty primary client-side without hitting the API", async () => {
    render(<DnsServersForm />);
    await save();
    expect(screen.getByText(/at least one dns server/i)).toBeInTheDocument();
    expect(dnsMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed IP client-side", async () => {
    render(<DnsServersForm />);
    fill({ primary: "not.an.ip" });
    await save();
    expect(screen.getByText(/isn't a valid ip/i)).toBeInTheDocument();
    expect(dnsMock).not.toHaveBeenCalled();
  });

  it("sends only the non-empty servers, polls, and shows applied", async () => {
    const onApplied = vi.fn();
    render(<DnsServersForm onApplied={onApplied} />);
    fill({ primary: "1.1.1.1", secondary: "8.8.8.8" });
    await save();
    expect(dnsMock).toHaveBeenCalledWith(["1.1.1.1", "8.8.8.8"]);
    expect(opMock).toHaveBeenCalledWith("op-dns");
    expect(await screen.findByText(/dns servers updated/i)).toBeInTheDocument();
    expect(onApplied).toHaveBeenCalled();
  });

  it("accepts a single primary (secondary blank)", async () => {
    render(<DnsServersForm />);
    fill({ primary: "9.9.9.9" });
    await save();
    expect(dnsMock).toHaveBeenCalledWith(["9.9.9.9"]);
  });

  it("shows a calm amber notice when the router is unreachable", async () => {
    dnsMock.mockRejectedValue(
      new RouterStatusError("UNREACHABLE", "ECONNREFUSED 192.168.50.1", 503),
    );
    render(<DnsServersForm />);
    fill({ primary: "1.1.1.1" });
    await save();
    expect(await screen.findByText(/isn't reachable/i)).toBeInTheDocument();
    expect(screen.queryByText(/ECONNREFUSED/)).not.toBeInTheDocument();
  });

  it("surfaces a rolled-back op.reason in red", async () => {
    opMock.mockResolvedValue({
      id: "op-dns",
      state: "rolled_back",
      startedAt: 0,
      finishedAt: 1,
      reason: "Reverted: lost upstream resolution.",
    } as never);
    render(<DnsServersForm />);
    fill({ primary: "1.1.1.1" });
    await save();
    expect(
      await screen.findByText(/reverted: lost upstream/i),
    ).toBeInTheDocument();
  });
});
