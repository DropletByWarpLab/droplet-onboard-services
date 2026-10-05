"use client";

// WARP-3522 — the single /projects route's state, kept in the URL.
//
//   /projects?p=<IDENTIFIER>&view=<tab>&item=<KEY-123>&v=<savedViewId>&f=<filter>
//
// The page used to hold project, view, filter and the open drawer in useState,
// so none of it could be linked to, reloaded, or walked with Back and Forward.
// Now the URL is the source of truth and the page DERIVES everything from it
// (`parsePmUrl`); every change is a navigation (`buildPmPath`). Nothing is
// mirrored, so there is no second copy to drift: back/forward work because
// they are just URL changes the page re-derives from.
//
// History follows the brief: PUSH for what is navigation — a project, a tab, an
// item — and REPLACE for what is editing — a filter, a saved view. One filter
// edit per keystroke must not become one Back press.
//
// The parameter names and their validation live in
// packages/shared-types/src/pm-links.ts, shared with the orchestrator, which
// builds the same links for notifications.

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { buildPmPath, parsePmUrl, type PmUrlState } from "@droplet/shared-types";

export type UrlState = Required<PmUrlState>;
export type NavMode = "push" | "replace";

export function useProjectsUrl() {
  const router = useRouter();
  const params = useSearchParams();
  const state: UrlState = useMemo(() => parsePmUrl(params ?? new URLSearchParams()), [params]);
  // The canonical form of what is in the address bar (a parameter the contract
  // rejects is not part of it), so "no change" is recognised and not navigated.
  const current = buildPmPath(state);

  /** Did THIS page push the open drawer's history entry? If so, closing it goes
   *  Back — the entry it added is the one it removes — instead of stacking a
   *  second entry. A link that arrived with `item=` already in it was not
   *  pushed by us, and "back" from there would leave the app. */
  const drawerPushed = useRef(false);
  useEffect(() => {
    if (state.item === null) drawerPushed.current = false;
  }, [state.item]);

  const go = useCallback(
    (patch: Partial<UrlState>, mode: NavMode) => {
      const canonical = buildPmPath({ ...state, ...patch });
      if (canonical === current) return;
      // Insights already preserves parameters owned by other surfaces. Keep
      // that contract while every PM parameter still uses the shared parser
      // and canonical builder (including rejection of malformed PM values).
      const other = new URLSearchParams(params?.toString() ?? "");
      for (const name of Object.keys(state)) other.delete(name);
      const suffix = other.toString();
      const hash = typeof window === "undefined" ? "" : window.location.hash;
      const href = canonical + (suffix ? `${canonical.includes("?") ? "&" : "?"}${suffix}` : "") + hash;
      // scroll:false — a filter edit, a drawer and a tab must not jump the page to the top.
      if (mode === "push") router.push(href, { scroll: false });
      else router.replace(href, { scroll: false });
    },
    [state, current, router, params],
  );

  const openItem = useCallback(
    (key: string) => {
      drawerPushed.current = true;
      go({ item: key }, "push");
    },
    [go],
  );

  const closeItem = useCallback(() => {
    if (drawerPushed.current) {
      drawerPushed.current = false;
      router.back();
      return;
    }
    go({ item: null }, "replace");
  }, [go, router]);

  return { state, go, openItem, closeItem };
}
