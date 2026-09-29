"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
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
import { helpSlot } from "@/components/shell/dom-slots";
import { menuItems as itemsOf, moveMenuFocus } from "@/components/ui/useMenuButton";
// WARP-1091 — the launcher's popover menu + slide-in panel are the
// component's only indigo-token consumers. HelpLauncher is mounted by
// AuthGate as a sibling of the routed page (not inside any page's
// `.droplet-shell` / `ShellPage`), so those two conditionally-rendered
// subtrees carry their own `droplet-shell` scope class + import the
// token/primitive CSS directly (the WARP-1072 class-scoping pattern also
// used by `<Dialog>`). The persistent FAB button does NOT get the scope
// class — it's mounted unconditionally on every authenticated page, and
// `droplet-shell.css` retheme's `body:has(.droplet-shell)`, which would
// permanently repaint the body behind pages that haven't converted yet.
// The FAB keeps the global (non-shell-scoped) `--color-accent` token,
// which resolves identically everywhere.
import "@/components/shell/indigo-tokens.css";
import "@/components/shell/droplet-shell.css";

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
 *
 * WARP-3043 — a page can offer a header slot (`helpSlot`, components/shell/
 * dom-slots). /chat and the Workshop do: there the floating button would sit
 * over the docked composer's send button. With a slot registered, the trigger
 * is portaled into it as a header icon button and the menu opens under it,
 * placed from the trigger's box; the menu and panel stay in this tree, out of
 * the header's stacking context. Without one, the floating button is
 * unchanged. Surfaces are separated by tone, not strokes.
 *
 * AuthGate mounts this tree AFTER the routed page, so a menu opened from a
 * header trigger is a whole page away from it in tab order. In slot mode the
 * menu follows the menu-button pattern instead: opening focuses its first
 * item, arrows wrap and Home/End jump, and Escape or Tab hands focus back to
 * the trigger (Tab then carries on from the header).
 */

type View = "closed" | "menu" | "panel";

export function HelpLauncher() {
  const router = useRouter();
  const [view, setView] = useState<View>("closed");
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const slot = helpSlot.useTarget();
  // Where the menu opens under a header trigger; null = the floating spot.
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);

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

  // A menu opened from a header trigger takes focus (see the file note).
  useEffect(() => {
    if (view === "menu" && slot) itemsOf(menuRef.current)[0]?.focus();
  }, [view, slot]);

  // Focus the search field when the panel opens.
  useEffect(() => {
    if (view === "panel") searchRef.current?.focus();
  }, [view]);

  // Under a header trigger the menu is placed from the trigger's box. A slot
  // that is not laid out (hidden below 1024px) has no box, so the menu keeps
  // its floating spot there.
  useLayoutEffect(() => {
    if (view !== "menu" || !slot) {
      setAnchor(null);
      return;
    }
    function place() {
      const rect = triggerRef.current?.getBoundingClientRect();
      setAnchor(
        rect && (rect.width > 0 || rect.height > 0)
          ? { top: rect.bottom + 8, right: window.innerWidth - rect.right }
          : null,
      );
    }
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [view, slot]);

  // Click outside the launcher closes the popover menu (the panel owns a scrim).
  // A header trigger is portaled out of this tree, so it counts as inside.
  useEffect(() => {
    if (view !== "menu") return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (rootRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      setView("closed");
    }
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [view]);

  const go = (href: string) => {
    setView("closed");
    router.push(href);
  };

  const toggle = () => setView((v) => (v === "closed" ? "menu" : "closed"));

  // Slot mode only: Escape and Tab close back onto the header trigger. Tab
  // is not prevented, so the browser moves on from the trigger.
  const onSlotMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" || e.key === "Tab") {
      if (e.key === "Escape") e.preventDefault();
      setView("closed");
      triggerRef.current?.focus();
    } else if (moveMenuFocus(menuRef.current, e.key)) {
      e.preventDefault();
    }
  };
  const triggerLabel = view === "closed" ? "Open help" : "Close help";

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
          className="droplet-shell fixed inset-0 z-[60]"
          role="dialog"
          aria-modal="true"
          aria-label="Help and support"
        >
          <button
            type="button"
            aria-label="Close help"
            onClick={() => setView("closed")}
            className="absolute inset-0 motion-safe:animate-in motion-safe:fade-in"
            style={{ background: "var(--scrim)" }}
          />
          <div
            className="absolute inset-y-0 right-0 flex w-full max-w-[404px] flex-col shadow-xl motion-safe:animate-in motion-safe:slide-in-from-right"
            style={{ background: "var(--surface)" }}
          >
            {/* Header */}
            <div className="p-5">
              <div className="mb-3.5 flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <span
                    className="aurora-brand flex h-8 w-8 items-center justify-center rounded-lg text-white"
                    aria-hidden="true"
                  >
                    <HelpCircle size={17} />
                  </span>
                  <span className="type-headline" style={{ color: "var(--text)" }}>
                    Help &amp; support
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setView("closed")}
                  aria-label="Close help"
                  className="rounded-md p-1.5 transition-colors text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
                >
                  <X size={16} />
                </button>
              </div>
              <div
                className="flex items-center gap-2 rounded-[10px] px-3 py-2"
                style={{ background: "var(--surface-2)" }}
              >
                <Search
                  size={15}
                  className="flex-none"
                  style={{ color: "var(--text-muted)" }}
                  aria-hidden="true"
                />
                <input
                  ref={searchRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search help articles…"
                  className="w-full bg-transparent type-subheadline outline-none text-[var(--text)] placeholder:text-[var(--text-muted)]"
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
                  className="flex flex-col items-center gap-1.5 rounded-xl px-2 py-3.5 transition-colors bg-[var(--inset)] hover:bg-[var(--surface-2)]"
                >
                  <Sparkles size={18} className="text-[var(--brand)]" aria-hidden="true" />
                  <span className="type-caption-1 font-semibold text-[var(--text-muted)]">
                    Ask Droplet AI
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => go("/help")}
                  className="flex flex-col items-center gap-1.5 rounded-xl px-2 py-3.5 transition-colors bg-[var(--inset)] hover:bg-[var(--surface-2)]"
                >
                  <BookOpen size={18} className="text-[var(--brand)]" aria-hidden="true" />
                  <span className="type-caption-1 font-semibold text-[var(--text-muted)]">
                    Browse all help
                  </span>
                </button>
              </div>

              <p className="mb-2.5 type-caption-1 font-bold uppercase tracking-[0.06em] text-[var(--text-muted)]">
                {hasQuery ? "Results" : "Popular topics"}
              </p>

              {hasQuery && results.length === 0 ? (
                <p className="rounded-xl px-3.5 py-3 type-footnote bg-[var(--surface-2)] text-[var(--text-muted)]">
                  No matching articles. Try a different word, or{" "}
                  <button
                    type="button"
                    onClick={() => go("/help")}
                    className="font-semibold hover:underline text-[var(--brand)]"
                  >
                    browse all help
                  </button>
                  .
                </p>
              ) : (
                <div className="overflow-hidden rounded-xl bg-[var(--inset)]">
                  {(hasQuery ? results : HELP_INDEX.slice(0, 6)).map(
                    (entry) => (
                      <button
                        key={entry.id}
                        type="button"
                        onClick={() => go(`/help#${entry.id}`)}
                        className="flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors hover:bg-[var(--surface-2)]"
                      >
                        <span className="flex-1 type-footnote font-medium text-[var(--text)]">
                          {entry.title}
                        </span>
                        <ChevronRight
                          size={14}
                          className="flex-none text-[var(--text-muted)]"
                          aria-hidden="true"
                        />
                      </button>
                    ),
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Launcher popover menu ── */}
      {view === "menu" && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Help"
          onKeyDown={slot ? onSlotMenuKeyDown : undefined}
          className={
            anchor
              ? "droplet-shell fixed z-[60] w-[308px] overflow-hidden rounded-2xl shadow-xl motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-2"
              : "droplet-shell fixed bottom-[calc(140px+env(safe-area-inset-bottom))] right-5 z-[60] w-[308px] overflow-hidden rounded-2xl shadow-xl motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 lg:bottom-[88px] lg:right-7"
          }
          style={
            anchor
              ? { top: anchor.top, right: anchor.right, background: "var(--surface)" }
              : { background: "var(--surface)" }
          }
        >
          {/* WARP-1153: py-3 on the spacing scale (was py-3.5 = 14px). */}
          <div className="px-4 py-3">
            <p className="type-subheadline font-semibold" style={{ color: "var(--text)" }}>
              How can we help?
            </p>
          </div>
          <div className="p-2">
            {menuItems.map(({ Icon, label, sub, onClick }) => (
              <button
                key={label}
                type="button"
                role="menuitem"
                onClick={onClick}
                className="flex w-full items-center gap-3 rounded-[10px] px-3 py-2.5 text-left transition-colors hover:bg-[var(--hover)] focus-visible:bg-[var(--hover)] focus-visible:outline-none"
              >
                <span
                  className="flex h-8 w-8 flex-none items-center justify-center rounded-lg"
                  style={{ background: "var(--brand-subtle)", color: "var(--brand)" }}
                  aria-hidden="true"
                >
                  <Icon size={16} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block type-footnote font-semibold" style={{ color: "var(--text)" }}>
                    {label}
                  </span>
                  <span className="block type-caption-1" style={{ color: "var(--text-muted)" }}>
                    {sub}
                  </span>
                </span>
                <ChevronRight
                  size={14}
                  className="flex-none"
                  style={{ color: "var(--text-muted)" }}
                  aria-hidden="true"
                />
              </button>
            ))}
          </div>
          <div
            className="flex items-center gap-1.5 px-4 py-2.5 type-caption-1"
            style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}
          >
            Press
            <kbd
              className="rounded px-1.5 py-0.5 type-caption-2 font-mono"
              style={{ background: "var(--surface)" }}
            >
              ?
            </kbd>
            anywhere to open help
          </div>
        </div>
      )}

      {/* ── Persistent FAB (desktop only) ── */}
      {/* Not `.droplet-shell`-scoped (see the file-level note) — the ring
          keeps the global `--color-accent` token, which resolves the same
          indigo everywhere without needing the shell scope class.

          Hidden below `lg` (the same 1024px line the mobile board uses): on a
          phone the FAB sat on top of the chat composer's send button and
          covered the bottom card on every scrolling page. Help stays one tap
          away in the More tab, and `?` still opens it on a keyboard. */}
      {slot ? (
        createPortal(
          <button
            ref={triggerRef}
            type="button"
            onClick={toggle}
            aria-label={triggerLabel}
            aria-expanded={view !== "closed"}
            aria-haspopup="menu"
            className="chat-iconbtn"
            title="Help"
          >
            {view === "menu" ? <X size={16} aria-hidden="true" /> : <HelpCircle size={16} aria-hidden="true" />}
          </button>,
          slot,
        )
      ) : (
        <button
          ref={triggerRef}
          type="button"
          onClick={toggle}
          aria-label={triggerLabel}
          aria-expanded={view !== "closed"}
          aria-haspopup="menu"
          className="aurora-brand fixed bottom-[calc(72px+env(safe-area-inset-bottom))] right-5 z-[55] hidden h-[52px] w-[52px] items-center justify-center rounded-full text-white shadow-lg transition-transform duration-200 ease-smooth hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2 motion-reduce:hover:scale-100 lg:bottom-7 lg:right-7 lg:flex"
        >
          {view === "menu" ? <X size={22} /> : <HelpCircle size={22} />}
        </button>
      )}
    </div>
  );
}
