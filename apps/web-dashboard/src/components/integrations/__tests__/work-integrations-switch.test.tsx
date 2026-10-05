/** WARP-3532 — the owner-only "Send work updates outside your network" switch. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const channel = vi.hoisted(() => ({ fetchWorkIntegrationsChannel: vi.fn(), setWorkIntegrationsChannel: vi.fn() }));
vi.mock("@/lib/api", () => channel);
let mockRole: string | undefined = "owner";
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: mockRole ? { id: "u1", role: mockRole } : null }) }));

import { WorkIntegrationsSwitch, WORK_INTEGRATIONS_LABEL } from "../WorkIntegrationsSwitch";

beforeEach(() => {
  vi.clearAllMocks();
  mockRole = "owner";
  channel.fetchWorkIntegrationsChannel.mockResolvedValue({ enabled: false });
  channel.setWorkIntegrationsChannel.mockResolvedValue(undefined);
});

describe("WorkIntegrationsSwitch", () => {
  it("shows OFF by default, in words, and lets the owner turn it on", async () => {
    render(<WorkIntegrationsSwitch />);
    const box = (await screen.findByLabelText(new RegExp(WORK_INTEGRATIONS_LABEL))) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.getByText(/Off: Droplet sends only to addresses on your own network/)).toBeTruthy();
    fireEvent.click(box);
    await waitFor(() => expect(channel.setWorkIntegrationsChannel).toHaveBeenCalledWith(true));
    expect(await screen.findByText(/On: work updates can go to Slack/)).toBeTruthy();
    expect(box.checked).toBe(true);
  });

  it("says what leaves when it is on", async () => {
    channel.fetchWorkIntegrationsChannel.mockResolvedValue({ enabled: true });
    render(<WorkIntegrationsSwitch />);
    expect(await screen.findByText(/What leaves is the work item’s key, title, state, who changed it and a link back/)).toBeTruthy();
  });

  it("lets an admin see the state but not change it", async () => {
    mockRole = "admin";
    render(<WorkIntegrationsSwitch />);
    const box = (await screen.findByRole("checkbox")) as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(screen.getByText("Only the owner can change this.")).toBeTruthy();
    expect(screen.getByText(/It is off, so anything for the internet is waiting/)).toBeTruthy();
  });

  it("renders nothing, and asks nothing, for anyone else", async () => {
    mockRole = "family";
    const { container } = render(<WorkIntegrationsSwitch />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe("");
    expect(channel.fetchWorkIntegrationsChannel).not.toHaveBeenCalled();
  });

  it("shows a disabled row, not a guess, when the setting cannot be read", async () => {
    channel.fetchWorkIntegrationsChannel.mockResolvedValue(null);
    render(<WorkIntegrationsSwitch />);
    const box = (await screen.findByRole("checkbox")) as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(screen.getByText(/Couldn’t read this setting/)).toBeTruthy();
  });

  it("says it did not change, and leaves the switch where it was, when the box refuses", async () => {
    channel.setWorkIntegrationsChannel.mockRejectedValue(Object.assign(new Error("x"), { status: 403 }));
    render(<WorkIntegrationsSwitch />);
    const box = (await screen.findByRole("checkbox")) as HTMLInputElement;
    fireEvent.click(box);
    expect(await screen.findByText("That didn’t change. Try again in a moment.")).toBeTruthy();
    expect(box.checked).toBe(false);
  });
});
