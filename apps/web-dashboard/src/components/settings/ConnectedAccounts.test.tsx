import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const { session, mounted } = vi.hoisted(() => ({ session: { role: "owner" }, mounted: { google: 0, microsoft: 0 } }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role: session.role } }) }));
vi.mock("./GoogleAccountCard", async () => {
  const { useEffect } = await import("react");
  return { GoogleAccountCard: () => { useEffect(() => { mounted.google += 1; }, []); return <div>Google account card</div>; } };
});
vi.mock("./Microsoft365Card", async () => {
  const { useEffect } = await import("react");
  return { Microsoft365Card: () => { useEffect(() => { mounted.microsoft += 1; }, []); return <div>Microsoft account card</div>; } };
});
vi.mock("./AccountProviderSetup", () => ({ AccountProviderSetup: ({ onSaved }: { onSaved: () => void }) => <button onClick={onSaved}>Save registration</button> }));
import { ConnectedAccounts } from "./ConnectedAccounts";

beforeEach(() => { session.role = "owner"; mounted.google = 0; mounted.microsoft = 0; });

describe("Connected accounts settings section", () => {
  it("groups both providers and explains account access and local mail storage", () => {
    render(<ConnectedAccounts />);
    expect(screen.getByRole("region", { name: "Connected accounts" })).toHaveTextContent("Google account card");
    expect(screen.getByRole("region", { name: "Connected accounts" })).toHaveTextContent("Microsoft account card");
    expect(screen.getByText(/does not change how you sign in to droplet/i)).toHaveTextContent(/copied and stored locally/i);
  });
  it("refreshes both connection cards after administrator setup is saved", () => {
    render(<ConnectedAccounts />);
    expect(mounted).toEqual({ google: 1, microsoft: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Save registration" }));
    expect(mounted).toEqual({ google: 2, microsoft: 2 });
  });
  it("hides personal connections for guests", () => {
    session.role = "guest";
    const { container } = render(<ConnectedAccounts />);
    expect(container).toBeEmptyDOMElement();
  });
});
