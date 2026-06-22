/**
 * WARP-871 — DhcpReservationForm: pin a device to a fixed IP from the
 * Network → System tab. Client-side validation mirrors schemas.py
 * StaticLeaseRequest; the Tier-1 write polls for the safe-apply outcome.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

import { DhcpReservationForm } from "../DhcpReservationForm";
import {
  addStaticDhcpLease,
  fetchNetworkOperation,
  RouterStatusError,
} from "@/lib/api";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual, // keep real RouterStatusError + routerUnreachableNotice
    addStaticDhcpLease: vi.fn(),
    fetchNetworkOperation: vi.fn(),
  };
});

const addMock = vi.mocked(addStaticDhcpLease);
const opMock = vi.mocked(fetchNetworkOperation);

beforeEach(() => {
  addMock.mockReset();
  opMock.mockReset();
  addMock.mockResolvedValue({ status: "ok", operationId: "op-lease" } as never);
  opMock.mockResolvedValue({
    id: "op-lease",
    state: "applied",
    startedAt: 0,
    finishedAt: 1,
    reason: null,
  } as never);
});
afterEach(() => {
  vi.clearAllMocks();
});

function fill({
  name = "Office NAS",
  mac = "AA:BB:CC:DD:EE:FF",
  ip = "192.168.50.20",
}: { name?: string; mac?: string; ip?: string } = {}) {
  fireEvent.change(screen.getByPlaceholderText(/office nas/i), {
    target: { value: name },
  });
  fireEvent.change(screen.getByPlaceholderText(/aa:bb:cc/i), {
    target: { value: mac },
  });
  fireEvent.change(screen.getByPlaceholderText(/192\.168\.50\.20/), {
    target: { value: ip },
  });
}
async function add() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /add reservation/i }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("DhcpReservationForm (WARP-871)", () => {
  it("rejects a blank name client-side without hitting the API", async () => {
    render(<DhcpReservationForm />);
    fill({ name: "" });
    await add();
    expect(screen.getByText(/enter a name/i)).toBeInTheDocument();
    expect(addMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed MAC client-side", async () => {
    render(<DhcpReservationForm />);
    fill({ mac: "AA-BB-CC" });
    await add();
    expect(screen.getByText(/aa:bb:cc:dd:ee:ff/i)).toBeInTheDocument();
    expect(addMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed IP client-side", async () => {
    render(<DhcpReservationForm />);
    fill({ ip: "300.1.1.1" });
    await add();
    expect(screen.getByText(/valid address/i)).toBeInTheDocument();
    expect(addMock).not.toHaveBeenCalled();
  });

  it("submits, polls, shows the applied banner, and clears the form", async () => {
    const onApplied = vi.fn();
    render(<DhcpReservationForm onApplied={onApplied} />);
    fill();
    await add();
    expect(addMock).toHaveBeenCalledWith(
      "Office NAS",
      "AA:BB:CC:DD:EE:FF",
      "192.168.50.20",
    );
    expect(opMock).toHaveBeenCalledWith("op-lease");
    expect(await screen.findByText(/reservation added/i)).toBeInTheDocument();
    expect(onApplied).toHaveBeenCalled();
    expect(
      (screen.getByPlaceholderText(/office nas/i) as HTMLInputElement).value,
    ).toBe("");
  });

  it("shows a calm amber notice when the router is unreachable", async () => {
    addMock.mockRejectedValue(
      new RouterStatusError("UNREACHABLE", "ECONNREFUSED 192.168.50.1", 503),
    );
    render(<DhcpReservationForm />);
    fill();
    await add();
    expect(await screen.findByText(/isn't reachable/i)).toBeInTheDocument();
    expect(screen.queryByText(/ECONNREFUSED/)).not.toBeInTheDocument();
  });

  it("surfaces a rolled-back op.reason in red", async () => {
    opMock.mockResolvedValue({
      id: "op-lease",
      state: "rolled_back",
      startedAt: 0,
      finishedAt: 1,
      reason: "Reverted: that IP is outside the DHCP range.",
    } as never);
    render(<DhcpReservationForm />);
    fill();
    await add();
    expect(
      await screen.findByText(/reverted: that ip is outside/i),
    ).toBeInTheDocument();
  });
});
