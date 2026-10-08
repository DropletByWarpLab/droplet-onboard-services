import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { providerDescriptor, type ConnectCard, type ConnectionsOverview } from "@droplet/shared-types";
import { PROVIDER_DESCRIPTORS } from "@/components/integrations/provider-descriptors";
import { Dialog } from "@/components/Dialog";
import { ChatMessage } from "@/components/ChatMessage";
import { connectCallsOf } from "./connect/connect-split";
import { ToolConnectCards } from "./connect/ToolConnectCards";

const mocks = vi.hoisted(() => ({
  role: "owner", userId: "person", authFetch: vi.fn(), integrations: vi.fn(), refresh: vi.fn(),
  oauth: { beforeConnect: vi.fn().mockResolvedValue(undefined), navigate: vi.fn(), afterConnect: vi.fn(), close: vi.fn(), cancel: vi.fn(), error: null as string | null, status: null as string | null },
  oauthOptions: {} as { onConnected?: () => void; onReturn?: () => void },
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { id: mocks.userId, role: mocks.role } }), authFetch: mocks.authFetch }));
vi.mock("@/lib/hooks/useIntegrations", () => ({ useIntegrations: mocks.integrations }));
vi.mock("@/lib/hooks/useChatConnectionOAuth", () => ({ useChatConnectionOAuth: (_provider: string, options: typeof mocks.oauthOptions) => { mocks.oauthOptions = options; return mocks.oauth; } }));
vi.mock("@/components/settings/GoogleAccountCard", () => ({ GoogleAccountCard: ({ returnTo, beforeConnect, navigate, afterConnect }: { returnTo?: string; beforeConnect?: () => Promise<void>; navigate?: (url: string) => void; afterConnect?: () => void }) => <section aria-label="Google setup"><span>Return to {returnTo}</span><button onClick={async () => { await beforeConnect?.(); navigate?.("provider-sign-in-url"); afterConnect?.(); }}>Approve Google</button></section> }));
vi.mock("@/components/settings/Microsoft365Card", () => ({ Microsoft365Card: () => <section aria-label="Microsoft setup">Microsoft account form</section> }));
vi.mock("@/components/settings/EmailAccountCard", () => ({ EmailAccountCard: ({ onConnected }: { onConnected?: () => void }) => <section aria-label="Mailbox setup"><input aria-label="Mailbox password" type="password" /><button onClick={onConnected}>Verified mailbox save</button></section> }));
vi.mock("@/components/calendar/SubscriptionsPanel", () => ({ SubscriptionsPanel: ({ onConnected }: { onConnected?: () => void }) => <section aria-label="Calendar setup"><input aria-label="Calendar share URL" /><button onClick={onConnected}>Saved calendar source</button></section> }));
vi.mock("@/components/integrations/SaasCredentialsSection", () => ({ SaasCredentialsSection: () => <div>Existing credential configurator</div> }));
vi.mock("@/components/settings/AccountProviderSetup", () => ({ AccountProviderSetup: ({ onSaved }: { onSaved: () => void }) => <button onClick={onSaved}>Saved provider registration</button> }));
vi.mock("@/components/integrations/ConnectWizard", () => ({ ConnectWizard: ({ catalogId, onClose, onConnected }: { catalogId: string | null; onClose: () => void; onConnected?: () => void }) => <Dialog open labelledBy="provider-setup-title" onClose={onClose}><h2 id="provider-setup-title">Provider setup</h2><span>{catalogId}</span><button onClick={onConnected}>Verified provider connection</button><button onClick={onClose}>Close provider setup</button></Dialog> }));
import { ChatConnections } from "./ChatConnections";

function card(family: ConnectCard["family"] = "google", provider: string = family): ConnectCard {
  const base = { kind: "connect_card" as const, provider, family, displayName: family === "google" ? "Google" : provider, scope: family === "integration" || family === "mailbox" ? "box" as const : "personal" as const, summary: "Approve account access or enter setup details in this popup.", safety: "setup-internet" as const, manageHref: "/settings" };
  if (family === "google" || family === "m365") return { ...base, mode: "oauth", providerLabel: family, options: [{ name: "mail", label: "Mail", defaultChecked: true }], start: { path: `/api/${family}/connect` } };
  if (family === "calendar" || family === "mailbox") return { ...base, mode: family, fields: [], post: { path: family === "calendar" ? "/api/calendar/sources" : "/api/email/accounts" } };
  return { ...base, mode: "wizard", steps: ["Approve access", "Check connection"], wizardHref: "/integrations" };
}
function overview(): ConnectionsOverview {
  const available = PROVIDER_DESCRIPTORS.map((entry) => ({ provider: entry.providerKeys[0], family: "integration" as const, displayName: entry.meta.name, category: entry.meta.category, scope: "box" as const, canConnect: entry.connect.kind !== "unavailable" }));
  return { kind: "connections_overview", connected: [{ id: "integration:future", family: "integration", provider: "future-provider", displayName: "Future reported system", scope: "box", status: "needs_attention", capabilities: [], manageHref: "/integrations", canDisconnect: true, canReconnect: false }], available: [{ provider: "google", family: "google", displayName: "Google / Gmail", category: "Personal accounts", scope: "personal", canConnect: true }, ...available], counts: { connected: 0, needsAttention: 1, available: available.length + 1 }, boxWideVisible: true };
}
function tool(data: unknown, name = "start_connection", id = "call-1") { return { id, name, args: {}, ok: true, data }; }

beforeEach(() => {
  vi.clearAllMocks(); mocks.role = "owner"; mocks.userId = "person"; mocks.oauth.status = null; mocks.oauth.error = null;
  mocks.integrations.mockReturnValue({ refresh: mocks.refresh });
  mocks.refresh.mockReset().mockResolvedValue([]);
  mocks.authFetch.mockResolvedValue({ ok: true, json: async () => ({ card: card() }) });
});

describe("connection setup through chat tool results", () => {
  it("offers no Connections or setup entry to an external guest, including a saved successful result", () => {
    mocks.role = "guest";
    const { container } = render(<ToolConnectCards calls={connectCallsOf([tool(overview(), "list_connections")])} interactive />);
    expect(container).toBeEmptyDOMElement();
    expect(mocks.authFetch).not.toHaveBeenCalled();
    expect(mocks.integrations).not.toHaveBeenCalled();
  });
  it("closes the previous person's setup and ignores its completion when the account changes", async () => {
    const calls = connectCallsOf([tool(card())]);
    const onOutcome = vi.fn();
    const view = render(<ToolConnectCards calls={calls} interactive onOutcome={onOutcome} />);
    await screen.findByRole("region", { name: "Google setup" });
    const completePrevious = mocks.oauthOptions.onConnected;
    mocks.userId = "next-person";
    view.rerender(<ToolConnectCards calls={calls} interactive onOutcome={onOutcome} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mocks.oauth.close).toHaveBeenCalled();
    act(() => completePrevious?.());
    expect(onOutcome).not.toHaveBeenCalled();
  });
  it("ignores a descriptor lookup that finishes for the previous person", async () => {
    let resolve!: (value: unknown) => void;
    mocks.authFetch.mockReturnValue(new Promise((done) => { resolve = done; }));
    const request = { kind: "overview" as const, overview: overview() };
    const view = render(<ChatConnections request={request} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Set up Google / Gmail" }));
    mocks.userId = "next-person";
    view.rerender(<ChatConnections request={request} onClose={vi.fn()} />);
    await act(async () => { resolve({ ok: true, json: async () => ({ card: card() }) }); });
    expect(screen.queryByRole("region", { name: "Google setup" })).not.toBeInTheDocument();
  });
  it("adds no composer or permanent connection control when closed", () => {
    const { container } = render(<ChatConnections request={null} onClose={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
    expect(mocks.integrations).toHaveBeenLastCalledWith(false);
  });
  it("opens the popup automatically for a fresh successful connection tool", async () => {
    render(<ToolConnectCards calls={connectCallsOf([tool(card())])} interactive />);
    expect(await screen.findByRole("dialog", { name: "Connect Google" })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Google setup" })).toHaveTextContent("Return to /chat/connect-return");
    expect(window.location.pathname).not.toContain("settings");
  });
  it("does not open a popup or active form from rehydrated history", () => {
    render(<ToolConnectCards calls={connectCallsOf([tool(card())])} interactive={false} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open setup" })).toBeDisabled();
    expect(mocks.authFetch).not.toHaveBeenCalled();
  });
  it("does not reopen a dismissed popup when the same completed result rerenders", async () => {
    const calls = connectCallsOf([tool(card())]);
    const { rerender } = render(<ToolConnectCards calls={calls} interactive />);
    const dialog = await screen.findByRole("dialog", { name: "Connect Google" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Close connection setup" }));
    rerender(<ToolConnectCards calls={connectCallsOf([tool(card())])} interactive />);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
  it("does not auto-open a completed result again after the assistant receives its persisted id", async () => {
    const seenIds = new Set<string>();
    const calls = connectCallsOf([tool(card())]);
    const first = render(<ToolConnectCards calls={calls} interactive seenIds={seenIds} />);
    expect(await screen.findByRole("dialog", { name: "Connect Google" })).toBeInTheDocument();
    first.unmount();
    render(<ToolConnectCards calls={calls} interactive seenIds={seenIds} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open setup" })).toBeEnabled();
  });
  it("returns focus to the existing tool-result action after closing a manually reopened popup", async () => {
    render(<ToolConnectCards calls={connectCallsOf([tool(card())])} interactive />);
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Connect Google" })).getByRole("button", { name: "Close connection setup" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const trigger = screen.getByRole("button", { name: "Open setup" });
    fireEvent.click(trigger);
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Connect Google" })).getByRole("button", { name: "Close connection setup" }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });
  it("wires results through the existing ChatMessage and keeps malformed results as chips", async () => {
    const { rerender } = render(<ChatMessage message={{ id: "assistant", role: "assistant", content: "Let's connect your account.", toolCalls: [tool(card())] }} connectionSetupInteractive />);
    expect(await screen.findByRole("dialog", { name: "Connect Google" })).toBeInTheDocument();
    expect(screen.queryByTestId("tool-call-chips")).not.toBeInTheDocument();
    rerender(<ChatMessage message={{ id: "assistant", role: "assistant", content: "Could not open setup.", toolCalls: [tool({ kind: "connect_card", post: { path: "https://untrusted.invalid" } })] }} />);
    expect(screen.getByTestId("tool-call-chips")).toBeInTheDocument();
  });
  it("shows the whole available catalog and retains reported-only connections inside the popup", () => {
    render(<ChatConnections request={{ kind: "overview", overview: overview() }} onClose={vi.fn()} />);
    for (const descriptor of PROVIDER_DESCRIPTORS) expect(screen.getByText(descriptor.meta.name)).toBeInTheDocument();
    expect(screen.getByText("Future reported system")).toBeInTheDocument();
    expect(screen.getByText("Needs attention")).toBeInTheDocument();
  });
  it("searches/filter overview choices and explains no matches", () => {
    render(<ChatConnections request={{ kind: "overview", overview: overview() }} onClose={vi.fn()} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Filter connections" }), { target: { value: "Personal accounts" } });
    expect(screen.getByRole("button", { name: "Set up Google / Gmail" })).toBeInTheDocument();
    expect(screen.queryByText(PROVIDER_DESCRIPTORS[0].meta.name)).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search connections" }), { target: { value: "missing-provider" } });
    expect(screen.getByText("No connections match your search or filter.")).toBeInTheDocument();
  });
  it("loads a fresh role-checked setup descriptor when selecting an overview choice", async () => {
    render(<ChatConnections request={{ kind: "overview", overview: overview() }} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Set up Google / Gmail" }));
    expect(await screen.findByRole("region", { name: "Google setup" })).toBeInTheDocument();
    expect(mocks.authFetch).toHaveBeenCalledWith("/api/connections/card?q=google");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });
  it("rereads the real overview after a verified connection and shows that status on return", async () => {
    const next = overview();
    next.connected = [{ ...next.connected[0], id: "google:person", family: "google", provider: "google", displayName: "Google account", status: "connected" }];
    next.counts.connected = 1;
    next.counts.needsAttention = 0;
    mocks.authFetch.mockImplementation((url: string) => Promise.resolve({ ok: true, json: async () => url === "/api/connections" ? next : { card: card() } }));
    render(<ChatConnections request={{ kind: "overview", overview: overview() }} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Set up Google / Gmail" }));
    await screen.findByRole("region", { name: "Google setup" });
    act(() => mocks.oauthOptions.onConnected?.());
    fireEvent.click(screen.getByRole("button", { name: "All connections" }));
    expect(await screen.findByText("Google account")).toBeInTheDocument();
    expect(mocks.authFetch).toHaveBeenCalledWith("/api/connections");
    expect(screen.getByText(/1 connected · 0 need attention/)).toBeInTheDocument();
  });
  it("reports lookup failure explicitly and retains the choices for retry", async () => {
    mocks.authFetch.mockRejectedValue(new Error("network failed"));
    render(<ChatConnections request={{ kind: "overview", overview: overview() }} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Set up Google / Gmail" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Droplet could not load this connection's setup.");
    expect(screen.getByRole("button", { name: "Set up Google / Gmail" })).toBeEnabled();
  });
  it("dispatches the backend provider key to its canonical catalog wizard without navigation", async () => {
    const descriptor = PROVIDER_DESCRIPTORS.find((entry) => entry.connect.kind === "wizard" && entry.providerKeys.some((key) => providerDescriptor(key)?.catalog?.id === entry.meta.id))!;
    const provider = descriptor.providerKeys.find((key) => providerDescriptor(key)?.catalog?.id === descriptor.meta.id)!;
    render(<ChatConnections request={{ kind: "card", card: card("integration", provider) }} onClose={vi.fn()} />);
    const dialog = await screen.findByRole("dialog", { name: "Provider setup" });
    expect(within(dialog).getByText(descriptor.meta.id)).toBeInTheDocument();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });
  it("opens the API transport's complete form instead of the SQL provisioning wizard", async () => {
    render(<ChatConnections request={{ kind: "card", card: card("integration", "eaglesoft-api") }} onClose={vi.fn()} />);
    expect(screen.queryByRole("dialog", { name: "Provider setup" })).not.toBeInTheDocument();
    expect(await screen.findByRole("form", { name: "Patterson API setup" })).toBeInTheDocument();
    expect(screen.getByLabelText("Integration key")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText(/Route map JSON/)).toBeRequired();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });
  it("reports an API connection using a fixed metadata sentence without sending form details to chat", async () => {
    const onOutcome = vi.fn();
    mocks.authFetch.mockResolvedValue({ ok: true, json: async () => ({ provider: "eaglesoft-api", status: "CONNECTED" }) });
    render(<ChatConnections request={{ kind: "card", card: card("integration", "eaglesoft-api") }} onClose={vi.fn()} onOutcome={onOutcome} />);
    await screen.findByRole("form", { name: "Patterson API setup" });
    for (const [label, value] of [["Server host or IP", "private-server.lan"], ["Integration key", "private-key"], ["User id", "private-user"], ["Password", "private-password"]]) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    }
    fireEvent.change(screen.getByLabelText(/Route map JSON/), { target: { value: JSON.stringify({ authenticate: { controller: "Authentication", method: "Authenticate", verb: "POST", template: "/private-route" }, reads: {}, writes: {} }) } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(onOutcome).toHaveBeenCalledWith("eaglesoft-api is connected now."));
    expect(JSON.stringify(onOutcome.mock.calls)).not.toMatch(/private-/);
  });
  it.each(["CONNECTED", "CAPABILITY_LIMITED", "NEEDS_RECONNECT"])("reports wizard success only when a status reread confirms %s", async (status) => {
    const descriptor = PROVIDER_DESCRIPTORS.find((entry) => entry.connect.kind === "wizard")!;
    const onOutcome = vi.fn();
    mocks.refresh.mockResolvedValue([{ provider: descriptor.providerKeys[0], status, writeEnabled: false }]);
    render(<ChatConnections request={{ kind: "card", card: card("integration", descriptor.providerKeys[0]) }} onClose={vi.fn()} onOutcome={onOutcome} />);
    fireEvent.click(await screen.findByRole("button", { name: "Verified provider connection" }));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
    if (status === "NEEDS_RECONNECT") expect(onOutcome).not.toHaveBeenCalled();
    else await waitFor(() => expect(onOutcome).toHaveBeenCalledTimes(1));
  });
  it("uses the existing credential configurator for MCP setup and never follows the supplied wizard URL", async () => {
    const descriptor = PROVIDER_DESCRIPTORS.find((entry) => entry.connect.kind === "route" && entry.connect.href === "/integrations/credentials")!;
    render(<ChatConnections request={{ kind: "card", card: card("integration", descriptor.providerKeys[0]) }} onClose={vi.fn()} />);
    expect(await screen.findByText("Existing credential configurator")).toBeInTheDocument();
  });
  it("removes privileged setup on role downgrade and skips admin status for family", async () => {
    const descriptor = PROVIDER_DESCRIPTORS.find((entry) => entry.connect.kind === "wizard")!;
    const request = { kind: "card" as const, card: card("integration", descriptor.providerKeys[0]) };
    const { rerender } = render(<ChatConnections request={request} onClose={vi.fn()} />);
    expect(await screen.findByRole("dialog", { name: "Provider setup" })).toBeInTheDocument();
    mocks.role = "family"; rerender(<ChatConnections request={request} onClose={vi.fn()} />);
    expect(screen.queryByRole("dialog", { name: "Provider setup" })).not.toBeInTheDocument();
    expect(screen.getByText(/ask your droplet owner or administrator/i)).toBeInTheDocument();
    expect(mocks.integrations).toHaveBeenLastCalledWith(false);
  });
  it("ignores a late wizard status reread after administrator access is lost", async () => {
    let resolve!: (value: unknown) => void;
    mocks.refresh.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const descriptor = PROVIDER_DESCRIPTORS.find((entry) => entry.connect.kind === "wizard")!;
    const request = { kind: "card" as const, card: card("integration", descriptor.providerKeys[0]) };
    const onOutcome = vi.fn();
    const { rerender } = render(<ChatConnections request={request} onClose={vi.fn()} onOutcome={onOutcome} />);
    fireEvent.click(await screen.findByRole("button", { name: "Verified provider connection" }));
    mocks.role = "family";
    rerender(<ChatConnections request={request} onClose={vi.fn()} onOutcome={onOutcome} />);
    await act(async () => { resolve([{ provider: descriptor.providerKeys[0], status: "CONNECTED" }]); });
    expect(onOutcome).not.toHaveBeenCalled();
  });
  it("wires provider approval into its separate window and reports only verified success once", async () => {
    const onOutcome = vi.fn();
    render(<ChatConnections request={{ kind: "card", card: card() }} onClose={vi.fn()} onOutcome={onOutcome} />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve Google" }));
    await waitFor(() => expect(mocks.oauth.navigate).toHaveBeenCalledWith("provider-sign-in-url"));
    expect(mocks.oauth.afterConnect).toHaveBeenCalled();
    expect(onOutcome).not.toHaveBeenCalled();
    act(() => { mocks.oauthOptions.onConnected?.(); mocks.oauthOptions.onConnected?.(); });
    expect(onOutcome.mock.calls).toEqual([["Google is connected now."]]);
  });
  it("offers explicit cancellation while provider approval is pending", async () => {
    mocks.oauth.status = "Finish approval in the sign-in window. Your chat stays open here.";
    render(<ChatConnections request={{ kind: "card", card: card() }} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel sign-in" }));
    expect(mocks.oauth.cancel).toHaveBeenCalledTimes(1);
  });
  it("keeps an already-connected personal account manageable inside the popup", async () => {
    const existing = { ...card(), blocked: { reason: "already_connected" as const, message: "Google is already connected." } };
    render(<ChatConnections request={{ kind: "card", card: existing }} onClose={vi.fn()} />);
    expect(await screen.findByRole("region", { name: "Google setup" })).toBeInTheDocument();
  });
  it("lets an administrator configure provider registration here and reloads the setup descriptor", async () => {
    const missing = { ...card(), blocked: { reason: "setup_required" as const, message: "Provider registration is required." } };
    render(<ChatConnections request={{ kind: "card", card: missing }} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Saved provider registration" }));
    expect(await screen.findByRole("region", { name: "Google setup" })).toBeInTheDocument();
    expect(mocks.authFetch).toHaveBeenCalledWith("/api/connections/card?q=google");
  });
  it("sends no mailbox password or calendar URL in outcomes", async () => {
    const onOutcome = vi.fn();
    const { rerender } = render(<ChatConnections request={{ kind: "card", card: card("mailbox") }} onClose={vi.fn()} onOutcome={onOutcome} />);
    fireEvent.change(await screen.findByLabelText("Mailbox password"), { target: { value: "private-mailbox-password" } });
    expect(onOutcome).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Verified mailbox save" }));
    expect(onOutcome.mock.calls).toEqual([["mailbox is connected now."]]);
    rerender(<ChatConnections request={{ kind: "card", card: card("calendar") }} onClose={vi.fn()} onOutcome={onOutcome} />);
    fireEvent.change(await screen.findByLabelText("Calendar share URL"), { target: { value: "private-calendar-share-url" } });
    fireEvent.click(screen.getByRole("button", { name: "Saved calendar source" }));
    expect(onOutcome).toHaveBeenLastCalledWith("Calendar subscription was added. The first sync is pending.");
    expect(JSON.stringify(onOutcome.mock.calls)).not.toMatch(/private-/);
  });
});
