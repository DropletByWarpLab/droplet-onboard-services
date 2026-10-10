/**
 * WARP-3965 — the Connectors directory, the connector page, tool permissions
 * and the two browser-handoff pages.
 *
 * Component tests over an SWR fixture: the real hook, cards, detail and
 * permission controls run; only the `@/lib/api` boundary, the session, the
 * router and the heavy dialogs (wizard, confirm, sign-in card) are stubbed.
 * The box's routes are built in parallel (WARP-3960..3964), so every contract
 * assumption below is the plan's §3 and nothing else.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import type { ConnectorDirectoryEntry, DirectoryTool, ToolGrade, ToolPermission } from "@/lib/api";
import { readPackageFile } from "@/__tests__/helpers/test-paths";
import { CHAT_DRAFT_KEY } from "@/lib/types";

const { session, api, push } = vi.hoisted(() => ({
  session: { role: "owner" as string },
  push: vi.fn(),
  api: {
    fetchConnectorDirectory: vi.fn(),
    fetchMcpOAuthConnections: vi.fn(),
    startMcpSignIn: vi.fn(),
    disconnectMcpOAuth: vi.fn(),
    setMcpServerEnabled: vi.fn(),
    setToolPermission: vi.fn(),
    setToolGroupPermission: vi.fn(),
    readMcpHandoff: vi.fn(),
  },
}));

vi.mock("@/lib/api", () => api);
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "u-1", role: session.role } }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/connectors",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ id: "atlassian" }),
}));
vi.mock("@/components/shell/ShellPage", () => ({
  ShellPage: ({ children, actions }: { children?: ReactNode; actions?: ReactNode }) => (
    <div className="droplet-shell">
      <div data-testid="shell-actions">{actions}</div>
      {children}
    </div>
  ),
}));
vi.mock("@/components/ConfirmDialog", () => ({
  ConfirmDialog: (props: {
    open: boolean;
    title: string;
    confirmLabel: string;
    onConfirm: () => void | Promise<void>;
    onCancel: () => void;
  }) =>
    props.open ? (
      <div role="dialog">
        <h2>{props.title}</h2>
        <button onClick={props.onCancel}>Cancel</button>
        <button onClick={() => void Promise.resolve(props.onConfirm()).then(props.onCancel, () => {})}>
          {props.confirmLabel}
        </button>
      </div>
    ) : null,
}));
vi.mock("@/components/integrations/ConnectWizard", () => ({
  ConnectWizard: ({ catalogId }: { catalogId: string | null }) =>
    catalogId ? <div data-testid="connect-wizard" data-provider={catalogId} /> : null,
}));
vi.mock("@/components/integrations/LanApiConnectionSetup", () => ({
  LanApiSetupDialog: ({ open }: { open: boolean }) => (open ? <div data-testid="lan-api" /> : null),
}));
vi.mock("@/components/integrations/DisconnectControl", () => ({
  DisconnectControl: ({ provider }: { provider: string }) => <button>Disconnect {provider}</button>,
}));
vi.mock("@/components/integrations/McpSignInCard", () => ({
  McpSignInCard: ({ provider }: { provider: string }) => <div data-testid={`paste-card-${provider}`} />,
}));
vi.mock("@/lib/hooks/useIntegrations", () => ({
  useIntegrations: () => ({
    entries: [
      {
        meta: { id: "quickbooks", name: "QuickBooks" },
        providerKeys: ["quickbooks-online"],
        connect: { kind: "wizard", catalogId: "quickbooks" },
        open: { kind: "unavailable", reason: "none" },
      },
    ],
  }),
}));

import ConnectorsPage from "@/app/connectors/page";
import ConnectorPage from "@/app/connectors/[id]/page";
import McpConnectedPage from "@/app/connectors/mcp/connected/page";
import { McpHandoffConfirm } from "@/components/integrations/McpHandoffConfirm";
import { ConnectorDetail } from "@/components/integrations/ConnectorDetail";
import { isLoosening, isYours, legalPermissions, matchesQuery } from "@/components/integrations/directory-model";

const tool = (name: string, grade: ToolGrade, permission: ToolPermission, over: Partial<DirectoryTool> = {}): DirectoryTool => ({
  name,
  description: `${name} description`,
  grade,
  permission,
  changed: false,
  ...over,
});

const TOOLS: DirectoryTool[] = [
  tool("searchJiraIssuesUsingJql", "read", "always"),
  tool("getConfluencePage", "read", "ask"),
  tool("createJiraIssue", "write", "ask"),
  tool("updateConfluencePage", "destructive", "block"),
];

function mcp(over: Partial<ConnectorDirectoryEntry> = {}, member: unknown = null): ConnectorDirectoryEntry {
  return {
    id: "atlassian",
    kind: "mcp",
    name: "Atlassian",
    vendor: "Atlassian",
    verified: true,
    tagline: "Ask about Jira issues and Confluence pages from Droplet.",
    description: "Droplet reads your Jira and Confluence as you.",
    categories: ["Project management", "Files & documents"],
    madeBy: { name: "Atlassian", url: "https://www.atlassian.com" },
    signInRequired: true,
    connectorUrl: "https://mcp.atlassian.com/v1/mcp/authv2",
    addedAt: "2026-09-02",
    links: { docs: "https://docs.example/a", support: "https://support.example/a", privacy: "https://privacy.example/a", guide: "/help/connectors/atlassian" },
    tools: TOOLS,
    promptSuggestions: ["Show what's on my plate in Jira"],
    related: ["todoist"],
    connection: {
      kind: "mcp",
      workspaceState: "ENABLED",
      member: member as never,
      workspace: null,
      anyoneConnected: member !== null,
    },
    actions: { connect: "signIn", canEditPermissions: true, canDisableServer: true, canAddWorkspaceConnection: true },
    ...over,
  };
}

const connectedMember = { id: "m1", state: "CONNECTED", siteName: "Warp Lab", siteUrl: "https://warplab.atlassian.net" };

function system(id: string, name: string, status: string, over: Partial<ConnectorDirectoryEntry> = {}): ConnectorDirectoryEntry {
  return {
    id,
    kind: "system",
    name,
    vendor: name,
    verified: true,
    tagline: `${name} tagline`,
    description: `${name} description`,
    categories: ["Accounting"],
    madeBy: { name },
    signInRequired: false,
    connectorUrl: null,
    addedAt: "2026-07-01",
    links: {},
    tools: null,
    related: [],
    connection: { kind: "system", status },
    actions: { connect: "wizard", canEditPermissions: false, canDisableServer: false, canAddWorkspaceConnection: false },
    ...over,
  };
}

const todoist = mcp({
  id: "todoist",
  name: "Todoist",
  vendor: "Todoist",
  tagline: "Tasks from Todoist.",
  categories: ["Project management"],
  madeBy: { name: "Doist" },
  tools: [],
  promptSuggestions: [],
  related: [],
  connectorUrl: "https://ai.todoist.net/mcp",
});

const stripe = system("stripe", "Stripe", "NOT_CONFIGURED", { categories: ["Payments"], actions: { connect: "none", canEditPermissions: false, canDisableServer: false, canAddWorkspaceConnection: false } });
const quickbooks = system("quickbooks-online", "QuickBooks Online", "CONNECTED");

function wrap(ui: ReactNode) {
  return <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{ui}</SWRConfig>;
}

function useDirectory(entries: ConnectorDirectoryEntry[]) {
  api.fetchConnectorDirectory.mockResolvedValue(entries);
}

beforeEach(() => {
  vi.clearAllMocks();
  session.role = "owner";
  window.history.replaceState(null, "", "/connectors");
  window.sessionStorage.clear();
  api.fetchMcpOAuthConnections.mockResolvedValue([{ provider: "atlassian", callbackSupported: true, member: null, workspace: null }]);
  api.setToolPermission.mockResolvedValue(undefined);
  api.setToolGroupPermission.mockResolvedValue(undefined);
  api.setMcpServerEnabled.mockResolvedValue(undefined);
  api.disconnectMcpOAuth.mockResolvedValue(undefined);
});

describe("directory model", () => {
  it("offers exactly the contract: reads take all three, writes ask or block, destructive blocks", () => {
    expect(legalPermissions("read")).toEqual(["always", "ask", "block"]);
    expect(legalPermissions("write")).toEqual(["ask", "block"]);
    expect(legalPermissions("destructive")).toEqual(["block"]);
  });

  it("calls a move toward always-allow loosening, and a move toward blocked tightening", () => {
    expect(isLoosening("block", "ask")).toBe(true);
    expect(isLoosening("ask", "always")).toBe(true);
    expect(isLoosening("always", "ask")).toBe(false);
    expect(isLoosening("ask", "ask")).toBe(false);
  });

  it("a member's tick is their own sign-in, never a colleague's", () => {
    const colleague = mcp({}, { id: "x", state: "DISCONNECTED" });
    colleague.connection = { kind: "mcp", workspaceState: "ENABLED", member: null, workspace: null, anyoneConnected: true };
    expect(isYours(colleague, false)).toBe(false);
    expect(isYours(colleague, true)).toBe(true);
    expect(isYours(mcp({}, connectedMember), false)).toBe(true);
  });

  it("a server turned off for the Workspace is not yours", () => {
    const e = mcp({}, connectedMember);
    if (e.connection.kind === "mcp") e.connection.workspaceState = "DISABLED";
    expect(isYours(e, true)).toBe(false);
  });

  it("searches name, vendor, tagline and category", () => {
    expect(matchesQuery(mcp(), "jira")).toBe(true);
    expect(matchesQuery(mcp(), "payments")).toBe(false);
    expect(matchesQuery(mcp(), "  ")).toBe(true);
  });
});

describe("the directory page", () => {
  it("shows business systems and MCP servers as two sections of the same cards, for a member", async () => {
    session.role = "family";
    useDirectory([mcp(), todoist, stripe, quickbooks]);
    render(wrap(<ConnectorsPage />));
    expect(await screen.findByText("Business systems")).toBeInTheDocument();
    expect(screen.getByText("MCP servers")).toBeInTheDocument();
    expect(screen.getByTestId("connector-card-atlassian")).toHaveAttribute("href", "/connectors/atlassian");
    expect(screen.getByTestId("connector-card-stripe")).toBeInTheDocument();
    // A member has no Add menu.
    expect(screen.queryByRole("button", { name: "Add a connector" })).toBeNull();
  });

  it("causes no request for a guest and says why", async () => {
    session.role = "guest";
    render(wrap(<ConnectorsPage />));
    expect(await screen.findByText(/aren.t available for guest accounts/i)).toBeInTheDocument();
    expect(api.fetchConnectorDirectory).not.toHaveBeenCalled();
  });

  it("searching turns the sections into one list of rows across both kinds", async () => {
    useDirectory([mcp(), todoist, stripe, quickbooks]);
    render(wrap(<ConnectorsPage />));
    await screen.findByText("Business systems");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search connectors" }), { target: { value: "todo" } });
    expect(await screen.findByTestId("connector-row-todoist")).toBeInTheDocument();
    expect(screen.queryByText("Business systems")).toBeNull();
    expect(screen.queryByTestId("connector-card-todoist")).toBeNull();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search connectors" }), { target: { value: "quick" } });
    expect(await screen.findByTestId("connector-row-quickbooks-online")).toBeInTheDocument();
    expect(screen.queryByTestId("connector-row-todoist")).toBeNull();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search connectors" }), { target: { value: "zzz" } });
    expect(await screen.findByText(/No connectors match/)).toBeInTheDocument();
  });

  it("filters by category chip", async () => {
    useDirectory([mcp(), stripe, quickbooks]);
    render(wrap(<ConnectorsPage />));
    await screen.findByText("Business systems");
    fireEvent.click(screen.getByRole("button", { name: "Payments" }));
    expect(screen.getByTestId("connector-card-stripe")).toBeInTheDocument();
    expect(screen.queryByTestId("connector-card-quickbooks-online")).toBeNull();
    expect(screen.queryByTestId("connector-card-atlassian")).toBeNull();
  });

  it("Yours lists only what is connected, and an empty Yours points at Discover", async () => {
    useDirectory([mcp({}, connectedMember), stripe, quickbooks]);
    render(wrap(<ConnectorsPage />));
    await screen.findByText("Business systems");
    fireEvent.click(screen.getByRole("button", { name: "Yours" }));
    expect(screen.getByTestId("connector-card-atlassian")).toBeInTheDocument();
    expect(screen.getByTestId("connector-card-quickbooks-online")).toBeInTheDocument();
    expect(screen.queryByTestId("connector-card-stripe")).toBeNull();
  });

  it("an empty Yours offers Discover", async () => {
    useDirectory([stripe]);
    render(wrap(<ConnectorsPage />));
    await screen.findByText("Business systems");
    fireEvent.click(screen.getByRole("button", { name: "Yours" }));
    expect(screen.getByText("Nothing connected yet")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Browse Discover" }));
    expect(screen.getByTestId("connector-card-stripe")).toBeInTheDocument();
  });

  it("gives an owner an Add menu with the by-URL item disabled until it ships", async () => {
    useDirectory([mcp()]);
    render(wrap(<ConnectorsPage />));
    await screen.findByText("MCP servers");
    fireEvent.click(screen.getByRole("button", { name: "Add a connector" }));
    const byUrl = screen.getByRole("menuitem", { name: "Add an MCP server by URL" });
    expect(byUrl).toBeDisabled();
    expect(byUrl).toHaveAttribute("title", "Coming soon");
    fireEvent.click(screen.getByRole("menuitem", { name: "Open Connector credentials" }));
    expect(push).toHaveBeenCalledWith("/connectors/credentials");
  });

  it("says a box without the directory needs an update, and does not offer a retry", async () => {
    api.fetchConnectorDirectory.mockRejectedValue(new Error("directory_absent"));
    render(wrap(<ConnectorsPage />));
    expect(await screen.findByRole("alert")).toHaveTextContent(/needs an update/i);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("?connect=<provider> lands on that connector and strips the parameter; an unknown one opens nothing", async () => {
    useDirectory([mcp()]);
    window.history.replaceState(null, "", "/connectors?connect=atlassian&keep=1");
    render(wrap(<ConnectorsPage />));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/connectors/atlassian"));
    expect(window.location.search).toBe("?keep=1");
  });

  it("an unknown ?connect= is stripped and navigates nowhere", async () => {
    useDirectory([mcp()]);
    window.history.replaceState(null, "", "/connectors?connect=nonesuch");
    render(wrap(<ConnectorsPage />));
    await screen.findByText("MCP servers");
    expect(push).not.toHaveBeenCalled();
    expect(window.location.search).toBe("");
  });
});

describe("the connector page", () => {
  const navigate = vi.fn();
  const detail = (entry: ConnectorDirectoryEntry, all: ConnectorDirectoryEntry[] = [entry]) =>
    render(wrap(<ConnectorDetail entry={entry} all={all} refresh={vi.fn()} navigate={navigate} />));

  it("a member connects an MCP server through the box and opens exactly the address it returned", async () => {
    session.role = "family";
    api.startMcpSignIn.mockResolvedValue({ authorizeUrl: "https://auth.example/authorize?x=1", expiresAt: "t", redirectUri: "r" });
    detail(mcp({ actions: { connect: "signIn", canEditPermissions: false, canDisableServer: false, canAddWorkspaceConnection: false } }));
    fireEvent.click(await screen.findByRole("button", { name: "Connect to Droplet" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("https://auth.example/authorize?x=1"));
    expect(api.startMcpSignIn).toHaveBeenCalledWith({ provider: "atlassian", scope: "MEMBER" });
  });

  it("refuses a non-http authorize address", async () => {
    api.startMcpSignIn.mockResolvedValue({ authorizeUrl: "javascript:void(0)", expiresAt: "t", redirectUri: "r" });
    detail(mcp());
    fireEvent.click(await screen.findByRole("button", { name: "Connect to Droplet" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("a refused start shows a fixed sentence, never the box's message", async () => {
    api.startMcpSignIn.mockRejectedValue(new Error("connection_disabled"));
    detail(mcp());
    fireEvent.click(await screen.findByRole("button", { name: "Connect to Droplet" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("An owner or admin turned Atlassian off for this Workspace.");
  });

  it("shows the description, Tools, the facts column, the trust note and related connectors before anyone signs in", async () => {
    detail(mcp(), [mcp(), todoist]);
    expect(await screen.findByText("Droplet reads your Jira and Confluence as you.")).toBeInTheDocument();
    const tools = screen.getByRole("region", { name: "Tools" });
    expect(within(tools).getByText("createJiraIssue")).toBeInTheDocument();
    expect(screen.getByText("MADE BY")).toBeInTheDocument();
    expect(screen.getByText("SIGN-IN")).toBeInTheDocument();
    expect(screen.getByText("Required")).toBeInTheDocument();
    expect(screen.getByText("https://mcp.atlassian.com/v1/mcp/authv2")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Documentation/ })).toHaveAttribute("href", "https://docs.example/a");
    expect(screen.getByText(/Only use connectors from vendors your business already trusts/)).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Related connectors" })).getByText("Todoist")).toBeInTheDocument();
    // Not connected: no permissions and no prompt chips to act on.
    expect(screen.queryByTestId("tool-permissions")).toBeNull();
    expect(screen.queryByRole("region", { name: "Prompt suggestions" })).toBeNull();
  });

  it("collapses a long tool list behind Show all", async () => {
    const many = Array.from({ length: 15 }, (_, i) => tool(`tool${i}`, "read", "always"));
    detail(mcp({ tools: many }));
    const region = await screen.findByRole("region", { name: "Tools" });
    expect(within(region).getAllByText(/^tool\d+$/)).toHaveLength(12);
    fireEvent.click(screen.getByRole("button", { name: "Show all 15" }));
    expect(within(region).getAllByText(/^tool\d+$/)).toHaveLength(15);
  });

  it("a connected member can disconnect their own sign-in after confirming", async () => {
    detail(mcp({}, connectedMember));
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    expect(api.disconnectMcpOAuth).not.toHaveBeenCalled();
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(api.disconnectMcpOAuth).toHaveBeenCalledWith("m1"));
  });

  it("a prompt suggestion seeds the composer on a fresh chat and sends nothing", async () => {
    detail(mcp({}, connectedMember));
    const chip = await screen.findByRole("button", { name: "Show what's on my plate in Jira" });
    fireEvent.click(chip);
    expect(window.sessionStorage.getItem(CHAT_DRAFT_KEY)).toBe("Show what's on my plate in Jira");
    expect(push).toHaveBeenCalledWith("/chat");
    expect(api.startMcpSignIn).not.toHaveBeenCalled();
  });

  it("turns a server off for the Workspace only after a confirmation, and a member never sees that menu", async () => {
    detail(mcp({}, connectedMember));
    fireEvent.click(await screen.findByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Turn off for the Workspace" }));
    expect(api.setMcpServerEnabled).not.toHaveBeenCalled();
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(api.setMcpServerEnabled).toHaveBeenCalledWith("atlassian", false));
  });

  it("hides the Workspace controls when the box offers none", async () => {
    session.role = "family";
    detail(mcp({ actions: { connect: "signIn", canEditPermissions: false, canDisableServer: false, canAddWorkspaceConnection: false } }));
    await screen.findByRole("button", { name: "Connect to Droplet" });
    // Only the setup-guide item remains, so the menu still exists but offers nothing admin.
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.queryByRole("menuitem", { name: /Turn off/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /Workspace connection/ })).toBeNull();
  });

  it("the Workspace connection needs the acknowledgement, verbatim, before it starts", async () => {
    api.startMcpSignIn.mockResolvedValue({ authorizeUrl: "https://auth.example/a", expiresAt: "t", redirectUri: "r" });
    detail(mcp());
    fireEvent.click(await screen.findByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Workspace connection…" }));
    const create = screen.getByRole("button", { name: "Create a Workspace connection" });
    expect(create).toBeDisabled();
    fireEvent.click(screen.getByLabelText("Everyone allowed to use this server acts as this account and sees what it sees."));
    fireEvent.click(create);
    await waitFor(() =>
      expect(api.startMcpSignIn).toHaveBeenCalledWith({ provider: "atlassian", scope: "WORKSPACE", acknowledge: true }),
    );
  });

  it("an off server offers no Connect, says so, and lets an admin turn it back on", async () => {
    const e = mcp({}, null);
    if (e.connection.kind === "mcp") e.connection.workspaceState = "DISABLED";
    detail(e);
    expect(await screen.findByText(/turned Atlassian off for this Workspace/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect to Droplet" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Turn on for the Workspace" }));
    await waitFor(() => expect(api.setMcpServerEnabled).toHaveBeenCalledWith("atlassian", true));
  });

  it("on a box that is not https, the paste card replaces Connect", async () => {
    api.fetchMcpOAuthConnections.mockResolvedValue([{ provider: "atlassian", callbackSupported: false, member: null, workspace: null }]);
    detail(mcp());
    expect(await screen.findByTestId("paste-card-atlassian")).toBeInTheDocument();
    expect(screen.getByText(/isn.t on https, so finish by pasting the address/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect to Droplet" })).toBeNull();
  });

  it("reads the sign-in outcome the box's callback added, then strips it", async () => {
    window.history.replaceState(null, "", "/connectors/atlassian?mcp=atlassian:cancelled");
    detail(mcp());
    expect(await screen.findByRole("status")).toHaveTextContent("Sign-in was cancelled");
    expect(window.location.search).toBe("");
  });

  it("an owner connects a business system through the descriptor's own wizard", async () => {
    detail(system("quickbooks-online", "QuickBooks Online", "NOT_CONFIGURED"));
    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
    expect(screen.getByTestId("connect-wizard")).toHaveAttribute("data-provider", "quickbooks");
  });

  it("a member can read a business system but is told who sets it up", async () => {
    session.role = "family";
    detail(system("quickbooks-online", "QuickBooks Online", "NOT_CONFIGURED"));
    expect(await screen.findByText("An owner or admin sets up QuickBooks Online.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
  });

  it("a business system with no dashboard setup says so instead of offering a dead button", async () => {
    detail(stripe);
    expect(await screen.findByText("Stripe can’t be set up from the dashboard yet.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
  });

  it("a connected business system offers Disconnect to an owner", async () => {
    detail(quickbooks);
    expect(await screen.findByRole("button", { name: "Disconnect quickbooks-online" })).toBeInTheDocument();
  });

  it("renders from the route by id, and says when the directory does not list it", async () => {
    useDirectory([mcp()]);
    const { unmount } = render(wrap(<ConnectorPage />));
    expect(await screen.findByTestId("connector-detail-atlassian")).toBeInTheDocument();
    unmount();
    useDirectory([todoist]);
    render(wrap(<ConnectorPage />));
    expect(await screen.findByText(/couldn.t find that connector/i)).toBeInTheDocument();
  });
});

describe("tool permissions", () => {
  const navigate = vi.fn();
  const open = (role: string, over: Partial<ConnectorDirectoryEntry> = {}) => {
    session.role = role;
    render(wrap(<ConnectorDetail entry={mcp(over, connectedMember)} all={[]} refresh={vi.fn()} navigate={navigate} />));
  };
  const radio = (toolName: string, label: string) =>
    within(screen.getByRole("radiogroup", { name: `Permission for ${toolName}` })).getByRole("radio", { name: label });

  it("groups tools as Interactive and Read-only with counts", async () => {
    open("owner");
    const interactive = await screen.findByRole("region", { name: "Interactive tools" });
    const readOnly = screen.getByRole("region", { name: "Read-only tools" });
    expect(within(interactive).getByText("createJiraIssue")).toBeInTheDocument();
    expect(within(interactive).getByText("updateConfluencePage")).toBeInTheDocument();
    expect(within(readOnly).getByText("searchJiraIssuesUsingJql")).toBeInTheDocument();
    expect(screen.getByText("Choose when Droplet may use these tools.", { exact: false })).toBeInTheDocument();
  });

  it("a write tool offers no Always allow, and a destructive tool is Blocked by Droplet", async () => {
    open("owner");
    await screen.findByTestId("tool-permissions");
    expect(radio("createJiraIssue", "Always allow")).toBeDisabled();
    expect(radio("createJiraIssue", "Ask first")).toBeEnabled();
    expect(radio("createJiraIssue", "Blocked")).toBeEnabled();
    for (const label of ["Always allow", "Ask first", "Blocked"]) {
      expect(radio("updateConfluencePage", label)).toBeDisabled();
    }
    expect(radio("updateConfluencePage", "Blocked")).toHaveAttribute("aria-checked", "true");
    expect(screen.getAllByText("Blocked by Droplet").length).toBeGreaterThan(0);
  });

  it("an owner sets a write tool to Blocked, and the change is one PATCH", async () => {
    open("owner");
    await screen.findByTestId("tool-permissions");
    fireEvent.click(radio("createJiraIssue", "Blocked"));
    await waitFor(() =>
      expect(api.setToolPermission).toHaveBeenCalledWith("atlassian", "createJiraIssue", "block", undefined),
    );
    expect(api.setToolPermission).toHaveBeenCalledTimes(1);
  });

  it("choosing the permission a tool already has sends nothing", async () => {
    open("owner");
    await screen.findByTestId("tool-permissions");
    fireEvent.click(radio("createJiraIssue", "Ask first"));
    expect(api.setToolPermission).not.toHaveBeenCalled();
  });

  it("echoes the reviewed definition hash so a changed tool is not approved blind", async () => {
    open("owner", { tools: [tool("createJiraIssue", "write", "ask", { changed: true, inputSchemaHash: "h1" })] });
    await screen.findByTestId("tool-permissions");
    expect(screen.getByText(/The vendor changed this tool/)).toBeInTheDocument();
    fireEvent.click(radio("createJiraIssue", "Blocked"));
    await waitFor(() =>
      expect(api.setToolPermission).toHaveBeenCalledWith("atlassian", "createJiraIssue", "block", "h1"),
    );
  });

  it("an admin cannot loosen: the control is disabled with a reason, and tightening works", async () => {
    open("admin");
    await screen.findByTestId("tool-permissions");
    // getConfluencePage is "ask": Always allow would loosen it.
    const loosen = radio("getConfluencePage", "Always allow");
    expect(loosen).toBeDisabled();
    expect(loosen).toHaveAttribute("title", "Only the owner can loosen this.");
    // searchJiraIssuesUsingJql is "always": Ask first tightens it.
    fireEvent.click(radio("searchJiraIssuesUsingJql", "Ask first"));
    await waitFor(() =>
      expect(api.setToolPermission).toHaveBeenCalledWith("atlassian", "searchJiraIssuesUsingJql", "ask", undefined),
    );
  });

  it("a member reads the table and cannot change it", async () => {
    open("family", { actions: { connect: "signIn", canEditPermissions: false, canDisableServer: false, canAddWorkspaceConnection: false } });
    await screen.findByTestId("tool-permissions");
    expect(radio("searchJiraIssuesUsingJql", "Ask first")).toBeDisabled();
    expect(radio("createJiraIssue", "Blocked")).toBeDisabled();
    expect(screen.getByText("Members need a role with write access to this connector.")).toBeInTheDocument();
  });

  it("the group menu applies one permission to the whole group in a single PATCH", async () => {
    open("owner");
    await screen.findByTestId("tool-permissions");
    fireEvent.click(screen.getByRole("button", { name: "Set all read-only tools" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Ask first" }));
    await waitFor(() => expect(api.setToolGroupPermission).toHaveBeenCalledWith("atlassian", "read", "ask"));
    expect(api.setToolGroupPermission).toHaveBeenCalledTimes(1);
    expect(api.setToolPermission).not.toHaveBeenCalled();
  });

  it("the interactive group menu has no Always allow", async () => {
    open("owner");
    await screen.findByTestId("tool-permissions");
    fireEvent.click(screen.getByRole("button", { name: "Set all interactive tools" }));
    expect(screen.queryByRole("menuitem", { name: "Always allow" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Ask first" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Blocked" })).toBeInTheDocument();
  });

  it("an admin's group menu disables a choice that would loosen any tool in the group", async () => {
    open("admin");
    await screen.findByTestId("tool-permissions");
    fireEvent.click(screen.getByRole("button", { name: "Set all read-only tools" }));
    // getConfluencePage is "ask" in this group, so "Always allow" loosens it.
    expect(screen.getByRole("menuitem", { name: "Always allow" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Blocked" })).toBeEnabled();
  });

  it("shows the box's refusal as a fixed sentence", async () => {
    api.setToolPermission.mockRejectedValue(new Error("admin_can_only_tighten"));
    open("owner");
    await screen.findByTestId("tool-permissions");
    fireEvent.click(radio("createJiraIssue", "Blocked"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Only the owner can loosen a permission.");
  });

  it("explains an empty tool list instead of drawing an empty table", async () => {
    open("owner", { tools: [] });
    expect(await screen.findByText(/lists this connector.s tools after the first sign-in/)).toBeInTheDocument();
  });
});

describe("browser handoff: confirm page", () => {
  const id = "h".repeat(43);
  const handoff = {
    provider: "atlassian",
    displayName: "Atlassian",
    scope: "MEMBER",
    destinationHost: "auth.atlassian.com",
    callback: "https://box.example/api/mcp/oauth/callback",
    expiresAt: "2026-10-10T12:00:00Z",
  };
  const mount = (navigate = vi.fn()) => {
    window.history.replaceState(null, "", `/connectors/mcp/connect?handoff=${id}`);
    render(<McpHandoffConfirm navigate={navigate} />);
    return navigate;
  };

  it("asks 'Finish connecting <Vendor>?' and says a link alone connects nothing", async () => {
    api.readMcpHandoff.mockResolvedValue(handoff);
    mount();
    expect(await screen.findByRole("heading", { name: "Finish connecting Atlassian?" })).toBeInTheDocument();
    expect(screen.getByText(/A link on its own can never connect anything to your Workspace\./)).toBeInTheDocument();
    expect(api.readMcpHandoff).toHaveBeenCalledWith(id);
    // Reading never starts a sign-in.
    expect(api.startMcpSignIn).not.toHaveBeenCalled();
  });

  it("keeps the destination hidden until it is asked for", async () => {
    api.readMcpHandoff.mockResolvedValue(handoff);
    mount();
    await screen.findByRole("heading", { name: "Finish connecting Atlassian?" });
    expect(screen.queryByText("auth.atlassian.com")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show destination" }));
    expect(screen.getByText("auth.atlassian.com")).toBeInTheDocument();
    expect(screen.getByText("https://box.example/api/mcp/oauth/callback")).toBeInTheDocument();
  });

  it("Continue connecting calls start with exactly the handoff id and opens the returned address", async () => {
    api.readMcpHandoff.mockResolvedValue(handoff);
    api.startMcpSignIn.mockResolvedValue({ authorizeUrl: "https://auth.atlassian.com/authorize?x=1", expiresAt: "t", redirectUri: "r" });
    const navigate = mount();
    fireEvent.click(await screen.findByRole("button", { name: "Continue connecting" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("https://auth.atlassian.com/authorize?x=1"));
    expect(api.startMcpSignIn).toHaveBeenCalledWith({ handoff: id });
    expect(api.startMcpSignIn).toHaveBeenCalledTimes(1);
  });

  it("Not now goes to Connectors and starts nothing", async () => {
    api.readMcpHandoff.mockResolvedValue(handoff);
    mount();
    const notNow = await screen.findByRole("link", { name: "Not now" });
    expect(notNow).toHaveAttribute("href", "/connectors");
    expect(api.startMcpSignIn).not.toHaveBeenCalled();
  });

  it.each([
    ["handoff_invalid", "This link has expired or was already used. Go back to Droplet and choose Connect again."],
    ["handoff_wrong_member", "This link was made for another member’s account. Sign in as that member, or start again from your own Droplet."],
  ])("a %s refusal shows its own sentence and no Continue", async (code, sentence) => {
    api.readMcpHandoff.mockRejectedValue(new Error(code));
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent(sentence);
    expect(screen.queryByRole("button", { name: "Continue connecting" })).toBeNull();
  });

  it("a start refused after Continue shows the refusal and does not navigate", async () => {
    api.readMcpHandoff.mockResolvedValue(handoff);
    api.startMcpSignIn.mockRejectedValue(new Error("handoff_invalid"));
    const navigate = mount();
    fireEvent.click(await screen.findByRole("button", { name: "Continue connecting" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("expired or was already used");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("a link with no handoff is refused without a request", async () => {
    window.history.replaceState(null, "", "/connectors/mcp/connect");
    render(<McpHandoffConfirm navigate={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("expired or was already used");
    expect(api.readMcpHandoff).not.toHaveBeenCalled();
  });

  it("never prints the handoff id", async () => {
    api.readMcpHandoff.mockResolvedValue(handoff);
    mount();
    await screen.findByRole("heading", { name: "Finish connecting Atlassian?" });
    fireEvent.click(screen.getByRole("button", { name: "Show destination" }));
    expect(document.body.textContent ?? "").not.toContain(id);
  });
});

describe("browser handoff: connected page", () => {
  it.each([
    ["atlassian:connected", "Connected to Atlassian", "You can return to Droplet."],
    ["atlassian:cancelled", "Sign-in was cancelled", "Nothing was connected."],
    ["atlassian:expired", "That sign-in expired", "Start again from Droplet"],
    ["atlassian:bogus", "Sign-in could not be completed", "Nothing was connected."],
  ])("%s", async (query, title, body) => {
    useDirectory([mcp()]);
    window.history.replaceState(null, "", `/connectors/mcp/connected?mcp=${query}`);
    render(wrap(<McpConnectedPage />));
    expect(await screen.findByRole("heading", { name: title })).toBeInTheDocument();
    expect(screen.getByText(body, { exact: false })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Connectors" })).toHaveAttribute("href", "/connectors");
  });

  it("takes the vendor's name from the directory, never from the query", async () => {
    useDirectory([mcp()]);
    window.history.replaceState(null, "", "/connectors/mcp/connected?mcp=evil%20corp:connected");
    render(wrap(<McpConnectedPage />));
    expect(await screen.findByRole("heading", { name: "Connected to your service" })).toBeInTheDocument();
    expect(screen.queryByText(/evil/i)).toBeNull();
  });
});

describe("copy and wiring guards", () => {
  const FILES = [
    "src/app/connectors/page.tsx",
    "src/app/connectors/[id]/page.tsx",
    "src/app/connectors/mcp/connect/page.tsx",
    "src/app/connectors/mcp/connected/page.tsx",
    "src/components/integrations/ConnectorDetail.tsx",
    "src/components/integrations/DirectoryCards.tsx",
    "src/components/integrations/ToolPermissions.tsx",
    "src/components/integrations/PromptSuggestions.tsx",
    "src/components/integrations/RelatedConnectors.tsx",
    "src/components/integrations/McpHandoffConfirm.tsx",
    "src/components/integrations/directory-model.ts",
  ];

  it.each(FILES)("%s names no other vendor's product", (file) => {
    expect(readPackageFile(file)).not.toMatch(/claude|anthropic/i);
  });

  it("the Settings page no longer renders the sign-in card", () => {
    expect(readPackageFile("src/app/settings/page.tsx")).not.toContain("McpSignInCard");
  });

  it("the client no longer sends a redirect mode", () => {
    expect(readPackageFile("src/lib/api.ts")).not.toContain("redirectMode");
    expect(readPackageFile("src/components/integrations/McpSignInCard.tsx")).not.toContain("redirectMode");
  });

  it("members see Connectors in the nav roles", () => {
    const nav = readPackageFile("src/components/nav-config.ts");
    expect(nav).toMatch(/href: "\/connectors",[\s\S]{0,400}roles: \["owner", "admin", "family"\]/);
  });
});
