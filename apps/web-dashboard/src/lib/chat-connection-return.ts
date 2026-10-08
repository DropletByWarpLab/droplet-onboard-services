/** Only navigation context crosses a provider sign-in; forms own credentials. */
export type ChatConnectionProvider = "google" | "m365";

export const CHAT_CONNECTION_RETURN_KEY = "droplet.chatConnectionReturn";
const OUTCOMES = new Set(["connected", "cancelled", "expired", "failed", "different_account"]);
const CONVERSATION_ID = /^[a-zA-Z0-9_-]{1,128}$/;

function isProvider(value: unknown): value is ChatConnectionProvider {
  return value === "google" || value === "m365";
}

/** Preserve setup intent when an account card switches to the box's canonical hostname. */
export function chatConnectionNavigationUrl(provider: ChatConnectionProvider, rawUrl: string): string {
  if (typeof window === "undefined") return rawUrl;
  const destination = new URL(rawUrl, window.location.href);
  if (window.location.pathname !== "/chat" || destination.origin === window.location.origin ||
    destination.pathname !== "/chat" || destination.search || destination.hash) return rawUrl;
  destination.searchParams.set("connect", provider);
  const conversationId = new URL(window.location.href).searchParams.get("c");
  if (conversationId && CONVERSATION_ID.test(conversationId)) destination.searchParams.set("c", conversationId);
  return destination.toString();
}

export async function saveChatConnectionReturn(provider: ChatConnectionProvider): Promise<void> {
  if (typeof window === "undefined" || window.location.pathname !== "/chat") return;
  const conversationId = new URL(window.location.href).searchParams.get("c");
  try {
    window.sessionStorage.setItem(CHAT_CONNECTION_RETURN_KEY, JSON.stringify({
      provider,
      conversationId: conversationId && CONVERSATION_ID.test(conversationId) ? conversationId : null,
    }));
  } catch {
    // Sign-in remains available in browsers that block session storage.
  }
}

/** Leave outcome consumption to the existing account card when it mounts. */
export function resumeChatConnectionReturn(): ChatConnectionProvider | null {
  if (typeof window === "undefined" || window.location.pathname !== "/chat") return null;
  const url = new URL(window.location.href);
  const handoff = url.searchParams.get("connect");
  if (isProvider(handoff)) {
    url.searchParams.delete("connect");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    return handoff;
  }
  const provider = (["google", "m365"] as const).find((key) =>
    OUTCOMES.has(url.searchParams.get(key) ?? "") || (key === "m365" && url.searchParams.get(key) === "invalid"),
  );
  if (!provider) return null;

  try {
    const raw = window.sessionStorage.getItem(CHAT_CONNECTION_RETURN_KEY);
    window.sessionStorage.removeItem(CHAT_CONNECTION_RETURN_KEY);
    const pending: unknown = raw ? JSON.parse(raw) : null;
    if (pending && typeof pending === "object" && "provider" in pending && "conversationId" in pending &&
      isProvider(pending.provider) && pending.provider === provider &&
      typeof pending.conversationId === "string" && CONVERSATION_ID.test(pending.conversationId) &&
      !url.searchParams.has("c")) {
      url.searchParams.set("c", pending.conversationId);
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    }
  } catch {
    // A corrupt or unavailable marker cannot prevent showing the provider outcome.
  }
  return provider;
}
