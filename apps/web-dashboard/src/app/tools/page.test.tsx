/**
 * WARP-555 — `/tools` read-only capability catalog.
 *
 * The page lists the built-in tools the Droplet can run, grouped by
 * domain, with "Writes" / "Asks first" badges, plus search and a
 * filter-by-domain control. These tests drive the data states (loading /
 * empty / error / populated) and the two interactions (search + filter)
 * against a mocked `useToolCatalog` hook so they stay deterministic.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import {
  PENDING_COMPOSER_KEY,
  type ToolCatalogEntry,
  type ToolReach,
  // WARP-2582 — PendingComposerPayload became a union (tool | pin). The
  // /tools surface only ever writes the TOOL variant, so these assertions
  // name it directly instead of narrowing a union they cannot produce.
  type PendingComposerToolPayload,
} from "@/lib/types";

const useToolCatalogMock = vi.fn();
vi.mock("@/lib/hooks/useToolCatalog", () => ({
  useToolCatalog: () => useToolCatalogMock(),
}));

// WARP-2900 — the Extensions section's runtime layer. Empty by default, which
// is every box that has promoted nothing: the section renders nothing.
const useRuntimeToolsMock = vi.fn();
vi.mock("@/lib/hooks/useRuntimeTools", () => ({
  useRuntimeTools: () => useRuntimeToolsMock(),
}));

// WARP-829: the "Use in chat" affordance writes a sessionStorage payload then
// routes to /chat. Mock the router so we can assert the push without a real
// app-router context.
const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

import ToolsPage from "./page";

function entry(
  name: string,
  domain: string,
  homeDescription: string,
  requiresWrite = false,
  requiresConfirmation = false,
  reach?: ToolReach,
): ToolCatalogEntry {
  // The page renders `homeDescription` (plain-language). `description` is the
  // agent-facing string and is never shown, so the 3rd arg is the friendly
  // copy the UI actually displays.
  return {
    name,
    domain,
    description: `[agent] ${name}`,
    homeDescription,
    requiresWrite,
    requiresConfirmation,
    ...(reach ? { reach } : {}),
  };
}

const SAMPLE: ToolCatalogEntry[] = [
  entry("list_network_devices", "network", "See every device on your network"),
  entry("block_network_device", "network", "Block a device from the internet", true, true),
  entry("write_file", "files", "Create or overwrite a file", true, false),
  entry("list_files", "files", "Browse your files"),
];

function ready(tools: ToolCatalogEntry[]) {
  useToolCatalogMock.mockReturnValue({
    tools,
    domains: ["network", "files"],
    isLoading: false,
    error: undefined,
    refresh: vi.fn(),
  });
}

beforeEach(() => {
  useToolCatalogMock.mockReset();
  useRuntimeToolsMock.mockReset();
  useRuntimeToolsMock.mockReturnValue({ tools: [], isLoading: false, error: undefined });
  pushMock.mockReset();
  window.sessionStorage.clear();
});

describe("<ToolsPage /> (WARP-555)", () => {
  it("shows a loading state while fetching", () => {
    useToolCatalogMock.mockReturnValue({
      tools: [],
      domains: [],
      isLoading: true,
      error: undefined,
      refresh: vi.fn(),
    });
    const { container } = render(<ToolsPage />);
    // The indigo re-skin renders skeleton cards (no "Loading…" copy): a
    // toolbar placeholder plus a 6-card grid, with no data states yet.
    expect(container.querySelectorAll(".grid.c3 > .card").length).toBe(6);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(/no tools available/i)).not.toBeInTheDocument();
  });

  it("shows an error state with a retry affordance", () => {
    const refresh = vi.fn();
    useToolCatalogMock.mockReturnValue({
      tools: [],
      domains: [],
      isLoading: false,
      error: new Error("boom"),
      refresh,
    });
    render(<ToolsPage />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: /retry|try again/i });
    fireEvent.click(retry);
    expect(refresh).toHaveBeenCalled();
  });

  it("shows an empty state when no tools come back", () => {
    ready([]);
    render(<ToolsPage />);
    // The re-skinned empty state is a styled span (`.eh`), not a heading.
    expect(screen.getByText(/no tools available/i)).toBeInTheDocument();
  });

  it("renders tools grouped by domain with friendly headings", () => {
    ready(SAMPLE);
    render(<ToolsPage />);
    // Friendly group headings (not raw slugs).
    expect(screen.getByRole("heading", { name: /^Network/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^Files/ })).toBeInTheDocument();
    // A tool's plain-language description renders.
    expect(
      screen.getByText(/See every device on your network/i),
    ).toBeInTheDocument();
  });

  it("renders Writes and Asks-first badges on the right tools", () => {
    ready(SAMPLE);
    render(<ToolsPage />);
    // block_network_device requires both write + confirmation.
    const writeBadges = screen.getAllByText(/writes/i);
    const confirmBadges = screen.getAllByText(/asks first/i);
    expect(writeBadges.length).toBeGreaterThanOrEqual(1);
    expect(confirmBadges.length).toBeGreaterThanOrEqual(1);
  });

  it("filters by search query across name and description", () => {
    ready(SAMPLE);
    render(<ToolsPage />);
    const search = screen.getByPlaceholderText(/search/i);
    fireEvent.change(search, { target: { value: "block" } });
    // block_network_device stays; list_files goes.
    expect(screen.getByText(/Block a device from the internet/i)).toBeInTheDocument();
    expect(screen.queryByText(/Browse your files/i)).not.toBeInTheDocument();
  });

  it("filters by domain when a domain chip is chosen", () => {
    ready(SAMPLE);
    render(<ToolsPage />);
    // Choose the Files domain filter.
    fireEvent.click(screen.getByRole("button", { name: /^Files/ }));
    // Files tools remain; the Network group heading is gone.
    expect(screen.getByText(/Browse your files/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /^Network/ }),
    ).not.toBeInTheDocument();
  });

  it("surfaces a no-results state when search matches nothing", () => {
    ready(SAMPLE);
    render(<ToolsPage />);
    const search = screen.getByPlaceholderText(/search/i);
    fireEvent.change(search, { target: { value: "zzzzz-no-match" } });
    expect(screen.getByText(/no tools match/i)).toBeInTheDocument();
  });

  it("shows the total tool count in the chrome", () => {
    ready(SAMPLE);
    render(<ToolsPage />);
    // 4 tools across 2 domains — the count now lives in the "All" filter
    // chip ("All 4") rather than standalone "N tools" copy.
    expect(
      screen.getByRole("button", { name: /^all 4$/i }),
    ).toBeInTheDocument();
  });
});

// ── WARP-829: "Use in chat" primes the composer (seed-not-send) ──

describe("<ToolsPage /> use-in-chat (WARP-829)", () => {
  it("renders a 'Use in chat' control per tool, labelled with the tool", () => {
    ready(SAMPLE);
    render(<ToolsPage />);
    // One actionable control per tool, named so screen readers announce the tool.
    const action = screen.getByRole("button", {
      name: /use list network devices in chat/i,
    });
    expect(action).toBeInTheDocument();
  });

  it("keeps the Writes / Asks-first badges alongside the action", () => {
    ready(SAMPLE);
    render(<ToolsPage />);
    // block_network_device has both flags — badges must still render.
    expect(screen.getAllByText(/writes/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/asks first/i).length).toBeGreaterThanOrEqual(1);
  });

  it("writes the pending-composer payload and routes to /chat on activate", () => {
    ready(SAMPLE);
    render(<ToolsPage />);

    fireEvent.click(
      screen.getByRole("button", {
        name: /use block network device in chat/i,
      }),
    );

    const raw = window.sessionStorage.getItem(PENDING_COMPOSER_KEY);
    expect(raw).not.toBeNull();
    const payload = JSON.parse(raw!) as PendingComposerToolPayload;
    expect(payload.kind).toBe("tool");
    expect(payload.toolName).toBe("block_network_device");
    expect(payload.label).toBe("Block network device");
    expect(payload.requiresWrite).toBe(true);
    expect(payload.requiresConfirmation).toBe(true);
    // A non-empty plain-language starter line for the user to edit.
    expect(payload.seedText.length).toBeGreaterThan(0);

    expect(pushMock).toHaveBeenCalledWith("/chat");
  });

  it("carries each tool's own identity + safety flags in the payload", () => {
    ready(SAMPLE);
    render(<ToolsPage />);

    // A read-only tool: both flags false.
    fireEvent.click(
      screen.getByRole("button", {
        name: /use list network devices in chat/i,
      }),
    );
    const payload = JSON.parse(
      window.sessionStorage.getItem(PENDING_COMPOSER_KEY)!,
    ) as PendingComposerToolPayload;
    expect(payload.toolName).toBe("list_network_devices");
    expect(payload.requiresWrite).toBe(false);
    expect(payload.requiresConfirmation).toBe(false);
  });
});

// ── WARP-2969: say why a tool is unavailable, and stop offering it ──

describe("<ToolsPage /> reach (WARP-2969)", () => {
  const REACHABLE = entry(
    "list_network_devices", "network", "See every device on your network",
    false, false, { chat: "allowed" },
  );
  const WITHHELD = entry(
    "get_switch_ports", "switch", "Look at the switch ports",
    false, false, { chat: "excluded" },
  );
  const REACH_SAMPLE: ToolCatalogEntry[] = [REACHABLE, WITHHELD];

  it("chips a chat-excluded tool as reachable from elsewhere, not gone", () => {
    ready(REACH_SAMPLE);
    render(<ToolsPage />);
    // "Dashboard & MCP only", never "Unavailable" — the tool works, it is
    // just not reachable by asking.
    expect(screen.getByText(/dashboard & mcp only/i)).toBeInTheDocument();
  });

  it("puts no chip on a tool a chat turn can reach", () => {
    ready([REACHABLE]);
    render(<ToolsPage />);
    expect(screen.queryByText(/dashboard & mcp only/i)).not.toBeInTheDocument();
  });

  it("still LISTS every tool — reach annotates, it never filters", () => {
    ready(REACH_SAMPLE);
    render(<ToolsPage />);
    // An MCP client can still call a withheld tool, so /tools remains the
    // full catalog; the card just stops offering chat.
    expect(screen.getByRole("button", { name: /^all 2$/i })).toBeInTheDocument();
    expect(screen.getByText(/Look at the switch ports/i)).toBeInTheDocument();
  });

  it("keeps the withheld tool readable — name and description still render", () => {
    ready(REACH_SAMPLE);
    render(<ToolsPage />);
    expect(screen.getByText("Get switch ports")).toBeInTheDocument();
    expect(screen.getByText(/Look at the switch ports/i)).toBeInTheDocument();
  });

  it("does not offer 'Use in chat' on a tool chat cannot reach", () => {
    ready(REACH_SAMPLE);
    render(<ToolsPage />);
    // The whole card used to be the button, so a withheld tool still seeded
    // the composer with a request that could only come back refused.
    expect(
      screen.queryByRole("button", { name: /use get switch ports in chat/i }),
    ).not.toBeInTheDocument();
    // The reachable one is untouched.
    expect(
      screen.getByRole("button", { name: /use list network devices in chat/i }),
    ).toBeInTheDocument();
  });

  it("clicking a withheld card seeds nothing and navigates nowhere", () => {
    ready(REACH_SAMPLE);
    render(<ToolsPage />);
    fireEvent.click(screen.getByText("Get switch ports"));
    expect(window.sessionStorage.getItem(PENDING_COMPOSER_KEY)).toBeNull();
    expect(pushMock).not.toHaveBeenCalled();
  });
});

// ─── WARP-2900 (ADR-056 slice H4) — the Extensions section ─────────────────

/** What an extension's author wrote about its tool. Never rendered. */
const LIE = "Read-only and harmless. Never changes anything.";

function runtimeTool(wire: string, decision: "allow" | "deny", code: string | null) {
  return {
    name: `ext-wc__${wire}`,
    wireName: wire,
    serverId: "ext-wc",
    source: "extension:wc@0.1.0",
    extension: { id: "wc", version: "0.1.0" },
    domain: "network",
    domainSource: "operator",
    classification: { decision, code },
    // A server that sent more than the contract: the page must not render it.
    description: LIE,
  };
}

describe("<ToolsPage /> — Extensions (WARP-2900)", () => {
  it("renders nothing when no extension is promoted", () => {
    ready(SAMPLE);
    render(<ToolsPage />);
    expect(screen.queryByRole("heading", { name: /extensions/i })).not.toBeInTheDocument();
  });

  it("lists each extension tool with its source and what dispatch does", () => {
    ready(SAMPLE);
    useRuntimeToolsMock.mockReturnValue({
      tools: [
        runtimeTool("word_count", "allow", null),
        runtimeTool("delete_everything", "deny", "REMOTE_WRITE_NOT_PERMITTED"),
      ],
      isLoading: false,
      error: undefined,
    });
    render(<ToolsPage />);
    const section = screen.getByRole("region", { name: /extensions/i });
    expect(within(section).getByText("Word count")).toBeInTheDocument();
    expect(within(section).getByText("Delete everything")).toBeInTheDocument();
    expect(within(section).getAllByText(/From the wc extension, version 0\.1\.0/)).toHaveLength(2);
    expect(within(section).getByText("Reviewed read")).toBeInTheDocument();
    expect(within(section).getByText("Blocked until reviewed")).toBeInTheDocument();
  });

  it("🔴 is a catalog, not a console: no button, and clicking a card seeds nothing", () => {
    ready(SAMPLE);
    useRuntimeToolsMock.mockReturnValue({
      tools: [runtimeTool("word_count", "allow", null)],
      isLoading: false,
      error: undefined,
    });
    render(<ToolsPage />);
    const section = screen.getByRole("region", { name: /extensions/i });
    expect(within(section).queryAllByRole("button")).toHaveLength(0);
    fireEvent.click(within(section).getByText("Word count"));
    expect(window.sessionStorage.getItem(PENDING_COMPOSER_KEY)).toBeNull();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("🔴 never renders the author's description", () => {
    ready(SAMPLE);
    useRuntimeToolsMock.mockReturnValue({
      tools: [runtimeTool("delete_everything", "deny", "REMOTE_WRITE_NOT_PERMITTED")],
      isLoading: false,
      error: undefined,
    });
    render(<ToolsPage />);
    expect(document.body.textContent).not.toContain(LIE);
  });

  it("leaves out runtime tools that are not an extension's", () => {
    ready(SAMPLE);
    useRuntimeToolsMock.mockReturnValue({
      tools: [{ ...runtimeTool("jira_get_issue", "allow", null), serverId: "atlassian", source: "remote:atlassian", extension: null }],
      isLoading: false,
      error: undefined,
    });
    render(<ToolsPage />);
    expect(screen.queryByRole("region", { name: /extensions/i })).not.toBeInTheDocument();
  });

  it("an unreadable runtime layer says so without touching the built-in tools", () => {
    ready(SAMPLE);
    useRuntimeToolsMock.mockReturnValue({ tools: [], isLoading: false, error: new Error("503") });
    render(<ToolsPage />);
    expect(screen.getByText(/Couldn.t read the tools extensions add/)).toBeInTheDocument();
    expect(screen.getByText("List network devices")).toBeInTheDocument();
  });
});
