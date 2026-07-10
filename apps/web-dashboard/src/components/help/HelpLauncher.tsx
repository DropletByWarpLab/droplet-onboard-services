"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  BookOpen,
  ChevronRight,
  HelpCircle,
  MessageSquare,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { HELP_INDEX, searchHelp } from "@/lib/help-index";

/**
 * Persistent help launcher (Onboarding-Flow redesign §4 — "Help, anytime").
 *
 * A bottom-right FAB on every authenticated dashboard surface that opens a
 * compact launcher popover, which in turn opens a slide-in help panel. Mirrors
 * `redesign/OnbTourHelp.jsx` (HelpFab / HelpLauncher / HelpPanel), consolidated
 * into one mounted widget so a single "?" entry point reaches everything.
 *
 * Grounded, not fabricated: the panel's search + popular topics reuse the real
 * in-repo `HELP_INDEX` / `searchHelp` (lib/help-index) and deep-link to the
 * full prose at `/help#<id>`; "Ask Droplet AI" routes to `/chat`; "Browse all
 * help" routes to `/help`. No invented support channels.
 *
 * Keyboard: `?` toggles the launcher (ignored while typing in a field); `Esc`
 * closes. The panel traps nothing heavier than focus-on-open + a scrim, so it
 * never blocks the dashboard underneath beyond its own overlay.
 *
 * Mounted by AuthGate's authenticated branch only, so it never appears on the
 * wizard, login, the full-screen tour, or the change-password takeover.
 */

type View = "closed" | "menu" | "panel";

export function HelpLauncher() {
  const router = useRouter();
  const [view, setView] = useState<View>("closed");
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // "?" toggles the launcher (unless the customer is typing); Esc closes.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      const typing =
        !!t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable);
      if (e.key === "?" && !typing) {
        e.preventDefault();
        setView((v) => (v === "closed" ? "menu" : "closed"));
      } else if (e.key === "Escape") {
        setView("closed");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Focus the search field when the panel opens.
  useEffect(() => {
    if (view === "panel") searchRef.current?.focus();
  }, [view]);

  // Click outside the launcher closes the popover menu (the panel owns a scrim).
  useEffect(() => {
    if (view !== "menu") return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setView("closed");
      }
    }
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [view]);

  const go = (href: string) => {
    setView("closed");
    router.push(href);
  };

  const results = useMemo(() => searchHelp(query).slice(0, 6), [query]);
  const hasQuery = query.trim().length > 0;

  const menuItems = [
    {
      Icon: Search,
      label: "Search help",
      sub: "Find any article or shortcut",
      onClick: () => setView("panel"),
    },
    {
      Icon: BookOpen,
      label: "Browse all help",
      sub: "Guides for every feature",
      onClick: () => go("/help"),
    },
    {
      Icon: Sparkles,
      label: "Ask Droplet AI",
      sub: "Answers from your own data",
      onClick: () => go("/chat"),
    },
  ];

  return (
    <div ref={rootRef}>
      {/* ── Slide-in help panel ── */}
      {view === "panel" && (
        <div
          className="fixed inset-0 z-[60]"
          role="dialog"
          aria-modal="true"
          aria-label="Help and support"
        >
          <button
            type="button"
            aria-label="Close help"
            onClick={() => setView("closed")}
            className="absolute inset-0 bg-label-primary/30 motion-safe:animate-in motion-safe:fade-in"
          />
          <div className="absolute inset-y-0 right-0 flex w-full max-w-[404px] flex-col border-l border-separator bg-surface-primary shadow-xl motion-safe:animate-in motion-safe:slide-in-from-right">
            {/* Header */}
            <div className="border-b border-separator p-5">
              <div className="mb-3.5 flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <span
                    className="aurora-brand flex h-8 w-8 items-center justify-center rounded-lg text-white"
                    aria-hidden="true"
                  >
                    <HelpCircle size={17} />
                  </span>
                  <span className="type-headline text-label-primary">
                    Help &amp; support
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setView("closed")}
                  aria-label="Close help"
                  className="rounded-md p-1.5 text-label-tertiary transition-colors hover:bg-surface-secondary hover:text-label-secondary"
                >
                  <X size={16} />
                </button>
              </div>
              <div className="flex items-center gap-2 rounded-[10px] border border-separator bg-surface-secondary px-3 py-2">
                <Search
                  size={15}
                  className="flex-none text-label-tertiary"
                  aria-hidden="true"
                />
                <input
                  ref={searchRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search help articles…"
                  className="w-full bg-transparent type-subheadline text-label-primary outline-none placeholder:text-label-tertiary"
                  aria-label="Search help articles"
                />
              </div>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto overscroll-contain p-5">
              {/* Quick actions */}
              <div className="mb-6 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => go("/chat")}
                  className="flex flex-col items-center gap-1.5 rounded-xl border border-separator bg-surface-primary px-2 py-3.5 transition-colors hover:bg-surface-secondary"
                >
                  <Sparkles size={18} className="text-accent" aria-hidden="true" />
                  <span className="type-caption-1 font-semibold text-label-secondary">
                    Ask Droplet AI
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => go("/help")}
                  className="flex flex-col items-center gap-1.5 rounded-xl border border-separator bg-surface-primary px-2 py-3.5 transition-colors hover:bg-surface-secondary"
                >
                  <BookOpen size={18} className="text-accent" aria-hidden="true" />
                  <span className="type-caption-1 font-semibold text-label-secondary">
                    Browse all help
                  </span>
                </button>
              </div>

              <p className="mb-2.5 type-caption-1 font-bold uppercase tracking-[0.06em] text-label-tertiary">
                {hasQuery ? "Results" : "Popular topics"}
              </p>

              {hasQuery && results.length === 0 ? (
                <p className="rounded-xl border border-separator bg-surface-secondary px-3.5 py-3 type-footnote text-label-secondary">
                  No matching articles. Try a different word, or{" "}
                  <button
                    type="button"
                    onClick={() => go("/help")}
                    className="font-semibold text-accent hover:underline"
                  >
                    browse all help
                  </button>
                  .
                </p>
              ) : (
                <div className="overflow-hidden rounded-xl border border-separator">
                  {(hasQuery ? results : HELP_INDEX.slice(0, 6)).map(
                    (entry, i) => (
                      <button
                        key={entry.id}
                        type="button"
                        onClick={() => go(`/help#${entry.id}`)}
                        className={`flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors hover:bg-surface-secondary ${
                          i ? "border-t border-separator" : ""
                        }`}
                      >
                        <span className="flex-1 type-footnote font-medium text-label-primary">
                          {entry.title}
                        </span>
                        <ChevronRight
                          size={14}
                          className="flex-none text-label-tertiary"
                          aria-hidden="true"
                        />
                      </button>
                    ),
                  )}
                </div>
              )}
            </div>

            {/* Status footer */}
            <div className="flex items-center gap-2 border-t border-separator bg-surface-secondary px-5 py-3">
              <span
                className="h-1.5 w-1.5 flex-none rounded-full bg-system-green"
                aria-hidden="true"
              />
              <span className="type-caption-1 text-label-secondary">
                Everything here stays on your Droplet.
              </span>
            </div>
          </div>
        </div>
      )}

      {/* ── Launcher popover menu ── */}
      {view === "menu" && (
        <div
          role="menu"
          aria-label="Help"
          className="fixed bottom-[calc(140px+env(safe-area-inset-bottom))] right-5 z-[60] w-[308px] overflow-hidden rounded-2xl border border-separator bg-surface-primary shadow-xl motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 lg:bottom-[88px] lg:right-7"
        >
          {/* WARP-1153: py-3 on the spacing scale (was py-3.5 = 14px). */}
          <div className="border-b border-separator px-4 py-3">
            <p className="type-subheadline font-semibold text-label-primary">
              How can we help?
            </p>
            <p className="type-caption-1 text-label-tertiary">
              Everything stays on your Droplet.
            </p>
          </div>
          <div className="p-2">
            {menuItems.map(({ Icon, label, sub, onClick }) => (
              <button
                key={label}
                type="button"
                role="menuitem"
                onClick={onClick}
                className="flex w-full items-center gap-3 rounded-[10px] px-3 py-2.5 text-left transition-colors hover:bg-surface-secondary"
              >
                <span
                  className="flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-accent-subtle text-accent"
                  aria-hidden="true"
                >
                  <Icon size={16} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block type-footnote font-semibold text-label-primary">
                    {label}
                  </span>
                  <span className="block type-caption-1 text-label-tertiary">
                    {sub}
                  </span>
                </span>
                <ChevronRight
                  size={14}
                  className="flex-none text-label-tertiary"
                  aria-hidden="true"
                />
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1.5 border-t border-separator bg-surface-secondary px-4 py-2.5 type-caption-1 text-label-tertiary">
            Press
            <kbd className="rounded border border-separator bg-surface-primary px-1.5 py-0.5 type-caption-2 font-mono">
              ?
            </kbd>
            anywhere to open help
          </div>
        </div>
      )}

      {/* ── Persistent FAB ── */}
      <button
        type="button"
        onClick={() => setView((v) => (v === "closed" ? "menu" : "closed"))}
        aria-label={view === "closed" ? "Open help" : "Close help"}
        aria-expanded={view !== "closed"}
        aria-haspopup="menu"
        className="aurora-brand fixed bottom-[calc(72px+env(safe-area-inset-bottom))] right-5 z-[55] flex h-[52px] w-[52px] items-center justify-center rounded-full text-white shadow-lg transition-transform duration-200 ease-smooth hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 motion-reduce:hover:scale-100 lg:bottom-7 lg:right-7"
      >
        {view === "menu" ? <X size={22} /> : <HelpCircle size={22} />}
      </button>
    </div>
  );
}
