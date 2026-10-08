"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch, useAuth } from "@/lib/auth";
import { CHAT_CONNECTION_POPUP_KEY, CHAT_CONNECTION_POPUP_TTL, connectionPopupEntryUrl, isConnectionPopupMessage, type ConnectionPopupRecord, type PopupProvider } from "@/lib/chat-connection-popup";

interface Attempt {
  popup: Window;
  expectedOrigin: string;
  record: ConnectionPopupRecord;
  navigated: boolean;
  baseline: string | null;
  userId: string;
  checking: boolean;
}

/** Provider approval is isolated in a window; the chat and its draft stay mounted. */
export function useChatConnectionOAuth(provider: PopupProvider, options: { onConnected?: () => void; onReturn?: () => void } = {}) {
  const { user } = useAuth();
  const userRef = useRef(user);
  userRef.current = user;
  const callbacks = useRef(options);
  callbacks.current = options;
  const attempt = useRef<Attempt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const close = useCallback(() => {
    const pending = attempt.current;
    attempt.current = null;
    try { pending?.popup.close(); } catch { /* window already closed */ }
  }, []);

  useEffect(() => {
    close();
  }, [close, provider, user?.id, user?.role]);
  useEffect(() => close, [close]);

  const readConnection = useCallback(async () => {
    const response = await authFetch(`/api/${provider}/connection`);
    if (!response.ok) throw new Error("connection status unavailable");
    return await response.json() as { state?: string; connectedAt?: string | null };
  }, [provider]);

  const finish = useCallback(async (pending: Attempt, outcome: string | null) => {
    if (attempt.current !== pending || pending.checking || pending.userId !== userRef.current?.id) return;
    pending.checking = true;
    try {
      const view = await readConnection();
      if (attempt.current !== pending || pending.userId !== userRef.current?.id) return;
      const verified = view.state === "CONNECTED" && typeof view.connectedAt === "string" && view.connectedAt !== pending.baseline;
      if (outcome === null && !verified) return;
      close();
      setStatus(verified ? "Account connected. You can continue in this chat." : "Sign-in did not finish. You can try again here.");
      if (verified) callbacks.current.onConnected?.();
      callbacks.current.onReturn?.();
    } catch {
      if (attempt.current !== pending) return;
      if (outcome !== null) {
        close();
        setError("Droplet could not confirm the connection. Check its status and try again.");
        callbacks.current.onReturn?.();
      }
    } finally { pending.checking = false; }
  }, [close, readConnection]);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const pending = attempt.current;
      if (pending && isConnectionPopupMessage(event, pending)) void finish(pending, event.data.outcome);
    };
    window.addEventListener("message", receive);
    const timer = window.setInterval(() => {
      const pending = attempt.current;
      if (!pending || !pending.navigated) return;
      if (Date.now() - pending.record.startedAt > CHAT_CONNECTION_POPUP_TTL) {
        close();
        setStatus("Sign-in expired. You can try again here.");
        callbacks.current.onReturn?.();
      } else if (pending.popup.closed) {
        // Providers can sever window.opener. A closed window is only a trigger
        // to check the authenticated status; it is never proof of success.
        void finish(pending, null);
      }
    }, 2_000);
    return () => { window.removeEventListener("message", receive); window.clearInterval(timer); };
  }, [close, finish]);

  const beforeConnect = useCallback(async () => {
    close();
    setError(null);
    setStatus(null);
    const popup = window.open("about:blank", "_blank", "popup,width=600,height=760");
    if (!popup) {
      setError("Allow popups for Droplet, then try connecting again.");
      throw new Error("popup blocked");
    }
    // getRandomValues is available on the LAN's HTTP address as well as HTTPS.
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const record: ConnectionPopupRecord = { provider, nonce, openerOrigin: window.location.origin, startedAt: Date.now() };
    const pending: Attempt = { popup, record, expectedOrigin: window.location.origin, navigated: false, baseline: null, userId: userRef.current?.id ?? "", checking: false };
    attempt.current = pending;
    try {
      popup.document.title = "Droplet account sign-in";
      popup.document.body.textContent = "Opening account sign-in… You can keep your Droplet chat open.";
      popup.sessionStorage.setItem(CHAT_CONNECTION_POPUP_KEY, JSON.stringify(record));
      const view = await readConnection();
      if (attempt.current !== pending) throw new Error("setup closed");
      pending.baseline = view.connectedAt ?? null;
    } catch (cause) {
      if (attempt.current === pending) {
        close();
        setError("Droplet could not prepare account sign-in. Try again.");
      }
      throw cause;
    }
  }, [close, provider, readConnection]);

  const navigate = useCallback((raw: string) => {
    const pending = attempt.current;
    if (!pending || pending.popup.closed || pending.userId !== userRef.current?.id) return;
    const destination = new URL(raw, window.location.href);
    if (!["https:", "http:"].includes(destination.protocol)) throw new Error("invalid sign-in destination");
    if (destination.pathname === "/chat/connect-return" && destination.origin !== window.location.origin) {
      pending.expectedOrigin = destination.origin;
      pending.popup.location.href = connectionPopupEntryUrl(destination.origin, pending.record);
    } else {
      pending.popup.location.href = destination.toString();
    }
    pending.navigated = true;
    setStatus("Finish approval in the sign-in window. Your chat stays open here.");
  }, []);

  const afterConnect = useCallback(() => {
    if (attempt.current && !attempt.current.navigated) close();
  }, [close]);

  const cancel = useCallback(() => {
    close();
    setStatus("Sign-in cancelled. You can try again here.");
    callbacks.current.onReturn?.();
  }, [close]);

  return { beforeConnect, navigate, afterConnect, close, cancel, error, status };
}
