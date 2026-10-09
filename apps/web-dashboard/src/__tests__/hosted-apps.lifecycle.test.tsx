import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SWRConfig } from "swr";

const auth = vi.hoisted(() => ({ id: "owner-1", role: "owner", fetch: vi.fn() }));
const router = vi.hoisted(() => ({ push: vi.fn() }));
const box = vi.hoisted(() => ({ address: "localhost" }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { id: auth.id, role: auth.role }, isLoading: false }), authFetch: (...args: unknown[]) => auth.fetch(...args) }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/lib/hooks/useBoxAddress", () => ({ useBoxAddress: () => box.address }));
import { HostedAppOpen, HostedAppSetup } from "@/components/hosted/AppActions";
import { HostedAppError } from "@/components/hosted/api";
import { useOwnerConfirmation } from "@/components/hosted/useOwnerConfirmation";
import { InstalledList } from "@/components/admin/extensions/InstalledList";
import { AppGrantDialog } from "@/components/hosted/AppGrantDialog";
import { AppUninstallDialog } from "@/components/hosted/AppUninstallDialog";
import { NewAppForm } from "@/components/workshop/NewAppForm";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const session = () => json({ url: "https://localhost:8443/daily/_droplet/session?code=old-owner-code" });
function deferred() { let resolve!: (value: Response) => void; const promise = new Promise<Response>(r => { resolve = r; }); return { promise, resolve }; }
const fresh = (node: React.ReactNode) => <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{node}</SWRConfig>;
beforeEach(() => { vi.clearAllMocks(); auth.id = "owner-1"; auth.role = "owner"; box.address = "localhost"; });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); (globalThis as unknown as { jsdom: { reconfigure: (options: { url: string }) => void } }).jsdom.reconfigure({ url: "http://localhost:3000/" }); });

describe("App browser handoff retirement", () => {
  it.each(["https://192.168.1.195/", "https://droplet.local/"])("accepts the authenticated appliance DNS address while the dashboard uses %s", async (dashboardUrl) => {
    (globalThis as unknown as { jsdom: { reconfigure: (options: { url: string }) => void } }).jsdom.reconfigure({ url: dashboardUrl });
    box.address = "droplet-ai.lan";
    const tab = { opener: null, location: { replace: vi.fn() }, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    auth.fetch.mockResolvedValue(json({ url: "https://droplet-ai.lan:8443/daily/_droplet/session?code=single-use" }));
    render(<HostedAppOpen slug="daily" />); fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(tab.location.replace).toHaveBeenCalledWith("https://droplet-ai.lan:8443/daily/_droplet/session?code=single-use"));
    expect(tab.close).not.toHaveBeenCalled();
  });
  it.each(["account", "role", "slug", "disabled", "unmount"])("closes the reserved tab when %s changes before the mint completes", async (change) => {
    const pending = deferred(); const tab = { opener: "old", location: { replace: vi.fn() }, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window); auth.fetch.mockReturnValue(pending.promise);
    const view = render(<HostedAppOpen slug="daily" />); fireEvent.click(screen.getByRole("button"));
    const signal = auth.fetch.mock.calls[0][1].signal as AbortSignal;
    if (change === "unmount") view.unmount();
    else {
      if (change === "account") auth.id = "family-2";
      if (change === "role") auth.role = "family";
      view.rerender(<HostedAppOpen slug={change === "slug" ? "weekly" : "daily"} disabled={change === "disabled"} />);
    }
    expect(signal.aborted).toBe(true); expect(tab.close).toHaveBeenCalled();
    await act(async () => { pending.resolve(session()); });
    expect(tab.location.replace).not.toHaveBeenCalled();
  });
  it.each(["https://unrelated.example:8443/daily/_droplet/session?code=secret", "https://localhost:8443/daily/_droplet/session?code=secret#fragment"])("refuses an unrelated or ambiguous session destination %s", async (url) => {
    const tab = { opener: null, location: { replace: vi.fn() }, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window); auth.fetch.mockResolvedValue(json({ url }));
    render(<HostedAppOpen slug="daily" />); fireEvent.click(screen.getByRole("button"));
    await screen.findByRole("alert"); expect(tab.close).toHaveBeenCalled(); expect(tab.location.replace).not.toHaveBeenCalled();
  });
  it("does not surface a late refusal from a previous principal", async () => {
    const pending = deferred(); vi.spyOn(window, "open").mockReturnValue(null); auth.fetch.mockReturnValue(pending.promise);
    const view = render(<HostedAppOpen slug="daily" />); fireEvent.click(screen.getByRole("button"));
    auth.id = "owner-2"; view.rerender(<HostedAppOpen slug="daily" />);
    await act(async () => { pending.resolve(json({ error: "denied" }, 403)); });
    expect(screen.queryByRole("alert")).toBeNull(); expect(screen.getByRole("button")).not.toBeDisabled();
  });
});

describe("App setup ownership during asynchronous requests", () => {
  it.each(["account", "workspace", "unmount"])("does not enqueue setup when %s changes during conversation creation", async (change) => {
    const pending = deferred(); auth.fetch.mockImplementation((path: string) => path === "/api/llm/conversations" ? pending.promise : Promise.resolve(json({ id: "run-old" })));
    const view = render(<HostedAppSetup workspaceId="workspace-old" name="Old app" />); fireEvent.click(screen.getByRole("button"));
    if (change === "unmount") view.unmount();
    else { if (change === "account") auth.id = "owner-2"; view.rerender(<HostedAppSetup workspaceId={change === "workspace" ? "workspace-new" : "workspace-old"} name="New app" />); }
    await act(async () => { pending.resolve(json({ id: "chat-old" })); });
    expect(auth.fetch.mock.calls.map(call => call[0])).toEqual(["/api/llm/conversations"]); expect(router.push).not.toHaveBeenCalled();
  });
  it("does not navigate to a completed setup after its workspace unmounts", async () => {
    const pending = deferred(); auth.fetch.mockImplementation((path: string) => path === "/api/agent-runs" ? pending.promise : Promise.resolve(json({ id: "chat-old" })));
    const view = render(<HostedAppSetup workspaceId="workspace-old" name="Old app" />);
    await act(async () => { fireEvent.click(screen.getByRole("button")); }); view.unmount();
    await act(async () => { pending.resolve(json({ id: "run-old" })); }); expect(router.push).not.toHaveBeenCalled();
  });
  it("discards a previous principal's saved retry chat", async () => {
    let conversations = 0; let runs = 0;
    auth.fetch.mockImplementation((path: string) => Promise.resolve(path === "/api/llm/conversations" ? json({ id: `chat-${++conversations}` }) : ++runs === 1 ? json({}, 503) : json({ id: "run-new" })));
    const view = render(<HostedAppSetup workspaceId="workspace-1" name="App" />); fireEvent.click(screen.getByRole("button"));
    await screen.findByRole("link", { name: "Open the setup chat" }); auth.id = "owner-2";
    view.rerender(<HostedAppSetup workspaceId="workspace-1" name="App" />);
    expect(screen.queryByRole("link", { name: "Open the setup chat" })).toBeNull(); fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/chat?c=chat-2")); expect(conversations).toBe(2);
  });
});

describe("Owner confirmation retirement", () => {
  const action = vi.fn(async () => undefined);
  function ConfirmHarness({ code = "STEP_UP_PASSWORD_REQUIRED" }: { code?: string }) {
    const owner = useOwnerConfirmation({ actionLabel: "Continue", onError: vi.fn() });
    return <><button onClick={() => owner.requestConfirmation(new HostedAppError(403, code), action)}>Request action</button>{owner.confirmation}</>;
  }
  it.each(["account", "role"])("clears a pending password prompt on %s replacement", (change) => {
    const view = render(<ConfirmHarness />); fireEvent.click(screen.getByText("Request action"));
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "old-password" } });
    if (change === "account") auth.id = "owner-2"; else auth.role = "admin";
    view.rerender(<ConfirmHarness />); expect(screen.queryByRole("dialog")).toBeNull(); expect(action).not.toHaveBeenCalled();
  });
  it("drops a late MFA verification after an account replacement", async () => {
    const pending = deferred(); vi.stubGlobal("fetch", vi.fn().mockReturnValue(pending.promise));
    const view = render(<ConfirmHarness code="mfa_required" />); fireEvent.click(screen.getByText("Request action"));
    const dialog = screen.getByRole("dialog"); fireEvent.change(within(dialog).getByLabelText("Password"), { target: { value: "password" } });
    fireEvent.change(within(dialog).getByLabelText("Two-factor code"), { target: { value: "123456" } }); fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
    auth.id = "owner-2"; view.rerender(<ConfirmHarness code="mfa_required" />);
    await act(async () => { pending.resolve(json({ ok: true })); }); expect(action).not.toHaveBeenCalled();
  });
  it("clears cancellation before a new confirmation is requested", async () => {
    render(<ConfirmHarness />); fireEvent.click(screen.getByText("Request action"));
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "discarded" } }); fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByText("Request action")); expect(screen.getByLabelText("Password")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "fresh" } }); fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(action).toHaveBeenCalledExactlyOnceWith("fresh"));
  });
  it("closes management dialogs as soon as owner management is removed", async () => {
    auth.fetch.mockResolvedValue(json({ roles: [] }));
    const props = { extensions: [{ id: "daily", status: "live", version: null, failureReason: null, readback: { kind: "app", lines: [] } }], loading: false, error: undefined, busy: null, canManage: true, onSetEnabled: vi.fn(), onUninstall: vi.fn() } as unknown as React.ComponentProps<typeof InstalledList>;
    const view = render(fresh(<InstalledList {...props} />)); fireEvent.click(screen.getByRole("button", { name: "Access for daily" }));
    await screen.findByRole("dialog"); auth.role = "admin"; view.rerender(fresh(<InstalledList {...props} canManage={false} />)); expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("retires an app grant dialog across owner replacement without replaying a protected mutation", async () => {
    auth.fetch.mockImplementation((path: string, init?: RequestInit) => Promise.resolve(init?.method === "PUT" ? json({ error: "STEP_UP_PASSWORD_REQUIRED" }, 403) : json({ roles: [] })));
    const close = vi.fn(); const view = render(fresh(<AppGrantDialog slug="daily" onSaved={vi.fn()} onClose={close} triggerRef={{ current: null }} />));
    await screen.findByLabelText("Allow members to open this app"); fireEvent.click(screen.getByRole("button", { name: "Save access" }));
    await screen.findByRole("dialog", { name: "Confirm it's you" }); auth.id = "owner-2";
    view.rerender(fresh(<AppGrantDialog slug="daily" onSaved={vi.fn()} onClose={close} triggerRef={{ current: null }} />));
    expect(screen.queryByRole("dialog")).toBeNull(); expect(close).toHaveBeenCalled(); expect(auth.fetch.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
  });
  it("offers no owner dialogs or setup writes to a member", () => {
    auth.role = "family"; render(fresh(<><AppGrantDialog slug="daily" onSaved={vi.fn()} onClose={vi.fn()} triggerRef={{ current: null }} /><AppUninstallDialog slug="daily" onDone={vi.fn()} onClose={vi.fn()} triggerRef={{ current: null }} /><HostedAppSetup workspaceId="w" name="App" /></>));
    expect(screen.queryByRole("dialog")).toBeNull(); expect(screen.getByRole("button")).toBeDisabled(); expect(auth.fetch).not.toHaveBeenCalled();
  });
});

describe("App creation retirement", () => {
  it.each(["account", "unmount"])("ignores creation callbacks after %s changes", async (change) => {
    const pending = deferred(); auth.fetch.mockImplementation((path: string) => path === "/api/hosted" ? Promise.resolve(json({ apps: [], supervisionEnabled: true })) : pending.promise);
    const created = vi.fn(); const close = vi.fn(); const view = render(<NewAppForm templates={["static-site"]} onCreated={created} onClose={close} initialFocusRef={{ current: null }} onBusyChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Create app workspace" })).not.toBeDisabled()); fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Old app" } });
    fireEvent.click(screen.getByRole("button", { name: "Create app workspace" }));
    if (change === "unmount") view.unmount(); else { auth.id = "owner-2"; view.rerender(<NewAppForm templates={["static-site"]} onCreated={created} onClose={close} initialFocusRef={{ current: null }} onBusyChange={vi.fn()} />); }
    await act(async () => { pending.resolve(json({ id: "old-workspace", name: "Old app" })); }); expect(created).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
  });
});
