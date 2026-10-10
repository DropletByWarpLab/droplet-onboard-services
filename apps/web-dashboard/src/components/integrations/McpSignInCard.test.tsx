import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const { session } = vi.hoisted(() => ({ session: { role: "family" } }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role: session.role } }) }));

const api = vi.hoisted(() => ({
  fetchMcpOAuthConnections: vi.fn(),
  startMcpSignIn: vi.fn(),
  pasteMcpRedirect: vi.fn(),
  disconnectMcpOAuth: vi.fn(),
}));
vi.mock("@/lib/api", () => api);

import { McpSignInCard, WORKSPACE_ACK_TEXT } from "./McpSignInCard";

const view = (over: Record<string, unknown> = {}) => ({
  provider: "atlassian", member: null, workspace: null,
  redirectUri: "https://droplet.example/api/mcp/oauth/callback", callbackSupported: true, apiToken: false, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  session.role = "family";
  window.history.replaceState(null, "", "/settings");
  api.fetchMcpOAuthConnections.mockResolvedValue([view()]);
});

describe("McpSignInCard", () => {
  it("renders nothing and requests nothing for a guest", () => {
    session.role = "guest";
    const { container } = render(<McpSignInCard provider="atlassian" displayName="Atlassian" />);
    expect(container).toBeEmptyDOMElement();
    expect(api.fetchMcpOAuthConnections).not.toHaveBeenCalled();
  });

  it("renders nothing when the box has no sign-in view (no dead button)", async () => {
    api.fetchMcpOAuthConnections.mockRejectedValue(new Error("404"));
    const { container } = render(<McpSignInCard provider="atlassian" displayName="Atlassian" />);
    await waitFor(() => expect(api.fetchMcpOAuthConnections).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the three statuses", async () => {
    api.fetchMcpOAuthConnections.mockResolvedValue([view({ member: { id: "m1", state: "CONNECTED" } })]);
    const { unmount } = render(<McpSignInCard provider="atlassian" displayName="Atlassian" />);
    expect(await screen.findByText("Signed in · refreshes automatically")).toBeInTheDocument();
    unmount();
    api.fetchMcpOAuthConnections.mockResolvedValue([view({ member: { id: "m1", state: "NEEDS_RECONNECT" } })]);
    const second = render(<McpSignInCard provider="atlassian" displayName="Atlassian" />);
    expect(await screen.findByText("Needs sign-in again")).toBeInTheDocument();
    second.unmount();
    api.fetchMcpOAuthConnections.mockResolvedValue([view()]);
    render(<McpSignInCard provider="atlassian" displayName="Atlassian" />);
    expect(await screen.findByText("Not signed in")).toBeInTheDocument();
  });

  it("start navigates only to the URL the box returned", async () => {
    const navigate = vi.fn();
    api.startMcpSignIn.mockResolvedValue({ authorizeUrl: "https://auth.example/authorize?x=1", expiresAt: "t", redirectUri: "r" });
    render(<McpSignInCard provider="atlassian" displayName="Atlassian" navigate={navigate} />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in with Atlassian" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("https://auth.example/authorize?x=1"));
    expect(api.startMcpSignIn).toHaveBeenCalledWith({ provider: "atlassian", scope: "MEMBER" });
  });

  it("without a registered address, shows the paste field first and starts in loopback mode", async () => {
    api.fetchMcpOAuthConnections.mockResolvedValue([view({ callbackSupported: false })]);
    api.startMcpSignIn.mockResolvedValue({ authorizeUrl: "https://auth.example/a", expiresAt: "t", redirectUri: "r" });
    render(<McpSignInCard provider="atlassian" displayName="Atlassian" navigate={vi.fn()} />);
    expect(await screen.findByLabelText(/paste its full address/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sign in with Atlassian" }));
    await waitFor(() => expect(api.startMcpSignIn).toHaveBeenCalledWith({ provider: "atlassian", scope: "MEMBER", redirectMode: "loopback" }));
  });

  it.each([
    ["remote_mcp_off", "Remote MCP is switched off for this Workspace. An owner or admin can turn it on in Integrations › Connector credentials."],
    ["server_not_allowed", "This Droplet isn't set up to reach Atlassian."],
    ["connection_disabled", "An owner or admin turned Atlassian off for this Workspace."],
  ])("a 409 %s shows the fixed sentence and never navigates", async (code, sentence) => {
    const navigate = vi.fn();
    api.startMcpSignIn.mockRejectedValue(new Error(code));
    render(<McpSignInCard provider="atlassian" displayName="Atlassian" navigate={navigate} />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in with Atlassian" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(sentence);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("links the remote MCP switch for an admin only", async () => {
    session.role = "admin";
    api.startMcpSignIn.mockRejectedValue(new Error("remote_mcp_off"));
    render(<McpSignInCard provider="atlassian" displayName="Atlassian" />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in with Atlassian" }));
    expect(await screen.findByRole("link", { name: "Open the remote MCP switch" })).toHaveAttribute("href", "/integrations/credentials");
  });

  it("shows the blocked outcome copy for ?mcp=atlassian:blocked", async () => {
    window.history.replaceState(null, "", "/settings?mcp=atlassian:blocked");
    render(<McpSignInCard provider="atlassian" displayName="Atlassian" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Sign-in was blocked because remote MCP was switched off. Nothing was sent to Atlassian.");
  });

  it("refuses a non-http authorize URL", async () => {
    const navigate = vi.fn();
    api.startMcpSignIn.mockResolvedValue({ authorizeUrl: "javascript:void(0)", expiresAt: "t", redirectUri: "r" });
    render(<McpSignInCard provider="atlassian" displayName="Atlassian" navigate={navigate} />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in with Atlassian" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("paste sends the full address", async () => {
    api.fetchMcpOAuthConnections.mockResolvedValue([view({ member: { id: "m1", state: "PENDING_CONSENT" } })]);
    api.pasteMcpRedirect.mockResolvedValue(undefined);
    render(<McpSignInCard provider="atlassian" displayName="Atlassian" />);
    const full = "http://localhost/api/mcp/oauth/callback?code=abc&state=xyz";
    fireEvent.change(await screen.findByLabelText(/paste its full address/i), { target: { value: `  ${full}  ` } });
    fireEvent.click(screen.getByRole("button", { name: "Finish sign-in" }));
    await waitFor(() => expect(api.pasteMcpRedirect).toHaveBeenCalledWith(full));
  });

  it("explains a refused bare code", async () => {
    api.fetchMcpOAuthConnections.mockResolvedValue([view({ member: { id: "m1", state: "PENDING_CONSENT" } })]);
    api.pasteMcpRedirect.mockRejectedValue(new Error("bare_code_rejected"));
    render(<McpSignInCard provider="atlassian" displayName="Atlassian" />);
    fireEvent.change(await screen.findByLabelText(/paste its full address/i), { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Finish sign-in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/whole address/i);
  });

  it("disconnects the member's own sign-in by id", async () => {
    api.fetchMcpOAuthConnections.mockResolvedValue([view({ member: { id: "m1", state: "CONNECTED" } })]);
    api.disconnectMcpOAuth.mockResolvedValue(undefined);
    render(<McpSignInCard provider="atlassian" displayName="Atlassian" />);
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(api.disconnectMcpOAuth).toHaveBeenCalledWith("m1"));
  });

  it("Workspace button stays disabled until the verbatim acknowledgement is ticked", async () => {
    session.role = "admin";
    api.startMcpSignIn.mockResolvedValue({ authorizeUrl: "https://auth.example/a", expiresAt: "t", redirectUri: "r" });
    const navigate = vi.fn();
    render(<McpSignInCard provider="atlassian" displayName="Atlassian" admin navigate={navigate} />);
    const button = await screen.findByRole("button", { name: "Create a Workspace connection" });
    expect(button).toBeDisabled();
    expect(WORKSPACE_ACK_TEXT).toBe("Everyone allowed to use this server acts as this account and sees what it sees.");
    fireEvent.click(screen.getByLabelText(WORKSPACE_ACK_TEXT));
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(api.startMcpSignIn).toHaveBeenCalledWith({ provider: "atlassian", scope: "WORKSPACE", acknowledge: true }));
  });

  it("a member never sees the Workspace connection, even in admin mode", async () => {
    render(<McpSignInCard provider="atlassian" displayName="Atlassian" admin />);
    await screen.findByRole("button", { name: "Sign in with Atlassian" });
    expect(screen.queryByRole("button", { name: "Create a Workspace connection" })).not.toBeInTheDocument();
  });

  it("consumes its own ?mcp= outcome and shows the copy", async () => {
    window.history.replaceState(null, "", "/settings?mcp=atlassian:connected");
    render(<McpSignInCard provider="atlassian" displayName="Atlassian" />);
    expect(await screen.findByText("You are signed in.")).toBeInTheDocument();
    expect(window.location.search).toBe("");
  });
});
