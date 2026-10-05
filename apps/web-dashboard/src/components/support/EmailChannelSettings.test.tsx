import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const listEmailAccounts = vi.fn();
const getEmailChannel = vi.fn();
const saveEmailChannel = vi.fn();
const revalidate = vi.fn();
vi.mock("./useSupport", async () => {
  const actual = await vi.importActual<typeof import("./useSupport")>("./useSupport");
  return {
    ...actual,
    supportActions: () => ({ listEmailAccounts, getEmailChannel, saveEmailChannel }),
    useAgents: () => ({ agents: [{ id: "agent-1", displayName: "Ada" }] }),
    useRevalidateSupport: () => revalidate,
  };
});

import { EmailChannelSettings } from "./EmailChannelSettings";
import { makeDesk } from "./support.test-fixtures";

beforeEach(() => {
  vi.clearAllMocks();
  listEmailAccounts.mockResolvedValue({ accounts: [{ id: "mail-1", address: "help@example.test", displayName: "Help" }] });
  getEmailChannel.mockResolvedValue({ channel: null });
  saveEmailChannel.mockResolvedValue({ channel: { id: "ch-1" } });
});

describe("service desk email settings", () => {
  it("shows a bounded acknowledgement preview and saves the explicit mailbox and contact owner", async () => {
    render(<EmailChannelSettings desk={makeDesk()} />);
    await screen.findByRole("option", { name: "Help · help@example.test" });
    fireEvent.change(screen.getByLabelText("Mailbox"), { target: { value: "mail-1" } });
    await waitFor(() => expect(screen.getByLabelText("Contact owner")).toHaveValue("agent-1"));
    fireEvent.click(screen.getByLabelText("Send an automatic acknowledgement"));
    expect(screen.getByLabelText("Acknowledgement preview")).toHaveTextContent("SUP-123");
    fireEvent.click(screen.getByRole("button", { name: "Connect mailbox" }));
    await waitFor(() => expect(saveEmailChannel).toHaveBeenCalledWith("desk-1", expect.objectContaining({
      emailAccountId: "mail-1",
      contactOwnerUserId: "agent-1",
      autoAckEnabled: true,
      reopenWindowDays: 14,
    })));
    expect(revalidate).toHaveBeenCalled();
  });
});
