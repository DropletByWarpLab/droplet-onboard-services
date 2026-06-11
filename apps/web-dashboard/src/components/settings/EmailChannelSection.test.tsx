/**
 * BUG-11 — Settings "Outbound email" section.
 *
 * The in-product config for the SMTP relay that delivers invite emails. Scope:
 *   - loads the current (redacted) config and reflects `hasPassword` without
 *     ever rendering the secret.
 *   - the password field is write-only: placeholder reflects whether one is
 *     stored; an empty submit keeps the existing password.
 *   - saving posts the form and shows a success confirmation.
 *   - a failed save shows a friendly error, never the raw transport string.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const getEmailChannel = vi.fn();
const saveEmailChannel = vi.fn();
vi.mock("@/lib/api", () => ({
  getEmailChannel: (...a: unknown[]) => getEmailChannel(...a),
  saveEmailChannel: (...a: unknown[]) => saveEmailChannel(...a),
}));

import { EmailChannelSection } from "./EmailChannelSection";

const baseCfg = {
  enabled: false,
  host: "",
  port: 587,
  username: "",
  fromAddress: "",
  fromName: "Droplet",
  security: "starttls" as const,
  hasPassword: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  getEmailChannel.mockResolvedValue(baseCfg);
  saveEmailChannel.mockResolvedValue({ ...baseCfg, enabled: true, host: "smtp.acme.co" });
});

describe("EmailChannelSection", () => {
  it("loads and renders the current config", async () => {
    getEmailChannel.mockResolvedValueOnce({
      ...baseCfg,
      enabled: true,
      host: "smtp.acme.co",
      hasPassword: true,
    });
    render(<EmailChannelSection />);

    await waitFor(() => expect(getEmailChannel).toHaveBeenCalled());
    await waitFor(() => {
      expect(screen.getByDisplayValue("smtp.acme.co")).toBeInTheDocument();
    });
  });

  it("reflects a stored password in the placeholder without rendering the secret", async () => {
    getEmailChannel.mockResolvedValueOnce({ ...baseCfg, hasPassword: true });
    render(<EmailChannelSection />);

    const pw = (await screen.findByLabelText(
      /smtp password/i,
    )) as HTMLInputElement;
    // Write-only: the field is empty, with a placeholder noting one exists.
    // The field renders before the redacted config lands, so wait for the
    // placeholder to flip — asserting right after findBy races the load.
    await waitFor(() =>
      expect(pw.placeholder).toMatch(/saved|stored|replace/i),
    );
    expect(pw.value).toBe("");
    expect(pw.type).toBe("password");
  });

  it("saves the form and shows a success confirmation", async () => {
    render(<EmailChannelSection />);
    await waitFor(() => expect(getEmailChannel).toHaveBeenCalled());

    fireEvent.change(await screen.findByLabelText(/smtp host/i), {
      target: { value: "smtp.acme.co" },
    });
    fireEvent.change(screen.getByLabelText(/from address/i), {
      target: { value: "droplet@acme.co" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(saveEmailChannel).toHaveBeenCalledTimes(1));
    const arg = saveEmailChannel.mock.calls[0][0];
    expect(arg.host).toBe("smtp.acme.co");
    expect(arg.fromAddress).toBe("droplet@acme.co");
    await waitFor(() => {
      expect(screen.getByText(/saved/i)).toBeInTheDocument();
    });
  });

  it("omits the password from the payload when left blank (keep-existing)", async () => {
    getEmailChannel.mockResolvedValueOnce({ ...baseCfg, host: "h", fromAddress: "d@acme.co", hasPassword: true });
    render(<EmailChannelSection />);
    await waitFor(() => expect(getEmailChannel).toHaveBeenCalled());

    fireEvent.click(await screen.findByRole("button", { name: /save/i }));

    await waitFor(() => expect(saveEmailChannel).toHaveBeenCalledTimes(1));
    const arg = saveEmailChannel.mock.calls[0][0];
    expect(arg.password).toBeUndefined();
  });

  it("shows a friendly error and never echoes the raw transport failure", async () => {
    const SECRET = "535 5.7.8 auth failed ECONNREFUSED smtp.acme.co";
    saveEmailChannel.mockRejectedValueOnce(new Error(SECRET));
    render(<EmailChannelSection />);
    await waitFor(() => expect(getEmailChannel).toHaveBeenCalled());

    fireEvent.change(await screen.findByLabelText(/smtp host/i), {
      target: { value: "smtp.acme.co" },
    });
    fireEvent.change(screen.getByLabelText(/from address/i), {
      target: { value: "d@acme.co" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(screen.getByText(/couldn't save|try again/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
  });
});
