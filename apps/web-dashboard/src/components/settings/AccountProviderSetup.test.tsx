import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const { authFetch, session } = vi.hoisted(() => ({ authFetch: vi.fn(), session: { role: "owner" } }));
vi.mock("@/lib/auth", () => ({ authFetch: (...args: unknown[]) => authFetch(...args), useAuth: () => ({ user: { role: session.role } }) }));
import { AccountProviderSetup, type AccountConnectionSetupView } from "./AccountProviderSetup";

const callback = "https://droplet.example/api/google/callback";
const view = (): AccountConnectionSetupView => ({
  google: { clientId: "google-client", hasClientSecret: true, configured: true, redirectUri: callback, callbackSupported: true },
  microsoft: { clientId: "microsoft-client", tenantId: "directory", configured: true, redirectUri: "https://droplet.example/api/m365/callback" },
});
const json = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, json: async () => body });
const writes = () => authFetch.mock.calls.filter(([, init]) => init?.method === "PUT");
const openSetup = () => {
  const details = screen.getByText("Account connection setup").closest("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
};

beforeEach(() => { vi.clearAllMocks(); session.role = "owner"; });

describe("administrator account registration", () => {
  it.each(["family", "guest"])("does not render setup or read credentials for %s", (role) => {
    session.role = role;
    const { container } = render(<AccountProviderSetup />);
    expect(container).toBeEmptyDOMElement();
    expect(authFetch).not.toHaveBeenCalled();
  });
  it("starts collapsed and loads only when the administrator opens it", async () => {
    authFetch.mockResolvedValue(json(view()));
    render(<AccountProviderSetup />);
    expect(screen.getByText("Account connection setup").closest("details")).not.toHaveAttribute("open");
    expect(authFetch).not.toHaveBeenCalled();
    openSetup();
    expect(await screen.findByLabelText("Google client secret")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("Google client secret")).toHaveValue("");
    expect(screen.getByText(/leave this blank to keep it/i)).toBeInTheDocument();
  });
  it("copies the exact server callback URI", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    authFetch.mockResolvedValue(json(view()));
    render(<AccountProviderSetup />);
    openSetup();
    expect(await screen.findByDisplayValue(callback)).toHaveAttribute("readonly");
    fireEvent.click(screen.getByRole("button", { name: "Copy Google callback URI" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(callback));
  });
  it("omits an unchanged stored Google secret on save", async () => {
    authFetch.mockResolvedValue(json(view()));
    const onSaved = vi.fn();
    render(<AccountProviderSetup onSaved={onSaved} />);
    openSetup();
    fireEvent.change(await screen.findByLabelText("Google client ID"), { target: { value: " revised-client " } });
    fireEvent.click(screen.getByRole("button", { name: "Save Google setup" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(JSON.parse(writes()[0]![1].body)).toEqual({ google: { clientId: "revised-client" } });
    expect(screen.getByLabelText("Google client secret")).toHaveValue("");
  });
  it("writes a replacement Google secret once and clears the input afterward", async () => {
    authFetch.mockResolvedValue(json(view()));
    render(<AccountProviderSetup />);
    openSetup();
    fireEvent.change(await screen.findByLabelText("Google client secret"), { target: { value: "replacement-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Google setup" }));
    expect(await screen.findByText("Google connection setup saved.")).toBeInTheDocument();
    expect(JSON.parse(writes()[0]![1].body)).toEqual({ google: { clientId: "google-client", clientSecret: "replacement-secret" } });
    expect(screen.getByLabelText("Google client secret")).toHaveValue("");
    expect(screen.queryByText("replacement-secret")).not.toBeInTheDocument();
  });
  it("sends an explicit empty secret only when the administrator selects removal", async () => {
    authFetch.mockResolvedValue(json(view()));
    render(<AccountProviderSetup />);
    openSetup();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Remove stored Google client secret" }));
    expect(screen.getByLabelText("Google client secret")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save Google setup" }));
    await screen.findByText("Google connection setup saved.");
    expect(JSON.parse(writes()[0]![1].body)).toEqual({ google: { clientId: "google-client", clientSecret: "" } });
  });
  it("saves only Microsoft registration details from the Microsoft form", async () => {
    authFetch.mockResolvedValue(json(view()));
    render(<AccountProviderSetup />);
    openSetup();
    fireEvent.change(await screen.findByLabelText("Microsoft application (client) ID"), { target: { value: " next-client " } });
    fireEvent.click(screen.getByRole("button", { name: "Save Microsoft setup" }));
    await screen.findByText("Microsoft connection setup saved.");
    expect(JSON.parse(writes()[0]![1].body)).toEqual({ microsoft: { clientId: "next-client", tenantId: "directory" } });
  });
  it("preserves unsaved Google fields when saving Microsoft", async () => {
    authFetch.mockResolvedValue(json(view()));
    render(<AccountProviderSetup />);
    openSetup();
    fireEvent.change(await screen.findByLabelText("Google client secret"), { target: { value: "unsaved-secret" } });
    fireEvent.change(screen.getByLabelText("Google client ID"), { target: { value: "unsaved-client" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Microsoft setup" }));
    await screen.findByText("Microsoft connection setup saved.");
    expect(screen.getByLabelText("Google client secret")).toHaveValue("unsaved-secret");
    expect(screen.getByLabelText("Google client ID")).toHaveValue("unsaved-client");
  });
  it("explains unsupported Google callbacks with a concrete hostname fix", async () => {
    const setup = view();
    setup.google.callbackSupported = false;
    authFetch.mockResolvedValue(json(setup));
    render(<AccountProviderSetup />);
    openSetup();
    expect(await screen.findByRole("alert")).toHaveTextContent(/https address with a registered hostname/i);
    expect(screen.getByRole("alert")).toHaveTextContent(/reload this setup.*updated callback uri/i);
  });
  it("allows retry after a failed load", async () => {
    authFetch.mockRejectedValueOnce(new Error("private provider failure")).mockResolvedValue(json(view()));
    render(<AccountProviderSetup />);
    openSetup();
    fireEvent.click(await screen.findByRole("button", { name: "Retry setup" }));
    expect(await screen.findByLabelText("Google client ID")).toHaveValue("google-client");
    expect(screen.queryByText("private provider failure")).not.toBeInTheDocument();
  });
  it("keeps typed values and shows a friendly failure when saving fails", async () => {
    authFetch.mockImplementation(async (_url: string, init?: { method: string }) => init?.method === "PUT" ? json({ message: "private secret failure" }, 500) : json(view()));
    render(<AccountProviderSetup />);
    openSetup();
    fireEvent.change(await screen.findByLabelText("Google client secret"), { target: { value: "new-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Google setup" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not save account connection setup/i);
    expect(screen.getByLabelText("Google client secret")).toHaveValue("new-secret");
    expect(screen.getByRole("button", { name: "Save Google setup" })).toBeEnabled();
    expect(screen.queryByText("private secret failure")).not.toBeInTheDocument();
  });
});
