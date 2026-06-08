"use client";

/**
 * WARP-555 — Tools (`/tools`)
 *
 * Read-only catalog of every built-in tool the Droplet's assistant can
 * run, grouped by the surface it touches (network, files, cameras, …),
 * with search and filter-by-domain.
 *
 * Scope: a catalog, not a console. There is still intentionally NO
 * run-from-dashboard path. WARP-829 makes each card SEED-not-run: picking a
 * tool primes the chat composer (via the one-shot `droplet.pendingComposer`
 * sessionStorage payload) and pins a chip naming the tool — it never
 * dispatches anything. The tool only runs when the user sends and the model
 * invokes it through the orchestrator's confirmation gate.
 *
 * Data: `useToolCatalog` → `GET /api/llm/tools/catalog`. Re-skinned to the
 * indigo `.droplet-shell` design language (WARP design handoff); the catalog
 * logic and the SEED-not-run contract are unchanged.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Pencil, Search, ShieldCheck, Wrench, XCircle } from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { useToolCatalog } from "@/lib/hooks/useToolCatalog";
import { iconForDomain, labelForDomain } from "@/lib/tool-domains";
import {
  PENDING_COMPOSER_KEY,
  type PendingComposerPayload,
  type ToolCatalogEntry,
} from "@/lib/types";

/** snake_case tool name → human title: `list_network_devices` → "List network devices". */
function humanizeToolName(name: string): string {
  const spaced = name.replace(/_/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * WARP-829 — the starter line dropped into the chat composer when a tool is
 * picked. Plain language, lower-case lead, no trailing punctuation.
 */
function seedTextForTool(tool: ToolCatalogEntry): string {
  return `Using ${labelForDomain(tool.domain).toLowerCase()}, `;
}

const ALL = "__all__";
const SUB =
  "Everything your Droplet's assistant can do for you. Browse by area or search by name, then pick a tool to start a chat about it. Nothing runs until you send your message.";

export default function ToolsPage() {
  const { tools, domains, isLoading, error, refresh } = useToolCatalog();
  const [query, setQuery] = useState("");
  const [domainFilter, setDomainFilter] = useState<string>(ALL);

  const orderedDomains = useMemo(() => {
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const d of domains) {
      if (!seen.has(d)) {
        seen.add(d);
        ordered.push(d);
      }
    }
    for (const t of tools) {
      if (!seen.has(t.domain)) {
        seen.add(t.domain);
        ordered.push(t.domain);
      }
    }
    return ordered;
  }, [domains, tools]);

  const countByDomain = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of tools) map.set(t.domain, (map.get(t.domain) ?? 0) + 1);
    return map;
  }, [tools]);

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = tools.filter((t) => {
      if (domainFilter !== ALL && t.domain !== domainFilter) return false;
      if (!q) return true;
      return (
        t.name.toLowerCase().includes(q) ||
        t.homeDescription.toLowerCase().includes(q) ||
        labelForDomain(t.domain).toLowerCase().includes(q)
      );
    });
    const byDomain = new Map<string, ToolCatalogEntry[]>();
    for (const t of matches) {
      const list = byDomain.get(t.domain) ?? [];
      list.push(t);
      byDomain.set(t.domain, list);
    }
    for (const list of byDomain.values()) {
      list.sort((a, b) => a.name.localeCompare(b.name));
    }
    return orderedDomains
      .filter((d) => byDomain.has(d))
      .map((d) => ({ domain: d, tools: byDomain.get(d)! }));
  }, [tools, query, domainFilter, orderedDomains]);

  const matchCount = grouped.reduce((n, g) => n + g.tools.length, 0);

  // ── Loading ──
  if (isLoading) {
    return (
      <ShellPage icon={<Wrench size={15} />} label="Tools" title="Tools" sub={SUB}>
        <div className="card" style={{ height: 40, maxWidth: 360, marginBottom: 18, opacity: 0.5 }} />
        <div className="grid c3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="card" style={{ height: 112, opacity: 0.5 }} />
          ))}
        </div>
      </ShellPage>
    );
  }

  // ── Error ──
  if (error) {
    return (
      <ShellPage icon={<Wrench size={15} />} label="Tools" title="Tools" sub={SUB}>
        <div className="card" role="alert">
          <div className="empty">
            <span className="ei">
              <XCircle size={24} />
            </span>
            <span className="eh">Couldn&rsquo;t load your tools</span>
            <span>
              We couldn&rsquo;t reach the assistant to read its tool list. This
              usually clears up on its own — try again in a moment.
            </span>
            <button className="btn" onClick={() => refresh()} type="button" style={{ marginTop: 10 }}>
              Try again
            </button>
          </div>
        </div>
      </ShellPage>
    );
  }

  // ── Empty (no tools at all) ──
  if (tools.length === 0) {
    return (
      <ShellPage icon={<Wrench size={15} />} label="Tools" title="Tools" sub={SUB}>
        <div className="card">
          <div className="empty">
            <span className="ei">
              <Wrench size={24} />
            </span>
            <span className="eh">No tools available</span>
            <span>
              Your Droplet hasn&rsquo;t reported any tools. Once its services are
              running, everything the assistant can do will show up here.
            </span>
          </div>
        </div>
      </ShellPage>
    );
  }

  return (
    <ShellPage icon={<Wrench size={15} />} label="Tools" title="Tools" sub={SUB}>
      {/* Search + domain filters */}
      <div className="toolbar">
        <div className="search">
          <Search size={16} aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tools"
            aria-label="Search tools"
          />
        </div>
      </div>
      <div className="chiprow" role="group" aria-label="Filter by area" style={{ marginBottom: 8 }}>
        <FilterChip
          label="All"
          count={tools.length}
          active={domainFilter === ALL}
          onClick={() => setDomainFilter(ALL)}
        />
        {orderedDomains.map((d) => (
          <FilterChip
            key={d}
            label={labelForDomain(d)}
            count={countByDomain.get(d) ?? 0}
            active={domainFilter === d}
            onClick={() => setDomainFilter(d)}
          />
        ))}
      </div>

      {/* Results */}
      {matchCount === 0 ? (
        <div className="card">
          <div className="empty">
            <span className="ei">
              <Search size={24} />
            </span>
            <span className="eh">No tools match</span>
            <span>Nothing matched your search. Try a different word, or clear the filters.</span>
          </div>
        </div>
      ) : (
        grouped.map(({ domain, tools: domainTools }) => {
          const DomainIcon = iconForDomain(domain);
          return (
            <section key={domain} aria-labelledby={`domain-${domain}`}>
              <div className="sect">
                <h2 id={`domain-${domain}`} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  <DomainIcon size={16} strokeWidth={2} style={{ color: "var(--brand)" }} aria-hidden />
                  {labelForDomain(domain)}
                </h2>
                <span className="sx">{domainTools.length}</span>
              </div>
              <div className="grid c3 stagger">
                {domainTools.map((tool) => (
                  <ToolCard key={tool.name} tool={tool} />
                ))}
              </div>
            </section>
          );
        })
      )}
    </ShellPage>
  );
}

/* ───────────────────────── sub-components ───────────────────────── */

function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active} className={"chip" + (active ? " on" : "")}>
      {label}
      <span style={{ fontVariantNumeric: "tabular-nums", opacity: 0.7 }}>{count}</span>
    </button>
  );
}

function ToolCard({ tool }: { tool: ToolCatalogEntry }) {
  const router = useRouter();
  const title = humanizeToolName(tool.name);

  // WARP-829: picking a tool primes the chat composer — it never runs the tool.
  const useInChat = () => {
    const payload: PendingComposerPayload = {
      kind: "tool",
      toolName: tool.name,
      label: title,
      requiresWrite: tool.requiresWrite,
      requiresConfirmation: tool.requiresConfirmation,
      seedText: seedTextForTool(tool),
    };
    try {
      window.sessionStorage.setItem(PENDING_COMPOSER_KEY, JSON.stringify(payload));
    } catch {
      /* private-mode / quota — fall through to navigation */
    }
    router.push("/chat");
  };

  return (
    <button
      type="button"
      onClick={useInChat}
      aria-label={`Use ${title} in chat`}
      className="card hover ds-tool-card"
      style={{
        font: "inherit",
        textAlign: "left",
        width: "100%",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{title}</span>
        <span
          aria-hidden
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            fontSize: 11,
            color: "var(--brand)",
            flexShrink: 0,
          }}
        >
          Use in chat
          <ArrowRight size={12} strokeWidth={2.5} />
        </span>
      </div>
      <p style={{ fontSize: 13, color: "var(--text)", opacity: 0.82, lineHeight: 1.5, flex: 1, margin: 0 }}>
        {tool.homeDescription}
      </p>
      {(tool.requiresWrite || tool.requiresConfirmation) && (
        <div className="chiprow" style={{ gap: 6, paddingTop: 2 }}>
          {tool.requiresWrite && (
            <span className="badge warn" title="This tool can change something on your Droplet.">
              <Pencil size={11} aria-hidden /> Writes
            </span>
          )}
          {tool.requiresConfirmation && (
            <span className="badge info" title="The assistant asks you to confirm before this runs.">
              <ShieldCheck size={11} aria-hidden /> Asks first
            </span>
          )}
        </div>
      )}
    </button>
  );
}
