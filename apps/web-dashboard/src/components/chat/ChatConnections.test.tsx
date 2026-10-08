import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { buildHubEntries, type HubEntry } from "@/lib/hooks/useIntegrations";
import { PROVIDER_DESCRIPTORS } from "@/components/integrations/provider-descriptors";
import { Dialog } from "@/components/Dialog";

const mocks = vi.hoisted(() => ({
  role: "owner" as string | undefined,
  push: vi.fn(),
  integrations: vi.fn(),
  refresh: vi.fn(),
  saveReturn: vi.fn().mockResolvedValue(undefined),
  resumeReturn: vi.fn(),
  personalMounts: { google: 0, m365: 0 },
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role: mocks.role } }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/lib/chat-connection-return", () => ({ saveChatConnectionReturn: mocks.saveReturn, resumeChatConnectionReturn: mocks.resumeReturn, chatConnectionNavigationUrl: (_provider: string, url: string) => url }));
vi.mock("@/lib/hooks/useIntegrations", async (original) => ({ ...await original<typeof import("@/lib/hooks/useIntegrations")>(), useIntegrations: mocks.integrations }));
vi.mock("@/components/settings/GoogleAccountCard", async () => {
  const { useEffect } = await import("react");
  return { GoogleAccountCard: ({ returnTo, beforeConnect }: { returnTo?: string; beforeConnect?: () => Promise<void> }) => {
    useEffect(() => { mocks.personalMounts.google += 1; }, []);
    return <section aria-label="Google setup"><span>Return to {returnTo}</span><button onClick={() => void beforeConnect?.()}>Approve Google</button></section>;
  } };
});
vi.mock("@/components/settings/Microsoft365Card", async () => {
  const { useEffect } = await import("react");
  return { Microsoft365Card: ({ returnTo, beforeConnect }: { returnTo?: string; beforeConnect?: () => Promise<void> }) => {
    useEffect(() => { mocks.personalMounts.m365 += 1; }, []);
    return <section aria-label="Microsoft setup"><span>Return to {returnTo}</span><button onClick={() => void beforeConnect?.()}>Approve Microsoft</button></section>;
  } };
});
vi.mock("@/components/settings/EmailAccountCard", () => ({ EmailAccountCard: () => <div>Existing mailbox setup</div> }));
vi.mock("@/components/calendar/SubscriptionsPanel", () => ({ SubscriptionsPanel: () => <div>Existing calendar setup</div> }));
vi.mock("@/components/integrations/SaasCredentialsSection", () => ({ SaasCredentialsSection: () => <div>Existing descriptor credential setup</div> }));
vi.mock("@/components/integrations/ConnectWizard", () => ({ ConnectWizard: ({ catalogId, onClose, onConnected, triggerRef }: {
  catalogId: string | null; onClose: () => void; onConnected?: () => void; triggerRef?: import("react").RefObject<HTMLElement | null>;
}) => <Dialog open={catalogId !== null} onClose={onClose} labelledBy="wizard-label" triggerRef={triggerRef}>
  <h2 id="wizard-label">Provider setup</h2><span>{catalogId}</span>
  <button onClick={onConnected}>Connection confirmed</button><button onClick={onClose}>Close setup</button>
</Dialog> }));

import { ChatConnections } from "./ChatConnections";

function hub(entries: HubEntry[] = buildHubEntries([], null), overrides: Record<string, unknown> = {}) {
  mocks.integrations.mockReturnValue({ entries, connected: [], isLoading: false, error: null, refresh: mocks.refresh, ...overrides });
}
function open() {
  fireEvent.click(screen.getByRole("button", { name: "Connections" }));
  return screen.getByRole("dialog", { name: "Connections" });
}
function connection(id: string) {
  const element = document.querySelector<HTMLElement>(`[data-connection-id="${id}"]`);
  expect(element).not.toBeNull();
  return within(element!);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.role = "owner";
  mocks.personalMounts.google = 0;
  mocks.personalMounts.m365 = 0;
  mocks.resumeReturn.mockReturnValue(null);
  hub();
});

describe("connections inside chat", () => {
  it.each(["owner", "admin"])("fetches status only after the %s opens Connections", (role) => {
    mocks.role = role;
    render(<ChatConnections />);
    expect(mocks.integrations).toHaveBeenLastCalledWith(false);
    expect(mocks.personalMounts).toEqual({ google: 0, m365: 0 });
    open();
    expect(mocks.integrations).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Close connections" }));
    expect(mocks.integrations).toHaveBeenLastCalledWith(false);
  });

  it("lets family connect personal accounts and calendars without requesting shared status", () => {
    mocks.role = "family";
    render(<ChatConnections />);
    open();
    expect(mocks.integrations).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole("button", { name: /Google \/ Gmail/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Microsoft \/ Outlook/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Calendar subscription/ })).toBeInTheDocument();
    expect(document.querySelector('[data-connection-id="mailbox"]')).toBeNull();
    for (const descriptor of PROVIDER_DESCRIPTORS) expect(document.querySelector(`[data-connection-id="${descriptor.meta.id}"]`)).toBeNull();
  });

  it.each(["guest", undefined])("hides connection setup and skips status for role %s", (role) => {
    mocks.role = role;
    const { container } = render(<ChatConnections />);
    expect(container).toBeEmptyDOMElement();
    expect(mocks.integrations).toHaveBeenLastCalledWith(false);
    expect(mocks.resumeReturn).not.toHaveBeenCalled();
  });

  it("renders the entire descriptor catalog and retains reported-only connections", () => {
    hub(buildHubEntries([{ provider: "future-box-provider", status: "CONNECTED", writeEnabled: false }], null));
    render(<ChatConnections />);
    open();
    for (const descriptor of PROVIDER_DESCRIPTORS) expect(connection(descriptor.meta.id).getByText(descriptor.meta.name)).toBeInTheDocument();
    expect(connection("future-box-provider").getByText(/isn't in the dashboard's connector catalog yet/)).toBeInTheDocument();
    expect(connection("future-box-provider").getByRole("button", { name: "Open" })).toBeDisabled();
    expect(connection("future-box-provider").getByText("There's no detail view for this connection yet.")).toBeInTheDocument();
  });

  it("opens the selected provider's wizard alone, refreshes actual status, and returns to the browser", async () => {
    const descriptor = PROVIDER_DESCRIPTORS.find((item) => item.connect.kind === "wizard")!;
    render(<ChatConnections />);
    open();
    fireEvent.click(connection(descriptor.meta.id).getByRole("button", { name: "Connect" }));
    const wizard = await screen.findByRole("dialog", { name: "Provider setup" });
    expect(within(wizard).getByText(descriptor.meta.id)).toBeInTheDocument();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    fireEvent.click(within(wizard).getByRole("button", { name: "Connection confirmed" }));
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    fireEvent.click(within(wizard).getByRole("button", { name: "Close setup" }));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: "Connections" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("searchbox", { name: "Search connections" })).toHaveFocus());
  });

  it("dispatches other route descriptors to their existing page", () => {
    const descriptor = PROVIDER_DESCRIPTORS.find((item) => item.open.kind === "route")!;
    hub(buildHubEntries([{ provider: descriptor.providerKeys[0], status: "CONNECTED", writeEnabled: false }], null));
    render(<ChatConnections />);
    open();
    fireEvent.click(connection(descriptor.meta.id).getByRole("button", { name: "Open" }));
    expect(mocks.push).toHaveBeenCalledWith(descriptor.open.kind === "route" ? descriptor.open.href : "");
    expect(mocks.integrations).toHaveBeenLastCalledWith(false);
  });

  it("embeds the existing credential configurator for its exact setup route", async () => {
    const descriptor = PROVIDER_DESCRIPTORS.find((item) => item.connect.kind === "route" && item.connect.href === "/integrations/credentials")!;
    render(<ChatConnections />);
    open();
    fireEvent.click(connection(descriptor.meta.id).getByRole("button", { name: "Connect" }));
    expect(await screen.findByText("Existing descriptor credential setup")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Connector credentials" })).toBeInTheDocument();
    expect(mocks.push).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "All connections" }));
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog", { name: "Connections" })).toBeInTheDocument();
  });

  it("removes a privileged wizard when the owner becomes family", async () => {
    const descriptor = PROVIDER_DESCRIPTORS.find((item) => item.connect.kind === "wizard")!;
    const { rerender } = render(<ChatConnections />);
    open();
    fireEvent.click(connection(descriptor.meta.id).getByRole("button", { name: "Connect" }));
    expect(await screen.findByRole("dialog", { name: "Provider setup" })).toBeInTheDocument();
    mocks.role = "family";
    rerender(<ChatConnections />);
    expect(screen.queryByRole("dialog", { name: "Provider setup" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Connections" })).toBeInTheDocument();
    expect(mocks.integrations).toHaveBeenLastCalledWith(false);
  });

  it("disables unavailable setup and states its reason", () => {
    const fixture = buildHubEntries([], null)[0];
    hub([{ ...fixture, connect: { kind: "unavailable", reason: "Provider setup requires a future device update." } }]);
    render(<ChatConnections />);
    open();
    expect(connection(fixture.meta.id).getByRole("button", { name: "Connect" })).toBeDisabled();
    expect(connection(fixture.meta.id).getByText("Provider setup requires a future device update.")).toBeInTheDocument();
  });

  it("searches backend keys and description, filters by category, and reports no matches", () => {
    const entry = buildHubEntries([], null).find((item) => item.providerKeys.some((key) => key !== item.meta.id))!;
    render(<ChatConnections />);
    open();
    const search = screen.getByRole("searchbox", { name: "Search connections" });
    fireEvent.change(search, { target: { value: entry.providerKeys.find((key) => key !== entry.meta.id) } });
    expect(connection(entry.meta.id).getByText(entry.meta.name)).toBeInTheDocument();
    fireEvent.change(search, { target: { value: entry.meta.description } });
    expect(connection(entry.meta.id).getByText(entry.meta.name)).toBeInTheDocument();
    fireEvent.change(search, { target: { value: "" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Filter connections" }), { target: { value: entry.meta.category } });
    const ids = Array.from(document.querySelectorAll<HTMLElement>("[data-connection-id]")).map((element) => element.dataset.connectionId);
    expect(ids).toEqual(buildHubEntries([], null).filter((item) => item.meta.category === entry.meta.category).map((item) => item.meta.id));
    fireEvent.change(search, { target: { value: "no-such-provider-on-this-droplet" } });
    expect(screen.getByText("No connections match your search or filter.")).toBeInTheDocument();
  });

  it("shows loading and failed reads without inventing a not-configured status", () => {
    hub(buildHubEntries(undefined, null), { isLoading: true });
    const { rerender } = render(<ChatConnections />);
    open();
    expect(screen.getByText("Checking connection status…")).toBeInTheDocument();
    const entries = buildHubEntries(undefined, { code: "NETWORK_ERROR" });
    hub(entries, { error: "Couldn't check connection status (NETWORK_ERROR)." });
    rerender(<ChatConnections />);
    expect(screen.getByRole("alert")).toHaveTextContent("Connection status may be out of date.");
    expect(screen.queryByText("Not configured")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry connection status" }));
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it.each([
    { provider: "google", label: /Google \/ Gmail/, region: "Google setup", approve: "Approve Google" },
    { provider: "m365", label: /Microsoft \/ Outlook/, region: "Microsoft setup", approve: "Approve Microsoft" },
  ])("lazily opens $provider setup and preserves chat before approval", async ({ provider, label, region, approve }) => {
    mocks.role = "family";
    render(<ChatConnections />);
    open();
    expect(mocks.personalMounts).toEqual({ google: 0, m365: 0 });
    fireEvent.click(screen.getByRole("button", { name: label }));
    const card = await screen.findByRole("region", { name: region });
    expect(card).toHaveTextContent("Return to /chat");
    fireEvent.click(within(card).getByRole("button", { name: approve }));
    expect(mocks.saveReturn).toHaveBeenCalledWith(provider);
    expect(mocks.integrations).toHaveBeenLastCalledWith(false);
  });

  it.each(["google", "m365"])("reopens %s setup after returning from provider approval", async (provider) => {
    mocks.resumeReturn.mockReturnValue(provider);
    render(<ChatConnections />);
    expect(await screen.findByRole("region", { name: provider === "google" ? "Google setup" : "Microsoft setup" })).toBeInTheDocument();
  });

  it("reuses mailbox and calendar forms instead of sending credentials in chat", async () => {
    render(<ChatConnections />);
    open();
    fireEvent.click(connection("mailbox").getByText("Mailbox"));
    expect(await screen.findByText("Existing mailbox setup")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "All connections" }));
    fireEvent.click(connection("calendar").getByText("Calendar subscription"));
    expect(await screen.findByText("Existing calendar setup")).toBeInTheDocument();
  });

  it("restores keyboard focus to the stable composer trigger on close", async () => {
    render(<ChatConnections />);
    const trigger = screen.getByRole("button", { name: "Connections" });
    trigger.focus();
    open();
    await waitFor(() => expect(screen.getByRole("searchbox", { name: "Search connections" })).toHaveFocus());
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
});
