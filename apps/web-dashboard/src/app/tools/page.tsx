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
 * Scope: a catalog, not a console. There is still intentionally NO
 * run-from-dashboard path — executing a tool outside a chat turn is a
 * separate safety decision (RBAC + confirmation + audit), tracked apart
 * from this surface. WARP-829 makes each card actionable in a SEED-not-run
 * sense: picking a tool primes the chat composer (via the one-shot
 * `droplet.pendingComposer` sessionStorage payload) and pins a chip naming
 * the tool — it never dispatches anything. The tool only runs when the user
 * sends and the model invokes it through the orchestrator's confirmation
 * gate. The productized workflow shelf (Live / Drafts / Suggested,
 * FEATURES.md §2.8, backed by `/api/tools`) is a distinct concept from this
 * capability catalog.
 *
 * Data: `useToolCatalog` → `GET /api/llm/tools/catalog`, which reads the
 * in-process tools-core registry and RBAC-filters write tools for
 * non-privileged roles. Badges use plain language ("Writes" / "Asks
 * first") per ADR-002, not the registry's `requiresWrite` jargon.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Pencil,
  Search,
  ShieldCheck,
  Wrench,
  XCircle,
} from "lucide-react";
import { Topbar } from "@/components/Topbar";
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
 * picked from this catalog. Plain language, lower-case lead, no trailing
 * punctuation (the user finishes the sentence). It does NOT name the raw
 * tool — the home-user persona (ADR-002) asks the assistant in their own
 * words; the pinned chip carries the precise tool identity for the model.
 */
function seedTextForTool(tool: ToolCatalogEntry): string {
  return `Using ${labelForDomain(tool.domain).toLowerCase()}, `;
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
            area or search by name, then pick a tool to start a chat about
            it. Nothing runs until you send your message.
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
  const router = useRouter();
  const title = humanizeToolName(tool.name);

  // WARP-829: picking a tool primes the chat composer — it never runs the
  // tool. We write a one-shot seed-not-send payload to sessionStorage and
  // route to /chat, which seeds the composer and pins a "acting on <tool>"
  // chip. The tool only executes later, when the user sends and the model
  // invokes it through the orchestrator's confirmation gate.
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
      // Private-mode / quota — fall through to the navigation so the user
      // still lands on chat; they just type the request themselves.
    }
    router.push("/chat");
  };

  // The whole card is the action: one tab stop, the largest possible hit
  // target, and Enter/Space activation come free from the native <button>.
  // The badges inside are non-interactive status, not nested controls.
  return (
    <button
      type="button"
      onClick={useInChat}
      aria-label={`Use ${title} in chat`}
      className="
        dp-card group p-4 flex flex-col gap-2 h-full w-full text-left
        cursor-pointer
        transition-[border-color,box-shadow,transform] duration-200 ease-smooth
        hover:border-accent/40 hover:shadow-md
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40
        active:scale-[0.99]
      "
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="type-subheadline text-label-primary font-medium">
          {title}
        </h3>
        {/* Affordance cue — the "Use in chat" label is always faintly present
            so touch users (no hover) still see the card leads to chat; it
            strengthens on hover/focus. No second tab stop — the whole card is
            the button. */}
        <span
          className="
            inline-flex items-center gap-1 type-caption-2 text-accent shrink-0
            opacity-70
            transition-opacity duration-200 ease-smooth
            group-hover:opacity-100
            group-focus-visible:opacity-100
          "
          aria-hidden
        >
          Use in chat
          <ArrowRight
            size={12}
            strokeWidth={2.5}
            className="
              -translate-x-0.5
              transition-transform duration-200 ease-smooth
              group-hover:translate-x-0
              group-focus-visible:translate-x-0
            "
          />
        </span>
      </div>
      {/* label-primary (not secondary): the home description is the card's
          primary content, and the shipped --color-label-secondary token sits
          at 3.44:1 on a white card — under WCAG AA for 13px text. Title still
          reads as the heading via weight (font-medium) + size. Token drift
          tracked separately. */}
      <p className="type-footnote text-label-primary flex-1">
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
    </button>
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
