/**
 * WARP-3375 — Disconnect asks what to do with the records the connector copied.
 *
 * The confirm used to say "Your X data is untouched" while the box deleted the
 * Customers records the connector had landed. These tests drive the real
 * `DisconnectControl` and pin, per connector shape: what the copy claims, that
 * Keep is the default and deletes nothing, and that Delete cannot happen
 * without a second, red confirmation.
 *
 * Only the session and `disconnectProvider` are stubbed; the descriptors are
 * the real shared registry, so a connector that starts copying something
 * changes what its confirm says.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const { session, disconnectProviderMock } = vi.hoisted(() => ({
  session: { role: "owner" as string | undefined },
  disconnectProviderMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: session.role ? { id: "u-1", role: session.role } : null }),
}));

vi.mock("@/lib/api.erp", () => ({ disconnectProvider: disconnectProviderMock }));

import { DisconnectControl } from "../DisconnectControl";

function open(provider: string, name: string) {
  render(<DisconnectControl provider={provider} displayName={name} />);
  fireEvent.click(screen.getByRole("button", { name: `Disconnect ${name}` }));
}

const confirm = () => screen.getByTestId("disconnect-confirm").textContent ?? "";
const radio = (name: RegExp) => screen.queryByRole("radio", { name }) as HTMLInputElement | null;

beforeEach(() => {
  session.role = "owner";
  disconnectProviderMock.mockReset().mockResolvedValue({});
});

describe("a connector that copies records offers Keep (default) or Delete", () => {
  it("defaults to Keep, and one click sends keep", async () => {
    // Mutation: pre-select Delete, or send "delete" from the first panel → red.
    open("hubspot", "HubSpot");

    expect(radio(/^Keep the records/)!.checked).toBe(true);
    expect(radio(/^Delete the records/)!.checked).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));

    await waitFor(() => expect(disconnectProviderMock).toHaveBeenCalledTimes(1));
    expect(disconnectProviderMock).toHaveBeenCalledWith("hubspot", "keep");
  });

  it("choosing Delete deletes NOTHING until a second, red confirmation is accepted", async () => {
    // Mutation: run("delete") straight from the first panel's button → red.
    open("hubspot", "HubSpot");

    fireEvent.click(radio(/^Delete the records/)!);
    // The first panel's button no longer disconnects: it moves on.
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(disconnectProviderMock).not.toHaveBeenCalled();

    const second = screen.getByTestId("disconnect-confirm-delete");
    expect(second.textContent).toContain("Delete the companies, contacts and deals copied from HubSpot?");
    expect(second.textContent).toContain("cannot be undone");
    expect(second.className).toContain("#ef4444");

    fireEvent.click(screen.getByRole("button", { name: "Delete records and disconnect" }));

    await waitFor(() => expect(disconnectProviderMock).toHaveBeenCalledTimes(1));
    expect(disconnectProviderMock).toHaveBeenCalledWith("hubspot", "delete");
  });

  it("Go back from the red confirmation deletes nothing and keeps the panel open", () => {
    open("hubspot", "HubSpot");
    fireEvent.click(radio(/^Delete the records/)!);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    fireEvent.click(screen.getByRole("button", { name: "Go back" }));

    expect(disconnectProviderMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("disconnect-confirm")).toBeTruthy();
  });

  it("reopening after an abandoned Delete starts on Keep again", () => {
    // A Delete picked once must never be the default the next time.
    open("hubspot", "HubSpot");
    fireEvent.click(radio(/^Delete the records/)!);
    fireEvent.click(screen.getByRole("button", { name: "Keep connected" }));

    fireEvent.click(screen.getByRole("button", { name: "Disconnect HubSpot" }));

    expect(radio(/^Keep the records/)!.checked).toBe(true);
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
  });

  it("a failed disconnect is said, and offers the trigger again", async () => {
    disconnectProviderMock.mockRejectedValueOnce(Object.assign(new Error("x"), { status: 403 }));
    open("hubspot", "HubSpot");

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));

    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Disconnect HubSpot" })).toBeTruthy();
  });
});

describe("the copy says exactly what each option does, per connector", () => {
  it("HubSpot (CRM): Keep leaves ordinary records, Delete removes them and archives noted ones", () => {
    open("hubspot", "HubSpot");

    const text = confirm();
    expect(text).toContain("removes the stored credential");
    expect(text).toContain("the key is not revoked there");
    expect(text).toContain(
      "The companies, contacts and deals copied from HubSpot stay in Customers as ordinary records your team can edit. They stop syncing.",
    );
    expect(text).toContain(
      "The companies, contacts and deals copied from HubSpot are deleted from Customers. Any that carry a note your team wrote are archived instead, so the note is kept.",
    );
    // Not a ledger connector: nothing is said about Money.
    expect(text).not.toContain("Money");
  });

  it("QuickBooks (ledger): Keep leaves read-only copies, Delete removes invoices and bills", () => {
    open("quickbooks-online", "QuickBooks");

    const text = confirm();
    expect(text).toContain(
      "The invoices and bills copied from QuickBooks stay in Money as read-only copies. They stop updating.",
    );
    expect(text).toContain(
      "The invoices and bills copied from QuickBooks are deleted from Money, with their balance history.",
    );
    expect(text).not.toContain("Customers");
  });

  it("Stripe names only what it lands: invoices, not bills", () => {
    open("stripe", "Stripe");

    expect(confirm()).toContain("The invoices copied from Stripe stay in Money");
    expect(confirm()).not.toContain("bills");
  });

  it("Xero (CRM and ledger): says both", () => {
    open("xero", "Xero");

    const text = confirm();
    expect(text).toContain("The contacts copied from Xero stay in Customers");
    expect(text).toContain("The invoices and bills copied from Xero stay in Money");
  });

  it.each([
    ["eaglesoft", "Eaglesoft"],
    ["github", "GitHub"],
    ["mailchimp", "Mailchimp"],
    ["atlassian", "Atlassian"],
  ])("%s copies nothing: says so, and offers no choice", async (provider, name) => {
    open(provider, name);

    expect(confirm()).toContain(`Droplet keeps no copy of your ${name} data, so no records on this box are affected.`);
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(disconnectProviderMock).toHaveBeenCalledWith(provider, "keep"));
  });

  it("never claims the data is untouched, for any connector", () => {
    // Mutation: restore "Your X data is untouched" → red.
    for (const [provider, name] of [
      ["hubspot", "HubSpot"],
      ["quickbooks-online", "QuickBooks"],
      ["eaglesoft", "Eaglesoft"],
    ] as const) {
      const { unmount } = render(<DisconnectControl provider={provider} displayName={name} />);
      fireEvent.click(screen.getByRole("button", { name: `Disconnect ${name}` }));
      expect(confirm().toLowerCase()).not.toContain("untouched");
      unmount();
    }
  });
});
