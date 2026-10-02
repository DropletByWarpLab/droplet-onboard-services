/**
 * WARP-2969 — the `/chat` composer's "/" tool menu lists only tools a turn
 * can actually reach.
 *
 * The menu is fed by the same `GET /api/llm/tools/catalog` that backs
 * `/tools`, which used to report every registered tool through one predicate
 * (`requiresWrite`). So the menu offered the 54 tools the chat-scope policy
 * withholds — picking one seeded a message that could only ever come back
 * "I can't do that".
 *
 * `/tools` still LISTS those tools, with a chip saying why; the slash menu is
 * the one surface that filters, because everything in it is an offer to act.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import type { ToolCatalogEntry } from "@/lib/types";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    listConversations: vi.fn().mockResolvedValue([]),
    fetchConversation: vi.fn(),
    sendChat: vi.fn(),
    fetchModels: vi.fn().mockResolvedValue({ models: [] }),
  };
});

vi.mock("@/lib/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth");
  return {
    ...actual,
    useAuth: () => ({ user: { id: "u1", username: "alice", displayName: "Alice" } }),
  };
});

// A model must be selected or the composer renders disabled and never takes
// the "/" that opens the menu.
vi.mock("@/lib/hooks/useModels", () => ({
  useModels: () => ({
    models: [{ id: "local-1", provider: "ollama" }],
    defaultModel: "local-1",
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/chat",
}));

const useToolCatalogMock = vi.fn();
vi.mock("@/lib/hooks/useToolCatalog", () => ({
  useToolCatalog: () => useToolCatalogMock(),
}));

import ChatPage from "@/app/chat/page";

function entry(
  name: string,
  domain: string,
  homeDescription: string,
  reach: ToolCatalogEntry["reach"],
): ToolCatalogEntry {
  return {
    name,
    domain,
    description: `[agent] ${name}`,
    homeDescription,
    requiresWrite: false,
    requiresConfirmation: false,
    ...(reach ? { reach } : {}),
  };
}

const REACHABLE = entry("list_network_devices", "network", "See every device", {
  chat: "allowed",
});
const CHAT_EXCLUDED = entry("get_switch_ports", "switch", "Look at switch ports", {
  chat: "excluded",
});

beforeEach(() => {
  useToolCatalogMock.mockReset().mockReturnValue({
    tools: [REACHABLE, CHAT_EXCLUDED],
    domains: ["network", "switch"],
    isLoading: false,
    error: undefined,
    refresh: vi.fn(),
  });
});

function openSlashMenu() {
  render(<ChatPage />);
  fireEvent.change(screen.getByPlaceholderText(/ask droplet anything/i), {
    target: { value: "/" },
  });
  return screen.getByRole("listbox", { name: /tools/i });
}

describe("/chat slash menu offers only reachable tools (WARP-2969)", () => {
  it("lists a tool a turn can reach", () => {
    expect(
      within(openSlashMenu()).getByText(/list network devices/i),
    ).toBeInTheDocument();
  });

  it("omits a tool the chat-scope policy withholds", () => {
    expect(within(openSlashMenu()).queryByText(/get switch ports/i)).toBeNull();
  });

  it("offers exactly the reachable tools", () => {
    expect(within(openSlashMenu()).getAllByRole("option")).toHaveLength(1);
  });

  it("falls back to the whole list when the orchestrator sends no reach", () => {
    // Pre-WARP-2969 orchestrator: absence is not evidence of withholding, and
    // an empty slash menu would be a worse answer than the old one.
    useToolCatalogMock.mockReturnValue({
      tools: [entry("a_tool", "network", "does a thing", undefined)],
      domains: ["network"],
      isLoading: false,
      error: undefined,
      refresh: vi.fn(),
    });
    expect(within(openSlashMenu()).getAllByRole("option")).toHaveLength(1);
  });
});
