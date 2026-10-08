import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SWRConfig } from "swr";

const auth = vi.hoisted(() => ({ role: "owner", id: "owner-1", fetch: vi.fn() }));
const router = vi.hoisted(() => ({ push: vi.fn() }));
const lifecycle = vi.hoisted(() => ({ uninstall: vi.fn() }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role: auth.role, id: auth.id }, isLoading: false }), authFetch: (...args: unknown[]) => auth.fetch(...args) }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/lib/hooks/useBoxAddress", () => ({ useBoxAddress: () => "localhost" }));
vi.mock("@/components/shell/ShellPage", () => ({ ShellPage: ({ title, actions, children }: { title: string; actions?: React.ReactNode; children: React.ReactNode }) => <main><h1>{title}</h1>{actions}{children}</main> }));
vi.mock("@/lib/api", async (original) => ({ ...(await original<typeof import("@/lib/api")>()), uninstallExtension: (...args: unknown[]) => lifecycle.uninstall(...args) }));

import HostedPage from "@/app/hosted/page";
import { NewToolDialog } from "@/components/workshop/NewToolDialog";
import { HostedAppOpen, HostedAppSetup } from "@/components/hosted/AppActions";
import { AppGrantDialog } from "@/components/hosted/AppGrantDialog";
import { AppUninstallDialog } from "@/components/hosted/AppUninstallDialog";
import { AppLogsDialog } from "@/components/hosted/AppLogsDialog";
import { WorkspaceAppFacts } from "@/components/hosted/WorkspaceAppFacts";
import { WorkspaceContext } from "@/components/workshop/WorkspaceContext";
import { ARCHIVE_CAP_BYTES } from "@/components/workshop/NewAppForm";
import type { WorkspaceDetail } from "@/components/workshop/workspaces/api";
import { ExtensionRequestError } from "@/lib/api";

const APP = { id: "app-1", slug: "daily", workspaceId: "workspace-1", name: "Daily dashboard", version: "0.1.0", status: "live", url: "https://localhost:8443/daily/", memoryMb: 128, lastHealthAt: null, grants: ["family"] };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const renderFresh = (element: React.ReactNode) => render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{element}</SWRConfig>);
const triggerRef = { current: null };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

beforeEach(() => {
  vi.clearAllMocks();
  auth.role = "owner"; auth.id = "owner-1";
  lifecycle.uninstall.mockResolvedValue({ id: "daily", status: "uninstalled" });
  auth.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/hosted" || path === "/api/hosted?workspaceId=workspace-1") return json({ apps: [APP], supervisionEnabled: true });
    if (path === "/api/workspace/templates") return json({ templates: ["python-tool", "static-site", "node-app", "python-app"] });
    if (path === "/api/workspace" && init?.method === "POST") return json({ id: "workspace-1", name: "Daily dashboard" });
    if (path === "/api/workspace/import") return json({ id: "workspace-1", name: "Daily dashboard" });
    if (path === "/api/llm/conversations") return json({ id: "chat-1" }, 201);
    if (path === "/api/agent-runs") return json({ id: "run-1", status: "queued", sessionId: "chat-1" }, 201);
    if (path === "/api/extensions/daily/grants") return json({ roles: ["family"] });
    throw new Error(`Unexpected request: ${path}`);
  });
});

describe("Apps access and browser handoff", () => {
  it("shows granted apps to a member with no creation or management controls", async () => {
    auth.role = "family";
    renderFresh(<HostedPage />);
    expect(await screen.findByText("Daily dashboard")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open daily in browser" })).not.toBeDisabled();
    expect(screen.queryByRole("button", { name: "New app" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Logs for daily" })).toBeNull();
  });
  it("hides ungranted apps from members and never fetches the list for guests", async () => {
    auth.role = "family";
    auth.fetch.mockResolvedValue(json({ apps: [{ ...APP, grants: [] }], supervisionEnabled: true }));
    const view = renderFresh(<HostedPage />);
    expect(await screen.findByText("No apps yet")).toBeTruthy();
    expect(screen.queryByText("Daily dashboard")).toBeNull();
    view.unmount(); auth.fetch.mockClear(); auth.role = "guest";
    renderFresh(<HostedPage />);
    expect(screen.getByText(/Apps are available to owners/)).toBeTruthy();
    expect(auth.fetch).not.toHaveBeenCalled();
  });
  it("disables creation and open when app supervision is off", async () => {
    auth.fetch.mockResolvedValue(json({ apps: [APP], supervisionEnabled: false }));
    renderFresh(<HostedPage />);
    await screen.findByText(/Apps are turned off/);
    expect(screen.getByRole("button", { name: "New app" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Open daily in browser" })).toBeDisabled();
  });
  it("loads the next bounded page when the operator asks for more apps", async () => {
    auth.fetch.mockImplementation(async (path: string) => path === "/api/hosted" ? json({ apps: [APP], supervisionEnabled: true, nextCursor: "daily" }) :
      path === "/api/hosted?cursor=daily" ? json({ apps: [{ ...APP, id: "app-2", slug: "weekly", name: "Weekly dashboard" }], supervisionEnabled: true, nextCursor: null }) : json({}, 404));
    renderFresh(<HostedPage />);
    await screen.findByText("Daily dashboard");
    expect(screen.queryByText("Weekly dashboard")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Load more apps" }));
    expect(await screen.findByText("Weekly dashboard")).toBeTruthy();
    expect(screen.getByText("Daily dashboard")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more apps" })).toBeNull();
  });
  it("mints a session and navigates a reserved tab, using the returned single-use URL", async () => {
    const tab = { opener: "original", location: { replace: vi.fn() }, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    auth.fetch.mockResolvedValue(json({ url: "https://localhost:8443/daily/_droplet/session?code=single-use" }));
    render(<HostedAppOpen slug="daily" />);
    fireEvent.click(screen.getByRole("button", { name: "Open daily in browser" }));
    await waitFor(() => expect(tab.location.replace).toHaveBeenCalledWith("https://localhost:8443/daily/_droplet/session?code=single-use"));
    expect(tab.opener).toBeNull();
    expect(auth.fetch).toHaveBeenCalledWith("/api/hosted/daily/session", expect.objectContaining({ method: "POST", body: "{}" }));
  });
  it.each([
    "javascript:alert(1)", "http://localhost:8443/daily/_droplet/session?code=x",
    "https://localhost/daily/_droplet/session?code=x", "https://localhost:3000/daily/_droplet/session?code=x",
    "https://name:password@localhost:8443/daily/_droplet/session?code=x",
    "https://localhost:8443/other/_droplet/session?code=x", "https://localhost:8443/daily/",
  ])("refuses an invalid session handoff URL %s", async (url) => {
    const tab = { opener: null, location: { replace: vi.fn() }, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    auth.fetch.mockResolvedValue(json({ url }));
    render(<HostedAppOpen slug="daily" />);
    fireEvent.click(screen.getByRole("button", { name: "Open daily in browser" }));
    await screen.findByRole("alert");
    expect(tab.close).toHaveBeenCalled(); expect(tab.location.replace).not.toHaveBeenCalled();
  });
  it("closes the reserved tab and shows a calm refusal when access is denied", async () => {
    const tab = { opener: null, location: { replace: vi.fn() }, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    auth.fetch.mockResolvedValue(json({ error: "denied", message: "untrusted message" }, 403));
    render(<HostedAppOpen slug="daily" />);
    fireEvent.click(screen.getByRole("button", { name: "Open daily in browser" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Ask the owner");
    expect(tab.close).toHaveBeenCalled();
    expect(tab.location.replace).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("untrusted message");
  });
});

describe("New app sources", () => {
  const open = (onCreated = vi.fn()) => render(<NewToolDialog open initialKind="app" onClose={vi.fn()} onCreated={onCreated} />);
  const name = async () => { fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Daily dashboard" } }); await waitFor(() => expect(screen.getByRole("button", { name: "Create app workspace" })).not.toBeDisabled()); };
  it("creates an app from a selected app template without changing tool defaults", async () => {
    const created = vi.fn(); open(created); await name();
    fireEvent.click(screen.getByLabelText(/Node app/));
    fireEvent.click(screen.getByRole("button", { name: "Create app workspace" }));
    await waitFor(() => expect(created).toHaveBeenCalledWith({ id: "workspace-1", name: "Daily dashboard", kind: "app" }));
    const [, input] = auth.fetch.mock.calls.find(([path]) => path === "/api/workspace")!;
    expect(JSON.parse(input.body)).toEqual({ name: "Daily dashboard", kind: "app", template: "node-app" });
  });
  it("imports an archive with multipart fields and lets the browser set its boundary", async () => {
    const created = vi.fn(); open(created); await name();
    fireEvent.click(screen.getByLabelText("Archive"));
    fireEvent.change(screen.getByLabelText(/Archive \(.zip/), { target: { files: [new File(["code"], "daily.tar.gz")] } });
    fireEvent.click(screen.getByRole("button", { name: "Create app workspace" }));
    await waitFor(() => expect(created).toHaveBeenCalled());
    const [, input] = auth.fetch.mock.calls.find(([path]) => path === "/api/workspace/import")!;
    expect(input.body.get("name")).toBe("Daily dashboard");
    expect(input.body.get("archive").name).toBe("daily.tar.gz");
    expect(input.headers).toBeUndefined();
  });
  it("refuses unsupported or oversized archives before calling the import API", async () => {
    open(); await name(); fireEvent.click(screen.getByLabelText("Archive"));
    const input = screen.getByLabelText(/Archive \(.zip/);
    fireEvent.change(input, { target: { files: [new File(["code"], "daily.js")] } });
    fireEvent.click(screen.getByRole("button", { name: "Create app workspace" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a .zip or .tar.gz");
    const file = new File(["code"], "daily.zip"); Object.defineProperty(file, "size", { value: ARCHIVE_CAP_BYTES + 1 });
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Create app workspace" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("limit is 256 MiB");
    expect(auth.fetch.mock.calls.some(([path]) => path === "/api/workspace/import")).toBe(false);
  });
  it("creates a blank app workspace for Git push", async () => {
    open(); await name(); fireEvent.click(screen.getByLabelText("Git push"));
    fireEvent.click(screen.getByRole("button", { name: "Create app workspace" }));
    await waitFor(() => expect(auth.fetch.mock.calls.some(([path]) => path === "/api/workspace")).toBe(true));
    const [, input] = auth.fetch.mock.calls.find(([path]) => path === "/api/workspace")!;
    expect(JSON.parse(input.body)).toEqual({ name: "Daily dashboard", kind: "app" });
  });
  it("keeps app creation disabled when supervision is off", async () => {
    auth.fetch.mockResolvedValue(json({ templates: ["static-site"], apps: [], supervisionEnabled: false }));
    open(); await screen.findByText(/Apps are turned off/);
    expect(screen.getByRole("button", { name: "Create app workspace" })).toBeDisabled();
  });
});

describe("Assistant setup", () => {
  it("reopens an imported app with no manifest or query intent and still offers setup", async () => {
    auth.fetch.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/hosted?workspaceId=")) return json({ apps: [], supervisionEnabled: true });
      if (path.endsWith("/log?limit=30")) return json({ entries: [] });
      if (path.endsWith("/diff")) return json({ diff: "", truncated: false });
      if (path.endsWith("/output")) return json({ lastRun: null });
      const id = path.split("/").at(-1);
      return json({ id, name: id === "workspace-1" ? "Imported app" : "Other workspace", kind: id === "workspace-1" ? "app" : "extension",
        template: null, app: null, status: "active", userId: "owner-1", runs: [], git: { id, branch: "work", head: "a".repeat(40), dirty: false, tags: [] } });
    });
    const Fixture = ({ id }: { id: string }) => <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}><WorkspaceContext workspaceId={id} live={false} /></SWRConfig>;
    const view = render(<Fixture id="workspace-1" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Set up with the assistant" })).not.toBeDisabled());
    view.rerender(<Fixture id="other-workspace" />);
    await screen.findByText("Other workspace");
    expect(screen.queryByRole("button", { name: "Set up with the assistant" })).toBeNull();
    view.rerender(<Fixture id="workspace-1" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Set up with the assistant" })).not.toBeDisabled());
  });
  it("creates an owned chat, queues app-setup with its session, and navigates to watch it", async () => {
    render(<HostedAppSetup workspaceId="workspace-1" name="Daily dashboard" />);
    fireEvent.click(screen.getByRole("button", { name: "Set up with the assistant" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/chat?c=chat-1"));
    const [, input] = auth.fetch.mock.calls.find(([path]) => path === "/api/agent-runs")!;
    expect(JSON.parse(input.body)).toEqual(expect.objectContaining({ brief: "app-setup", workspaceId: "workspace-1", sessionId: "chat-1" }));
    expect(JSON.parse(input.body)).not.toHaveProperty("origin");
  });
  it("retains the saved chat and reuses it when queuing setup is retried", async () => {
    let runs = 0;
    auth.fetch.mockImplementation(async (path: string) => path === "/api/llm/conversations" ? json({ id: "chat-1" }) : ++runs === 1 ? json({ error: "unavailable" }, 503) : json({ id: "run-1" }));
    render(<HostedAppSetup workspaceId="workspace-1" name="Daily dashboard" />);
    fireEvent.click(screen.getByRole("button", { name: "Set up with the assistant" }));
    expect(await screen.findByRole("link", { name: "Open the setup chat" })).toHaveAttribute("href", "/chat?c=chat-1");
    fireEvent.click(screen.getByRole("button", { name: "Try setup again" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/chat?c=chat-1"));
    expect(auth.fetch.mock.calls.filter(([path]) => path === "/api/llm/conversations")).toHaveLength(1);
  });
  it("only offers setup on the requesting person's workspace", async () => {
    const detail = { id: "workspace-1", name: "Daily dashboard", userId: "another-owner", app: null } as unknown as WorkspaceDetail;
    renderFresh(<WorkspaceAppFacts detail={detail} working={false} />);
    expect(screen.queryByRole("button", { name: "Set up with the assistant" })).toBeNull();
    expect(screen.getByText(/person who created this workspace/)).toBeTruthy();
  });
  it("keeps setup disabled on an owned workspace when apps are off", async () => {
    auth.fetch.mockResolvedValue(json({ apps: [], supervisionEnabled: false }));
    const detail = { id: "workspace-1", name: "Daily dashboard", userId: "owner-1", app: null } as unknown as WorkspaceDetail;
    renderFresh(<WorkspaceAppFacts detail={detail} working={false} />);
    await screen.findByText(/Apps are turned off/);
    expect(screen.getByRole("button", { name: "Set up with the assistant" })).toBeDisabled();
  });
});

describe("Owner app access and data", () => {
  it("renders bounded logs as text and says when earlier output was dropped", async () => {
    auth.fetch.mockResolvedValue(json({ output: "<script>untrusted output</script>", droppedBytes: 512, truncated: true, retainedBytes: 100, startSequence: 512, nextSequence: 612 }));
    renderFresh(<AppLogsDialog slug="daily" triggerRef={triggerRef} onClose={vi.fn()} />);
    expect(await screen.findByText("<script>untrusted output</script>")).toBeTruthy();
    expect(document.querySelector("script")).toBeNull();
    expect(screen.getByText(/Older output/)).toBeTruthy();
    expect(auth.fetch).toHaveBeenCalledWith("/api/hosted/daily/logs?limit=200", undefined);
  });
  it("reads member access and saves an explicit empty grant set on revocation", async () => {
    const done = vi.fn().mockResolvedValue(undefined);
    renderFresh(<AppGrantDialog slug="daily" triggerRef={triggerRef} onClose={vi.fn()} onSaved={done} />);
    const checkbox = await screen.findByLabelText("Allow members to open this app");
    expect(checkbox).toBeChecked(); fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole("button", { name: "Save access" }));
    await waitFor(() => expect(done).toHaveBeenCalled());
    const [, input] = auth.fetch.mock.calls.find(([, init]) => init?.method === "PUT")!;
    expect(JSON.parse(input.body)).toEqual({ roles: [] });
  });
  it("preserves data by default and requires the exact slug to delete data", async () => {
    const done = vi.fn().mockResolvedValue(undefined);
    const view = render(<AppUninstallDialog slug="daily" triggerRef={triggerRef} onClose={vi.fn()} onDone={done} />);
    fireEvent.click(screen.getByRole("button", { name: "Confirm uninstall" }));
    await waitFor(() => expect(lifecycle.uninstall).toHaveBeenCalledWith("daily", undefined, undefined));
    view.unmount(); lifecycle.uninstall.mockClear();
    render(<AppUninstallDialog slug="daily" triggerRef={triggerRef} onClose={vi.fn()} onDone={done} />);
    fireEvent.click(screen.getByLabelText(/Also permanently delete/));
    const confirm = screen.getByRole("button", { name: "Confirm uninstall" });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Type daily to delete its data"), { target: { value: "Daily" } });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Type daily to delete its data"), { target: { value: "daily" } });
    fireEvent.click(confirm);
    await waitFor(() => expect(lifecycle.uninstall).toHaveBeenCalledWith("daily", { deleteData: true, confirmSlug: "daily" }, undefined));
  });
  it("requires typed confirmation to remove retained data from an uninstalled app", async () => {
    render(<AppUninstallDialog slug="daily" dataOnly triggerRef={triggerRef} onClose={vi.fn()} onDone={vi.fn().mockResolvedValue(undefined)} />);
    expect(screen.getByRole("button", { name: "Delete saved data" })).toBeDisabled();
    expect(screen.queryByLabelText(/Also permanently delete/)).toBeNull();
    fireEvent.change(screen.getByLabelText("Type daily to delete its data"), { target: { value: "daily" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete saved data" }));
    await waitFor(() => expect(lifecycle.uninstall).toHaveBeenCalledWith("daily", { deleteData: true, confirmSlug: "daily" }, undefined));
  });
  it("uses the existing MFA dialog and retries the same uninstall after verification", async () => {
    lifecycle.uninstall.mockRejectedValueOnce(new ExtensionRequestError("untrusted detail", 401, "mfa_stale"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ ok: true })));
    const done = vi.fn().mockResolvedValue(undefined);
    render(<AppUninstallDialog slug="daily" triggerRef={triggerRef} onClose={vi.fn()} onDone={done} />);
    fireEvent.click(screen.getByRole("button", { name: "Confirm uninstall" }));
    const dialog = await screen.findByRole("dialog", { name: "Confirm it's you" });
    fireEvent.change(within(dialog).getByLabelText("Password"), { target: { value: "password" } });
    fireEvent.change(within(dialog).getByLabelText("Two-factor code"), { target: { value: "123456" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Uninstall app" }));
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(lifecycle.uninstall).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain("untrusted detail");
  });
  it("replays a passkey-only owner's current password only on the protected request", async () => {
    lifecycle.uninstall.mockRejectedValueOnce(new ExtensionRequestError("password required", 403, "STEP_UP_PASSWORD_REQUIRED"));
    render(<AppUninstallDialog slug="daily" triggerRef={triggerRef} onClose={vi.fn()} onDone={vi.fn().mockResolvedValue(undefined)} />);
    fireEvent.click(screen.getByRole("button", { name: "Confirm uninstall" }));
    const dialog = await screen.findByRole("dialog", { name: "Confirm it's you" });
    fireEvent.change(within(dialog).getByLabelText("Password"), { target: { value: "current" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Uninstall app" }));
    await waitFor(() => expect(lifecycle.uninstall).toHaveBeenLastCalledWith("daily", undefined, "current"));
  });
});
