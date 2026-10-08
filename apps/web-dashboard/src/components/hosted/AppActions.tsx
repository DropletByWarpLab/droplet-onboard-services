"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, Sparkles } from "lucide-react";
import { HostedSetupError, hostedErrorCopy, mintHostedAppSession, startHostedAppSetup } from "./api";
import { useHostedActionScope } from "./useHostedActionScope";
import { useBoxAddress } from "@/lib/hooks/useBoxAddress";

export function HostedAppOpen({ slug, disabled = false }: { slug: string; disabled?: boolean }) {
  const boxAddress = useBoxAddress();
  const scope = useHostedActionScope(`open:${slug}:${disabled}:${boxAddress}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<{ tab: Window | null; controller: AbortController } | null>(null);
  useEffect(() => {
    setBusy(false); setError(null);
    return () => { pending.current?.controller.abort(); pending.current?.tab?.close(); pending.current = null; };
  }, [scope.key]);
  const open = async () => {
    const isCurrent = scope.capture();
    if (busy || disabled || !isCurrent()) return;
    // Reserve the browser tab during the user's click, before the async mint.
    const tab = window.open("", "_blank");
    if (tab) tab.opener = null;
    const operation = { tab, controller: new AbortController() };
    pending.current = operation;
    setBusy(true);
    setError(null);
    try {
      const session = await mintHostedAppSession(slug, operation.controller.signal);
      if (!isCurrent()) { tab?.close(); return; }
      const url = new URL(session.url, window.location.href);
      // The box's configured DNS name may differ from the IP/mDNS address
      // serving this dashboard. Never learn a trusted host from the mint itself.
      const address = boxAddress.trim().toLowerCase();
      let applianceHostname: string | null = null;
      try { const hostname = new URL(`https://${address}`).hostname; if (hostname === address) applianceHostname = hostname; } catch { /* Display names are not necessarily DNS names. */ }
      if (url.protocol !== "https:" || (url.hostname !== window.location.hostname && url.hostname !== applianceHostname) || url.port !== "8443" || url.username || url.password || url.hash ||
          url.pathname !== `/${encodeURIComponent(slug)}/_droplet/session` || !url.searchParams.get("code")) {
        throw new Error("Invalid app session URL");
      }
      if (tab) tab.location.replace(url.href);
      else window.location.assign(url.href);
    } catch (err) {
      tab?.close();
      if (isCurrent()) setError(hostedErrorCopy(err));
    } finally { if (pending.current === operation) pending.current = null; if (isCurrent()) setBusy(false); }
  };
  return <span>
    <button type="button" className="btn sm" disabled={disabled || busy || !scope.key} aria-busy={busy}
      aria-label={`Open ${slug} in browser`} onClick={() => void open()}>
      <ExternalLink size={13} aria-hidden /> {busy ? "Opening…" : "Open in browser"}
    </button>
    {error && <span role="alert" className="sub" style={{ display: "block", color: "var(--danger-ink)" }}>{error}</span>}
  </span>;
}

export function HostedAppSetup({ workspaceId, name, disabled = false }: { workspaceId: string; name: string; disabled?: boolean }) {
  const scope = useHostedActionScope(`setup:${workspaceId}:${disabled}`, ["owner", "admin"]);
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    setBusy(false); setError(null); setSessionId(undefined);
    return () => { controller.current?.abort(); controller.current = null; };
  }, [scope.key]);
  const setup = async () => {
    const isCurrent = scope.capture();
    if (busy || disabled || !isCurrent()) return;
    const operation = new AbortController(); controller.current = operation;
    setBusy(true);
    setError(null);
    try { const url = await startHostedAppSetup(workspaceId, name, sessionId, { signal: operation.signal, isCurrent }); if (isCurrent()) router.push(url); }
    catch (err) {
      if (!isCurrent()) return;
      if (err instanceof HostedSetupError) setSessionId(err.sessionId);
      setError(hostedErrorCopy(err instanceof HostedSetupError ? err.cause : err));
    }
    finally { if (controller.current === operation) controller.current = null; if (isCurrent()) setBusy(false); }
  };
  return <div>
    <button type="button" className="btn sm primary" disabled={disabled || busy || !scope.key} aria-busy={busy}
      onClick={() => void setup()}><Sparkles size={13} aria-hidden /> {busy ? "Starting…" : error ? "Try setup again" : "Set up with the assistant"}</button>
    {error && <p role="alert" className="ws-note">{error}</p>}
    {error && sessionId && <a className="ws-note" href={`/chat?c=${encodeURIComponent(sessionId)}`}>Open the setup chat</a>}
  </div>;
}
