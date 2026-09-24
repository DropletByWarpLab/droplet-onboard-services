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
const testEmailChannel = vi.fn();
vi.mock("@/lib/api", () => ({
  getEmailChannel: (...a: unknown[]) => getEmailChannel(...a),
  saveEmailChannel: (...a: unknown[]) => saveEmailChannel(...a),
  testEmailChannel: (...a: unknown[]) => testEmailChannel(...a),
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
  lastError: null as string | null,
  lastTestedAt: null as string | null,
};

beforeEach(() => {
  vi.clearAllMocks();
  getEmailChannel.mockResolvedValue(baseCfg);
  saveEmailChannel.mockResolvedValue({ ...baseCfg, enabled: true, host: "smtp.acme.co" });
});

describe("EmailChannelSection", () => {
  it("renders the group header via the shell Sect pattern — sentence case, no uppercase eyebrow (WARP-1344)", async () => {
    render(<EmailChannelSection />);
    const heading = screen.getByRole("heading", { name: "Outbound email" });
    expect(heading.className).not.toMatch(/uppercase/);
    expect(heading.closest(".sect")).not.toBeNull();
    await waitFor(() => expect(getEmailChannel).toHaveBeenCalled());
  });

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

  // ── WARP-2957 — the relay is verified, not just saved ───────────────────
  it("shows Connected with the check time once a test has passed", async () => {
    getEmailChannel.mockResolvedValueOnce({
      ...baseCfg,
      host: "smtp.acme.co",
      hasPassword: true,
      lastTestedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      lastError: null,
    });
    render(<EmailChannelSection />);
    await waitFor(() => expect(getEmailChannel).toHaveBeenCalled());
    expect(await screen.findByText(/connected · checked 5 minutes ago/i)).toBeInTheDocument();
    expect(screen.queryByText(/not connected/i)).not.toBeInTheDocument();
  });

  it("shows the closed-set failure sentence from the row, and says Not connected", async () => {
    getEmailChannel.mockResolvedValueOnce({
      ...baseCfg,
      host: "smtp.acme.co",
      hasPassword: true,
      lastTestedAt: new Date().toISOString(),
      lastError: "The mail server rejected the username or password.",
    });
    render(<EmailChannelSection />);
    expect(await screen.findByText(/not connected/i)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/rejected the username or password/i);
  });

  it("says 'Saved, not tested yet' for a stored password with no test on record", async () => {
    getEmailChannel.mockResolvedValueOnce({ ...baseCfg, host: "smtp.acme.co", hasPassword: true });
    render(<EmailChannelSection />);
    expect(await screen.findByText(/saved, not tested yet/i)).toBeInTheDocument();
  });

  it("Test connection dials the saved relay and renders the outcome", async () => {
    getEmailChannel.mockResolvedValueOnce({ ...baseCfg, host: "smtp.acme.co", hasPassword: true });
    const at = new Date().toISOString();
    testEmailChannel.mockResolvedValueOnce({ ok: true, reason: null, error: null, lastTestedAt: at });
    render(<EmailChannelSection />);
    await waitFor(() => expect(getEmailChannel).toHaveBeenCalled());

    const button = await screen.findByRole("button", { name: /test connection/i });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);

    await waitFor(() => expect(testEmailChannel).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/connected · checked just now/i)).toBeInTheDocument();
    // A test is not a save.
    expect(saveEmailChannel).not.toHaveBeenCalled();
  });

  it("Test connection renders a failed dial as the sentence the box chose", async () => {
    getEmailChannel.mockResolvedValueOnce({ ...baseCfg, host: "smtp.acme.co", hasPassword: true });
    testEmailChannel.mockResolvedValueOnce({
      ok: false,
      reason: "unreachable",
      error: "Couldn't reach the mail server. Check the host name and port.",
      lastTestedAt: new Date().toISOString(),
    });
    render(<EmailChannelSection />);
    const button = await screen.findByRole("button", { name: /test connection/i });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't reach the mail server/i);
  });

  it("disables Test connection until a relay host has been saved", async () => {
    render(<EmailChannelSection />);
    await waitFor(() => expect(getEmailChannel).toHaveBeenCalled());
    expect(await screen.findByRole("button", { name: /test connection/i })).toBeDisabled();
  });

  it("renders the verify outcome carried on an enabled save", async () => {
    saveEmailChannel.mockResolvedValueOnce({
      ...baseCfg,
      enabled: true,
      host: "smtp.acme.co",
      fromAddress: "d@acme.co",
      hasPassword: true,
      lastTestedAt: new Date().toISOString(),
      lastError: null,
    });
    render(<EmailChannelSection />);
    await waitFor(() => expect(getEmailChannel).toHaveBeenCalled());
    fireEvent.click(await screen.findByLabelText(/enable outbound email/i));
    fireEvent.change(await screen.findByLabelText(/smtp host/i), { target: { value: "smtp.acme.co" } });
    fireEvent.change(screen.getByLabelText(/from address/i), { target: { value: "d@acme.co" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(await screen.findByText(/connected · checked just now/i)).toBeInTheDocument();
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
