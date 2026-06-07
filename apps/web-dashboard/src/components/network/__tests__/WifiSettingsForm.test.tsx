/**
 * Issue #12 — WifiSettingsForm: editable Wi-Fi provisioning in the Network tab.
 * Mirrors InternetStep's SSID→password→confirm→poll dance + calm error ladder.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

import { WifiSettingsForm } from "../WifiSettingsForm";
import {
  setWifiSsid,
  setWifiPassword,
  confirmNetworkCommand,
  fetchNetworkOperation,
  RouterStatusError,
} from "@/lib/api";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual, // keep real RouterStatusError + routerUnreachableNotice
    setWifiSsid: vi.fn(),
    setWifiPassword: vi.fn(),
    confirmNetworkCommand: vi.fn(),
    fetchNetworkOperation: vi.fn(),
  };
});

const ssidMock = vi.mocked(setWifiSsid);
const pwMock = vi.mocked(setWifiPassword);
const confirmMock = vi.mocked(confirmNetworkCommand);
const opMock = vi.mocked(fetchNetworkOperation);

beforeEach(() => {
  ssidMock.mockReset();
  pwMock.mockReset();
  confirmMock.mockReset();
  opMock.mockReset();
  ssidMock.mockResolvedValue({ status: "ok", tier: 1 } as never);
  pwMock.mockResolvedValue({ status: "ok", tier: 1 } as never);
});
afterEach(() => vi.clearAllMocks());

function fill(ssid: string, pw: string) {
  fireEvent.change(screen.getByPlaceholderText(/studio fotonia/i), {
    target: { value: ssid },
  });
  fireEvent.change(screen.getByPlaceholderText(/wi-fi password/i), {
    target: { value: pw },
  });
}
async function save() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /save wi-fi/i }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("WifiSettingsForm (issue #12)", () => {
  it("rejects a blank SSID client-side without hitting the API", async () => {
    render(<WifiSettingsForm />);
    fill("", "abcdefgh");
    await save();
    expect(screen.getByText(/enter a network name/i)).toBeInTheDocument();
    expect(ssidMock).not.toHaveBeenCalled();
  });

  it("rejects a password under 8 chars client-side", async () => {
    render(<WifiSettingsForm />);
    fill("Studio Fotonia", "short");
    await save();
    expect(screen.getByText(/at least 8 characters/i)).toBeInTheDocument();
    expect(ssidMock).not.toHaveBeenCalled();
  });

  it("submits SSID then password and shows the applied banner on a Tier-1 save", async () => {
    render(<WifiSettingsForm />);
    fill("Studio Fotonia", "supersecret");
    await save();
    expect(ssidMock).toHaveBeenCalledWith("Studio Fotonia");
    expect(pwMock).toHaveBeenCalledWith("supersecret");
    expect(ssidMock.mock.invocationCallOrder[0]).toBeLessThan(
      pwMock.mock.invocationCallOrder[0],
    );
    expect(await screen.findByText(/wi-fi updated/i)).toBeInTheDocument();
  });

  it("auto-confirms + polls when the password POST returns 202 confirmation_required", async () => {
    pwMock.mockResolvedValue({
      status: "confirmation_required",
      operation: "set_wifi_password",
      tier: 2,
      confirmationToken: "tok-12",
    } as never);
    confirmMock.mockResolvedValue({ operationId: "op-12" });
    opMock.mockResolvedValue({
      id: "op-12",
      state: "applied",
      startedAt: 0,
      finishedAt: 1,
      reason: null,
    } as never);
    render(<WifiSettingsForm />);
    fill("Studio Fotonia", "supersecret");
    await save();
    expect(confirmMock).toHaveBeenCalledWith("tok-12", "set_wifi_password");
    expect(opMock).toHaveBeenCalledWith("op-12");
    expect(await screen.findByText(/wi-fi updated/i)).toBeInTheDocument();
  });

  it("shows the actionable message in red on a 422 validation refusal", async () => {
    pwMock.mockRejectedValue(
      new RouterStatusError("UNKNOWN", "PSK contains invalid characters.", 422),
    );
    render(<WifiSettingsForm />);
    fill("Studio Fotonia", "badcontrolchars");
    await save();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/invalid characters/i);
  });

  it("shows a calm amber notice (not the raw error) when the router is unreachable", async () => {
    ssidMock.mockRejectedValue(
      new RouterStatusError("UNREACHABLE", "ECONNREFUSED 192.168.50.1", 503),
    );
    render(<WifiSettingsForm />);
    fill("Studio Fotonia", "supersecret");
    await save();
    expect(await screen.findByText(/isn't reachable/i)).toBeInTheDocument();
    expect(screen.queryByText(/ECONNREFUSED/)).not.toBeInTheDocument();
  });

  it("surfaces a rolled-back op.reason in red (plain Error from pollOperation)", async () => {
    pwMock.mockResolvedValue({
      status: "confirmation_required",
      operation: "set_wifi_password",
      tier: 2,
      confirmationToken: "tok-rb",
    } as never);
    confirmMock.mockResolvedValue({ operationId: "op-rb" });
    opMock.mockResolvedValue({
      id: "op-rb",
      state: "rolled_back",
      startedAt: 0,
      finishedAt: 1,
      reason: "Reverted: lost connectivity to the AP.",
    } as never);
    render(<WifiSettingsForm />);
    fill("Studio Fotonia", "supersecret");
    await save();
    expect(
      await screen.findByText(/reverted: lost connectivity/i),
    ).toBeInTheDocument();
  });

  it("toggles password visibility", async () => {
    render(<WifiSettingsForm />);
    const pw = screen.getByPlaceholderText(
      /wi-fi password/i,
    ) as HTMLInputElement;
    expect(pw.type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: /show.*password/i }));
    expect(pw.type).toBe("text");
  });
});
