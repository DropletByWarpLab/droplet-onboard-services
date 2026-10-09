import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { providerDescriptor } from "@droplet/shared-types";
import { LanApiConnectionSetup, LanApiSetupDialog, isLanApiProvider } from "./LanApiConnectionSetup";

const mocks = vi.hoisted(() => ({ role: "owner", authFetch: vi.fn() }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { id: "owner", role: mocks.role } }), authFetch: mocks.authFetch }));

// Represents an operator-supplied discovered contract, never a shipped default.
const routeMap = { authenticate: { controller: "Authentication", method: "Authenticate", verb: "POST", template: "/discovered-auth" }, reads: {}, writes: {} };
const ca = "-----BEGIN CERTIFICATE-----\noperator-ca\n-----END CERTIFICATE-----";
function fill() {
  fireEvent.change(screen.getByLabelText("Server host or IP"), { target: { value: "practice-server.lan" } });
  fireEvent.change(screen.getByLabelText("Integration key"), { target: { value: "private-integration-key" } });
  fireEvent.change(screen.getByLabelText("User id"), { target: { value: "private-api-user" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "private-api-password" } });
  fireEvent.change(screen.getByLabelText(/Route map JSON/), { target: { value: JSON.stringify(routeMap) } });
}
function response(body: unknown, ok = true) { return { ok, json: async () => body }; }

beforeEach(() => {
  vi.clearAllMocks(); mocks.role = "owner";
  mocks.authFetch.mockResolvedValue(response({ provider: "eaglesoft-api", status: "CONNECTED" }));
});

describe("Patterson API setup", () => {
  it("uses the canonical credential fields with masked secrets and requires an actual route map", () => {
    render(<LanApiConnectionSetup />);
    for (const field of providerDescriptor("eaglesoft-api")!.credentialFields) {
      const input = screen.getByLabelText(new RegExp(field.label));
      expect(input).toHaveAttribute("type", field.secret ? "password" : field.type === "positiveInteger" ? "number" : "text");
      if (field.required) expect(input).toBeRequired();
    }
    expect(screen.getByLabelText(/Route map JSON/)).toHaveValue("");
    expect(screen.getByLabelText(/Route map JSON/)).toBeRequired();
    expect(screen.getByText(/Each read needs its discovered route/)).toBeInTheDocument();
    expect(screen.getByText(/Droplet keeps HTTPS verification enabled/)).toBeInTheDocument();
  });
  it("sends the exact legacy API envelope directly and reports only metadata after confirmed connection", async () => {
    const onConnected = vi.fn();
    render(<LanApiConnectionSetup onConnected={onConnected} />);
    fill();
    fireEvent.change(screen.getByLabelText(/HTTPS port/), { target: { value: "9991" } });
    fireEvent.change(screen.getByLabelText(/CA certificate PEM/), { target: { value: ca } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
    const [path, init] = mocks.authFetch.mock.calls[0];
    expect(path).toBe("/api/integrations/eaglesoft/connect");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ provider: "eaglesoft-api", host: "practice-server.lan", port: 9991, apiCredentials: { integrationKey: "private-integration-key", userId: "private-api-user", password: "private-api-password" }, enableWrites: false, apiRouteMap: routeMap, apiCaCert: ca });
    expect(onConnected.mock.calls).toEqual([[]]);
    expect(screen.getByRole("status")).toHaveTextContent("Eaglesoft API is connected.");
    for (const label of ["Integration key", "User id", "Password"]) expect(screen.getByLabelText(label)).toHaveValue("");
    expect(screen.queryByText(/private-api-password/)).not.toBeInTheDocument();
  });
  it("tests via the exact legacy route without saving or claiming connected, then allows explicit save", async () => {
    mocks.authFetch.mockResolvedValueOnce(response({ ok: true, message: "not rendered" }));
    const onConnected = vi.fn();
    render(<LanApiConnectionSetup onConnected={onConnected} />);
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Choose Connect to save this setup.");
    expect(mocks.authFetch.mock.calls[0][0]).toBe("/api/integrations/eaglesoft/test");
    const body = JSON.parse(mocks.authFetch.mock.calls[0][1].body);
    expect(body.provider).toBe("eaglesoft-api");
    expect(body).not.toHaveProperty("port");
    expect(body).not.toHaveProperty("apiCaCert");
    expect(body.enableWrites).toBe(false);
    expect(onConnected).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Password")).toHaveValue("private-api-password");
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
    expect(mocks.authFetch.mock.calls[1][0]).toBe("/api/integrations/eaglesoft/connect");
  });
  it("keeps a saved but blocked HTTP200 setup pending instead of reporting success", async () => {
    mocks.authFetch.mockResolvedValue(response({ provider: "eaglesoft-api", status: "PROVISIONING" }));
    const onConnected = vi.fn();
    render(<LanApiConnectionSetup onConnected={onConnected} />);
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Setup was saved, but the API is not connected yet.");
    expect(onConnected).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Password")).toHaveValue("");
  });
  it.each([
    [response({ provider: "eaglesoft", status: "CONNECTED" }), "Connect"],
    [response({ provider: "eaglesoft-api", status: "ERROR", error: "private-api-password" }), "Connect"],
    [response({ error: "private-api-password" }, false), "Connect"],
    [response({ ok: false, message: "private-api-password" }), "Test connection"],
  ])("rejects unconfirmed verdicts without echoing server details or claiming success", async (reply, action) => {
    mocks.authFetch.mockResolvedValue(reply);
    const onConnected = vi.fn();
    render(<LanApiConnectionSetup onConnected={onConnected} />);
    fill();
    fireEvent.click(screen.getByRole("button", { name: action }));
    expect(await screen.findByRole("alert")).not.toHaveTextContent("private-api-password");
    expect(onConnected).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Password")).toHaveValue("");
  });
  it.each(["not-json", "{}", JSON.stringify({ authenticate: { controller: "Authentication", method: "Authenticate" }, reads: {}, writes: {} })])("refuses an undiscovered or malformed route map before credential submission", async (text) => {
    render(<LanApiConnectionSetup />);
    fill();
    fireEvent.change(screen.getByLabelText(/Route map JSON/), { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(mocks.authFetch).not.toHaveBeenCalled();
  });
  it("rejects an invalid certificate and never offers a TLS verification bypass", () => {
    render(<LanApiConnectionSetup />);
    fill();
    fireEvent.change(screen.getByLabelText(/CA certificate PEM/), { target: { value: "not-a-certificate" } });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(screen.getByRole("alert")).toHaveTextContent("PEM format");
    expect(mocks.authFetch).not.toHaveBeenCalled();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });
  it("does not fetch or display credential inputs to a family member", () => {
    mocks.role = "family";
    render(<LanApiConnectionSetup />);
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
    expect(mocks.authFetch).not.toHaveBeenCalled();
  });
  it("aborts a closed form and ignores a late connection verdict", async () => {
    let resolve!: (value: ReturnType<typeof response>) => void;
    mocks.authFetch.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const onConnected = vi.fn();
    const { unmount } = render(<LanApiConnectionSetup onConnected={onConnected} />);
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    const signal = mocks.authFetch.mock.calls[0][1].signal as AbortSignal;
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => { resolve(response({ provider: "eaglesoft-api", status: "CONNECTED" })); });
    expect(onConnected).not.toHaveBeenCalled();
  });
});

describe("Patterson API setup dialog on the hub", () => {
  it("claims only the Patterson API provider key, not the direct-SQL tile or any other provider", () => {
    expect(isLanApiProvider("eaglesoft-api")).toBe(true);
    expect(isLanApiProvider("eaglesoft")).toBe(false);
    expect(isLanApiProvider("stripe")).toBe(false);
    expect(isLanApiProvider("")).toBe(false);
  });

  it("names the system in its heading, holds the form, and closes from its own button", () => {
    const onClose = vi.fn();
    render(<LanApiSetupDialog open onClose={onClose} />);
    expect(screen.getByRole("dialog", { name: "Connect Eaglesoft (Patterson API)" })).toBeInTheDocument();
    expect(screen.getByRole("form", { name: "Patterson API setup" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders nothing while closed", () => {
    render(<LanApiSetupDialog open={false} onClose={() => {}} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
  });

  it("passes the connected verdict to the hub", async () => {
    const onConnected = vi.fn();
    render(<LanApiSetupDialog open onClose={() => {}} onConnected={onConnected} />);
    fill();
    fireEvent.click(screen.getAllByRole("button", { name: "Connect" })[0]);
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
  });
});
