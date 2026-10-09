/** WARP-3912 — the owner/admin "Connected MCP servers" switch. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const channel = vi.hoisted(() => ({ fetchRemoteMcpChannel: vi.fn(), setRemoteMcpChannel: vi.fn() }));
vi.mock("@/lib/api", () => channel);
let mockRole: string | undefined = "admin";
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: mockRole ? { id: "u1", role: mockRole } : null }) }));

import { RemoteMcpSwitch, REMOTE_MCP_LABEL } from "../RemoteMcpSwitch";

beforeEach(() => {
  vi.clearAllMocks();
  mockRole = "admin";
  channel.fetchRemoteMcpChannel.mockResolvedValue({ enabled: false });
  channel.setRemoteMcpChannel.mockResolvedValue(undefined);
});

describe("RemoteMcpSwitch", () => {
  it("shows OFF in words and lets an admin turn it on", async () => {
    render(<RemoteMcpSwitch />);
    const box = (await screen.findByLabelText(new RegExp(REMOTE_MCP_LABEL))) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.getByText(/Off: the assistant cannot reach any outside service/)).toBeTruthy();
    fireEvent.click(box);
    await waitFor(() => expect(channel.setRemoteMcpChannel).toHaveBeenCalledWith(true));
    expect(await screen.findByText(/disconnects them immediately and stops any call in progress/)).toBeTruthy();
  });

  it("sends enabled=false when an owner turns it off", async () => {
    mockRole = "owner";
    channel.fetchRemoteMcpChannel.mockResolvedValue({ enabled: true });
    render(<RemoteMcpSwitch />);
    const box = (await screen.findByRole("checkbox")) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    await waitFor(() => expect(channel.setRemoteMcpChannel).toHaveBeenCalledWith(false));
  });

  it("renders nothing, and asks nothing, for a member", async () => {
    mockRole = "family";
    const { container } = render(<RemoteMcpSwitch />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe("");
    expect(channel.fetchRemoteMcpChannel).not.toHaveBeenCalled();
  });

  it("shows a disabled row, not a guess, when the setting cannot be read", async () => {
    channel.fetchRemoteMcpChannel.mockResolvedValue(null);
    render(<RemoteMcpSwitch />);
    const box = (await screen.findByRole("checkbox")) as HTMLInputElement;
    expect(box.disabled).toBe(true);
  });

  it("leaves the switch where it was when the box refuses", async () => {
    channel.setRemoteMcpChannel.mockRejectedValue(Object.assign(new Error("x"), { status: 403 }));
    render(<RemoteMcpSwitch />);
    const box = (await screen.findByRole("checkbox")) as HTMLInputElement;
    fireEvent.click(box);
    expect(await screen.findByText("That didn’t change. Try again in a moment.")).toBeTruthy();
    expect(box.checked).toBe(false);
  });
});
