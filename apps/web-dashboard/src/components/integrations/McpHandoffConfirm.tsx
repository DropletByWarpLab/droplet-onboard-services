"use client";

/**
 * /connectors/mcp/connect?handoff=<id> — the browser half of a sign-in a native
 * client started (WARP-3965).
 *
 * A link on its own can never connect anything: the page shows who is asking and
 * where the person would go, and only the person pressing Continue calls start
 * with the handoff id, so the box's state cookie lives in THIS browser. Reading a
 * handoff does not consume it; start does. The id is never rendered or logged.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Blocks } from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { readMcpHandoff, startMcpSignIn, type McpHandoffView } from "@/lib/api";

/** One fixed sentence per refusal the box can give; its own message is never shown. */
const REFUSALS: Record<string, string> = {
  handoff_invalid: "This link has expired or was already used. Go back to Droplet and choose Connect again.",
  handoff_wrong_member:
    "This link was made for another member’s account. Sign in as that member, or start again from your own Droplet.",
  acknowledge_required: "This connection needs an owner or admin to confirm it in Droplet first.",
  connection_disabled: "An owner or admin turned this connection off for the Workspace.",
};
const GENERIC = "Droplet couldn’t continue. Go back to Droplet and choose Connect again.";

export function McpHandoffConfirm({
  navigate = (url: string) => window.location.assign(url),
}: {
  navigate?: (url: string) => void;
}) {
  const [handoffId, setHandoffId] = useState<string | null | undefined>(undefined);
  const [view, setView] = useState<McpHandoffView | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [showDestination, setShowDestination] = useState(false);
  const [busy, setBusy] = useState(false);

  // Read from `window.location`, not `useSearchParams`, which would force a
  // Suspense boundary onto the page for one query value.
  useEffect(() => {
    setHandoffId(new URLSearchParams(window.location.search).get("handoff"));
  }, []);

  useEffect(() => {
    if (handoffId === undefined) return;
    if (!handoffId) {
      setRefusal(REFUSALS.handoff_invalid!);
      return;
    }
    let live = true;
    readMcpHandoff(handoffId).then(
      (v) => live && setView(v),
      (err) => {
        const code = err instanceof Error ? err.message : "";
        if (live) setRefusal(Object.hasOwn(REFUSALS, code) ? REFUSALS[code]! : GENERIC);
      },
    );
    return () => {
      live = false;
    };
  }, [handoffId]);

  const proceed = async () => {
    if (busy || !handoffId) return;
    setBusy(true);
    try {
      const body = await startMcpSignIn({ handoff: handoffId });
      // Only an http(s) address the box returned; never built from page state.
      const target = new URL(body.authorizeUrl);
      if (target.protocol !== "https:" && target.protocol !== "http:") throw new Error("bad_url");
      navigate(body.authorizeUrl);
      return;
    } catch (err) {
      const code = err instanceof Error ? err.message : "";
      setRefusal(Object.hasOwn(REFUSALS, code) ? REFUSALS[code]! : GENERIC);
    }
    setBusy(false);
  };

  const vendor = view?.displayName ?? "this service";

  return (
    <ShellPage icon={<Blocks size={15} />} label="Connectors">
      <div className="card space-y-4" style={{ maxWidth: 560, margin: "0 auto" }} data-testid="mcp-handoff">
        {refusal ? (
          <>
            <h1 className="type-title-2">This link can’t be used</h1>
            <p className="type-footnote text-[color:var(--text-muted)]" role="alert">{refusal}</p>
            <Link href="/connectors" className="btn">Open Connectors</Link>
          </>
        ) : !view ? (
          <p className="type-footnote text-[color:var(--text-muted)]" role="status">Checking this link…</p>
        ) : (
          <>
            <h1 className="type-title-2">Finish connecting {vendor}?</h1>
            <p className="type-footnote text-[color:var(--text-muted)]">
              A link brought you here. Only continue if you started connecting {vendor} from Droplet on
              this computer. A link on its own can never connect anything to your Workspace.
            </p>
            <div>
              <button
                type="button"
                className="btn ghost sm"
                aria-expanded={showDestination}
                onClick={() => setShowDestination((v) => !v)}
              >
                Show destination
              </button>
              {showDestination && (
                <dl className="type-footnote" style={{ margin: "8px 0 0" }}>
                  <dt className="text-[color:var(--text-faint)]">You will sign in at</dt>
                  <dd style={{ margin: "0 0 6px", fontFamily: "var(--font-mono)" }}>{view.destinationHost}</dd>
                  <dt className="text-[color:var(--text-faint)]">Then you come back to</dt>
                  <dd style={{ margin: 0, fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>{view.callback}</dd>
                </dl>
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <button type="button" className="btn primary" disabled={busy} onClick={() => void proceed()}>
                Continue connecting
              </button>
              <Link href="/connectors" className="type-footnote text-[color:var(--brand)]">Not now</Link>
            </div>
          </>
        )}
      </div>
    </ShellPage>
  );
}
