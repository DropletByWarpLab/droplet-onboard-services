"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, Sparkles } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { HostedSetupError, hostedErrorCopy, mintHostedAppSession, startHostedAppSetup } from "./api";

export function HostedAppOpen({ slug, disabled = false }: { slug: string; disabled?: boolean }) {
  const { user } = useAuth();
  const identity = `${user?.id ?? ""}:${user?.role ?? ""}:${slug}`;
  const latestIdentity = useRef(identity);
  latestIdentity.current = identity;
  const generation = useRef(0);
  const mounted = useRef(false);
  const pendingTab = useRef<Window | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    generation.current += 1;
    setBusy(false);
    setError(null);
    return () => {
      mounted.current = false;
      generation.current += 1;
      pendingTab.current?.close();
      pendingTab.current = null;
    };
  }, [identity]);
  const open = async () => {
    if (busy || disabled || !user) return;
    const gen = generation.current;
    const current = () => mounted.current && generation.current === gen && latestIdentity.current === identity;
    // Reserve the browser tab during the user's click, before the async mint.
    const tab = window.open("", "_blank");
    if (tab) tab.opener = null;
    pendingTab.current = tab;
    setBusy(true);
    setError(null);
    try {
      const session = await mintHostedAppSession(slug);
      // A code minted for the previous person must never reach the app tab.
      if (!current()) { tab?.close(); return; }
      const url = new URL(session.url, window.location.href);
      if (url.protocol !== "https:" || url.port !== "8443" || url.username || url.password ||
          url.pathname !== `/${encodeURIComponent(slug)}/_droplet/session` || !url.searchParams.get("code")) {
        throw new Error("Invalid app session URL");
      }
      if (tab) tab.location.replace(url.href);
      else window.location.assign(url.href);
    } catch (err) {
      tab?.close();
      if (current()) setError(hostedErrorCopy(err));
    } finally {
      if (pendingTab.current === tab) pendingTab.current = null;
      if (current()) setBusy(false);
    }
  };
  return <span>
    <button type="button" className="btn sm" disabled={disabled || busy} aria-busy={busy}
      aria-label={`Open ${slug} in browser`} onClick={() => void open()}>
      <ExternalLink size={13} aria-hidden /> {busy ? "Opening…" : "Open in browser"}
    </button>
    {error && <span role="alert" className="sub" style={{ display: "block", color: "var(--danger-ink)" }}>{error}</span>}
  </span>;
}

export function HostedAppSetup({ workspaceId, name, disabled = false }: { workspaceId: string; name: string; disabled?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const setup = async () => {
    setBusy(true);
    setError(null);
    try { router.push(await startHostedAppSetup(workspaceId, name, sessionId)); }
    catch (err) {
      if (err instanceof HostedSetupError) setSessionId(err.sessionId);
      setError(hostedErrorCopy(err instanceof HostedSetupError ? err.cause : err));
    }
    finally { setBusy(false); }
  };
  return <div>
    <button type="button" className="btn sm primary" disabled={disabled || busy} aria-busy={busy}
      onClick={() => void setup()}><Sparkles size={13} aria-hidden /> {busy ? "Starting…" : error ? "Try setup again" : "Set up with the assistant"}</button>
    {error && <p role="alert" className="ws-note">{error}</p>}
    {error && sessionId && <a className="ws-note" href={`/chat?c=${encodeURIComponent(sessionId)}`}>Open the setup chat</a>}
  </div>;
}
