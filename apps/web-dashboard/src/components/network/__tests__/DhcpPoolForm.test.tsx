/**
 * DhcpPoolForm — the live LAN DHCP pool range + lease-time editor.
 *
 * Tier-2: a save mints a 202 + token, the form confirms it, then polls the
 * operation. Pins:
 *  - the form hydrates from the live pool;
 *  - a valid save runs the confirm dance (setDhcpPool -> confirmNetworkCommand
 *    -> pollOperation) with the entered values;
 *  - client-side validation blocks an out-of-range start before any call.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { SWRConfig } from "swr";

vi.mock("@/lib/api", () => ({
  fetchDhcpPool: vi.fn(),
  setDhcpPool: vi.fn(),
  confirmNetworkCommand: vi.fn(),
  fetchNetworkOperation: vi.fn(),
}));

import {
  fetchDhcpPool,
  setDhcpPool,
  confirmNetworkCommand,
  fetchNetworkOperation,
} from "@/lib/api";
import { DhcpPoolForm } from "../DhcpPoolForm";

function renderForm() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <DhcpPoolForm />
    </SWRConfig>,
  );
}

const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  asMock(fetchDhcpPool).mockResolvedValue({ start: "100", limit: "150", leasetime: "12h" });
});

describe("DhcpPoolForm", () => {
  it("hydrates from the live pool", async () => {
    renderForm();
    await waitFor(() =>
      expect((screen.getByLabelText(/start/i) as HTMLInputElement).value).toBe("100"),
    );
    expect((screen.getByLabelText(/pool size|addresses|limit/i) as HTMLInputElement).value).toBe(
      "150",
    );
  });

  it("a valid save runs the Tier-2 confirm dance with the entered values", async () => {
    asMock(setDhcpPool).mockResolvedValue({
      status: "confirmation_required",
      confirmationToken: "tok-1",
      operation: "set_dhcp_pool",
    });
    asMock(confirmNetworkCommand).mockResolvedValue({ operationId: "op-1" });
    asMock(fetchNetworkOperation).mockResolvedValue({ state: "applied" });

    renderForm();
    await waitFor(() =>
      expect((screen.getByLabelText(/start/i) as HTMLInputElement).value).toBe("100"),
    );

    fireEvent.change(screen.getByLabelText(/start/i), { target: { value: "120" } });
    fireEvent.change(screen.getByLabelText(/pool size|addresses|limit/i), {
      target: { value: "130" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save|apply/i }));

    await waitFor(() => expect(setDhcpPool).toHaveBeenCalledWith(120, 130, "12h"));
    await waitFor(() =>
      expect(confirmNetworkCommand).toHaveBeenCalledWith("tok-1", "set_dhcp_pool"),
    );
    await waitFor(() => expect(fetchNetworkOperation).toHaveBeenCalledWith("op-1"));
  });

  it("blocks an out-of-range start before any network call", async () => {
    renderForm();
    await waitFor(() =>
      expect((screen.getByLabelText(/start/i) as HTMLInputElement).value).toBe("100"),
    );
    fireEvent.change(screen.getByLabelText(/start/i), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: /save|apply/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(setDhcpPool).not.toHaveBeenCalled();
  });
});
