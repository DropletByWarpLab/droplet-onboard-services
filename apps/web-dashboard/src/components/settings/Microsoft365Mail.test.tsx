import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("@/lib/auth", () => ({ authFetch: (...args: unknown[]) => authFetch(...args) }));
vi.mock("@/components/ConfirmDialog", () => ({ ConfirmDialog: (props: { open: boolean; title: string; description: string; confirmedIdentifier?: string; accessory?: ReactNode; onConfirm: () => Promise<void>; onCancel: () => void }) => props.open ? <div role="dialog"><h2>{props.title}</h2><p>{props.description}</p><p>{props.confirmedIdentifier}</p>{props.accessory}<button onClick={props.onCancel}>Cancel</button><button onClick={() => void props.onConfirm().then(props.onCancel, () => {})}>Confirm turn off</button></div> : null }));
import { Microsoft365Mail, type MicrosoftMailView } from "./Microsoft365Mail";
const off: MicrosoftMailView = { enabled: false, state: "DISCONNECTED", needsConsent: false, lastSyncAt: null, lastError: null, mailboxId: null, messageCount: 0 };
const waiting: MicrosoftMailView = { ...off, enabled: true, state: "WAITING", mailboxId: "outlook-1" };
const ready: MicrosoftMailView = { ...waiting, state: "CONNECTED", lastSyncAt: "2026-10-05T12:00:00Z", messageCount: 37 };
beforeEach(() => { authFetch.mockReset(); });
const props = () => ({ accountAddress: "sam@company.example", connected: true, onChanged: vi.fn().mockResolvedValue(undefined), onReconnect: vi.fn(), signInBusy: false });

describe("Outlook email import", () => {
  it("starts only after explicit opt-in and waits for actual imported messages", async () => {
    authFetch.mockResolvedValue({ ok: true });
    const changes = props();
    const { rerender } = render(<Microsoft365Mail view={off} {...changes} />);
    expect(authFetch).not.toHaveBeenCalled();
    expect(screen.getByRole("checkbox", { name: "Import Outlook emails into Droplet" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "Import Outlook emails into Droplet" }));
    await waitFor(() => expect(changes.onChanged).toHaveBeenCalledOnce());
    expect(authFetch).toHaveBeenCalledWith("/api/m365/mail", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true }) });
    rerender(<Microsoft365Mail view={waiting} {...changes} />);
    expect(screen.getByText("Waiting for first email import…")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open Outlook inbox" })).not.toBeInTheDocument();
  });
  it("disables the checkbox during updates and leaves it off on failure without exposing provider errors", async () => {
    let reject!: (error: Error) => void;
    authFetch.mockImplementation(() => new Promise((_done, fail) => { reject = fail; }));
    render(<Microsoft365Mail view={off} {...props()} />);
    const checkbox = screen.getByRole("checkbox", { name: "Import Outlook emails into Droplet" });
    fireEvent.click(checkbox);
    expect(checkbox).toBeDisabled();
    reject(new Error("secret-provider-failure"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not enable outlook email import/i);
    expect(checkbox).not.toBeChecked();
    expect(checkbox).toBeEnabled();
    expect(screen.queryByText("secret-provider-failure")).not.toBeInTheDocument();
  });
  it("explains a mailbox address conflict instead of asking for repeated retries", async () => {
    authFetch.mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: "mailbox_conflict", privateProviderDetail: "hidden-detail" }) });
    render(<Microsoft365Mail view={off} {...props()} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Import Outlook emails into Droplet" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This email address already has a mailbox in Droplet. Remove that mailbox before importing through Outlook.");
    expect(screen.queryByText("hidden-detail")).not.toBeInTheDocument();
  });
  it("links to the local inbox after a successful page without claiming the whole mailbox is complete", () => {
    render(<Microsoft365Mail view={ready} {...props()} />);
    expect(screen.getByTestId("outlook-mail-status")).toHaveTextContent(/37 messages.*last imported/i);
    expect(screen.getByRole("link", { name: "Open Outlook inbox" })).toHaveAttribute("href", "/email/outlook-1");
    expect(screen.getByText(/more emails may arrive as import continues/i)).toBeInTheDocument();
    expect(screen.getByText(/sending from outlook in droplet is not available/i)).toHaveTextContent("Import received and sent Outlook emails");
    expect(screen.getByText(/sending from outlook in droplet is not available/i)).toHaveTextContent("Unsent drafts and attachment files are not imported");
  });
  it.each([null, "invalid-date"])("does not imply imported mail for an OAuth-connected account with lastSyncAt %s", (lastSyncAt) => {
    render(<Microsoft365Mail view={{ ...ready, lastSyncAt }} {...props()} />);
    expect(screen.queryByRole("link", { name: "Open Outlook inbox" })).not.toBeInTheDocument();
    expect(screen.getByText("Waiting for first email import…")).toBeInTheDocument();
  });
  it("offers renewed consent while preserving access to the existing local archive", () => {
    const changes = props();
    render(<Microsoft365Mail view={{ ...ready, needsConsent: true, state: "NEEDS_RECONNECT", lastError: "secret-provider-error" }} {...changes} connected={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Reconnect Outlook email" }));
    expect(changes.onReconnect).toHaveBeenCalledOnce();
    expect(screen.getByRole("link", { name: "Open Outlook inbox" })).toHaveAttribute("href", "/email/outlook-1");
    expect(screen.queryByText("secret-provider-error")).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Import Outlook emails into Droplet" })).toBeEnabled();
  });
  it("confirms the account and local archive/draft removal before turning import off", async () => {
    authFetch.mockResolvedValue({ ok: true });
    render(<Microsoft365Mail view={ready} {...props()} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Import Outlook emails into Droplet" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("sam@company.example");
    expect(dialog).toHaveTextContent(/local messages, attachment metadata and droplet drafts.*emails in outlook stay in outlook.*calendar and file connections stay connected/i);
    expect(authFetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(authFetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Import Outlook emails into Droplet" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm turn off" }));
    await waitFor(() => expect(authFetch).toHaveBeenCalledWith("/api/m365/mail", expect.objectContaining({ body: JSON.stringify({ enabled: false }) })));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
  it("keeps the enabled archive and removal dialog after a failed off request", async () => {
    authFetch.mockResolvedValue({ ok: false });
    render(<Microsoft365Mail view={ready} {...props()} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Import Outlook emails into Droplet" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm turn off" }));
    expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveTextContent(/check its status and try again/i);
    expect(screen.getByRole("checkbox", { name: "Import Outlook emails into Droplet" })).toBeChecked();
  });
  it("shows the server's fixed import error and checks status without changing the preference", () => {
    const changes = props();
    render(<Microsoft365Mail view={{ ...ready, state: "ERROR", lastError: "Outlook email setup could not complete. Check the connection and try enabling email again." }} {...changes} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Outlook email setup could not complete. Check the connection and try enabling email again.");
    fireEvent.click(screen.getByRole("button", { name: "Check import status" }));
    expect(changes.onChanged).toHaveBeenCalledOnce();
    expect(authFetch).not.toHaveBeenCalled();
    expect(screen.getByText(/existing local emails are kept/i)).toBeInTheDocument();
  });
});
