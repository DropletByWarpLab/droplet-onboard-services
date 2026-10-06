import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("@/lib/auth", () => ({ authFetch: (...args: unknown[]) => authFetch(...args) }));
vi.mock("@/components/ConfirmDialog", () => ({ ConfirmDialog: (props: { open: boolean; title: string; description: string; confirmedIdentifier?: string; accessory?: ReactNode; onConfirm: () => Promise<void>; onCancel: () => void }) => props.open ? <div role="dialog"><h2>{props.title}</h2><p>{props.description}</p><p>{props.confirmedIdentifier}</p>{props.accessory}<button onClick={props.onCancel}>Cancel</button><button onClick={() => void props.onConfirm().then(props.onCancel, () => {})}>Confirm turn off</button></div> : null }));
import { Microsoft365Calendar, type MicrosoftCalendarView } from "./Microsoft365Calendar";
const off: MicrosoftCalendarView = { enabled: false, state: "DISCONNECTED", lastSyncAt: null, lastError: null };
const waiting: MicrosoftCalendarView = { enabled: true, state: "WAITING", lastSyncAt: null, lastError: null };
const ready: MicrosoftCalendarView = { enabled: true, state: "CONNECTED", lastSyncAt: "2026-10-05T12:00:00Z", lastError: null, eventCount: 3 };
beforeEach(() => { vi.clearAllMocks(); });
const props = () => ({ accountAddress: "sam@company.example", connected: true, onChanged: vi.fn().mockResolvedValue(undefined), onReconnect: vi.fn(), signInBusy: false });

describe("Outlook calendar opt-in", () => {
  it("enables reading through the endpoint and waits for first sync", async () => {
    authFetch.mockResolvedValue({ ok: true });
    const changes = props();
    const { rerender } = render(<Microsoft365Calendar view={off} {...changes} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Show Outlook calendar in Droplet" }));
    await waitFor(() => expect(changes.onChanged).toHaveBeenCalledOnce());
    expect(authFetch).toHaveBeenCalledWith("/api/m365/calendar", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true }) });
    rerender(<Microsoft365Calendar view={waiting} {...changes} />);
    expect(screen.getByText("Waiting for first calendar sync…")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open Calendar" })).not.toBeInTheDocument();
  });
  it("disables the checkbox while enabling and leaves the setting off if the request fails", async () => {
    let resolve!: (value: { ok: boolean }) => void;
    authFetch.mockImplementation(() => new Promise(done => { resolve = done; }));
    render(<Microsoft365Calendar view={off} {...props()} />);
    const checkbox = screen.getByRole("checkbox", { name: "Show Outlook calendar in Droplet" });
    fireEvent.click(checkbox);
    expect(checkbox).toBeDisabled();
    resolve({ ok: false });
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not enable your outlook calendar/i);
    expect(checkbox).not.toBeChecked();
    expect(checkbox).toBeEnabled();
  });
  it("shows actual imported events as read-only and links to Calendar only after a sync", () => {
    render(<Microsoft365Calendar view={ready} {...props()} />);
    expect(screen.getByTestId("outlook-calendar-status")).toHaveTextContent(/3 events.*read-only/i);
    expect(screen.getByRole("link", { name: "Open Calendar" })).toHaveAttribute("href", "/calendar");
  });
  it("confirms local event removal before sending an off request", async () => {
    authFetch.mockResolvedValue({ ok: true });
    render(<Microsoft365Calendar view={ready} {...props()} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Show Outlook calendar in Droplet" }));
    expect(screen.getByRole("dialog")).toHaveTextContent(/delete the imported calendar events.*nothing in your outlook calendar changes/i);
    expect(screen.getByRole("dialog")).toHaveTextContent("sam@company.example");
    expect(authFetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(authFetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Show Outlook calendar in Droplet" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm turn off" }));
    await waitFor(() => expect(authFetch).toHaveBeenCalledWith("/api/m365/calendar", expect.objectContaining({ body: JSON.stringify({ enabled: false }) })));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
  it("retains the checked calendar and dialog if removal fails", async () => {
    authFetch.mockRejectedValue(new Error("private provider error"));
    render(<Microsoft365Calendar view={ready} {...props()} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Show Outlook calendar in Droplet" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm turn off" }));
    expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveTextContent(/nothing changed/i);
    expect(screen.getByRole("checkbox", { name: "Show Outlook calendar in Droplet" })).toBeChecked();
    expect(screen.queryByText("private provider error")).not.toBeInTheDocument();
  });
  it("offers reconnect when existing calendar consent needs approval", () => {
    const changes = props();
    render(<Microsoft365Calendar view={{ ...waiting, state: "NEEDS_RECONNECT" }} {...changes} />);
    fireEvent.click(screen.getByRole("button", { name: "Reconnect Outlook calendar" }));
    expect(changes.onReconnect).toHaveBeenCalledOnce();
  });
});
