"use client";
import type { RefObject } from "react";
import useSWR from "swr";
import { Dialog } from "@/components/Dialog";
import { fetchHostedAppLogs, hostedErrorCopy } from "./api";

export function AppLogsDialog({ slug, onClose, triggerRef }: {
  slug: string | null; onClose: () => void; triggerRef?: RefObject<HTMLElement | null>;
}) {
  const logs = useSWR(slug ? `/api/hosted/${slug}/logs` : null, () => fetchHostedAppLogs(slug!));
  return <Dialog open={slug !== null} onClose={onClose} triggerRef={triggerRef} labelledBy="app-logs-heading" maxWidth="2xl">
    <h2 id="app-logs-heading" className="text-[16px] font-semibold m-0">Logs for {slug}</h2>
    {logs.isLoading ? <p className="sub" role="status">Loading logs…</p> : logs.error ?
      <p className="sub" role="alert">{hostedErrorCopy(logs.error)}</p> : logs.data ? <>
        <p className="sub">Recent output from this app. Logs can contain text written by the app.</p>
        {logs.data.truncated || logs.data.droppedBytes > 0 ? <p className="sub" role="status">Older output has been dropped from the log buffer.</p> : null}
        <pre className="ws-pre" aria-label="App logs">{logs.data.output || logs.data.note || "No output yet."}</pre>
      </> : null}
    <div className="flex justify-end gap-2 mt-4"><button type="button" className="btn" disabled={logs.isLoading} onClick={() => void logs.mutate()}>Refresh logs</button>
      <button type="button" className="btn primary" onClick={onClose}>Close</button></div>
  </Dialog>;
}
