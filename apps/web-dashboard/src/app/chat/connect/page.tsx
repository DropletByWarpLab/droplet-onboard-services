"use client";

import { useEffect, useState } from "react";
import { GoogleAccountCard } from "@/components/settings/GoogleAccountCard";
import { Microsoft365Card } from "@/components/settings/Microsoft365Card";
import { CHAT_CONNECTION_POPUP_KEY, connectionPopupRecordFromUrl, type ConnectionPopupRecord } from "@/lib/chat-connection-popup";
import "@/components/shell/indigo-tokens.css";

/** Canonical-host account linking runs here when the box's address differs. */
export default function ChatConnectPopupPage() {
  const [record, setRecord] = useState<ConnectionPopupRecord | null>(null);
  useEffect(() => {
    const pending = connectionPopupRecordFromUrl(window.location.href);
    if (!pending || !window.opener) return;
    try { window.sessionStorage.setItem(CHAT_CONNECTION_POPUP_KEY, JSON.stringify(pending)); }
    catch { return; }
    window.history.replaceState(window.history.state, "", "/chat/connect");
    setRecord(pending);
  }, []);
  return <div className="droplet-shell p-6 space-y-4">
    <h1 className="type-title-2">Account sign-in</h1>
    <p className="type-caption-1">Complete account approval in this window. Your Droplet chat stays open.</p>
    {record?.provider === "google" ? <GoogleAccountCard returnTo="/chat/connect-return" /> : record?.provider === "m365" ? <Microsoft365Card returnTo="/chat/connect-return" /> : <p className="type-body">Open account setup from your Droplet chat to continue.</p>}
  </div>;
}
