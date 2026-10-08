import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_CONNECTION_RETURN_KEY,
  chatConnectionNavigationUrl,
  resumeChatConnectionReturn,
  saveChatConnectionReturn,
} from "./chat-connection-return";
import { clearChatHandoffs } from "./session-reset";

beforeEach(() => {
  sessionStorage.clear();
  window.history.replaceState(null, "", "/chat?c=conversation-123");
});
afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("chat connection sign-in return", () => {
  it.each(["google", "m365"] as const)("keeps provider intent and conversation on a canonical-host %s handoff", (provider) => {
    const destination = new URL(chatConnectionNavigationUrl(provider, "https://droplet.example/chat"));
    expect(destination.origin).toBe("https://droplet.example");
    expect(destination.searchParams.get("connect")).toBe(provider);
    expect(destination.searchParams.get("c")).toBe("conversation-123");
    window.history.replaceState(null, "", `/chat${destination.search}`);
    expect(resumeChatConnectionReturn()).toBe(provider);
    expect(new URL(window.location.href).searchParams.has("connect")).toBe(false);
    expect(new URL(window.location.href).searchParams.get("c")).toBe("conversation-123");
  });

  it("leaves provider authorization URLs unchanged", () => {
    const authorize = "https://accounts.google.com/o/oauth2/auth?state=opaque&redirect_uri=https%3A%2F%2Fdroplet.example%2Fapi%2Fgoogle%2Fcallback";
    expect(chatConnectionNavigationUrl("google", authorize)).toBe(authorize);
  });

  it("shows the Microsoft invalid callback explanation and restores the conversation", async () => {
    await saveChatConnectionReturn("m365");
    window.history.replaceState(null, "", "/chat?m365=invalid");
    expect(resumeChatConnectionReturn()).toBe("m365");
    expect(new URL(window.location.href).searchParams.get("c")).toBe("conversation-123");
  });

  it("forgets pending conversation context when the session ends", async () => {
    await saveChatConnectionReturn("google");
    clearChatHandoffs();
    expect(sessionStorage.getItem(CHAT_CONNECTION_RETURN_KEY)).toBeNull();
  });
  it.each(["google", "m365"] as const)("restores the same conversation after %s sign-in without consuming its outcome", async (provider) => {
    await saveChatConnectionReturn(provider);
    window.history.replaceState(null, "", `/chat?${provider}=connected`);
    expect(resumeChatConnectionReturn()).toBe(provider);
    expect(new URL(window.location.href).searchParams.get("c")).toBe("conversation-123");
    expect(new URL(window.location.href).searchParams.get(provider)).toBe("connected");
    expect(sessionStorage.getItem(CHAT_CONNECTION_RETURN_KEY)).toBeNull();
  });

  it.each(["cancelled", "expired", "failed", "different_account"])("returns to the setup card after a %s result", async (outcome) => {
    await saveChatConnectionReturn("google");
    window.history.replaceState(null, "", `/chat?google=${outcome}`);
    expect(resumeChatConnectionReturn()).toBe("google");
    expect(new URL(window.location.href).searchParams.get("c")).toBe("conversation-123");
  });

  it("does not replace a conversation explicitly opened in the return URL", async () => {
    await saveChatConnectionReturn("google");
    window.history.replaceState(null, "", "/chat?google=connected&c=another-chat");
    resumeChatConnectionReturn();
    expect(new URL(window.location.href).searchParams.get("c")).toBe("another-chat");
  });

  it("does not resume the other provider's stale conversation", async () => {
    await saveChatConnectionReturn("google");
    window.history.replaceState(null, "", "/chat?m365=connected");
    expect(resumeChatConnectionReturn()).toBe("m365");
    expect(new URL(window.location.href).searchParams.has("c")).toBe(false);
  });

  it.each(["not-an-outcome", "", "https://example.com"])("ignores unrecognized outcomes (%s)", (value) => {
    window.history.replaceState(null, "", `/chat?google=${encodeURIComponent(value)}`);
    expect(resumeChatConnectionReturn()).toBeNull();
  });

  it.each(["broken json", JSON.stringify({ provider: "google", conversationId: "//example.com" }), JSON.stringify({ provider: "other", conversationId: "conversation-123" })])("ignores invalid stored navigation context", (value) => {
    sessionStorage.setItem(CHAT_CONNECTION_RETURN_KEY, value);
    window.history.replaceState(null, "", "/chat?google=connected");
    expect(resumeChatConnectionReturn()).toBe("google");
    expect(new URL(window.location.href).searchParams.has("c")).toBe(false);
  });

  it("keeps sign-in usable when session storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    await expect(saveChatConnectionReturn("google")).resolves.toBeUndefined();
    window.history.replaceState(null, "", "/chat?google=connected");
    expect(resumeChatConnectionReturn()).toBe("google");
  });

  it("does not handle outcomes outside chat", async () => {
    await saveChatConnectionReturn("google");
    window.history.replaceState(null, "", "/settings?google=connected");
    expect(resumeChatConnectionReturn()).toBeNull();
    expect(sessionStorage.getItem(CHAT_CONNECTION_RETURN_KEY)).not.toBeNull();
  });
});
