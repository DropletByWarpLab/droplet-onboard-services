"use client";

/**
 * Connectors (/connectors) — one directory for the business systems Droplet
 * reads and the MCP servers a member signs in to (WARP-3965).
 *
 * The list, the state and the actions all come from `GET /api/connectors/
 * directory`; the dashboard holds no catalog of its own. Two kinds share one
 * card, one list row and one detail layout, in two sections: Business systems
 * and MCP servers. A search turns the sections into one list of rows.
 *
 * `?connect=<provider>` is the hand-off from Ask AI ("Open the wizard"): it
 * lands on that connector's detail page, whose Connect does the rest. The page
 * never guesses, so a provider the directory does not list is stripped and opens
 * nothing.
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Blocks, ChevronDown, Search, ShieldCheck } from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { Sect } from "@/components/shell/primitives";
import { useAuth } from "@/lib/auth";
import type { ConnectorDirectoryEntry } from "@/lib/api";
import { useConnectorDirectory } from "@/lib/hooks/useConnectorDirectory";
import { DirectoryCard, DirectoryRow } from "@/components/integrations/DirectoryCards";
import { DropMenu } from "@/components/integrations/DropMenu";
import { allCategories, isYours, matchesQuery } from "@/components/integrations/directory-model";

type Tab = "yours" | "discover";

function Grid({ entries, canManage }: { entries: ConnectorDirectoryEntry[]; canManage: boolean }) {
  return (
    <div className="grid c3 stagger">
      {entries.map((e) => (
        <DirectoryCard key={e.id} entry={e} yours={isYours(e, canManage)} />
      ))}
    </div>
  );
}

function errorCopy(code: string): string {
  return code === "directory_absent"
    ? "This Droplet needs an update before it can show Connectors."
    : "Droplet couldn't load Connectors. Try again in a moment.";
}

export default function ConnectorsPage() {
  const router = useRouter();
  const { user } = useAuth();
  const canManage = user?.role === "owner" || user?.role === "admin";
  // Guests have no directory: no request, no half-empty page.
  const allowed = canManage || user?.role === "family";
  const { entries, loading, error, refresh } = useConnectorDirectory(allowed);
  const [tab, setTab] = useState<Tab>("discover");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);

  // Once per mount, after the directory has answered.
  useEffect(() => {
    if (!entries || typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const wanted = url.searchParams.get("connect");
    if (wanted === null) return;
    url.searchParams.delete("connect");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    if (entries.some((e) => e.id === wanted)) router.push(`/connectors/${encodeURIComponent(wanted)}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries]);

  const categories = useMemo(() => allCategories(entries ?? []), [entries]);
  const searching = query.trim() !== "";

  const visible = useMemo(
    () =>
      (entries ?? []).filter(
        (e) => matchesQuery(e, query) && (category === null || e.categories.includes(category)),
      ),
    [entries, query, category],
  );
  const pool = !searching && tab === "yours" ? visible.filter((e) => isYours(e, canManage)) : visible;
  const systems = pool.filter((e) => e.kind === "system");
  const servers = pool.filter((e) => e.kind === "mcp");

  return (
    <ShellPage
      icon={<Blocks size={15} />}
      label="Connectors"
      title="Connectors"
      sub="Connect the business systems and AI tools your team already uses."
      actions={
        canManage ? (
          <DropMenu
            label="Add a connector"
            trigger={
              <>
                Add <ChevronDown size={14} aria-hidden />
              </>
            }
            items={[
              {
                id: "mcp-url",
                label: "Add an MCP server by URL",
                disabled: true,
                reason: "Coming soon",
                onSelect: () => {},
              },
              {
                id: "credentials",
                label: "Open Connector credentials",
                onSelect: () => router.push("/connectors/credentials"),
              },
            ]}
          />
        ) : undefined
      }
    >
      {!allowed ? (
        <p className="type-footnote text-[color:var(--text-muted)]" role="status">
          Connectors aren&rsquo;t available for guest accounts.
        </p>
      ) : (
        <>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
            <div className="pills" role="group" aria-label="Connectors section">
              {(["yours", "discover"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  className={tab === t ? "active" : undefined}
                  aria-pressed={tab === t}
                  onClick={() => setTab(t)}
                >
                  {t === "yours" ? "Yours" : "Discover"}
                </button>
              ))}
            </div>
            <label className="search">
              <Search size={15} aria-hidden />
              <input
                type="search"
                placeholder="Search connectors"
                aria-label="Search connectors"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
          </div>

          {categories.length > 0 && (
            <div className="chiprow" role="group" aria-label="Filter by category" style={{ margin: "14px 0 6px" }}>
              <button type="button" className={category === null ? "chip on" : "chip"} onClick={() => setCategory(null)}>
                All
              </button>
              {categories.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={category === c ? "chip on" : "chip"}
                  aria-pressed={category === c}
                  onClick={() => setCategory(category === c ? null : c)}
                >
                  {c}
                </button>
              ))}
            </div>
          )}

          {/* A failed read is told, never smoothed into an empty directory. */}
          {error && (
            <div className="card" role="alert" style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
              <AlertTriangle size={16} className="shrink-0" style={{ marginTop: 1, color: "var(--danger-ink)" }} aria-hidden />
              <span className="type-footnote text-[color:var(--text-muted)]" style={{ flex: 1 }}>
                {errorCopy(error)}
              </span>
              {error !== "directory_absent" && (
                <button type="button" className="btn sm" onClick={() => void refresh()}>
                  Try again
                </button>
              )}
            </div>
          )}

          {loading && !entries && (
            <p className="type-footnote text-[color:var(--text-muted)]" role="status">
              Loading connectors…
            </p>
          )}

          {entries && searching && (
            <>
              <Sect title="Results" extra={`${visible.length}`} />
              {visible.length === 0 ? (
                <p className="type-footnote text-[color:var(--text-muted)]" role="status">
                  No connectors match &ldquo;{query.trim()}&rdquo;.
                </p>
              ) : (
                <div className="card" style={{ padding: 6 }}>
                  <div className="rows">
                    {visible.map((e) => (
                      <DirectoryRow key={e.id} entry={e} yours={isYours(e, canManage)} />
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {entries && !searching && (
            <>
              {tab === "yours" && pool.length === 0 && (
                <div className="empty" style={{ paddingBottom: 8 }}>
                  <span className="ei" aria-hidden><Blocks size={24} /></span>
                  <div className="eh">Nothing connected yet</div>
                  <p className="type-footnote" style={{ maxWidth: 420 }}>
                    Connectors you set up or sign in to show up here.
                  </p>
                  <button type="button" className="btn primary" onClick={() => setTab("discover")}>
                    Browse Discover
                  </button>
                </div>
              )}
              {systems.length > 0 && (
                <>
                  <Sect title="Business systems" extra={`${systems.length}`} />
                  <Grid entries={systems} canManage={canManage} />
                </>
              )}
              {servers.length > 0 && (
                <>
                  <Sect title="MCP servers" extra={`${servers.length}`} />
                  <Grid entries={servers} canManage={canManage} />
                </>
              )}
              {tab === "discover" && pool.length === 0 && (
                <p className="type-footnote text-[color:var(--text-muted)]" role="status">
                  Nothing in this category yet.
                </p>
              )}
            </>
          )}

          <p
            className="type-caption-1 text-[color:var(--text-faint)]"
            style={{ marginTop: 24, display: "flex", alignItems: "flex-start", gap: 8, maxWidth: 720 }}
          >
            <ShieldCheck size={14} className="shrink-0" style={{ marginTop: 1 }} />
            Reads run automatically, writes ask for a thumbs-up, destructive actions are blocked.
          </p>
        </>
      )}
    </ShellPage>
  );
}
