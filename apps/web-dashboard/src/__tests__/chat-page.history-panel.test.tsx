import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

// Mock api so the page renders without hitting the network.
const listConversationsMock = vi.fn().mockResolvedValue([]);
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    listConversations: (...a: unknown[]) => listConversationsMock(...a),
    // The chat page also imports things like fetchModels — keep them as no-ops.
    fetchModels: vi.fn().mockResolvedValue([]),
  };
});

// next/navigation mocks
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/chat",
}));

import ChatPage from "@/app/chat/page";

describe("/chat page mounts the history panel", () => {
  it("renders the desktop chat-history aside and the empty-state copy", async () => {
    render(<ChatPage />);
    // The aside is `hidden lg:flex` but jsdom doesn't apply visibility CSS,
    // so it's still in the DOM and queryable by accessible name.
    expect(
      screen.getByRole("complementary", { name: /chat history/i }),
    ).toBeInTheDocument();
    // The mobile-only trigger is keyed off the aria-label.
    expect(
      screen.getByRole("button", { name: /open chat history/i }),
    ).toBeInTheDocument();
    // Panel renders its empty-state once listConversations resolves [].
    await waitFor(() =>
      expect(screen.getByText(/no chats yet/i)).toBeInTheDocument(),
    );
  });
});
