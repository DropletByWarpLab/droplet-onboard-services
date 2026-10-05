// NewItemModal inside a cycle (WARP-3521): the item is planned into that cycle
// as it is created.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { SWRConfig } from "swr";
import { NewItemModal } from "./modals";
import type { PmProject } from "./types";

const toast = vi.fn();
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast }) }));

const posts: Array<Record<string, unknown>> = [];
vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn((url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const json = (b: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(b) } as Response);
    if (method === "POST" && url.endsWith("/projects/p/work-items")) {
      posts.push(JSON.parse(String(init?.body)));
      return json({ work_item: { id: "w1" } });
    }
    if (url.endsWith("/projects/p/states")) return json({ states: [] });
    return json({});
  }),
}));

const PROJECT = { id: "p", identifier: "INBOX", name: "Inbox" } as PmProject;

function renderModal(cycleId?: string) {
  const onCreated = vi.fn();
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <NewItemModal project={PROJECT} cycleId={cycleId} onClose={() => undefined} onCreated={onCreated} />
    </SWRConfig>,
  );
  return { onCreated };
}

beforeEach(() => {
  posts.length = 0;
  toast.mockReset();
});

describe("NewItemModal — cycleId", () => {
  it("plans the new item into the cycle it was opened from", async () => {
    const { onCreated } = renderModal("c1");
    fireEvent.change(screen.getByPlaceholderText("What needs doing?"), { target: { value: "Write the plan" } });
    fireEvent.click(screen.getByRole("button", { name: "Create item" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ name: "Write the plan", cycle_id: "c1" });
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  });

  it("opened from the board, it sends no cycle at all", async () => {
    renderModal();
    fireEvent.change(screen.getByPlaceholderText("What needs doing?"), { target: { value: "Write the plan" } });
    fireEvent.click(screen.getByRole("button", { name: "Create item" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).not.toHaveProperty("cycle_id");
  });
});
