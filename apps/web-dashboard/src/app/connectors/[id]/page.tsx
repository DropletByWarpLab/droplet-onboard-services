"use client";

/**
 * A connector's page (/connectors/<id>) — business system or MCP server, one
 * layout (WARP-3965). Everything shown comes from the directory read; an id the
 * directory does not list is said so, never guessed at.
 */

import { useParams } from "next/navigation";
import Link from "next/link";
import { Blocks } from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { useAuth } from "@/lib/auth";
import { useConnectorDirectory } from "@/lib/hooks/useConnectorDirectory";
import { ConnectorDetail } from "@/components/integrations/ConnectorDetail";

export default function ConnectorPage() {
  const params = useParams<{ id: string }>();
  const id = decodeURIComponent(params?.id ?? "");
  const { user } = useAuth();
  const allowed = user?.role === "owner" || user?.role === "admin" || user?.role === "family";
  const { entries, loading, error, refresh } = useConnectorDirectory(allowed);
  const entry = entries?.find((e) => e.id === id);

  return (
    <ShellPage icon={<Blocks size={15} />} label="Connectors">
      {!allowed ? (
        <p className="type-footnote text-[color:var(--text-muted)]" role="status">
          Connectors aren&rsquo;t available for guest accounts.
        </p>
      ) : error ? (
        <p className="type-footnote text-system-red" role="alert">
          {error === "directory_absent"
            ? "This Droplet needs an update before it can show Connectors."
            : "Droplet couldn’t load this connector. Try again in a moment."}
        </p>
      ) : loading && !entries ? (
        <p className="type-footnote text-[color:var(--text-muted)]" role="status">Loading…</p>
      ) : entry && entries ? (
        <ConnectorDetail entry={entry} all={entries} refresh={refresh} />
      ) : (
        <p className="type-footnote text-[color:var(--text-muted)]" role="status">
          We couldn&rsquo;t find that connector.{" "}
          <Link href="/connectors" className="text-[color:var(--brand)]">Back to Connectors</Link>
        </p>
      )}
    </ShellPage>
  );
}
