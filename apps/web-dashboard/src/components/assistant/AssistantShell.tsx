"use client";

/**
 * WARP-3062 — the assistant navigation layout: `<AssistantShell>` replaces
 * the sidebar layout's `<Sidebar/> + <main>` when the person's nav layout is
 * `assistant` (see `AuthGate`).
 *
 * A bar across the top carries the "Ask AI | Overview" switch at its centre,
 * in the same place on both sides. Below it:
 *
 *   Ask side       the page alone — `/chat` brings its own history rail and,
 *                  on phones, its history drawer and docked composer
 *   business side  today's `Sidebar` and page, unchanged, pushed down by the
 *                  bar (`--shell-bar-h`)
 *
 * The side comes from the URL (`lib/assistant-side.ts`), never from state.
 * `/` is the Ask side's front door and forwards to `/chat`; Home is served
 * at `/overview` in this layout, which is where the Sidebar's Overview entry
 * points here.
 *
 * Styling: `assistant-shell.css`, scoped under `.droplet-assistant`, which
 * carries the indigo token ramp (indigo-tokens.css) like `.droplet-workspace`.
 */
import "@/components/shell/indigo-tokens.css";
import "./assistant-shell.css";

import { Suspense, useCallback, useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import {
  ASK_HREF,
  SIDE_HOME,
  SIDE_STORAGE_KEYS,
  returnHrefFor,
  sideForPath,
  type AssistantSide,
} from "@/lib/assistant-side";
import { AssistantSideSwitch } from "./AssistantSideSwitch";

function readReturn(side: AssistantSide): string {
  try {
    return returnHrefFor(side, sessionStorage.getItem(SIDE_STORAGE_KEYS[side]));
  } catch {
    return SIDE_HOME[side];
  }
}

export function AssistantShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const side = sideForPath(pathname);
  const atFrontDoor = pathname === "/";

  // Where each tab leads: the last URL seen on that side, this tab only.
  const [returns, setReturns] = useState<Record<AssistantSide, string>>(SIDE_HOME);

  useEffect(() => {
    setReturns({ ask: readReturn("ask"), business: readReturn("business") });
  }, []);

  const remember = useCallback((url: string) => {
    const visited = sideForPath(url.split(/[?#]/, 1)[0]);
    // Only a real place on its side is worth returning to — not `/`, which
    // only forwards.
    if (returnHrefFor(visited, url) !== url) return;
    try {
      sessionStorage.setItem(SIDE_STORAGE_KEYS[visited], url);
    } catch {
      // Storage unavailable — the switch still works for this page's life.
    }
    setReturns((prev) => (prev[visited] === url ? prev : { ...prev, [visited]: url }));
  }, []);

  // `/` forwards to the conversation, keeping any query (a `?c=` link).
  useEffect(() => {
    if (!atFrontDoor) return;
    router.replace(`${ASK_HREF}${window.location.search}`);
  }, [atFrontDoor, router]);

  return (
    <div className="droplet-assistant" data-nav-layout="assistant" data-side={side}>
      {/* useSearchParams needs a Suspense boundary under the App Router; the
          tracker renders nothing, so the fallback is nothing too. */}
      <Suspense fallback={null}>
        <VisitTracker onVisit={remember} />
      </Suspense>
      <header className="da-bar">
        <AssistantSideSwitch side={side} hrefs={returns} />
      </header>
      {side === "business" && <Sidebar />}
      <main
        id="main"
        tabIndex={-1}
        className={
          side === "business"
            ? "da-main lg:ml-[var(--sidebar-w)] sidebar-w-transition pb-[calc(56px_+_env(safe-area-inset-bottom))] lg:pb-0"
            : "da-main"
        }
      >
        {/* Nothing while `/` forwards — Home must not flash on the Ask side. */}
        {atFrontDoor ? null : children}
      </main>
    </div>
  );
}

/**
 * Records every URL the person lands on — including the `?c=` the chat page
 * writes with `history.replaceState`, which `useSearchParams` follows — so
 * the switch can return to the open conversation.
 */
function VisitTracker({ onVisit }: { onVisit: (url: string) => void }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams?.toString() ?? "";
  useEffect(() => {
    onVisit(search ? `${pathname}?${search}` : pathname);
  }, [pathname, search, onVisit]);
  return null;
}
