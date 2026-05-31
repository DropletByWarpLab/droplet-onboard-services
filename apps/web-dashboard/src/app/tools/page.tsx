"use client";

/**
 * WARP-555 — Tools (`/tools`)
 *
 * Read-only catalog of every built-in tool the Droplet's assistant can
 * run, grouped by the surface it touches (network, files, cameras, …),
 * with search and filter-by-domain. This answers issue #4 — the ~74
 * tools in `packages/tools-core` are registered but had no place to be
 * seen.
 *
 * Scope (v1): a catalog, not a console. There is intentionally NO
 * run-from-dashboard button here — executing a tool outside a chat turn
 * is a separate safety decision (RBAC + confirmation + audit), tracked
 * apart from this surface. The productized workflow shelf (Live / Drafts
 * / Suggested, FEATURES.md §2.8, backed by `/api/tools`) is also a
 * distinct concept from this capability catalog.
 *
 * Data: `useToolCatalog` → `GET /api/llm/tools/catalog`, which reads the
 * in-process tools-core registry and RBAC-filters write tools for
 * non-privileged roles. Badges use plain language ("Writes" / "Asks
 * first") per ADR-002, not the registry's `requiresWrite` jargon.
 */

import { useMemo, useState } from "react";
import { Pencil, Search, ShieldCheck, Wrench, XCircle } from "lucide-react";
import { Topbar } from "@/components/Topbar";
import { useToolCatalog } from "@/lib/hooks/useToolCatalog";
import { iconForDomain, labelForDomain } from "@/lib/tool-domains";
import type { ToolCatalogEntry } from "@/lib/types";

/** snake_case tool name → human title: `list_network_devices` → "List network devices". */
function humanizeToolName(name: string): string {
  const spaced = name.replace(/_/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const ALL = "__all__";

export default function ToolsPage() {
  const { tools, domains, isLoading, error, refresh } = useToolCatalog();
  const [query, setQuery] = useState("");
  const [domainFilter, setDomainFilter] = useState<string>(ALL);

  // Order domains by the orchestrator's canonical list, then append any
  // domain the server sent on a tool but didn't list (defensive — the
  // page should never silently drop a tool).
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

  // Count per domain for the filter chips (unfiltered by search so the
  // chips read as a stable map of "what's installed").
  const countByDomain = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of tools) map.set(t.domain, (map.get(t.domain) ?? 0) + 1);
    return map;
  }, [tools]);

  // Apply search + domain filter, then bucket by domain.
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
    // Stable tool order within a group.
    for (const list of byDomain.values()) {
      list.sort((a, b) => a.name.localeCompare(b.name));
    }
    return orderedDomains
      .filter((d) => byDomain.has(d))
      .map((d) => ({ domain: d, tools: byDomain.get(d)! }));
  }, [tools, query, domainFilter, orderedDomains]);

  const matchCount = grouped.reduce((n, g) => n + g.tools.length, 0);

  const chrome = (status: {
    tone: "ok" | "warn" | "error" | "neutral";
    label: string;
  }) => (
    <Topbar
      crumbs={[
        { label: "Workspace", href: "/" },
        { label: "Admin" },
        { label: "Tools" },
      ]}
      status={status}
    />
  );

  // ── Loading ──
  if (isLoading) {
    return (
      <div>
        {chrome({ tone: "neutral", label: "Loading tools…" })}
        <div className="p-6 space-y-6">
          <div className="h-10 w-full max-w-md dp-card animate-pulse bg-surface-secondary" />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="dp-card h-28 animate-pulse bg-surface-secondary"
              />
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ── Error ──
  if (error) {
    return (
      <div>
        {chrome({ tone: "error", label: "Couldn’t load tools" })}
        <div className="p-6">
          <div className="dp-card text-center py-12" role="alert">
            <XCircle size={32} className="mx-auto text-system-red mb-3" />
            <h2 className="type-title-3 text-label-primary mb-1">
              Couldn’t load your tools
            </h2>
            <p className="type-subheadline text-label-tertiary max-w-md mx-auto">
              We couldn’t reach the assistant to read its tool list. This
              usually clears up on its own — try again in a moment.
            </p>
            <button
              onClick={() => refresh()}
              className="dp-btn-secondary text-sm mt-4"
            >
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Empty (no tools at all) ──
  if (tools.length === 0) {
    return (
      <div>
        {chrome({ tone: "neutral", label: "No tools yet" })}
        <div className="p-6">
          <div className="dp-card text-center py-12">
            <Wrench size={32} className="mx-auto text-label-quaternary mb-3" />
            <h2 className="type-title-3 text-label-primary mb-1">
              No tools available
            </h2>
            <p className="type-subheadline text-label-tertiary max-w-md mx-auto">
              Your Droplet hasn’t reported any tools. Once its services are
              running, everything the assistant can do will show up here.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const totalLabel = `${tools.length} tool${tools.length === 1 ? "" : "s"} available`;

  return (
    <div>
      {chrome({ tone: "ok", label: totalLabel })}

      <div className="p-6 space-y-6">
        {/* Intro — sets the read-only framing in plain language. */}
        <div>
          <h1 className="type-title-2 text-label-primary">Tools</h1>
          <p className="type-subheadline text-label-tertiary mt-1 max-w-2xl">
            Everything your Droplet’s assistant can do for you. Browse by
            area or search by name. Tools run when you ask in a chat —
            this page is just the catalog.
          </p>
        </div>

        {/* Search + domain filters */}
        <div className="space-y-3">
          <div className="relative max-w-md">
            <Search
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-label-tertiary pointer-events-none"
              aria-hidden
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search tools"
              aria-label="Search tools"
              className="
                w-full h-10 pl-9 pr-3 rounded-lg
                bg-surface-secondary border border-separator
                type-subheadline text-label-primary placeholder:text-label-tertiary
                focus:outline-none focus:ring-2 focus:ring-accent/40
                transition-colors duration-200 ease-smooth
              "
            />
          </div>

          <div
            className="flex flex-wrap gap-2"
            role="group"
            aria-label="Filter by area"
          >
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
        </div>

        {/* Results */}
        {matchCount === 0 ? (
          <div className="dp-card text-center py-12">
            <Search size={28} className="mx-auto text-label-quaternary mb-3" />
            <h2 className="type-title-3 text-label-primary mb-1">
              No tools match
            </h2>
            <p className="type-subheadline text-label-tertiary max-w-md mx-auto">
              Nothing matched your search. Try a different word, or clear
              the filters.
            </p>
          </div>
        ) : (
          <div className="space-y-8">
            {grouped.map(({ domain, tools: domainTools }) => {
              const DomainIcon = iconForDomain(domain);
              return (
                <section key={domain} aria-labelledby={`domain-${domain}`}>
                  <div className="flex items-center gap-2 mb-3">
                    <DomainIcon
                      size={18}
                      strokeWidth={2}
                      className="text-accent"
                      aria-hidden
                    />
                    <h2
                      id={`domain-${domain}`}
                      className="type-headline text-label-primary"
                    >
                      {labelForDomain(domain)}
                    </h2>
                    <span className="type-caption-1 text-label-tertiary tabular-nums">
                      {domainTools.length}
                    </span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {domainTools.map((tool) => (
                      <ToolCard key={tool.name} tool={tool} />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
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
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`
        inline-flex items-center gap-1.5 h-8 px-3 rounded-full border
        type-footnote transition-colors duration-200 ease-smooth
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40
        ${
          active
            ? "bg-accent-subtle border-accent/30 text-accent font-medium"
            : "bg-surface-secondary border-separator text-label-secondary hover:text-label-primary"
        }
      `}
    >
      {label}
      <span
        className={`tabular-nums ${active ? "text-accent" : "text-label-tertiary"}`}
      >
        {count}
      </span>
    </button>
  );
}

function ToolCard({ tool }: { tool: ToolCatalogEntry }) {
  return (
    <div className="dp-card p-4 flex flex-col gap-2 h-full">
      <h3 className="type-subheadline text-label-primary font-medium">
        {humanizeToolName(tool.name)}
      </h3>
      <p className="type-footnote text-label-secondary flex-1">
        {tool.homeDescription}
      </p>

      {/* Safety badges — only render the ones that apply. Read-only tools
          (no write, no confirm) show no badge so the eye reads them as the
          safe default. */}
      {(tool.requiresWrite || tool.requiresConfirmation) && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {tool.requiresWrite && (
            <Badge
              tone="orange"
              icon={<Pencil size={11} aria-hidden />}
              label="Writes"
              title="This tool can change something on your Droplet."
            />
          )}
          {tool.requiresConfirmation && (
            <Badge
              tone="blue"
              icon={<ShieldCheck size={11} aria-hidden />}
              label="Asks first"
              title="The assistant asks you to confirm before this runs."
            />
          )}
        </div>
      )}
    </div>
  );
}

function Badge({
  tone,
  icon,
  label,
  title,
}: {
  tone: "orange" | "blue";
  icon: React.ReactNode;
  label: string;
  title: string;
}) {
  // The colored icon + tint carry the meaning; the LABEL uses the
  // high-contrast primary text token so it clears WCAG AA at caption size —
  // the previous colored-text-on-tint badge measured ~2–3.5:1 (fails AA).
  const tintClass =
    tone === "orange" ? "bg-system-orange/15" : "bg-system-blue/15";
  const iconClass =
    tone === "orange" ? "text-system-orange" : "text-system-blue";
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 h-6 px-2 rounded-full type-caption-2 font-medium text-label-primary ${tintClass}`}
    >
      <span className={iconClass}>{icon}</span>
      {label}
    </span>
  );
}
