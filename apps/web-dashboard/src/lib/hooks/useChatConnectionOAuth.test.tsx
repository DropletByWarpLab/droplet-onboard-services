import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_CONNECTION_POPUP_KEY, CHAT_CONNECTION_POPUP_TTL, type ConnectionPopupRecord } from "@/lib/chat-connection-popup";
import { useChatConnectionOAuth } from "./useChatConnectionOAuth";

const auth = vi.hoisted(() => ({
  authFetch: vi.fn(),
  user: { id: "stefan", role: "owner" } as { id: string; role: string } | null,
}));
vi.mock("@/lib/auth", () => ({ authFetch: auth.authFetch, useAuth: () => ({ user: auth.user }) }));

interface TestPopup {
  closed: boolean;
  close: ReturnType<typeof vi.fn>;
  document: { title: string; body: { textContent: string } };
  location: { href: string };
  sessionStorage: { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void };
}

function popupWindow(): TestPopup {
  const values = new Map<string, string>();
  const popup: TestPopup = {
    closed: false,
    close: vi.fn(),
    document: { title: "", body: { textContent: "" } },
    location: { href: "about:blank" },
    sessionStorage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } },
  };
  popup.close.mockImplementation(() => { popup.closed = true; });
  return popup;
}

function response(view: { state: string; connectedAt?: string | null }, ok = true): Response {
  return { ok, json: async () => view } as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function recordOf(popup: TestPopup): ConnectionPopupRecord {
  return JSON.parse(popup.sessionStorage.getItem(CHAT_CONNECTION_POPUP_KEY)!);
}

function returnMessage(popup: TestPopup, overrides: { origin?: string; source?: Window | null; nonce?: string; provider?: string; outcome?: string } = {}) {
  const record = recordOf(popup);
  window.dispatchEvent(new MessageEvent("message", {
    origin: overrides.origin ?? window.location.origin,
    source: overrides.source === undefined ? popup as unknown as Window : overrides.source,
    data: { type: "droplet.connection-return", provider: overrides.provider ?? record.provider, nonce: overrides.nonce ?? record.nonce, outcome: overrides.outcome ?? "connected" },
  }));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-08T20:00:00Z"));
  vi.clearAllMocks();
  auth.user = { id: "stefan", role: "owner" };
  auth.authFetch.mockReset().mockResolvedValue(response({ state: "DISCONNECTED", connectedAt: null }));
  vi.spyOn(crypto, "randomUUID").mockReturnValue("12345678-1234-1234-1234-123456789abc");
  window.history.replaceState(null, "", "/chat?c=live-chat");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("chat account authorization popup", () => {
  it("reserves a window synchronously before awaiting status or starting OAuth", async () => {
    const popup = popupWindow();
    const open = vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    const status = deferred<Response>();
    auth.authFetch.mockReturnValueOnce(status.promise);
    const { result } = renderHook(() => useChatConnectionOAuth("google"));
    let preparing!: Promise<void>;
    act(() => { preparing = result.current.beforeConnect(); });
    expect(open).toHaveBeenCalledWith("about:blank", "_blank", expect.stringContaining("popup"));
    expect(popup.document.body.textContent).toMatch(/chat open/);
    expect(recordOf(popup)).toMatchObject({ provider: "google", openerOrigin: window.location.origin, startedAt: Date.now() });
    expect(Object.keys(recordOf(popup)).sort()).toEqual(["nonce", "openerOrigin", "provider", "startedAt"]);
    expect(auth.authFetch).toHaveBeenCalledWith("/api/google/connection");
    await act(async () => { status.resolve(response({ state: "DISCONNECTED" })); await preparing; });
    expect(popup.location.href).toBe("about:blank");
  });

  it("prevents the caller's start request when the browser blocks the popup", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const { result } = renderHook(() => useChatConnectionOAuth("google"));
    await act(async () => {
      const start = async () => { await result.current.beforeConnect(); await auth.authFetch("/api/google/connect", { method: "POST" }); };
      await expect(start()).rejects.toThrow(/popup blocked/);
    });
    expect(auth.authFetch).not.toHaveBeenCalled();
    expect(result.current.error).toMatch(/Allow popups/);
  });

  it("can prepare a secure correlation nonce on a LAN browser without randomUUID", async () => {
    const popup = popupWindow();
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    Object.defineProperty(crypto, "randomUUID", { configurable: true, value: undefined });
    const { result } = renderHook(() => useChatConnectionOAuth("google"));
    await act(async () => { await result.current.beforeConnect(); });
    expect(recordOf(popup).nonce).toMatch(/^[a-zA-Z0-9-]{32,64}$/);
    expect(popup.close).not.toHaveBeenCalled();
  });

  it("navigates provider approval in the reserved popup while preserving parent URL", async () => {
    const popup = popupWindow();
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    const { result } = renderHook(() => useChatConnectionOAuth("google"));
    const parentUrl = window.location.href;
    await act(async () => { await result.current.beforeConnect(); });
    act(() => result.current.navigate("https://accounts.google.com/o/oauth2/auth?state=opaque"));
    expect(popup.location.href).toBe("https://accounts.google.com/o/oauth2/auth?state=opaque");
    expect(window.location.href).toBe(parentUrl);
    expect(result.current.status).toMatch(/chat stays open/);
    act(() => result.current.afterConnect());
    expect(popup.close).not.toHaveBeenCalled();
  });

  it("moves a canonical-host handoff into the popup and accepts only its resulting origin", async () => {
    const popup = popupWindow();
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    const onConnected = vi.fn();
    const { result } = renderHook(() => useChatConnectionOAuth("m365", { onConnected }));
    const parentUrl = window.location.href;
    await act(async () => { await result.current.beforeConnect(); });
    act(() => result.current.navigate("https://canonical.example/chat/connect-return"));
    const url = new URL(popup.location.href);
    expect(url.origin).toBe("https://canonical.example");
    expect(url.pathname).toBe("/chat/connect");
    expect(url.searchParams.get("channel")).toBe(recordOf(popup).nonce);
    expect(window.location.href).toBe(parentUrl);
    await act(async () => { returnMessage(popup); });
    expect(auth.authFetch).toHaveBeenCalledTimes(1);
    auth.authFetch.mockResolvedValueOnce(response({ state: "CONNECTED", connectedAt: "2026-10-08T20:01:00Z" }));
    await act(async () => { returnMessage(popup, { origin: "https://canonical.example" }); });
    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  it.each([
    { origin: "https://attacker.example" },
    { source: {} as Window },
    { source: null },
    { nonce: "abcdefab-abcd-abcd-abcd-abcdefabcdef" },
    { provider: "m365" },
    { outcome: "not_an_outcome" },
  ])("ignores unrelated or spoofed return signal %j", async (override) => {
    const popup = popupWindow();
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    const onConnected = vi.fn();
    const onReturn = vi.fn();
    const { result } = renderHook(() => useChatConnectionOAuth("google", { onConnected, onReturn }));
    await act(async () => { await result.current.beforeConnect(); });
    act(() => result.current.navigate("https://accounts.google.com/approval"));
    await act(async () => { returnMessage(popup, override); });
    expect(auth.authFetch).toHaveBeenCalledTimes(1);
    expect(onConnected).not.toHaveBeenCalled();
    expect(onReturn).not.toHaveBeenCalled();
  });

  it("checks authenticated status and refuses a connected signal when account remains disconnected", async () => {
    const popup = popupWindow();
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    const onConnected = vi.fn(), onReturn = vi.fn();
    const { result } = renderHook(() => useChatConnectionOAuth("google", { onConnected, onReturn }));
    await act(async () => { await result.current.beforeConnect(); });
    act(() => result.current.navigate("https://accounts.google.com/approval"));
    await act(async () => { returnMessage(popup); });
    expect(auth.authFetch).toHaveBeenCalledTimes(2);
    expect(onConnected).not.toHaveBeenCalled();
    expect(onReturn).toHaveBeenCalledTimes(1);
    expect(result.current.status).toMatch(/did not finish/);
    expect(popup.close).toHaveBeenCalledTimes(1);
  });

  it("reports verified success once even when return signals are duplicated", async () => {
    const popup = popupWindow();
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    const onConnected = vi.fn(), onReturn = vi.fn();
    const { result } = renderHook(() => useChatConnectionOAuth("google", { onConnected, onReturn }));
    await act(async () => { await result.current.beforeConnect(); });
    act(() => result.current.navigate("https://accounts.google.com/approval"));
    auth.authFetch.mockResolvedValueOnce(response({ state: "CONNECTED", connectedAt: "new-grant" }));
    await act(async () => { returnMessage(popup); returnMessage(popup); });
    await act(async () => { returnMessage(popup); });
    expect(auth.authFetch).toHaveBeenCalledTimes(2);
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(onReturn).toHaveBeenCalledTimes(1);
    expect(popup.close).toHaveBeenCalledTimes(1);
  });

  it("does not treat a closed popup and unchanged existing grant as a new successful connection", async () => {
    const popup = popupWindow();
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    auth.authFetch.mockResolvedValue(response({ state: "CONNECTED", connectedAt: "old-grant" }));
    const onConnected = vi.fn();
    const { result } = renderHook(() => useChatConnectionOAuth("google", { onConnected }));
    await act(async () => { await result.current.beforeConnect(); });
    act(() => result.current.navigate("https://accounts.google.com/approval"));
    popup.closed = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(auth.authFetch).toHaveBeenCalledTimes(2);
    expect(onConnected).not.toHaveBeenCalled();
  });

  it("refuses a claimed success when an existing grant has not changed", async () => {
    const popup = popupWindow();
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    auth.authFetch.mockResolvedValue(response({ state: "CONNECTED", connectedAt: "old-grant" }));
    const onConnected = vi.fn(), onReturn = vi.fn();
    const { result } = renderHook(() => useChatConnectionOAuth("google", { onConnected, onReturn }));
    await act(async () => { await result.current.beforeConnect(); });
    act(() => result.current.navigate("https://accounts.google.com/approval"));
    await act(async () => { returnMessage(popup); });
    expect(onConnected).not.toHaveBeenCalled();
    expect(onReturn).toHaveBeenCalledTimes(1);
    expect(result.current.status).toMatch(/did not finish/);
  });

  it("can verify a newly completed grant when the provider severs the opener", async () => {
    const popup = popupWindow();
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    const onConnected = vi.fn(), onReturn = vi.fn();
    const { result } = renderHook(() => useChatConnectionOAuth("google", { onConnected, onReturn }));
    await act(async () => { await result.current.beforeConnect(); });
    act(() => result.current.navigate("https://accounts.google.com/approval"));
    popup.closed = true;
    auth.authFetch.mockResolvedValueOnce(response({ state: "CONNECTED", connectedAt: "new-grant" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it("expires the attempt and ignores a late success signal", async () => {
    const popup = popupWindow();
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    const onConnected = vi.fn(), onReturn = vi.fn();
    const { result } = renderHook(() => useChatConnectionOAuth("google", { onConnected, onReturn }));
    await act(async () => { await result.current.beforeConnect(); });
    act(() => result.current.navigate("https://accounts.google.com/approval"));
    await act(async () => { await vi.advanceTimersByTimeAsync(CHAT_CONNECTION_POPUP_TTL + 2_000); });
    expect(result.current.status).toMatch(/expired/);
    expect(onReturn).toHaveBeenCalledTimes(1);
    await act(async () => { returnMessage(popup); });
    expect(onConnected).not.toHaveBeenCalled();
    expect(auth.authFetch).toHaveBeenCalledTimes(1);
  });

  it.each(["role", "user", "unmount"])("discards late verification after %s teardown", async (teardown) => {
    const popup = popupWindow();
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    const onConnected = vi.fn(), onReturn = vi.fn();
    const { result, rerender, unmount } = renderHook(() => useChatConnectionOAuth("google", { onConnected, onReturn }));
    await act(async () => { await result.current.beforeConnect(); });
    act(() => result.current.navigate("https://accounts.google.com/approval"));
    const verification = deferred<Response>();
    auth.authFetch.mockReturnValueOnce(verification.promise);
    act(() => returnMessage(popup));
    if (teardown === "unmount") unmount();
    else { auth.user = teardown === "role" ? { id: "stefan", role: "guest" } : { id: "other", role: "owner" }; rerender(); }
    expect(onReturn).not.toHaveBeenCalled();
    await act(async () => { verification.resolve(response({ state: "CONNECTED", connectedAt: "new-grant" })); });
    expect(popup.close).toHaveBeenCalledTimes(1);
    expect(onConnected).not.toHaveBeenCalled();
    expect(onReturn).not.toHaveBeenCalled();
  });

  it("does not let an obsolete preparation close a newer sign-in attempt", async () => {
    const firstPopup = popupWindow(), secondPopup = popupWindow();
    vi.spyOn(window, "open").mockReturnValueOnce(firstPopup as unknown as Window).mockReturnValueOnce(secondPopup as unknown as Window);
    const firstStatus = deferred<Response>();
    auth.authFetch.mockReturnValueOnce(firstStatus.promise);
    const { result } = renderHook(() => useChatConnectionOAuth("google"));
    let first!: Promise<unknown>;
    act(() => { first = result.current.beforeConnect().catch((error: unknown) => error); });
    await act(async () => { await result.current.beforeConnect(); });
    await act(async () => { firstStatus.resolve(response({ state: "DISCONNECTED" })); await first; });
    expect(firstPopup.close).toHaveBeenCalledTimes(1);
    expect(secondPopup.close).not.toHaveBeenCalled();
    act(() => result.current.navigate("https://accounts.google.com/approval"));
    expect(secondPopup.location.href).toBe("https://accounts.google.com/approval");
    expect(result.current.error).toBeNull();
  });

  it("closes an unused reserved window when the start request fails", async () => {
    const popup = popupWindow();
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    const { result } = renderHook(() => useChatConnectionOAuth("google"));
    await act(async () => { await result.current.beforeConnect(); });
    act(() => result.current.afterConnect());
    expect(popup.close).toHaveBeenCalledTimes(1);
  });
});
