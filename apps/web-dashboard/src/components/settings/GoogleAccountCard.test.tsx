import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";

const { authFetch, session } = vi.hoisted(() => ({ authFetch: vi.fn(), session: { role: "family" } }));
vi.mock("@/lib/auth", () => ({ authFetch: (...args: unknown[]) => authFetch(...args), useAuth: () => ({ user: { role: session.role } }) }));
vi.mock("@/components/ConfirmDialog", () => ({
  ConfirmDialog: (props: { open: boolean; title: string; description: string; confirmedIdentifier?: string; accessory?: ReactNode; onConfirm: () => Promise<void>; onCancel: () => void }) => props.open ? <div role="dialog"><h2>{props.title}</h2><p>{props.description}</p><p>{props.confirmedIdentifier}</p>{props.accessory}<button onClick={props.onCancel}>Cancel</button><button onClick={() => void props.onConfirm().then(props.onCancel, () => {})}>Confirm disconnect</button></div> : null,
}));
import { GoogleAccountCard, type GoogleConnectionView } from "./GoogleAccountCard";

const view = (over: Partial<GoogleConnectionView> = {}): GoogleConnectionView => ({ state: "DISCONNECTED", accountAddress: null, connectedAt: null, lastError: null, configured: true, callbackSupported: true, redirectUri: new URL("/api/google/callback", window.location.origin).toString(), mailboxId: null, mailEnabled: true, calendarEnabled: false, calendar: { state: "DISCONNECTED", lastSyncAt: null, lastError: null }, ...over });
const json = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, json: async () => body });

beforeEach(() => { vi.clearAllMocks(); session.role = "family"; window.history.replaceState(null, "", "/settings"); });

describe("Google account connection", () => {
  it("does not expose member accounts or make reads to a guest", () => {
    session.role = "guest";
    const { container } = render(<GoogleAccountCard />);
    expect(container).toBeEmptyDOMElement();
    expect(authFetch).not.toHaveBeenCalled();
  });
  it("connects a configured mailbox with no technical fields or credentials", async () => {
    const navigate = vi.fn();
    authFetch.mockResolvedValueOnce(json(view())).mockResolvedValueOnce(json({ authorizeUrl: "https://provider.example/consent" }));
    render(<GoogleAccountCard navigate={navigate} />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect Google" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("https://provider.example/consent"));
    expect(authFetch).toHaveBeenCalledWith("/api/google/connect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mail: true, calendar: false }) });
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Opening Google…" })).toBeDisabled();
    expect(screen.queryByText(/account linking opens droplet's registered address/i)).not.toBeInTheDocument();
  });
  it("moves an alias to the registered Droplet address without minting consent or copying query data", async () => {
    window.history.replaceState(null, "", "/settings?tab=accounts&private=do-not-copy");
    authFetch.mockResolvedValue(json(view({ redirectUri: "https://registered.example/api/google/callback" })));
    const navigate = vi.fn();
    render(<GoogleAccountCard navigate={navigate} />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect Google" }));
    expect(navigate).toHaveBeenCalledWith("https://registered.example/settings");
    expect(screen.getByText(/account linking opens droplet's registered address/i)).toHaveTextContent(/may need to sign in/i);
    expect(authFetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });
  it("points a person to their administrator and disables a missing setup", async () => {
    authFetch.mockResolvedValue(json(view({ configured: false })));
    render(<GoogleAccountCard />);
    expect(await screen.findByText(/ask your droplet administrator to enable google/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect Google" })).toBeDisabled();
  });
  it("does not start sign-in on an unsupported callback address", async () => {
    authFetch.mockResolvedValue(json(view({ callbackSupported: false })));
    render(<GoogleAccountCard />);
    expect(await screen.findByText(/https address with a registered hostname/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connect Google" }));
    expect(authFetch).toHaveBeenCalledTimes(1);
  });
  it("reports declined consent neutrally and removes only its callback parameter", async () => {
    window.history.replaceState(null, "", "/settings?google=cancelled&tab=accounts");
    authFetch.mockResolvedValue(json(view()));
    render(<GoogleAccountCard />);
    const outcome = await screen.findByTestId("google-outcome");
    expect(outcome).toHaveTextContent(/cancelled/i);
    expect(outcome).toHaveAttribute("role", "status");
    expect(window.location.search).toBe("?tab=accounts");
  });
  it.each(["failed", "expired"])("makes a %s callback actionable", async (outcome) => {
    window.history.replaceState(null, "", `/settings?google=${outcome}`);
    authFetch.mockResolvedValue(json(view()));
    render(<GoogleAccountCard />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/again/i);
    expect(await screen.findByRole("button", { name: "Connect Google" })).toBeEnabled();
  });
  it.each(["cancelled", "expired", "failed"])("keeps the prior connected status truthful after %s additive consent", async (outcome) => {
    window.history.replaceState(null, "", `/settings?google=${outcome}`);
    authFetch.mockResolvedValue(json(view({ state: "CONNECTED", accountAddress: "sam@example.com", mailboxId: "mb1" })));
    render(<GoogleAccountCard />);
    expect(await screen.findByText("Connected as sam@example.com")).toBeInTheDocument();
    expect(screen.getByTestId("google-outcome")).toHaveTextContent(/permission approval/i);
    expect(screen.getByTestId("google-outcome")).not.toHaveTextContent(/nothing was connected|google could not be connected|connect again/i);
    expect(screen.getByRole("button", { name: "Disconnect Google" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Reconnect Google" })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Gmail" })).toBeChecked();
    expect(screen.getByText(/owner or administrator manages gmail removal/i)).toHaveTextContent("Mailboxes Droplet reads");
    expect(authFetch).toHaveBeenCalledTimes(1);
  });
  it("explains a refused account switch, retaining the current address and requiring explicit disconnect", async () => {
    window.history.replaceState(null, "", "/settings?google=different_account");
    authFetch.mockResolvedValue(json(view({ state: "NEEDS_RECONNECT", accountAddress: "sam@example.com", mailboxId: "mb1" })));
    render(<GoogleAccountCard />);
    expect(await screen.findByRole("alert")).toHaveTextContent("To connect a different Google account, disconnect the current one first. Your existing local copies were kept.");
    expect(await screen.findByText(/reconnect sam@example.com/i)).toHaveTextContent(/disconnect this one first/i);
    expect(window.location.search).toBe("");
    expect(authFetch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Google" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("sam@example.com");
    expect(authFetch.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(0);
  });
  it.each(["toString", "<script>unsafe</script>"])("does not reflect unknown callback %s", async (outcome) => {
    window.history.replaceState(null, "", `/settings?google=${encodeURIComponent(outcome)}`);
    authFetch.mockResolvedValue(json(view()));
    render(<GoogleAccountCard />);
    await screen.findByText("Not connected");
    expect(screen.queryByTestId("google-outcome")).not.toBeInTheDocument();
    expect(window.location.search).toBe("");
  });
  it("retries failed status reads", async () => {
    authFetch.mockRejectedValueOnce(new Error("private network error")).mockResolvedValue(json(view()));
    render(<GoogleAccountCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: "Connect Google" })).toBeEnabled();
    expect(screen.queryByText(/private network error/i)).not.toBeInTheDocument();
  });
  it("reconnects with the shared registration and hides raw account errors", async () => {
    const navigate = vi.fn();
    authFetch.mockResolvedValueOnce(json(view({ state: "NEEDS_RECONNECT", accountAddress: "sam@example.com", lastError: "private_token_error" }))).mockResolvedValueOnce(json({ authorizeUrl: "https://provider.example/consent" }));
    render(<GoogleAccountCard navigate={navigate} />);
    fireEvent.click(await screen.findByRole("button", { name: "Reconnect Google" }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(screen.queryByText("private_token_error")).not.toBeInTheDocument();
  });
  it("can disconnect a mailbox that needs reconnection", async () => {
    authFetch.mockResolvedValue(json(view({ state: "NEEDS_RECONNECT", accountAddress: "sam@example.com", mailboxId: "mb1" })));
    render(<GoogleAccountCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect Google" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("sam@example.com");
  });
  it("keeps provider failures friendly and allows retry", async () => {
    authFetch.mockResolvedValueOnce(json(view())).mockResolvedValueOnce(json({ message: "private secret or provider error" }, 500));
    const navigate = vi.fn();
    render(<GoogleAccountCard navigate={navigate} />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect Google" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not start google sign-in/i);
    expect(screen.getByRole("button", { name: "Connect Google" })).toBeEnabled();
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.queryByText("private secret or provider error")).not.toBeInTheDocument();
  });
  it("confirms the exact mailbox and local copy deletion before disconnecting", async () => {
    let current = view({ state: "CONNECTED", accountAddress: "sam@example.com", mailboxId: "mb1" });
    authFetch.mockImplementation(async (_url: string, init?: { method: string }) => {
      if (init?.method === "DELETE") { current = view(); return json({}); }
      return json(current);
    });
    render(<GoogleAccountCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect Google" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("sam@example.com");
    expect(dialog).toHaveTextContent(/delete its local mailbox, copied messages, attachments and imported calendar events/i);
    expect(authFetch).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(authFetch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Google" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm disconnect" }));
    expect(await screen.findByRole("button", { name: "Connect Google" })).toBeEnabled();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(authFetch).toHaveBeenCalledWith("/api/google/connection", { method: "DELETE" });
  });
  it("retains the dialog and connected state if deletion fails", async () => {
    authFetch.mockImplementation(async (_url: string, init?: { method: string }) => init?.method === "DELETE" ? json({}, 500) : json(view({ state: "CONNECTED", accountAddress: "sam@example.com" })));
    render(<GoogleAccountCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect Google" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm disconnect" }));
    expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveTextContent(/nothing changed/i);
    expect(screen.getByText("Connected as sam@example.com")).toBeInTheDocument();
  });

  it("connects calendar only without asking for or promising full mail access", async () => {
    const navigate = vi.fn();
    authFetch.mockResolvedValueOnce(json(view())).mockResolvedValueOnce(json({ authorizeUrl: "https://provider.example/calendar-consent" }));
    render(<GoogleAccountCard navigate={navigate} />);
    await screen.findByRole("button", { name: "Connect Google" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Gmail" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Google Calendar" }));
    expect(screen.queryByText(/full mail access/i)).not.toBeInTheDocument();
    expect(screen.getByText(/calendar access is read-only/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connect Google" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("https://provider.example/calendar-consent"));
    expect(JSON.parse(authFetch.mock.calls.find(([, init]) => init?.method === "POST")![1].body)).toEqual({ mail: false, calendar: true });
  });
  it("requires at least one selected feature", async () => {
    authFetch.mockResolvedValue(json(view()));
    render(<GoogleAccountCard />);
    await screen.findByRole("button", { name: "Connect Google" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Gmail" }));
    expect(screen.getByRole("button", { name: "Connect Google" })).toBeDisabled();
    expect(screen.getByText(/select gmail or google calendar/i)).toBeInTheDocument();
  });
  it("adds calendar to an existing Gmail account with explicit updated consent while locking retained mail", async () => {
    const navigate = vi.fn();
    authFetch.mockResolvedValueOnce(json(view({ state: "CONNECTED", accountAddress: "sam@example.com", mailboxId: "mb1" }))).mockResolvedValueOnce(json({ authorizeUrl: "https://provider.example/both-consent" }));
    render(<GoogleAccountCard navigate={navigate} />);
    await screen.findByText("Connected as sam@example.com");
    expect(screen.getByRole("checkbox", { name: "Gmail" })).toBeDisabled();
    expect(screen.getByText(/remove a calendar import in calendar subscriptions/i)).toHaveTextContent(/owner or administrator manages gmail removal in mailboxes droplet reads/i);
    fireEvent.click(screen.getByRole("checkbox", { name: "Google Calendar" }));
    fireEvent.click(screen.getByRole("button", { name: "Update Google permissions" }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(JSON.parse(authFetch.mock.calls.find(([, init]) => init?.method === "POST")![1].body)).toEqual({ mail: true, calendar: true });
  });
  it("retains calendar-only reconnect choices without adding Gmail", async () => {
    const navigate = vi.fn();
    authFetch.mockResolvedValueOnce(json(view({ state: "NEEDS_RECONNECT", accountAddress: "sam@example.com", mailEnabled: false, calendarEnabled: true, calendar: { state: "NEEDS_RECONNECT", lastSyncAt: null, lastError: null } }))).mockResolvedValueOnce(json({ authorizeUrl: "https://provider.example/calendar-consent" }));
    render(<GoogleAccountCard navigate={navigate} />);
    await screen.findByRole("button", { name: "Reconnect Google" });
    expect(screen.getByRole("checkbox", { name: "Gmail" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Google Calendar" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Google Calendar" })).toBeDisabled();
    expect(screen.queryByText(/full mail access/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reconnect Google" }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(JSON.parse(authFetch.mock.calls.find(([, init]) => init?.method === "POST")![1].body)).toEqual({ mail: false, calendar: true });
  });
  it("waits for an actual first calendar sync before linking to Calendar", async () => {
    let current = view({ state: "CONNECTED", accountAddress: "sam@example.com", mailEnabled: false, calendarEnabled: true, calendar: { state: "WAITING", lastSyncAt: null, lastError: null } });
    authFetch.mockImplementation(async () => json(current));
    render(<GoogleAccountCard calendarPollMs={20} />);
    expect(await screen.findByText("Waiting for first calendar sync…")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open Calendar" })).not.toBeInTheDocument();
    current = { ...current, calendar: { state: "CONNECTED", lastSyncAt: new Date().toISOString(), lastError: null, eventCount: 12 } };
    expect(await screen.findByRole("link", { name: "Open Calendar" })).toHaveAttribute("href", "/calendar");
    expect(screen.getByTestId("google-calendar-status")).toHaveTextContent(/12 events.*read-only/i);
  });
});
