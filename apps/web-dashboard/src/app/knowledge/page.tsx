"use client";

/**
 * /knowledge — top-level dashboard view for the indexed-content surface.
 *
 * Three tabs: Recently indexed / Search / Brain memory. URL-parameterised
 * so back/forward + share-link round-tripping work:
 *
 *   /knowledge?tab=search&q=foo&source=brain
 *
 * The active tab + filter state is mirrored to the URL whenever the
 * user changes either, using `router.replace` so we don't pollute
 * history with every keystroke.
 */

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { BookOpen, Database, Search } from "lucide-react";
import { Topbar } from "@/components/Topbar";
import { RecentlyIndexedTab } from "./RecentlyIndexedTab";
import { SearchTab } from "./SearchTab";
import { BrainMemoryTab } from "./BrainMemoryTab";

const TABS = [
  { id: "recent", label: "Recently indexed", icon: BookOpen },
  { id: "search", label: "Search", icon: Search },
  { id: "brain", label: "Brain memory", icon: Database },
] as const;
type TabId = (typeof TABS)[number]["id"];

const VALID_TABS = new Set<TabId>(TABS.map((t) => t.id));
function parseTab(raw: string | null | undefined): TabId {
  if (raw && (VALID_TABS as Set<string>).has(raw)) return raw as TabId;
  return "recent";
}

const VALID_SOURCES = new Set(["nextcloud", "brain"]);
function parseSource(raw: string | null | undefined): "nextcloud" | "brain" | undefined {
  return raw && VALID_SOURCES.has(raw) ? (raw as "nextcloud" | "brain") : undefined;
}

function parseSince(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : raw;
}

export default function KnowledgePage() {
  return (
    <Suspense fallback={<KnowledgePageSkeleton />}>
      <KnowledgePageInner />
    </Suspense>
  );
}

function KnowledgePageSkeleton() {
  return (
    <div>
      <Topbar
        crumbs={[
          { label: "Workspace", href: "/" },
          { label: "Knowledge" },
        ]}
        status={{ tone: "neutral", label: "Loading…" }}
      />
      <div className="p-6 lg:p-8 max-w-5xl">
        <p className="type-footnote text-label-tertiary">Loading indexed content…</p>
      </div>
    </div>
  );
}

function KnowledgePageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const initialTab = parseTab(searchParams?.get("tab"));
  const initialQ = searchParams?.get("q") ?? "";
  const initialSource = parseSource(searchParams?.get("source"));
  const initialSince = parseSince(searchParams?.get("since"));

  const [tab, setTab] = useState<TabId>(initialTab);
  const [q, setQ] = useState(initialQ);

  // Push tab + state into the URL so back/forward + share-link works.
  // Using replaceState (not pushState) on minor changes avoids history
  // spam while typing into the search box.
  const syncUrl = useCallback(
    (next: { tab: TabId; q?: string }) => {
      const params = new URLSearchParams();
      params.set("tab", next.tab);
      if (next.q) params.set("q", next.q);
      if (initialSource) params.set("source", initialSource);
      if (initialSince) params.set("since", initialSince);
      const qs = params.toString();
      router.replace(qs ? `/knowledge?${qs}` : "/knowledge");
    },
    [router, initialSource, initialSince]
  );

  // Re-read URL when the user uses the browser back/forward buttons.
  useEffect(() => {
    const newTab = parseTab(searchParams?.get("tab"));
    if (newTab !== tab) setTab(newTab);
    const newQ = searchParams?.get("q") ?? "";
    if (newQ !== q) setQ(newQ);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  function handleTabChange(next: TabId) {
    setTab(next);
    syncUrl({ tab: next, q });
  }

  function handleQueryChange(next: string) {
    setQ(next);
    syncUrl({ tab: "search", q: next });
  }

  // WARP-298: full WAI-ARIA tabs pattern. Arrow keys move + activate
  // (automatic activation; matches our existing on-click behaviour and
  // keeps the URL state machine simple).
  function onTabKey(e: React.KeyboardEvent<HTMLButtonElement>) {
    const i = TABS.findIndex((t) => t.id === tab);
    if (i === -1) return;
    const n = TABS.length;
    let nextIndex: number | null = null;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        nextIndex = (i + 1) % n;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        nextIndex = (i - 1 + n) % n;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = n - 1;
        break;
    }
    if (nextIndex !== null) {
      e.preventDefault();
      handleTabChange(TABS[nextIndex].id);
      // Move focus to the newly activated tab so the SR + keyboard
      // user sees the focus follow the selection.
      const target = document.getElementById(`knowledge-tab-${TABS[nextIndex].id}`);
      target?.focus();
    }
  }

  return (
    <div>
      <Topbar
        crumbs={[
          { label: "Workspace", href: "/" },
          { label: "Knowledge" },
        ]}
      />

      <div className="p-6 lg:p-8 max-w-5xl">
      <div className="mb-6">
        <p className="type-footnote text-label-tertiary">
          Everything your Droplet has indexed — recently added files, full-text
          search, and the brain memory you&apos;ve built up from chat.
        </p>
      </div>

      {/* Tab strip */}
      <div
        role="tablist"
        aria-label="Knowledge view tabs"
        className="flex items-center gap-1 mb-6 border-b border-separator"
      >
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = t.id === tab;
          return (
            <button
              key={t.id}
              role="tab"
              type="button"
              id={`knowledge-tab-${t.id}`}
              aria-selected={active}
              aria-controls={`knowledge-panel-${t.id}`}
              tabIndex={active ? 0 : -1}
              data-testid={`knowledge-tab-${t.id}`}
              onClick={() => handleTabChange(t.id)}
              onKeyDown={onTabKey}
              className={`
                inline-flex items-center gap-2 px-3 h-10 -mb-px
                border-b-2 type-subheadline transition-colors duration-150
                ${
                  active
                    ? "border-accent text-accent"
                    : "border-transparent text-label-secondary hover:text-label-primary"
                }
              `}
            >
              <Icon size={14} aria-hidden="true" />
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Tab body — one <tabpanel> per tab so id/aria-labelledby always
          pair, even for inactive panels. Inactive panels are hidden via
          the HTML `hidden` attribute (removes from a11y tree + DOM flow).
          Their *contents* are only mounted when the tab is active so we
          don't pay for off-screen subtrees. */}
      <div
        role="tabpanel"
        id="knowledge-panel-recent"
        aria-labelledby="knowledge-tab-recent"
        tabIndex={0}
        hidden={tab !== "recent"}
      >
        {tab === "recent" && <RecentlyIndexedTab source={initialSource} />}
      </div>
      <div
        role="tabpanel"
        id="knowledge-panel-search"
        aria-labelledby="knowledge-tab-search"
        tabIndex={0}
        hidden={tab !== "search"}
      >
        {tab === "search" && (
          <SearchTab
            initialQuery={q}
            initialSource={initialSource}
            initialSince={initialSince}
            onQueryChange={handleQueryChange}
          />
        )}
      </div>
      <div
        role="tabpanel"
        id="knowledge-panel-brain"
        aria-labelledby="knowledge-tab-brain"
        tabIndex={0}
        hidden={tab !== "brain"}
      >
        {tab === "brain" && <BrainMemoryTab />}
      </div>
      </div>
    </div>
  );
}
