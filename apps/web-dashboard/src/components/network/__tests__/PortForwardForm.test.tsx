/**
 * WARP-871 — PortForwardForm: add a port forward from the Network → Firewall
 * tab. Mirrors WifiSettingsForm's add→(202 confirm)→poll dance + calm error
 * ladder, and the client-side validation that mirrors schemas.py.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

import { PortForwardForm } from "../PortForwardForm";
import {
  addNetworkPortForward,
  confirmNetworkCommand,
  fetchNetworkOperation,
  RouterStatusError,
} from "@/lib/api";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual, // keep real RouterStatusError + routerUnreachableNotice
    addNetworkPortForward: vi.fn(),
    confirmNetworkCommand: vi.fn(),
    fetchNetworkOperation: vi.fn(),
  };
});

const addMock = vi.mocked(addNetworkPortForward);
const confirmMock = vi.mocked(confirmNetworkCommand);
const opMock = vi.mocked(fetchNetworkOperation);

beforeEach(() => {
  addMock.mockReset();
  confirmMock.mockReset();
  opMock.mockReset();
  // Default: Tier-2 confirmation_required → confirm → applied.
  addMock.mockResolvedValue({
    status: "confirmation_required",
    operation: "add_port_forward",
    tier: 2,
    confirmationToken: "tok-pf",
  } as never);
  confirmMock.mockResolvedValue({ operationId: "op-pf" });
  opMock.mockResolvedValue({
    id: "op-pf",
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
  name = "Front-door camera",
  src = "8080",
  ip = "192.168.50.20",
  dest = "80",
}: {
  name?: string;
  src?: string;
  ip?: string;
  dest?: string;
} = {}) {
  fireEvent.change(screen.getByPlaceholderText(/front-door camera/i), {
    target: { value: name },
  });
  fireEvent.change(screen.getByPlaceholderText("8080"), {
    target: { value: src },
  });
  fireEvent.change(screen.getByPlaceholderText("192.168.50.20"), {
    target: { value: ip },
  });
  fireEvent.change(screen.getByPlaceholderText("80"), {
    target: { value: dest },
  });
}
async function add() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /add port forward/i }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("PortForwardForm (WARP-871)", () => {
  it("rejects a blank name client-side without hitting the API", async () => {
    render(<PortForwardForm />);
    fill({ name: "" });
    await add();
    expect(screen.getByText(/enter a name/i)).toBeInTheDocument();
    expect(addMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed internal IP client-side", async () => {
    render(<PortForwardForm />);
    fill({ ip: "999.1.1.1" });
    await add();
    expect(screen.getByText(/valid address/i)).toBeInTheDocument();
    expect(addMock).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range port client-side", async () => {
    render(<PortForwardForm />);
    fill({ src: "70000" });
    await add();
    expect(screen.getByText(/external port must be/i)).toBeInTheDocument();
    expect(addMock).not.toHaveBeenCalled();
  });

  it("rejects a reversed port range client-side", async () => {
    render(<PortForwardForm />);
    fill({ src: "9000-8000" });
    await add();
    expect(screen.getByText(/external port must be/i)).toBeInTheDocument();
    expect(addMock).not.toHaveBeenCalled();
  });

  it("submits, auto-confirms the 202, polls, and shows the applied banner", async () => {
    const onApplied = vi.fn();
    render(<PortForwardForm onApplied={onApplied} />);
    fill();
    await add();
    expect(addMock).toHaveBeenCalledWith(
      "Front-door camera",
      "8080",
      "192.168.50.20",
      "80",
      "tcp",
    );
    expect(confirmMock).toHaveBeenCalledWith("tok-pf", "add_port_forward");
    expect(opMock).toHaveBeenCalledWith("op-pf");
    expect(await screen.findByText(/port forward added/i)).toBeInTheDocument();
    expect(onApplied).toHaveBeenCalled();
  });

  it("shows the actionable message in red on a 422 validation refusal", async () => {
    addMock.mockRejectedValue(
      new RouterStatusError("UNKNOWN", "dest_ip must be a literal IPv4.", 422),
    );
    render(<PortForwardForm />);
    fill();
    await add();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/literal ipv4/i);
  });

  it("shows a calm amber notice (not the raw error) when the router is unreachable", async () => {
    addMock.mockRejectedValue(
      new RouterStatusError("UNREACHABLE", "ECONNREFUSED 192.168.50.1", 503),
    );
    render(<PortForwardForm />);
    fill();
    await add();
    expect(await screen.findByText(/isn't reachable/i)).toBeInTheDocument();
    expect(screen.queryByText(/ECONNREFUSED/)).not.toBeInTheDocument();
  });

  it("surfaces a rolled-back op.reason in red", async () => {
    opMock.mockResolvedValue({
      id: "op-pf",
      state: "rolled_back",
      startedAt: 0,
      finishedAt: 1,
      reason: "Reverted: rule conflicts with an existing redirect.",
    } as never);
    render(<PortForwardForm />);
    fill();
    await add();
    expect(
      await screen.findByText(/reverted: rule conflicts/i),
    ).toBeInTheDocument();
  });
});
