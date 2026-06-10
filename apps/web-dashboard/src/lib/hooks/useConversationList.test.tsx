import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

const listConversationsMock = vi.fn();
const renameConversationMock = vi.fn();
const deleteConversationMock = vi.fn();
const fetchConversationMock = vi.fn();
const setConversationProjectMock = vi.fn();

vi.mock("@/lib/api", () => ({
  listConversations: (...a: unknown[]) => listConversationsMock(...a),
  renameConversation: (...a: unknown[]) => renameConversationMock(...a),
  deleteConversation: (...a: unknown[]) => deleteConversationMock(...a),
  fetchConversation: (...a: unknown[]) => fetchConversationMock(...a),
  setConversationProject: (...a: unknown[]) => setConversationProjectMock(...a),
}));

import { useConversationList } from "./useConversationList";

function row(id: string, daysAgo = 0, title: string | null = `chat-${id}`) {
  const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  return {
    id,
    title,
    model: "llama3",
    provider: "ollama",
    createdAt: d.toISOString(),
    updatedAt: d.toISOString(),
  };
}

beforeEach(() => {
  listConversationsMock.mockReset();
  renameConversationMock.mockReset();
  deleteConversationMock.mockReset();
  fetchConversationMock.mockReset();
  setConversationProjectMock.mockReset();
});

describe("useConversationList", () => {
  it("fetches the first page on mount", async () => {
    listConversationsMock.mockResolvedValue([row("a"), row("b")]);
    const { result } = renderHook(() => useConversationList());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.flat.map((c) => c.id)).toEqual(["a", "b"]);
    expect(listConversationsMock).toHaveBeenCalledWith({ limit: 30, offset: 0 });
  });

  it("loadMore appends the next page and tracks hasMore", async () => {
    listConversationsMock.mockResolvedValueOnce(Array.from({ length: 30 }, (_, i) => row(`a${i}`)));
    const { result } = renderHook(() => useConversationList());
    await waitFor(() => expect(result.current.flat.length).toBe(30));
    expect(result.current.hasMore).toBe(true);

    listConversationsMock.mockResolvedValueOnce([row("z1"), row("z2")]);
    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.flat.length).toBe(32);
    expect(result.current.hasMore).toBe(false);
    expect(listConversationsMock).toHaveBeenNthCalledWith(2, { limit: 30, offset: 30 });
  });

  it("setSearch refetches page one with q and resets pagination", async () => {
    listConversationsMock.mockResolvedValueOnce(
      Array.from({ length: 30 }, (_, i) => row(`a${i}`)),
    );
    const { result } = renderHook(() => useConversationList());
    await waitFor(() => expect(result.current.flat.length).toBe(30));

    listConversationsMock.mockResolvedValueOnce([row("hit")]);
    act(() => {
      result.current.setSearch("frigate");
    });
    await waitFor(() =>
      expect(result.current.flat.map((c) => c.id)).toEqual(["hit"]),
    );
    expect(listConversationsMock).toHaveBeenLastCalledWith({
      limit: 30,
      offset: 0,
      q: "frigate",
    });
    expect(result.current.hasMore).toBe(false);

    // loadMore (when a search page fills up) carries the same q.
    listConversationsMock.mockResolvedValueOnce(
      Array.from({ length: 30 }, (_, i) => row(`s${i}`)),
    );
    act(() => {
      result.current.setSearch("ports");
    });
    await waitFor(() => expect(result.current.flat.length).toBe(30));
    listConversationsMock.mockResolvedValueOnce([]);
    await act(async () => {
      await result.current.loadMore();
    });
    expect(listConversationsMock).toHaveBeenLastCalledWith({
      limit: 30,
      offset: 30,
      q: "ports",
    });
  });

  it("optimisticInsert prepends a new row", async () => {
    listConversationsMock.mockResolvedValue([row("a", 1)]);
    const { result } = renderHook(() => useConversationList());
    await waitFor(() => expect(result.current.flat.length).toBe(1));
    act(() => {
      result.current.optimisticInsert(row("new", 0, "freshly minted"));
    });
    expect(result.current.flat[0].id).toBe("new");
    expect(result.current.flat[0].title).toBe("freshly minted");
  });

  it("applyTurnCompleted overwrites a row's title + updatedAt from the server", async () => {
    listConversationsMock.mockResolvedValue([row("a", 0, "old title")]);
    const { result } = renderHook(() => useConversationList());
    await waitFor(() => expect(result.current.flat.length).toBe(1));

    const newUpdatedAt = new Date().toISOString();
    fetchConversationMock.mockResolvedValueOnce({
      id: "a",
      title: "server-derived",
      updatedAt: newUpdatedAt,
      model: "llama3",
      provider: "ollama",
      createdAt: result.current.flat[0].createdAt,
      messages: [],
    });
    await act(async () => {
      await result.current.applyTurnCompleted("a");
    });
    expect(result.current.flat[0].title).toBe("server-derived");
    expect(result.current.flat[0].updatedAt).toBe(newUpdatedAt);
  });

  it("applyTurnCompleted skips title overwrite when a rename is in flight", async () => {
    listConversationsMock.mockResolvedValue([row("a", 0, "old")]);
    const { result, unmount } = renderHook(() => useConversationList());
    await waitFor(() => expect(result.current.flat.length).toBe(1));

    // Make rename hang so the rename id stays in pendingRenameIds.
    let resolveRename: (v: { id: string; title: string }) => void = () => {};
    renameConversationMock.mockReturnValueOnce(
      new Promise((res) => {
        resolveRename = res;
      }),
    );

    // Start the rename without awaiting so it stays in-flight.
    // The optimistic update (setFlat) fires synchronously inside rename
    // before the await, so we can waitFor it to appear.
    let renameError: unknown;
    act(() => {
      result.current.rename("a", "user-typed").catch((e) => {
        renameError = e;
      });
    });

    // Wait for the optimistic title to be visible in state.
    await waitFor(() => expect(result.current.flat[0].title).toBe("user-typed"));

    // While the rename is in flight, applyTurnCompleted should NOT
    // overwrite the title with the server's auto-derived one.
    fetchConversationMock.mockResolvedValueOnce({
      id: "a",
      title: "server-auto-derived",
      updatedAt: new Date().toISOString(),
      model: "llama3",
      provider: "ollama",
      createdAt: result.current.flat[0].createdAt,
      messages: [],
    });
    await act(async () => {
      await result.current.applyTurnCompleted("a");
    });
    expect(result.current.flat[0].title).toBe("user-typed"); // optimistic still in place

    // Let rename complete and drain the act queue, confirm final state.
    await act(async () => {
      resolveRename({ id: "a", title: "user-typed" });
    });
    expect(result.current.flat[0].title).toBe("user-typed");
    expect(renameError).toBeUndefined();

    unmount();
  });

  it("rename updates optimistically and reverts on error", async () => {
    listConversationsMock.mockResolvedValue([row("a", 0, "old")]);
    const { result } = renderHook(() => useConversationList());
    await waitFor(() => expect(result.current.flat.length).toBe(1));

    renameConversationMock.mockRejectedValueOnce(new Error("title_required"));
    await act(async () => {
      await expect(result.current.rename("a", "new")).rejects.toThrow();
    });
    expect(result.current.flat[0].title).toBe("old");
  });

  it("moveToProject updates optimistically and reverts on error (WARP-845)", async () => {
    listConversationsMock.mockResolvedValue([
      { ...row("a"), projectId: null },
    ]);
    const { result } = renderHook(() => useConversationList());
    await waitFor(() => expect(result.current.flat.length).toBe(1));

    // Success path: optimistic stamp sticks.
    setConversationProjectMock.mockResolvedValueOnce({ id: "a", projectId: "p1" });
    await act(async () => {
      await result.current.moveToProject("a", "p1");
    });
    expect(result.current.flat[0].projectId).toBe("p1");
    expect(setConversationProjectMock).toHaveBeenCalledWith("a", "p1");

    // Failure path: revert to the previous membership.
    setConversationProjectMock.mockRejectedValueOnce(new Error("boom"));
    await act(async () => {
      await result.current.moveToProject("a", "p2");
    });
    expect(result.current.flat[0].projectId).toBe("p1");
    expect(result.current.error).not.toBeNull();
  });

  it("clearProjectLocally ungroups a deleted project's chats (WARP-845)", async () => {
    listConversationsMock.mockResolvedValue([
      { ...row("a"), projectId: "p1" },
      { ...row("b"), projectId: "p2" },
    ]);
    const { result } = renderHook(() => useConversationList());
    await waitFor(() => expect(result.current.flat.length).toBe(2));

    act(() => {
      result.current.clearProjectLocally("p1");
    });
    expect(result.current.flat.find((c) => c.id === "a")?.projectId).toBeNull();
    // Other projects untouched.
    expect(result.current.flat.find((c) => c.id === "b")?.projectId).toBe("p2");
    // No server call — the FK SET NULL already happened server-side.
    expect(setConversationProjectMock).not.toHaveBeenCalled();
  });

  it("remove deletes the row when the server returns success", async () => {
    listConversationsMock.mockResolvedValue([row("a"), row("b")]);
    deleteConversationMock.mockResolvedValue(true);
    const { result } = renderHook(() => useConversationList());
    await waitFor(() => expect(result.current.flat.length).toBe(2));

    await act(async () => {
      await result.current.remove("a");
    });
    expect(result.current.flat.map((c) => c.id)).toEqual(["b"]);
  });
});
