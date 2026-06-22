/**
 * AiAgentAccessCard — read-only droplet-ai RPC scopes + honest-gated writes.
 *
 * Pins:
 *  - read + write scope chips render from the live ACL;
 *  - the live single-box /ubus endpoint is shown (NOT the legacy 192.168.50.1);
 *  - "session rotates hourly" is surfaced;
 *  - Rotate token / Revoke render DISABLED (honest gate) — there is no real
 *    write here, so they must never be enabled/clickable.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";

vi.mock("@/lib/api", () => ({
  fetchAiNetworkAccess: vi.fn(),
}));

import { fetchAiNetworkAccess } from "@/lib/api";
import { AiAgentAccessCard } from "../AiAgentAccessCard";

const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

function renderCard() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <AiAgentAccessCard />
    </SWRConfig>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  asMock(fetchAiNetworkAccess).mockResolvedValue({
    user: "droplet-ai",
    endpoint: "http://192.168.20.1:80/ubus",
    readScopes: ["system.board", "network.interface.*.status"],
    writeScopes: ["network.restart", "system.reboot"],
    session: { active: true, expiresAt: 1781890000, rotates: "hourly" },
  });
});

describe("AiAgentAccessCard", () => {
  it("renders read + write scope chips from the live ACL", async () => {
    renderCard();
    await waitFor(() => expect(screen.getByText("system.board")).toBeTruthy());
    expect(screen.getByText("network.interface.*.status")).toBeTruthy();
    expect(screen.getByText("network.restart")).toBeTruthy();
    expect(screen.getByText("system.reboot")).toBeTruthy();
  });

  it("shows the live /ubus endpoint and the hourly rotation note", async () => {
    renderCard();
    await waitFor(() => expect(screen.getByText(/192\.168\.20\.1.*\/ubus/)).toBeTruthy());
    expect(screen.queryByText(/192\.168\.50\.1/)).toBeNull();
    expect(screen.getByText(/rotates.*hourly/i)).toBeTruthy();
  });

  it("renders Rotate token + Revoke as DISABLED honest gates", async () => {
    renderCard();
    await waitFor(() => expect(screen.getByText("system.board")).toBeTruthy());
    const rotate = screen.getByRole("button", { name: /rotate token/i });
    const revoke = screen.getByRole("button", { name: /revoke/i });
    expect((rotate as HTMLButtonElement).disabled).toBe(true);
    expect((revoke as HTMLButtonElement).disabled).toBe(true);
  });
});
