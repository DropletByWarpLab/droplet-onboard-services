"use client";

import { lazy, Suspense, useEffect, useId, useRef, useState } from "react";
import { Dialog } from "@/components/Dialog";
import { useAuth } from "@/lib/auth";
import type { ConnectSetupRequest } from "../ChatConnections";
import type { ConnectCall } from "./connect-split";

const ChatConnections = lazy(() => import("../ChatConnections").then((module) => ({ default: module.ChatConnections })));

/** Successful connection tools open existing setup dialogs, without changing the composer. */
export function ToolConnectCards({ calls, interactive, onOutcome, seenIds }: {
  calls: ConnectCall[];
  interactive: boolean;
  onOutcome?: (turn: string) => void;
  seenIds?: Set<string>;
}) {
  const { user } = useAuth();
  const principal = `${user?.id}:${user?.role}`;
  const canConnect = user?.role === "owner" || user?.role === "admin" || user?.role === "family";
  const [setup, setSetup] = useState<{ principal: string; request: ConnectSetupRequest } | null>(null);
  const request = setup?.principal === principal ? setup.request : null;
  const localSeen = useRef(new Set<string>());
  const seen = seenIds ?? localSeen.current;
  const triggerRef = useRef<HTMLElement | null>(null);
  const loadingTitleId = useId();
  useEffect(() => {
    const fresh = calls.filter(({ call, result }) => !seen.has(call.id) && result.kind !== "disconnected");
    for (const { call } of calls) seen.add(call.id);
    if (!interactive) {
      setSetup(null);
      return;
    }
    const latest = fresh[fresh.length - 1];
    if (latest && latest.result.kind !== "disconnected") {
      triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (canConnect) setSetup({ principal, request: latest.result });
    }
  }, [calls, interactive, seen, principal, canConnect]);

  if (calls.length === 0 || !canConnect) return null;
  return <div className="flex flex-col gap-2 mt-2" data-testid="tool-connect-cards">
    {calls.map(({ call, result }) => result.kind === "disconnected" ? <p key={call.id} className="type-footnote" role="status">{result.disconnected.displayName} is disconnected.</p> : <div key={call.id} className="flex items-center gap-3">
      <span className="type-footnote">{result.kind === "overview" ? "Connections" : `${result.card.displayName} setup`}</span>
      <button type="button" className="btn" disabled={!interactive} onClick={(event) => { triggerRef.current = event.currentTarget; setSetup({ principal, request: result }); }}>{result.kind === "overview" ? "Open connections" : "Open setup"}</button>
    </div>)}
    {interactive && <Suspense fallback={request ? <Dialog open onClose={() => setSetup(null)} triggerRef={triggerRef} labelledBy={loadingTitleId}>
      <h2 id={loadingTitleId} className="type-title-2">Connection setup</h2>
      <p role="status" className="type-footnote mt-3">Loading connection setup…</p>
      <button type="button" className="btn mt-4" onClick={() => setSetup(null)}>Close setup</button>
    </Dialog> : null}>
      <ChatConnections key={principal} request={request} onClose={() => setSetup(null)} onOutcome={onOutcome} triggerRef={triggerRef} />
    </Suspense>}
  </div>;
}
