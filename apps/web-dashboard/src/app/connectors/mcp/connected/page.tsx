"use client";

/**
 * /connectors/mcp/connected?mcp=<provider>:<outcome> — where the box's callback
 * lands after a sign-in a native client started (WARP-3965). It says how it
 * went and offers one way on; the copy is ours, the query only picks a sentence.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Blocks } from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { useConnectorDirectory } from "@/lib/hooks/useConnectorDirectory";
import { useAuth } from "@/lib/auth";

type Outcome = "connected" | "cancelled" | "expired" | "failed";

const COPY: Record<Outcome, { title: (v: string) => string; body: string; error: boolean }> = {
  connected: { title: (v) => `Connected to ${v}`, body: "You can return to Droplet.", error: false },
  cancelled: { title: () => "Sign-in was cancelled", body: "Nothing was connected. Try again from Droplet when you’re ready.", error: false },
  expired: { title: () => "That sign-in expired", body: "Start again from Droplet when you’re ready.", error: true },
  failed: { title: () => "Sign-in could not be completed", body: "Nothing was connected. Try again from Droplet.", error: true },
};

export default function McpConnectedPage() {
  const { user } = useAuth();
  const allowed = user?.role === "owner" || user?.role === "admin" || user?.role === "family";
  const { entries } = useConnectorDirectory(allowed);
  const [parsed, setParsed] = useState<{ provider: string; outcome: Outcome } | null>(null);

  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get("mcp") ?? "";
    const [provider = "", o = ""] = raw.split(":");
    setParsed({ provider, outcome: Object.hasOwn(COPY, o) ? (o as Outcome) : "failed" });
  }, []);

  // The vendor's name comes from the directory, never from the query string.
  const vendor = entries?.find((e) => e.id === parsed?.provider)?.name ?? "your service";
  const copy = parsed ? COPY[parsed.outcome] : null;

  return (
    <ShellPage icon={<Blocks size={15} />} label="Connectors">
      <div className="card space-y-4" style={{ maxWidth: 560, margin: "0 auto" }} data-testid="mcp-connected">
        {copy && (
          <>
            <h1 className="type-title-2">{copy.title(vendor)}</h1>
            <p className="type-footnote text-[color:var(--text-muted)]" role={copy.error ? "alert" : "status"}>{copy.body}</p>
          </>
        )}
        <Link href="/connectors" className="btn primary">Open Connectors</Link>
      </div>
    </ShellPage>
  );
}
