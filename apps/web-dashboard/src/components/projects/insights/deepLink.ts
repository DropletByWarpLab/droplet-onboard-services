// `/projects?view=insights` (WARP-3524): the workspace-level Insights are a view
// of the Projects page, not a nav row (the top-level row cap is why). These two
// hooks are the whole of its URL behaviour, kept out of page.tsx so that file —
// which several slices edit at once — only has to call them.

import { useEffect } from "react";
import { useSearchParams } from "next/navigation";

/**
 * Does the URL ask for the workspace-level Insights? `useSearchParams` has to be
 * read under a Suspense boundary (the page provides one) and is null outside the
 * app router, which is how component tests mount the page.
 */
export function useInsightsDeepLink(): boolean {
  const params = useSearchParams();
  return params?.get("view") === "insights";
}

/**
 * Keeps `?view=insights` true to what is on screen: set while the workspace
 * Insights show, dropped as soon as anything else does. It only ever touches
 * that one parameter, and only when it disagrees, so a link that already says
 * the right thing is not rewritten.
 */
export function useSyncInsightsParam(showing: boolean): void {
  useEffect(() => {
    const url = new URL(window.location.href);
    if (showing === (url.searchParams.get("view") === "insights")) return;
    if (showing) url.searchParams.set("view", "insights");
    else url.searchParams.delete("view");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }, [showing]);
}
