"use client";

import { lazy, Suspense, useEffect, useId, useRef, useState } from "react";
import { Dialog } from "@/components/Dialog";
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
  const [request, setRequest] = useState<ConnectSetupRequest | null>(null);
  const localSeen = useRef(new Set<string>());
  const seen = seenIds ?? localSeen.current;
  const triggerRef = useRef<HTMLElement | null>(null);
  const loadingTitleId = useId();
  useEffect(() => {
    const fresh = calls.filter(({ call, result }) => !seen.has(call.id) && result.kind !== "disconnected");
    for (const { call } of calls) seen.add(call.id);
    if (!interactive) {
      setRequest(null);
      return;
    }
    const latest = fresh[fresh.length - 1];
    if (latest && latest.result.kind !== "disconnected") {
      triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setRequest(latest.result);
    }
  }, [calls, interactive, seen]);

  if (calls.length === 0) return null;
  return <div className="flex flex-col gap-2 mt-2" data-testid="tool-connect-cards">
    {calls.map(({ call, result }) => result.kind === "disconnected" ? <p key={call.id} className="type-footnote" role="status">{result.disconnected.displayName} is disconnected.</p> : <div key={call.id} className="flex items-center gap-3">
      <span className="type-footnote">{result.kind === "overview" ? "Connections" : `${result.card.displayName} setup`}</span>
      <button type="button" className="btn" disabled={!interactive} onClick={(event) => { triggerRef.current = event.currentTarget; setRequest(result); }}>{result.kind === "overview" ? "Open connections" : "Open setup"}</button>
    </div>)}
    {interactive && <Suspense fallback={request ? <Dialog open onClose={() => setRequest(null)} triggerRef={triggerRef} labelledBy={loadingTitleId}>
      <h2 id={loadingTitleId} className="type-title-2">Connection setup</h2>
      <p role="status" className="type-footnote mt-3">Loading connection setup…</p>
      <button type="button" className="btn mt-4" onClick={() => setRequest(null)}>Close setup</button>
    </Dialog> : null}>
      <ChatConnections request={request} onClose={() => setRequest(null)} onOutcome={onOutcome} triggerRef={triggerRef} />
    </Suspense>}
  </div>;
}
