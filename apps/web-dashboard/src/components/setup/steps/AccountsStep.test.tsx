import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import type { GoogleConnectionView } from "@/components/settings/GoogleAccountCard";
import type { M365ConnectionView } from "@/components/settings/Microsoft365Card";

const { authFetch, navigate } = vi.hoisted(() => ({ authFetch: vi.fn(), navigate: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  authFetch: (...args: unknown[]) => authFetch(...args),
  useAuth: () => ({ user: { role: "owner" } }),
}));
vi.mock("@/components/setup/StepShell", () => ({
  StepShell: ({ current, title, subtitle, children, primary, skip }: {
    current: string; title: string; subtitle: string; children: ReactNode;
    primary: { label: string; onClick: () => void }; skip: { label: string; onClick: () => void };
  }) => <main data-step={current}><h1>{title}</h1><p>{subtitle}</p>{children}<button onClick={skip.onClick}>{skip.label}</button><button onClick={primary.onClick}>{primary.label}</button></main>,
}));
vi.mock("@/components/settings/GoogleAccountCard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/settings/GoogleAccountCard")>();
  return { ...actual, GoogleAccountCard: (props: ComponentProps<typeof actual.GoogleAccountCard>) => <actual.GoogleAccountCard {...props} navigate={navigate} /> };
});
vi.mock("@/components/settings/Microsoft365Card", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/settings/Microsoft365Card")>();
  return { ...actual, Microsoft365Card: (props: ComponentProps<typeof actual.Microsoft365Card>) => <actual.Microsoft365Card {...props} navigate={navigate} /> };
});
vi.mock("@/components/settings/Microsoft365Files", () => ({ Microsoft365Files: () => null, SYNC_POLL_MS: 30_000 }));
vi.mock("@/components/ConfirmDialog", () => ({ ConfirmDialog: () => null }));

import { AccountsStep } from "./AccountsStep";

const googleView = (overrides: Partial<GoogleConnectionView> = {}): GoogleConnectionView => ({
  state: "DISCONNECTED", accountAddress: null, connectedAt: null, lastError: null,
  configured: true, callbackSupported: true,
  redirectUri: new URL("/api/google/callback", window.location.origin).toString(),
  mailboxId: null, mailEnabled: true, calendarEnabled: false,
  ...overrides,
});
const microsoftView = (overrides: Partial<M365ConnectionView> = {}): M365ConnectionView => ({
  state: "DISCONNECTED", accountUpn: null, tenantId: null, app: null, grantedScopes: [],
  connectedAt: null, lastRefreshOkAt: null, lastError: null, configured: true,
  redirectUri: new URL("/api/m365/callback", window.location.origin).toString(),
  calendar: { enabled: false, state: "DISCONNECTED", lastSyncAt: null, lastError: null },
  ...overrides,
});
const json = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, json: async () => body });

function serveConnections(google = googleView(), microsoft = microsoftView()) {
  authFetch.mockImplementation(async (url: string) => {
    if (url === "/api/google/connection") return json(google);
    if (url === "/api/m365/connection") return json(microsoft);
    if (url.endsWith("/connect")) return json({ authorizeUrl: "https://provider.example/consent" });
    throw new Error(`Unexpected request: ${url}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/setup?step=accounts");
  serveConnections();
});

describe("Optional connected accounts onboarding", () => {
  it("offers Google and Microsoft with the existing permissions explanation and administrator setup", async () => {
    render(<AccountsStep onComplete={vi.fn()} onSkip={vi.fn()} beforeConnect={vi.fn().mockResolvedValue(undefined)} />);
    expect(await screen.findByRole("button", { name: "Connect Google" })).toBeEnabled();
    expect(await screen.findByRole("button", { name: "Connect Outlook" })).toBeEnabled();
    expect(screen.getByText(/does not change how you sign in to droplet/i)).toHaveTextContent(/copied and stored locally/i);
    expect(screen.getByText(/connect your work or school microsoft account/i)).toHaveTextContent(/received and sent outlook emails or calendar/i);
    expect(screen.getByText("Account connection setup")).toBeInTheDocument();
  });

  it("supplies provider card and button styles without applying shell styles to wizard controls", async () => {
    render(<AccountsStep onComplete={vi.fn()} onSkip={vi.fn()} beforeConnect={vi.fn().mockResolvedValue(undefined)} />);
    const google = await screen.findByRole("button", { name: "Connect Google" });
    const microsoft = await screen.findByRole("button", { name: "Connect Outlook" });
    const styleScope = google.closest(".droplet-shell");
    expect(styleScope).not.toBeNull();
    expect(styleScope).toHaveStyle({ minHeight: "0", background: "transparent" });
    expect(microsoft.closest(".droplet-shell")).toBe(styleScope);
    expect(google.closest(".card")?.closest(".droplet-shell")).toBe(styleScope);
    expect(microsoft.closest(".card")?.closest(".droplet-shell")).toBe(styleScope);
    expect(screen.getByRole("button", { name: "Continue" }).closest(".droplet-shell")).toBeNull();
    expect(screen.getByRole("button", { name: "Skip for now" }).closest(".droplet-shell")).toBeNull();
  });

  it("can continue or skip when neither provider is configured", async () => {
    serveConnections(googleView({ configured: false }), microsoftView({ configured: false }));
    const onComplete = vi.fn();
    const onSkip = vi.fn();
    const beforeConnect = vi.fn();
    render(<AccountsStep onComplete={onComplete} onSkip={onSkip} beforeConnect={beforeConnect} />);
    expect(await screen.findByRole("button", { name: "Connect Google" })).toBeDisabled();
    expect(await screen.findByRole("button", { name: "Connect Outlook" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(onComplete).toHaveBeenCalledOnce();
    expect(onSkip).toHaveBeenCalledOnce();
    expect(beforeConnect).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(authFetch.mock.calls.filter(([, init]) => init?.method)).toHaveLength(0);
  });

  it("retries failed connection reads while skip remains available", async () => {
    let fail = true;
    authFetch.mockImplementation(async (url: string) => {
      if (url === "/api/google/connection") { if (fail) throw new Error("offline"); return json(googleView()); }
      return json(microsoftView());
    });
    render(<AccountsStep onComplete={vi.fn()} onSkip={vi.fn()} beforeConnect={vi.fn()} />);
    expect(await screen.findByText("Droplet could not read your Google connection.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skip for now" })).toBeEnabled();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: "Connect Google" })).toBeEnabled();
  });

  it.each([
    ["Connect Google", "/api/google/connect", { mail: true, calendar: false, returnTo: "/setup?step=accounts" }],
    ["Connect Outlook", "/api/m365/connect", { returnTo: "/setup?step=accounts" }],
  ] as const)("saves the resume point before %s starts provider approval", async (label, endpoint, body) => {
    let finishSave!: () => void;
    const beforeConnect = vi.fn(() => new Promise<void>((resolve) => { finishSave = resolve; }));
    render(<AccountsStep onComplete={vi.fn()} onSkip={vi.fn()} beforeConnect={beforeConnect} />);
    fireEvent.click(await screen.findByRole("button", { name: label }));
    expect(beforeConnect).toHaveBeenCalledOnce();
    expect(authFetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    expect(navigate).not.toHaveBeenCalled();
    await act(async () => { finishSave(); });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("https://provider.example/consent"));
    expect(authFetch).toHaveBeenCalledWith(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  });

  it.each(["Connect Google", "Connect Outlook"])("does not leave setup when saving progress fails before %s", async (label) => {
    const beforeConnect = vi.fn().mockRejectedValue(new Error("private setup error"));
    render(<AccountsStep onComplete={vi.fn()} onSkip={vi.fn()} beforeConnect={beforeConnect} />);
    fireEvent.click(await screen.findByRole("button", { name: label }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not save your setup progress/i);
    expect(screen.getByRole("button", { name: label })).toBeEnabled();
    expect(screen.queryByText("private setup error")).not.toBeInTheDocument();
    expect(authFetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each(["Connect Google", "Connect Outlook"])("keeps a skip safe while %s is waiting to save progress", async (label) => {
    let finishSave!: () => void;
    const beforeConnect = () => new Promise<void>((resolve) => { finishSave = resolve; });
    const result = render(<AccountsStep onComplete={vi.fn()} onSkip={() => result.rerender(<p>Next setup step</p>)} beforeConnect={beforeConnect} />);
    fireEvent.click(await screen.findByRole("button", { name: label }));
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    await act(async () => { finishSave(); });
    expect(screen.getByText("Next setup step")).toBeInTheDocument();
    expect(authFetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each(["Connect Google", "Connect Outlook"])("does not redirect after a skip while %s is starting approval", async (label) => {
    let finishConnect!: (response: ReturnType<typeof json>) => void;
    authFetch.mockImplementation(async (url: string) => {
      if (url === "/api/google/connection") return json(googleView());
      if (url === "/api/m365/connection") return json(microsoftView());
      return new Promise<ReturnType<typeof json>>((resolve) => { finishConnect = resolve; });
    });
    const result = render(<AccountsStep onComplete={vi.fn()} onSkip={() => result.rerender(<p>Next setup step</p>)} beforeConnect={vi.fn().mockResolvedValue(undefined)} />);
    fireEvent.click(await screen.findByRole("button", { name: label }));
    await waitFor(() => expect(authFetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    await act(async () => { finishConnect(json({ authorizeUrl: "https://provider.example/consent" })); });
    expect(screen.getByText("Next setup step")).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each(["Connect Google", "Connect Outlook"])("opens the registered setup address for %s and preserves only the fixed return target", async (label) => {
    window.history.replaceState(null, "", "/setup?step=accounts&private=do-not-copy");
    serveConnections(
      googleView({ redirectUri: "https://registered.example/api/google/callback" }),
      microsoftView({ redirectUri: "https://registered.example/api/m365/callback" }),
    );
    const beforeConnect = vi.fn().mockResolvedValue(undefined);
    render(<AccountsStep onComplete={vi.fn()} onSkip={vi.fn()} beforeConnect={beforeConnect} />);
    fireEvent.click(await screen.findByRole("button", { name: label }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("https://registered.example/setup?step=accounts"));
    expect(beforeConnect).toHaveBeenCalledOnce();
    expect(authFetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });

  it("shows declined approval for both providers without blocking the next setup step", async () => {
    window.history.replaceState(null, "", "/setup?step=accounts&google=cancelled&m365=cancelled");
    render(<AccountsStep onComplete={vi.fn()} onSkip={vi.fn()} beforeConnect={vi.fn()} />);
    expect(await screen.findByTestId("google-outcome")).toHaveTextContent(/cancelled/i);
    expect(await screen.findByTestId("m365-outcome")).toHaveTextContent(/cancelled/i);
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Skip for now" })).toBeEnabled();
    expect(window.location.search).toBe("?step=accounts");
  });

  it("reads successful connections on return and allows the Outlook calendar to be enabled", async () => {
    window.history.replaceState(null, "", "/setup?step=accounts&google=connected&m365=connected");
    serveConnections(
      googleView({ state: "CONNECTED", accountAddress: "sam@example.com", mailboxId: "mailbox1" }),
      microsoftView({ state: "CONNECTED", accountUpn: "sam@school.example" }),
    );
    render(<AccountsStep onComplete={vi.fn()} onSkip={vi.fn()} beforeConnect={vi.fn()} />);
    expect(await screen.findByText("Connected as sam@example.com")).toBeInTheDocument();
    expect(await screen.findByText("Connected as sam@school.example")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Show Outlook calendar in Droplet" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
    expect(window.location.search).toBe("?step=accounts");
  });

  it("keeps Outlook email import available and saves the onboarding return point before email reconnect", async () => {
    serveConnections(googleView(), microsoftView({
      state: "CONNECTED", accountUpn: "sam@school.example",
      mail: { enabled: true, state: "NEEDS_RECONNECT", needsConsent: true, lastSyncAt: "2026-10-05T12:00:00Z",
        lastError: null, mailboxId: "outlook-mailbox", messageCount: 12 },
    }));
    const beforeConnect = vi.fn().mockResolvedValue(undefined);
    render(<AccountsStep onComplete={vi.fn()} onSkip={vi.fn()} beforeConnect={beforeConnect} />);
    expect(await screen.findByRole("checkbox", { name: "Import Outlook emails into Droplet" })).toBeChecked();
    expect(screen.getByRole("link", { name: "Open Outlook inbox" })).toHaveAttribute("href", "/email/outlook-mailbox");
    fireEvent.click(screen.getByRole("button", { name: "Reconnect Outlook email" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("https://provider.example/consent"));
    expect(beforeConnect).toHaveBeenCalledOnce();
    expect(authFetch).toHaveBeenCalledWith("/api/m365/connect", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ returnTo: "/setup?step=accounts" }),
    });
  });
});
